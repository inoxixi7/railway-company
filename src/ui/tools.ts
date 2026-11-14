import { CONFIG } from '../config';
import { formatYen } from '../game/calendar';
import type { Game } from '../game/game';
import { buildDraftPreview, buildStationPreview, marker } from '../render/rail';
import type { MapView } from '../render/view';
import { draftEnd, pickStart, strokeTo, type Draft, type Stroke } from '../sim/rail/draft';
import type { Pt } from '../sim/rail/geometry';
import { STATION_TYPE_NAMES, STRUCTURE_NAMES, type StationType, type Structure } from '../sim/rail/network';
import { planDepot } from '../sim/rail/depots';
import { planStation, planStationOnTrack, type StationPlan } from '../sim/rail/stations';
import { h } from './dom';
import type { Sheet } from './sheet';
import { toast } from './toast';

export interface Tool {
  id: string;
  dragStart?(x: number, y: number): void;
  drag?(x: number, y: number): void;
  dragEnd?(): void;
  tap(x: number, y: number): void;
  dispose(): void;
}

const STRUCTURE_COLORS: Record<Structure, string> = { ground: 'var(--mut)', viaduct: '#a37be0', bridge: '#4a9fe0', tunnel: '#555' };

function seg<T extends string | number>(options: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  return h(
    'div',
    { class: 'seg' },
    ...options.map(([v, label]) => h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => onPick(v) }, label)),
  );
}

function issueList(messages: string[]): HTMLElement {
  return h('ul', { class: 'issues' }, ...[...new Set(messages)].map((t) => h('li', {}, t)));
}

/**
 * 铺轨：一笔一段，自动与前一段相切。松手定下这一段，再拖下一段。
 * 起点靠近端点或已有股道时自动接上（分岔），末端靠近时自动并线。
 */
export class TrackTool implements Tool {
  readonly id = 'track';
  private mode: 1 | 2 = 2;
  private crossing: 'flat' | 'over' = 'over';
  private draft: Draft | null = null;
  private startDirs: Pt[] = [];
  private stroke: Stroke | null = null;

  constructor(
    private game: Game,
    private view: MapView,
    private sheet: Sheet,
    private exit: () => void,
  ) {
    this.render();
  }

  private begin(x: number, y: number): void {
    const pick = pickStart(this.game.net, this.game.map, x, y, this.mode);
    if (pick.single && this.mode === 2) toast('从单条股道出发：这次铺单条');
    this.draft = { mode: pick.single ? 1 : this.mode, start: pick.anchor, startPt: pick.pt, pieces: [], strokes: [], end: { kind: 'free' }, crossing: this.crossing };
    this.startDirs = pick.dirs;
  }

  private strokeTo(x: number, y: number): Stroke | null {
    const d = this.draft!;
    if (d.end.kind !== 'free') return null;
    const e = draftEnd(d);
    return strokeTo(this.game.net, this.game.map, e.pt, e.dir ? [e.dir] : this.startDirs, { x, y }, d.mode, d.start);
  }

  private commit(): void {
    if (!this.draft || !this.stroke) return;
    this.draft.pieces.push(...this.stroke.pieces);
    this.draft.strokes.push(this.draft.pieces.length);
    this.draft.end = this.stroke.end;
    this.stroke = null;
  }

  dragStart(x: number, y: number): void {
    if (!this.draft) this.begin(x, y);
  }

  drag(x: number, y: number): void {
    if (!this.draft) return;
    this.stroke = this.strokeTo(x, y);
    this.render();
  }

  dragEnd(): void {
    this.commit();
    this.render();
  }

  tap(x: number, y: number): void {
    if (!this.draft) this.begin(x, y);
    else {
      if (this.draft.end.kind !== 'free') toast('草案已经接上了，请确认施工或撤销');
      this.stroke = this.strokeTo(x, y);
      this.commit();
    }
    this.render();
  }

  private undo(): void {
    const d = this.draft;
    if (!d) return;
    d.strokes.pop();
    d.pieces.length = d.strokes[d.strokes.length - 1] ?? 0;
    d.end = { kind: 'free' };
    if (!d.pieces.length) this.draft = null;
    this.render();
  }

