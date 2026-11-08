import { CONFIG } from '../config';
import { formatDuration, formatYen } from '../sim/calendar';
import { dirIndex, routeOctilinear, type GridPt } from '../sim/track/alignment';
import { lineEnds, type DepotCandidate, type Draft, type StationCandidate } from '../sim/rail/line';
import type { Acquisition } from '../sim/land/land';
import { STATION_TYPE_NAMES, type StationType } from '../sim/rail/types';
import type { World } from '../sim/world';
import type { MapView } from '../render/view';
import { buildDraftPreview, buildFootprint } from '../render/railRender';
import { buildSeconds, lineAlignment } from '../sim/rail/line';
import { sampleAlignment } from '../sim/track/alignment';
import type { Panel } from './panel';
import { toast } from './toast';
import { h, kv } from './dom';

export type ToolId = 'track' | 'station' | 'depot' | 'land';

export interface Tool {
  id: ToolId;
  /** 单指拖动（铺轨工具用来画线） */
  dragStart?(x: number, y: number): void;
  drag?(x: number, y: number): void;
  dragEnd?(): void;
  tap(x: number, y: number): void;
  /** 退出工具时清理 */
  dispose(): void;
}

function demolishRows(a?: Acquisition): [string, string][] {
  if (!a || a.citizen + a.own === 0) return [];
  return [['拆迁', `${a.citizen} 栋（补偿 ${formatYen(a.cost)}）${a.own ? `，另拆自有建筑 ${a.own} 栋` : ''}`]];
}

/** 工期文字 */
const buildTime = (days: number): string => (buildSeconds(days) > 0 ? `工期 ${formatDuration(buildSeconds(days))}` : '立即完工');

const STRUCTURE_NAMES = { ground: '地面', viaduct: '高架', bridge: '桥梁', tunnel: '隧道' } as const;
const STRUCTURE_COLORS = { ground: '#ffffff', viaduct: '#c39bff', bridge: '#6ec6ff', tunnel: '#777777' } as const;

/** 铺轨工具：拖动画 8 方向线，松手后继续从末端画；草案实时显示造价与问题 */
export class TrackTool implements Tool {
  readonly id = 'track' as const;
  private draft: Draft | null = null;
  /** 每一笔（用于撤销） */
  private legs: number[] = [];
  private preview: GridPt[] | null = null;
  private tracks: 1 | 2 = 2;

  constructor(
    private world: World,
    private view: MapView,
    private panel: Panel,
    private onExit: () => void,
  ) {
    this.render();
  }

