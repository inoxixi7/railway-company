import { CONFIG } from '../config';
import type { MapData } from '../sim/map/types';
import { applyDraft, evaluateDraft, type Draft, type DraftEval } from '../sim/rail/draft';
import { RailNetwork, type StationRec } from '../sim/rail/network';
import { addExternalTerminals, buildStation, removeStation, removeTrack, type StationPlan } from '../sim/rail/stations';
import { buildDepot, type DepotPlan } from '../sim/rail/depots';
import { newOpsData, Ops, type Line, type Train } from '../sim/ops/ops';
import { carType } from '../sim/ops/vehicles';
import { Calendar } from './calendar';

export type GameEvent =
  | { type: 'rail' }
  | { type: 'terrain' }
  | { type: 'ops' }
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

  readonly ops: Ops;
  /** 还没用掉的运行时间（秒） */
  private opsAcc = 0;

  constructor(readonly map: MapData) {
    addExternalTerminals(this.net, map);
    this.ops = new Ops(this.net, newOpsData(), map.cellMeters, () => this.today);
    this.ops.onEvent = (e) => {
      if (e.type === 'stuck') {
        this.emit({ type: 'notice', text: `${e.train.name}等进路太久，已撤回车辆基地。${e.line?.name ?? '线路'}可能太挤：加站台、加渡线或减少列车` });
      }
      this.emit({ type: 'ops' });
    };
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

  /** 推进日历与列车运行；到了竣工日就通知 */
  advance(realSec: number, speed: number): void {
    // 列车与日历脱钩：按固定的 1 秒步长推进运行时钟
    this.opsAcc += realSec * speed * CONFIG.ops.timeScale;
    let steps = Math.min(400, Math.floor(this.opsAcc));
    this.opsAcc -= Math.floor(this.opsAcc);
    while (steps-- > 0) this.ops.step(1);
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
    if (plan.pieces.length) this.emit({ type: 'terrain' });
    this.emit({ type: 'rail' });
    return st;
  }

  renameStation(id: number, name: string): void {
    const st = this.net.stations.get(id);
    if (st && name.trim()) st.name = name.trim().slice(0, 12);
  }

  placeDepot(plan: DepotPlan): boolean {
    if (!plan.ok) return false;
    const d = buildDepot(this.net, this.map, plan, this.today);
    this.spent += d.cost;
    this.pendingOpen.add(d.openDay);
    this.emit({ type: 'terrain' });
    this.emit({ type: 'rail' });
    return true;
  }

  buyTrain(depotId: number, typeId: string, cars: number): Train | string {
    const t = this.ops.buyTrain(depotId, typeId, cars);
    if (typeof t !== 'string') this.spent += carType(typeId).pricePerCar * t.cars;
    return t;
  }

  /** 新建线路：依次停靠的车站；相邻两站之间必须有路 */
  addLine(stops: number[]): Line | string {
    if (stops.length < 2) return '线路至少要两个车站';
    for (let i = 0; i < stops.length - 1; i++) {
      if (!this.ops.reachable(stops[i], stops[i + 1])) {
        const a = this.net.stations.get(stops[i])?.name;
        const b = this.net.stations.get(stops[i + 1])?.name;
        return `${a} 到 ${b} 之间没有已开通的股道`;
      }
    }
    return this.ops.addLine(stops);
  }

  /** 拆除车站（站台股道变回普通股道），返回退款；有线路停靠时返回原因 */
  demolishStation(id: number): number | string {
    const line = this.ops.data.lines.find((l) => l.stops.includes(id));
    if (line) return `${line.name}停靠这个车站，请先删除线路`;
    if (this.net.edgesOfStation(id).some((e) => this.ops.edgeInUse(e.id))) return '有列车正在使用这个车站';
    const refund = removeStation(this.net, id);
    this.spent -= refund;
    this.emit({ type: 'rail' });
    return refund;
  }

  /** 拆除一段股道，返回退款或不能拆的原因 */
  demolishTrack(edgeId: number): number | string {
    if (this.ops.edgeInUse(edgeId)) return '有列车正在使用这段股道，请先把列车撤回车辆基地';
    if (this.net.edges.get(edgeId)?.role === 'depot') return '这是车辆基地的股道';
    const r = removeTrack(this.net, edgeId);
    if (typeof r === 'number') {
      this.spent -= r;
      this.emit({ type: 'rail' });
    }
    return r;
  }
}

export const refundRatio = CONFIG.rail.refundRatio;
