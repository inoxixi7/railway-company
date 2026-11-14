import { CONFIG } from '../config';
import { formatYen } from '../game/calendar';
import type { Game } from '../game/game';
import { buildDraftPreview, buildStationPreview, marker } from '../render/rail';
import type { MapView } from '../render/view';
import { draftEnd, pickStart, strokeTo, type Draft, type Stroke } from '../sim/rail/draft';
import type { Pt } from '../sim/rail/geometry';
import { STATION_TYPE_NAMES, STRUCTURE_NAMES, type StationType, type Structure } from '../sim/rail/network';
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

/**
 * 建站：点空地放一座独立的车站（拖动确定方向），或点已有的直线股道在上面建站。
 */
export class StationTool implements Tool {
  readonly id = 'station';
  private type: StationType = 'side';
  private center: Pt | null = null;
  private dir: Pt = { x: 1, y: 0 };
  private onTrack: { edgeId: number; s: number } | null = null;
  private plan: StationPlan | null = null;

  constructor(
    private game: Game,
    private view: MapView,
    private sheet: Sheet,
    private exit: () => void,
  ) {
    this.render();
  }

  tap(x: number, y: number): void {
    const hit = this.game.net.nearestEdge(x, y, 0.8);
    if (hit && hit.edge.stationId === undefined) {
      this.onTrack = { edgeId: hit.edge.id, s: hit.s };
      this.center = null;
    } else {
      this.onTrack = null;
      this.center = { x, y };
    }
    this.render();
  }

  dragStart(x: number, y: number): void {
    this.onTrack = null;
    this.center = { x, y };
  }

  drag(x: number, y: number): void {
    if (!this.center) return;
    const dx = x - this.center.x;
    const dy = y - this.center.y;
    if (Math.hypot(dx, dy) > 1) {
      // 方向吸附到 5° 的倍数，方便对齐
      const a = Math.round(Math.atan2(dy, dx) / ((5 * Math.PI) / 180)) * ((5 * Math.PI) / 180);
      this.dir = { x: Math.cos(a), y: Math.sin(a) };
    }
    this.render();
  }

  dragEnd(): void {
    this.render();
  }

  private render(): void {
    const { net, map } = this.game;
    this.plan = null;
    if (this.onTrack) {
      const e = net.edges.get(this.onTrack.edgeId);
      if (e) this.plan = planStationOnTrack(net, map, this.type, e, this.onTrack.s);
    } else if (this.center) {
      this.plan = planStation(net, map, this.type, this.center.x, this.center.y, this.dir.x, this.dir.y);
    }
    const p = this.plan;
    this.view.setOverlay(p ? [buildStationPreview(map, p)] : []);
    const hints: Record<StationType, string> = {
      single: '一条站台股道。适合单线的小站。',
      side: '两条股道，站台在两侧。',
      island: '两条股道，中间一个站台；两端自动收到复线间距。',
    };
    const body = h('div');
    body.append(
      seg<StationType>(
        (['single', 'side', 'island'] as StationType[]).map((t) => [t, STATION_TYPE_NAMES[t]]),
        this.type,
        (v) => {
          this.type = v;
          this.render();
        },
      ),
      h('p', { class: 'note' }, hints[this.type]),
    );
    let sub = '点空地放置（拖动定方向），或点一段直线股道';
    if (p) {
      sub = p.ok ? `造价 ${formatYen(p.cost)}円 · 工期 ${CONFIG.rail.stationDays} 天` : '这里不能建站';
      if (p.issues.length) body.append(issueList(p.issues));
    }
    body.append(
      h(
        'div',
        { class: 'btns' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.exit() }, '完成'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn go',
            disabled: !p?.ok,
            onclick: () => {
              const st = p && this.game.placeStation(p);
              if (!st) return;
              toast(`${st.name}（${STATION_TYPE_NAMES[st.type]}）开工`);
              this.center = null;
              this.onTrack = null;
              this.render();
            },
          },
          '建站',
        ),
      ),
    );
    this.sheet.show('tool', 'station', '建站', sub, body);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}