  private snap(x: number, y: number): GridPt {
    for (const t of this.world.map.terminals) {
      if (Math.hypot(x - t.entry.x, y - t.entry.y) < 4) return { ...t.entry };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  private begin(x: number, y: number): boolean {
    if (this.draft) return true;
    const p = this.snap(x, y);
    const line = this.world.line;
    if (!line) {
      this.draft = { anchor: 'new', points: [p], tracks: this.tracks };
      return true;
    }
    const ends = lineEnds(line)!;
    const ds = Math.hypot(x - ends.start.pt.x, y - ends.start.pt.y);
    const de = Math.hypot(x - ends.end.pt.x, y - ends.end.pt.y);
    if (Math.min(ds, de) > 5) {
      toast('MVP 只有一条线：请从线路的端点开始延长');
      return false;
    }
    const end = de <= ds ? ends.end : ends.start;
    this.draft = { anchor: de <= ds ? 'end' : 'start', points: [{ ...end.pt }], tracks: this.tracks };
    return true;
  }

  private preferDir(points: GridPt[]): number {
    if (points.length >= 2) {
      const a = points[points.length - 2];
      const b = points[points.length - 1];
      return dirIndex(b.x - a.x, b.y - a.y);
    }
    const line = this.world.line;
    if (line && this.draft && this.draft.anchor !== 'new') {
      const ends = lineEnds(line)!;
      return this.draft.anchor === 'end' ? ends.end.dir : ends.start.dir;
    }
    return -1;
  }

  private routeTo(x: number, y: number): GridPt[] {
    const pts = this.draft!.points;
    const last = pts[pts.length - 1];
    const target = this.snap(x, y);
    const leg = routeOctilinear(last, target, this.preferDir(pts));
    return [...pts, ...leg.slice(1)];
  }

  dragStart(x: number, y: number): void {
    if (!this.begin(x, y)) return;
  }

  drag(x: number, y: number): void {
    if (!this.draft) return;
    this.preview = this.routeTo(x, y);
    this.render();
  }

  dragEnd(): void {
    if (!this.draft || !this.preview) return;
    this.legs.push(this.draft.points.length);
    this.draft.points = this.preview;
    this.preview = null;
    this.render();
  }

  tap(x: number, y: number): void {
    const fresh = !this.draft;
    if (!this.begin(x, y)) return;
    if (fresh) {
      this.render();
      return;
    }
    this.legs.push(this.draft!.points.length);
    this.draft!.points = this.routeTo(x, y);
    this.render();
  }

  private undo(): void {
    if (!this.draft) return;
    const n = this.legs.pop();
    if (n === undefined) this.draft = null;
    else this.draft.points = this.draft.points.slice(0, n);
    this.render();
  }

  private current(): Draft | null {
    if (!this.draft) return null;
    return { ...this.draft, tracks: this.tracks, points: this.preview ?? this.draft.points };
  }

  private render(): void {
    const d = this.current();
    const ev = d && d.points.length >= 2 ? this.world.evaluate(d) : null;
    const objs = [];
    if (ev) {
      const step = (ev.s1 - ev.s0) / (ev.profile.z.length - 1);
      // 预览只画新建部分（接入终点站时不含站内）
      const n = ev.profile.z.length;
      const internal = ev.terminal ? ev.terminal.rect.w : 0;
      const ps0 = ev.shift > 0 && ev.terminal ? ev.s0 + internal : ev.s0;
      const ps1 = ev.shift === 0 && ev.terminal ? ev.s1 - internal : ev.s1;
      const pstep = (ps1 - ps0) / (n - 1);
      void step;
      const issues = ev.issues.filter((i) => i.at).map((i) => ({ x: i.at!.x, y: i.at!.y }));
      objs.push(buildDraftPreview(this.world.map, ev.merged.alignment, ps0, ev.profile.z, ev.profile.structure, pstep, issues, ev.ok));
    } else if (d) {
      const p = d.points[0];
      objs.push(buildFootprint(this.world.map, p.x - 0.5, p.y - 0.5, 1, 1, true));
    }
    this.view.setOverlay(objs);

    const body = h('div');
    const seg = h(
      'div',
      { class: 'seg' },
      ...([2, 1] as const).map((n) =>
        h(
          'button',
          {
            type: 'button',
            class: this.tracks === n ? 'on' : '',
            onclick: () => {
              this.tracks = n;
              this.render();
            },
          },
          n === 2 ? '复线' : '单线（便宜，运能封顶）',
        ),
      ),
    );
    body.append(seg);
    let summary = '从线路端点（或任意处新建）拖动画线';
    if (!this.world.line && !d) summary = '拖动画线；画到东侧终点站西端即可接入';
    if (ev) {
      const s = ev.summary;
      summary = `${(s.lengthM / 1000).toFixed(2)} km · ${formatYen(s.cost + (ev.acquisition?.cost ?? 0))} · ${buildTime(s.days)}`;
      const parts = (Object.keys(s.byStructureM) as (keyof typeof s.byStructureM)[])
        .filter((k) => s.byStructureM[k] > 0)
        .map((k) => {
          const span = h('span', {}, h('span', { class: 'legend', style: `background:${STRUCTURE_COLORS[k]}` }), `${STRUCTURE_NAMES[k]} ${(s.byStructureM[k] / 1000).toFixed(2)} km`);
          return span;
        });
      const struct = h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 12px' }, ...parts);
      body.append(
        h('div', { style: 'margin-top:10px' }),
        kv([
          ['构造', struct],
          ['最大坡度', `${s.maxGradePermil.toFixed(1)}‰（上限 ${CONFIG.rail.maxGradePermil}‰）`],
          ['造价', formatYen(s.cost)],
          ...demolishRows(ev.acquisition),
          ['工期', buildTime(s.days).replace('工期 ', '')],
        ]),
      );
      if (ev.terminal) body.append(h('p', { class: 'note ok' }, `将接入「${ev.terminal.name}」`));
      if (ev.issues.length) body.append(h('ul', { class: 'issues' }, ...ev.issues.map((i) => h('li', {}, i.message))));
    }
    body.append(
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn', disabled: !this.draft, onclick: () => this.undo() }, '撤销'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.onExit() }, '取消'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            disabled: !ev?.ok,
            onclick: () => {
              if (!d || !this.world.confirmDraft(d)) return;
              const km = (ev!.summary.lengthM / 1000).toFixed(2);
              toast(buildSeconds(ev!.summary.days) > 0 ? `开工：${km} km，${formatDuration(buildSeconds(ev!.summary.days))}后竣工` : `线路建成：${km} km`);
              this.draft = null;
              this.legs = [];
              this.render();
            },
          },
          '确认施工',
        ),
      ),
    );
    this.panel.show('tool', '铺轨', summary, body, true);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}

/** 建站工具：点击线路上的位置，选择车站形式 */
export class StationTool implements Tool {
  readonly id = 'station' as const;
  private type: StationType = 'side';
  private at: { x: number; y: number } | null = null;
  private cand: StationCandidate | null = null;

  constructor(
    private world: World,
    private view: MapView,
    private panel: Panel,
    private onExit: () => void,
  ) {
    this.render();
  }

  tap(x: number, y: number): void {
    this.at = { x, y };
    this.render();
  }