  private current(): Draft | null {
    const d = this.draft;
    if (!d) return null;
    return { ...d, crossing: this.crossing, pieces: this.stroke ? [...d.pieces, ...this.stroke.pieces] : d.pieces, end: this.stroke ? this.stroke.end : d.end };
  }

  private render(): void {
    const d = this.current();
    const ev = d ? this.game.evaluate(d) : null;
    const map = this.game.map;
    if (ev && d) this.view.setOverlay([buildDraftPreview(map, ev, d.pieces)]);
    else if (d) this.view.setOverlay([marker(map, d.startPt, 0xffffff, 0.5)]);
    else this.view.setOverlay([]);

    const body = h('div');
    body.append(
      seg<1 | 2>([[2, '两条平行（复线）'], [1, '单条']], this.draft?.mode ?? this.mode, (v) => {
        this.mode = v;
        this.draft = null;
        this.stroke = null;
        this.render();
      }),
    );
    let sub = '在地图上拖动画线；从端点或已有股道出发可接出支线';
    if (d && !ev) sub = '继续拖动画出第一段';
    if (ev) {
      const s = ev.summary;
      // 画线时面板保持紧凑：关键数字放在副标题一行
      const over = s.maxGradePermil > CONFIG.rail.maxGradePermil + 0.5;
      sub = `${(s.lengthM / 1000).toFixed(2)} km · ${formatYen(s.cost)}円 · ${s.days} 天 · 坡度 ${s.maxGradePermil.toFixed(0)}‰${over ? '（超限）' : ''}`;
      const kinds = (Object.keys(s.byStructureM) as Structure[]).filter((k) => s.byStructureM[k] > 0.5);
      if (kinds.length > 1) {
        const mix = h('div', { class: 'mix' });
        const lg = h('div', { class: 'lg' });
        for (const k of kinds) {
          mix.append(h('i', { style: `width:${(s.byStructureM[k] / s.lengthM) * 100}%;background:${STRUCTURE_COLORS[k]}` }));
          lg.append(h('span', {}, h('i', { style: `background:${STRUCTURE_COLORS[k]}` }), `${STRUCTURE_NAMES[k]} ${(s.byStructureM[k] / 1000).toFixed(2)} km`));
        }
        body.append(mix, lg);
      }
      if (ev.crossings.length) {
        body.append(
          h('p', { class: 'note' }, `与已有股道相交 ${ev.crossings.length} 处：`),
          seg<'over' | 'flat'>([['over', '立体交叉（高架跨过）'], ['flat', '平面交叉']], this.crossing, (v) => {
            this.crossing = v;
            this.render();
          }),
        );
      }
      if (ev.issues.length) body.append(issueList(ev.issues.map((i) => i.message)));
    }
    body.append(
      h(
        'div',
        { class: 'btns' },
        h('button', { type: 'button', class: 'btn', disabled: !this.draft, onclick: () => this.undo() }, '撤销'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.exit() }, '取消'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn go',
            disabled: !ev?.ok || !!this.stroke,
            onclick: () => {
              const days = d && this.game.confirmDraft(d);
              if (!days) return;
              toast(`开工，${days} 天后竣工`);
              this.draft = null;
              this.render();
            },
          },
          '确认施工',
        ),
      ),
    );
    this.sheet.show('tool', 'track', '铺轨', sub, body);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}

type BuildKind = StationType | 'depot';

/**
 * 建站：点空地放一座独立的车站（拖动确定方向），或点已有的直线股道在上面建站。
 * 也在这里建车辆基地：点直线股道旁的平地。
 */
export class StationTool implements Tool {
  readonly id = 'station';
  private kind: BuildKind = 'side';
  private crossover = true;
  private center: Pt | null = null;
  private dir: Pt = { x: 1, y: 0 };
  private onTrack: { edgeId: number; s: number } | null = null;
  private tapPt: Pt | null = null;

