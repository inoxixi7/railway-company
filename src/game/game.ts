import { CONFIG } from '../config';
import type { MapData } from '../sim/map/types';
import { applyDraft, evaluateDraft, type Draft, type DraftEval } from '../sim/rail/draft';
import { RailNetwork, type StationRec } from '../sim/rail/network';
import { addExternalTerminals, buildStation, removeStation, removeTrack, type StationPlan } from '../sim/rail/stations';
import { Calendar } from './calendar';

export type GameEvent =
  | { type: 'rail' }
  | { type: 'terrain' }
  | { type: 'notice'; text: string };

/**
 * 游戏状态与指令。纯逻辑，不依赖渲染。
 */
export class Game {
  readonly calendar = new Calendar();
  readonly net = new RailNetwork();
  /** 累计投资（资金在第 3、4 步接入后改为扣款） */
  spent = 0;
  private stationNo = 1;
  private listeners: ((e: GameEvent) => void)[] = [];
  /** 还没竣工的日子，用于到期时刷新画面 */
  private pendingOpen = new Set<number>();

  constructor(readonly map: MapData) {
    addExternalTerminals(this.net, map);
  }

  on(fn: (e: GameEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: GameEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  get today(): number {
    return Math.floor(this.calendar.day);
  }

  /** 推进日历；到了竣工日就通知 */
  advance(realSec: number, speed: number): void {
    for (const day of this.calendar.advance(realSec, speed)) {
      if (!this.pendingOpen.has(day)) continue;
      this.pendingOpen.delete(day);
      const stations = [...this.net.stations.values()].filter((s) => s.openDay === day && !s.external);
      this.emit({ type: 'notice', text: stations.length ? `${stations.map((s) => s.name).join('、')}落成` : '线路区段竣工' });
      this.net.version++;
      this.emit({ type: 'rail' });
    }
  }

  evaluate(d: Draft): DraftEval | null {
    return evaluateDraft(this.net, this.map, d);
  }

  /** 确认施工，返回工期（天）；失败返回 null */
  confirmDraft(d: Draft): number | null {
    const ev = evaluateDraft(this.net, this.map, d);
    if (!ev || !ev.ok) return null;
    const r = applyDraft(this.net, this.map, d, ev, this.today);
    this.spent += r.cost;
    this.pendingOpen.add(r.openDay);
    this.emit({ type: 'terrain' });
    this.emit({ type: 'rail' });
    return ev.summary.days;
  }

  placeStation(plan: StationPlan): StationRec | null {
    if (!plan.ok) return null;
    const st = buildStation(this.net, this.map, plan, `${this.stationNo++}号站`, this.today);
    this.spent += st.cost;
    this.pendingOpen.add(st.openDay);
    if (plan.platforms.length) this.emit({ type: 'terrain' });
    this.emit({ type: 'rail' });
    return st;
  }

  renameStation(id: number, name: string): void {
    const st = this.net.stations.get(id);
    if (st && name.trim()) st.name = name.trim().slice(0, 12);
  }

  /** 拆除车站（站台股道变回普通股道），返回退款 */
  demolishStation(id: number): number {
    const refund = removeStation(this.net, id);
    this.spent -= refund;
    this.emit({ type: 'rail' });
    return refund;
  }

  /** 拆除一段股道，返回退款或不能拆的原因 */
  demolishTrack(edgeId: number): number | string {
    const r = removeTrack(this.net, edgeId);
    if (typeof r === 'number') {
      this.spent -= r;
      this.emit({ type: 'rail' });
    }
    return r;
  }
}

export const refundRatio = CONFIG.rail.refundRatio;