  private render(): void {
    this.cand = this.at ? this.world.stationCandidate(this.at.x, this.at.y, this.type) : null;
    const c = this.cand;
    const objs = [];
    if (c) {
      const L = CONFIG.rail.stationLengthCells;
      const W = CONFIG.rail.stationWidthCells;
      objs.push(buildFootprint(this.world.map, c.center.x - L / 2, c.center.y - W / 2, L, W, c.ok, Math.atan2(-c.dir.y, c.dir.x)));
    }
    this.view.setOverlay(objs);
    const body = h('div');
    body.append(
      h(
        'div',
        { class: 'seg' },
        ...(['single', 'side', 'island'] as StationType[]).map((t) =>
          h(
            'button',
            {
              type: 'button',
              class: this.type === t ? 'on' : '',
              onclick: () => {
                this.type = t;
                this.render();
              },
            },
            STATION_TYPE_NAMES[t],
          ),
        ),
      ),
    );
    const hints: Record<StationType, string> = {
      single: '一条股道。只能建在单线上，不能会车。',
      side: '两条股道、两侧站台。单线上可以会车。',
      island: '两条股道、中间一个站台。单线上可以会车。',
    };
    body.append(h('p', { class: 'note' }, hints[this.type]));
    let summary = this.world.line ? '点击线路上要建站的位置' : '请先铺设线路';
    if (c) {
      summary = c.ok ? `造价 ${formatYen(c.cost)} · ${buildTime(CONFIG.rail.stationDays)}` : '这里不能建站';
      body.append(kv(demolishRows(c.acquisition)));
      if (c.issues.length) body.append(h('ul', { class: 'issues' }, ...c.issues.map((i) => h('li', {}, i))));
    } else if (this.at && this.world.line) {
      summary = '请点在线路上';
    }
    body.append(
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.onExit() }, '完成'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            disabled: !c?.ok,
            onclick: () => {
              const st = c && this.world.placeStation(c, this.type);
              if (st) toast(`${st.name}（${STATION_TYPE_NAMES[this.type]}）${buildSeconds(CONFIG.rail.stationDays) > 0 ? '开工' : '建成'}`);
              this.at = null;
              this.render();
            },
          },
          '建站',
        ),
      ),
    );
    this.panel.show('tool', '建站', summary, body, true);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}

/** 车辆基地工具：点击某个车站的一侧 */
export class DepotTool implements Tool {
  readonly id = 'depot' as const;
  private cand: DepotCandidate | null = null;
  private msg = '';

  constructor(
    private world: World,
    private view: MapView,
    private panel: Panel,
    private onExit: () => void,
  ) {
    if (world.line?.depot) this.msg = 'MVP 只能建一个车辆基地（已建）';
    this.render();
  }

  tap(x: number, y: number): void {
    const line = this.world.line;
    if (!line) return;
    const al = lineAlignment(this.world.map, line);
    let best: { st: (typeof line.stations)[number]; d: number } | null = null;
    for (const st of line.stations) {
      const p = sampleAlignment(al, st.s);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 10 && (!best || d < best.d)) best = { st, d };
    }
    if (!best) {
      this.cand = null;
      this.msg = '请点在某个车站的旁边';
    } else {
      const p = sampleAlignment(al, best.st.s);
      // 点在线路法线 (ty, -tx) 的哪一侧
      const side: 1 | -1 = (x - p.x) * p.ty - (y - p.y) * p.tx >= 0 ? 1 : -1;
      this.cand = this.world.depotCandidate(best.st, side);
      this.msg = '';
    }
    this.render();
  }

  private render(): void {
    const c = this.cand;
    this.view.setOverlay(c ? [buildFootprint(this.world.map, c.x, c.y, c.w, c.h, c.ok)] : []);
    const d = CONFIG.rail.depot;
    const body = h('div');
    body.append(h('p', { class: 'note' }, `固定规格：${d.lengthCells * 20}×${d.widthCells * 20} m，${d.sidings} 条留置线，经出入库线连接旁边的车站。造价 ${formatYen(d.cost)}，${buildTime(d.days)}。`));
    let summary = this.msg || (this.world.line?.stations.length ? '点击车站的一侧' : '请先铺线并建站');
    if (c) {
      summary = c.ok ? '可以建设' : '这里不能建';
      body.append(kv(demolishRows(c.acquisition)));
      if (c.issues.length) body.append(h('ul', { class: 'issues' }, ...c.issues.map((i) => h('li', {}, i))));
    }
    body.append(
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.onExit() }, '完成'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            disabled: !c?.ok,
            onclick: () => {
              if (c && this.world.placeDepot(c)) {
                toast(buildSeconds(d.days) > 0 ? '车辆基地开工' : '车辆基地建成');
                this.onExit();
              }
            },
          },
          '建设',
        ),
      ),
    );
    this.panel.show('tool', '车辆基地', summary, body, true);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}