  constructor(
    private game: Game,
    private view: MapView,
    private sheet: Sheet,
    private exit: () => void,
  ) {
    this.render();
  }

  tap(x: number, y: number): void {
    this.tapPt = { x, y };
    const hit = this.game.net.nearestEdge(x, y, this.kind === 'depot' ? 4 : 0.8);
    if (hit && (this.kind === 'depot' || hit.edge.stationId === undefined)) {
      this.onTrack = { edgeId: hit.edge.id, s: hit.s };
      this.center = null;
    } else {
      this.onTrack = null;
      this.center = { x, y };
    }
    this.render();
  }

  dragStart(x: number, y: number): void {
    if (this.kind === 'depot') return;
    this.onTrack = null;
    this.center = { x, y };
  }

  drag(x: number, y: number): void {
    if (!this.center || this.kind === 'depot') return;
    const dx = x - this.center.x;
    const dy = y - this.center.y;
    if (Math.hypot(dx, dy) > 1) {
      // 方向吸附到 5° 的倍数，方便对齐
      const step = (5 * Math.PI) / 180;
      const a = Math.round(Math.atan2(dy, dx) / step) * step;
      this.dir = { x: Math.cos(a), y: Math.sin(a) };
    }
    this.render();
  }

  dragEnd(): void {
    this.render();
  }

  private render(): void {
    const { net, map } = this.game;
    const body = h('div');
    const kinds: [BuildKind, string][] = [['single', '一面一线'], ['side', '相对式'], ['island', '岛式'], ['depot', '车辆基地']];
    body.append(
      seg<BuildKind>(kinds, this.kind, (v) => {
        this.kind = v;
        this.center = null;
        this.onTrack = null;
        this.render();
      }),
    );
    let sub: string;
    let ok = false;
    let build: () => void = () => {};
    const issues: string[] = [];

    if (this.kind === 'depot') {
      const d = CONFIG.ops.depot;
      body.append(h('p', { class: 'note' }, `点直线股道旁的平地：自动用道岔接出出入库线。可停 ${d.capacity} 列，造价 ${formatYen(d.cost)}円，工期 ${d.days} 天。列车在这里购买。`));
      sub = '点一段直线股道的旁边';
      const e = this.onTrack && net.edges.get(this.onTrack.edgeId);
      if (e && this.tapPt) {
        const plan = planDepot(net, map, e, this.onTrack!.s, this.tapPt.x, this.tapPt.y);
        const d2 = CONFIG.ops.depot;
        const cx = plan.stub.k === 'L' ? (plan.stub.ax + plan.stub.bx) / 2 : plan.x;
        const cy = plan.stub.k === 'L' ? (plan.stub.ay + plan.stub.by) / 2 : plan.y;
        this.view.setOverlay([
          buildStationPreview(map, { x: cx, y: cy, hx: plan.hx, hy: plan.hy, z: plan.z, ok: plan.ok, extent: [d2.lengthCells / 2 + 0.3, d2.lengthCells / 2 + 0.3], halfWidth: 1.15, pieces: [...plan.lead, plan.stub].map((piece) => ({ piece, role: 'throat' as const })) }),
        ]);
        ok = plan.ok;
        issues.push(...plan.issues);
        sub = plan.ok ? '可以建设' : '这里不能建';
        build = () => {
          if (this.game.placeDepot(plan)) {
            toast('车辆基地开工');
            this.onTrack = null;
            this.render();
          }
        };
      } else {
        this.view.setOverlay([]);
        if (this.tapPt && !e) sub = '请点在股道旁边（4 格以内）';
      }
    } else {
      const type = this.kind;
      let plan: StationPlan | null = null;
      if (this.onTrack) {
        const e = net.edges.get(this.onTrack.edgeId);
        if (e) plan = planStationOnTrack(net, map, type, e, this.onTrack.s);
      } else if (this.center) {
        plan = planStation(net, map, type, this.center.x, this.center.y, this.dir.x, this.dir.y, [this.crossover, this.crossover]);
      }
      this.view.setOverlay(plan ? [buildStationPreview(map, plan)] : []);
      if (type !== 'single') {
        const input = h('input', { type: 'checkbox', 'aria-label': '两端带渡线' });
        input.checked = this.crossover;
        input.addEventListener('change', () => {
          this.crossover = input.checked;
          this.render();
        });
        body.append(h('label', { class: 'setting' }, h('div', {}, '两端带渡线', h('small', {}, '列车可以在站前换股道、折返；关掉更省地')), h('span', { class: 'switch' }, input, h('span'))));
      } else {
        body.append(h('p', { class: 'note' }, '一条站台股道，适合单线的小站。'));
      }
      sub = '点空地放置（拖动定方向），或点一段直线股道';
      if (plan) {
        ok = plan.ok;
        issues.push(...plan.issues);
        sub = plan.ok ? `造价 ${formatYen(plan.cost)}円 · 工期 ${CONFIG.rail.stationDays} 天` : '这里不能建站';
        const p = plan;
        build = () => {
          const st = this.game.placeStation(p);
          if (!st) return;
          toast(`${st.name}（${STATION_TYPE_NAMES[st.type]}）开工`);
          this.center = null;
          this.onTrack = null;
          this.render();
        };
      }
    }
    if (issues.length) body.append(issueList(issues));
    body.append(
      h(
        'div',
        { class: 'btns' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.exit() }, '完成'),
        h('button', { type: 'button', class: 'btn go', disabled: !ok, onclick: () => build() }, this.kind === 'depot' ? '建设' : '建站'),
      ),
    );
    this.sheet.show('tool', 'station', this.kind === 'depot' ? '车辆基地' : '建站', sub, body);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}

/** 新建线路：在地图上依次点车站 */
export class LineTool implements Tool {
  readonly id = 'line';
  private stops: number[] = [];

  constructor(
    private game: Game,
    private view: MapView,
    private sheet: Sheet,
    private exit: () => void,
    private done: () => void,
  ) {
    this.render();
  }

  tap(x: number, y: number): void {
    const net = this.game.net;
    let best: { id: number; d: number } | null = null;
    for (const st of net.stations.values()) {
      const d = Math.hypot(st.x - x, st.y - y);
      if (d < 5 && (!best || d < best.d)) best = { id: st.id, d };
    }
    if (!best) {
      toast('请点在车站上');
      return;
    }
    if (this.stops[this.stops.length - 1] === best.id) return;
    this.stops.push(best.id);
    this.render();
  }

  private render(): void {
    const { net, map, ops } = this.game;
    this.view.setOverlay(this.stops.map((id) => marker(map, net.stations.get(id)!, 0xffc233, 1.4)));
    const body = h('div');
    const issues: string[] = [];
    if (this.stops.length) {
      body.append(h('p', { class: 'stops' }, this.stops.map((id) => net.stations.get(id)?.name ?? '?').join('  →  ')));
      for (let i = 0; i < this.stops.length - 1; i++) {
        if (!ops.reachable(this.stops[i], this.stops[i + 1])) {
          issues.push(`${net.stations.get(this.stops[i])?.name} 到 ${net.stations.get(this.stops[i + 1])?.name} 之间没有已开通的股道`);
        }
      }
    }
    if (issues.length) body.append(issueList(issues));
    body.append(
      h(
        'div',
        { class: 'btns' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            disabled: !this.stops.length,
            onclick: () => {
              this.stops.pop();
              this.render();
            },
          },
          '撤销',
        ),
        h('button', { type: 'button', class: 'btn', onclick: () => this.exit() }, '取消'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn go',
            disabled: this.stops.length < 2 || issues.length > 0,
            onclick: () => {
              const r = this.game.addLine(this.stops);
              if (typeof r === 'string') {
                toast(r, 2500);
                return;
              }
              toast(`${r.name}已创建，到「调度」里给它配车`);
              this.exit();
              this.done();
            },
          },
          '创建线路',
        ),
      ),
    );
    this.sheet.show('tool', 'dispatch', '新建线路', this.stops.length ? '继续点下一站；列车在两端折返' : '在地图上依次点要停靠的车站', body);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}
