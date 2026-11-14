import { CONFIG } from '../../config';
import { pieceLength } from '../rail/geometry';
import type { RailNetwork, REdge } from '../rail/network';
import { curveLimit, findPath, hopEndNode, KeepLeft, type Hop } from './graph';
import { carType } from './vehicles';

/** 线路：依次停靠的车站；列车在两端折返往返 */
export interface Line {
  id: number;
  name: string;
  color: number;
  stops: number[];
}

export type TrainState = 'depot' | 'run' | 'dwell' | 'wait';

export interface Train {
  id: number;
  name: string;
  typeId: string;
  cars: number;
  lineId: number | null;
  /** 所属（存放）的车辆基地 */
  depotId: number;
  state: TrainState;
  /** 当前进路：从车尾所在的股道到目的站台 */
  hops: Hop[];
  /** 车头在 hops 的第几段，以及在这一段里走了多远（格） */
  hi: number;
  u: number;
  /** 速度（m/s） */
  v: number;
  /** 正开往线路的第几站，以及沿站序的方向 */
  stopIdx: number;
  stopStep: 1 | -1;
  /** 正在回车辆基地 */
  toDepot: boolean;
  timer: number;
  /** 这次等进路已经等了多久（运行秒） */
  waitSec: number;
  /** 到站次数 */
  arrivals: number;
  /** 进路已锁定，等停站（掉头换端）结束就直接出发 */
  ready: boolean;
}

export interface OpsData {
  lines: Line[];
  trains: Train[];
  /** 运行时钟（秒） */
  time: number;
  nextNo: number;
  nextLineNo: number;
}

export const newOpsData = (): OpsData => ({ lines: [], trains: [], time: 0, nextNo: 1, nextLineNo: 1 });

const LINE_COLORS = [0xe5482d, 0x2f7de1, 0x2aa772, 0xe9a23b, 0x8b5cf6, 0xdb2777, 0x0ea5b7, 0x7c8a2e];

export type OpsEvent = { type: 'stuck'; train: Train; line: Line | null } | { type: 'changed' };

/**
 * 列车运行。信号全自动：
 * 列车出发前把「到下一站的整条进路 + 目的站台」一起锁定，锁不到就在站内等。
 * 一段股道同一时刻只属于一列车，所以不会相撞。
 */
export class Ops {
  /** 锁：'e股道id' 或 'x平交点' → 列车 id */
  private locks = new Map<string, number>();
  private keepLeft: KeepLeft;
  onEvent: ((e: OpsEvent) => void) | null = null;

  constructor(
    readonly net: RailNetwork,
    readonly data: OpsData,
    private cellMeters: number,
    private today: () => number,
  ) {
    this.keepLeft = new KeepLeft(net, CONFIG.rail.trackSpacingM / cellMeters);
    // 读档后恢复锁
    for (const t of data.trains) if (t.state !== 'depot') this.lock(t, t.hops);
  }

  // ------------------------------------------------------------ 锁

  private keysOf(hop: Hop): string[] {
    const keys = [`e${hop.edge}`];
    const n = this.net.nodes.get(hopEndNode(this.net, hop));
    if (n?.crossWith !== undefined) keys.push(`x${Math.min(n.id, n.crossWith)}`);
    return keys;
  }

  private freeFor(t: Train, hop: Hop): boolean {
    return this.keysOf(hop).every((k) => {
      const owner = this.locks.get(k);
      return owner === undefined || owner === t.id;
    });
  }

  private lock(t: Train, hops: Hop[]): void {
    for (const h of hops) for (const k of this.keysOf(h)) this.locks.set(k, t.id);
  }

  private unlockAll(t: Train): void {
    for (const [k, owner] of [...this.locks]) if (owner === t.id) this.locks.delete(k);
  }

  /** 这段股道现在被哪列车占用或预约 */
  ownerOf(edgeId: number): number | undefined {
    return this.locks.get(`e${edgeId}`);
  }

  // ------------------------------------------------------------ 几何

  trainLength(t: Train): number {
    return (carType(t.typeId).carLengthM * t.cars) / this.cellMeters;
  }

  private hopLen(h: Hop): number {
    const e = this.net.edges.get(h.edge);
    return e ? pieceLength(e.piece) : 0;
  }

  /** 车头往后 back 格处在哪段股道的什么位置（沿股道 a→b 的弧长） */
  locate(t: Train, back: number): { edge: REdge; s: number; dir: 1 | -1 } | null {
    let i = t.hi;
    let u = t.u - back;
    while (u < 0 && i > 0) {
      i--;
      u += this.hopLen(t.hops[i]);
    }
    const h = t.hops[i];
    const e = h && this.net.edges.get(h.edge);
    if (!e) return null;
    const len = pieceLength(e.piece);
    const uu = Math.max(0, Math.min(len, u));
    return { edge: e, s: h.dir > 0 ? uu : len - uu, dir: h.dir };
  }

  // ------------------------------------------------------------ 线路与车辆

  addLine(stops: number[]): Line {
    const no = this.data.nextLineNo++;
    const line: Line = { id: this.net.newId(), name: `${no}号线`, color: LINE_COLORS[(no - 1) % LINE_COLORS.length], stops: [...stops] };
    this.data.lines.push(line);
    this.onEvent?.({ type: 'changed' });
    return line;
  }

  removeLine(id: number): void {
    this.data.lines = this.data.lines.filter((l) => l.id !== id);
    for (const t of this.data.trains) if (t.lineId === id) this.assign(t.id, null);
    this.onEvent?.({ type: 'changed' });
  }

  line(id: number | null): Line | null {
    return this.data.lines.find((l) => l.id === id) ?? null;
  }

  trainsOn(lineId: number): Train[] {
    return this.data.trains.filter((t) => t.lineId === lineId);
  }

  buyTrain(depotId: number, typeId: string, cars: number): Train | string {
    const depot = this.net.depots.get(depotId);
    if (!depot) return '需要先建车辆基地';
    if (this.today() < depot.openDay) return '车辆基地尚未落成';
    const inside = this.data.trains.filter((t) => t.depotId === depotId && t.state === 'depot').length;
    if (inside >= CONFIG.ops.depot.capacity) return `这个车辆基地已停满（${CONFIG.ops.depot.capacity} 列）`;
    const ct = carType(typeId);
    const t: Train = {
      id: this.net.newId(),
      name: `${this.data.nextNo++}号列车`,
      typeId,
      cars: Math.max(ct.minCars, Math.min(ct.maxCars, cars)),
      lineId: null,
      depotId,
      state: 'depot',
      hops: [],
      hi: 0,
      u: 0,
      v: 0,
      stopIdx: 0,
      stopStep: 1,
      toDepot: false,
      timer: 0,
      waitSec: 0,
      arrivals: 0,
      ready: false,
    };
    this.data.trains.push(t);
    this.onEvent?.({ type: 'changed' });
    return t;
  }

  /** 一条线最多能放几列车：站台总数 − 1（保证总有空站台可去，不会全线堵死） */
  maxTrains(line: Line): number {
    const platforms = [...new Set(line.stops)].reduce((s, st) => s + this.net.platformsOf(st).length, 0);
    return Math.max(1, platforms - 1);
  }

  /** 把列车分配到线路；null = 撤回车辆基地。超过线路上限时返回原因 */
  assign(trainId: number, lineId: number | null): string | null {
    const t = this.data.trains.find((x) => x.id === trainId);
    if (!t) return '找不到列车';
    const line = this.line(lineId);
    if (line && t.lineId !== line.id && this.trainsOn(line.id).length >= this.maxTrains(line)) {
      return `${line.name}最多 ${this.maxTrains(line)} 列（站台数 − 1）；想加车请增加站台或车站`;
    }
    t.lineId = lineId;
    t.toDepot = lineId === null && t.state !== 'depot';
    t.waitSec = 0;
    this.onEvent?.({ type: 'changed' });
    return null;
  }

  sellTrain(trainId: number): boolean {
    const t = this.data.trains.find((x) => x.id === trainId);
    if (!t || t.state !== 'depot') return false;
    this.data.trains = this.data.trains.filter((x) => x.id !== trainId);
    this.onEvent?.({ type: 'changed' });
    return true;
  }

  /** 有列车占用、或有线路的列车可能经过？（拆除前检查）这里只查占用与预约 */
  edgeInUse(edgeId: number): boolean {
    return this.locks.has(`e${edgeId}`);
  }

  // ------------------------------------------------------------ 寻路

  private isOpen(e: REdge): boolean {
    return this.today() >= e.openDay;
  }

  private pathTo(t: Train, starts: { hop: Hop; cost: number }[], goal: (e: REdge) => boolean, ignoreLocks = false): Hop[] | null {
    return findPath(this.net, {
      starts,
      isGoal: goal,
      blocked: (h) => {
        const e = this.net.edges.get(h.edge)!;
        if (!this.isOpen(e)) return true;
        // 车辆基地的股道只在进出基地时使用
        if (e.role === 'depot' && !goal(e)) return true;
        return !ignoreLocks && !this.freeFor(t, h);
      },
      factor: (h) => (this.keepLeft.wrongSide(h) ? CONFIG.ops.wrongSideFactor : 1),
    });
  }

  private stationGoal(stationId: number): (e: REdge) => boolean {
    return (e) => e.stationId === stationId && e.role === 'platform';
  }

  private depotEdge(depotId: number): REdge | undefined {
    const d = this.net.depots.get(depotId);
    return d ? this.net.edges.get(d.edgeId) : undefined;
  }

  /** 两站之间是否有路（不考虑占用），用于创建线路时检查 */
  reachable(fromStation: number, toStation: number): boolean {
    const starts: { hop: Hop; cost: number }[] = [];
    for (const e of this.net.platformsOf(fromStation)) starts.push({ hop: { edge: e.id, dir: 1 }, cost: 0 }, { hop: { edge: e.id, dir: -1 }, cost: 0 });
    const dummy = { id: -1 } as Train;
    return starts.length > 0 && this.pathTo(dummy, starts, this.stationGoal(toStation), true) !== null;
  }

  /** 估算线路上一列车往返一圈的运行时间（秒） */
  roundTripSec(line: Line, typeId = 'steel'): number | null {
    const ct = carType(typeId);
    const vmax = ct.maxSpeedKmh / 3.6;
    const a = ct.accelKmhS / 3.6;
    const b = ct.decelKmhS / 3.6;
    let total = 0;
    const dummy = { id: -1 } as Train;
    for (let i = 0; i < line.stops.length - 1; i++) {
      const starts: { hop: Hop; cost: number }[] = [];
      for (const e of this.net.platformsOf(line.stops[i])) starts.push({ hop: { edge: e.id, dir: 1 }, cost: 0 }, { hop: { edge: e.id, dir: -1 }, cost: 0 });
      const path = this.pathTo(dummy, starts, this.stationGoal(line.stops[i + 1]), true);
      if (!path) return null;
      const lenM = path.slice(1).reduce((s, h) => s + this.hopLen(h), 0) * this.cellMeters;
      const vPeak = Math.min(vmax, Math.sqrt((2 * lenM * a * b) / (a + b)));
      const ramp = (vPeak * vPeak) / (2 * a) + (vPeak * vPeak) / (2 * b);
      total += vPeak / a + vPeak / b + Math.max(0, lenM - ramp) / vPeak + CONFIG.ops.dwellSec;
    }
    return 2 * total + 2 * CONFIG.ops.reverseSec;
  }

  /** 线路的平均发车间隔（运行秒）；没有车或走不通时为 null */
  headwaySec(line: Line): number | null {
    const trains = this.trainsOn(line.id);
    if (!trains.length) return null;
    const rt = this.roundTripSec(line, trains[0].typeId);
    return rt === null ? null : rt / trains.length;
  }

  // ------------------------------------------------------------ 主循环

  step(dt: number): void {
    this.data.time += dt;
    for (const t of this.data.trains) {
      if (t.state === 'depot') {
        if (t.lineId !== null) this.tryLeaveDepot(t, dt);
      } else if (t.state === 'run') this.run(t, dt);
      else if (t.state === 'dwell') {
        t.timer -= dt;
        if (t.timer > 0) continue;
        if (t.ready) {
          t.ready = false;
          t.state = 'run';
        } else this.depart(t, dt);
      } else if (t.state === 'wait') this.depart(t, dt);
    }
  }

  private tryLeaveDepot(t: Train, dt: number): void {
    t.timer -= dt;
    if (t.timer > 0) return;
    t.timer = 5; // 每 5 秒试一次
    const line = this.line(t.lineId);
    const de = this.depotEdge(t.depotId);
    if (!line || !de || line.stops.length < 2) return;
    const starts = [
      { hop: { edge: de.id, dir: 1 } as Hop, cost: 0 },
      { hop: { edge: de.id, dir: -1 } as Hop, cost: 0 },
    ];
    if (!this.freeFor(t, starts[0].hop)) return;
    // 开往线路上最近的一站
    let best: { path: Hop[]; idx: number; cost: number } | null = null;
    line.stops.forEach((st, idx) => {
      const path = this.pathTo(t, starts, this.stationGoal(st));
      if (!path) return;
      const cost = path.reduce((s, h) => s + this.hopLen(h), 0);
      if (!best || cost < best.cost) best = { path, idx, cost };
    });
    if (!best) return;
    const b = best as { path: Hop[]; idx: number; cost: number };
    t.hops = b.path;
    t.hi = 0;
    // 车尾在尽头，车头向外
    t.u = Math.min(this.hopLen(b.path[0]), this.trainLength(t));
    t.v = 0;
    t.stopIdx = b.idx;
    t.stopStep = b.idx === line.stops.length - 1 ? -1 : 1;
    t.toDepot = false;
    t.state = 'run';
    t.waitSec = 0;
    this.lock(t, t.hops);
  }

  /** 停站结束：锁定到下一站（或车辆基地）的进路并出发 */
  private depart(t: Train, dt: number): void {
    const line = this.line(t.lineId);
    const cur = t.hops[t.hi];
    if (!cur) return;
    let goal: (e: REdge) => boolean;
    let nextIdx = t.stopIdx;
    let nextStep = t.stopStep;
    if (t.toDepot || !line) {
      goal = (e) => e.id === this.depotEdge(t.depotId)?.id;
    } else {
      if (line.stops.length < 2) return;
      nextIdx = t.stopIdx + t.stopStep;
      if (nextIdx < 0 || nextIdx >= line.stops.length) {
        nextStep = t.stopStep > 0 ? -1 : 1;
        nextIdx = t.stopIdx + nextStep;
      }
      nextIdx = Math.max(0, Math.min(line.stops.length - 1, nextIdx));
      goal = this.stationGoal(line.stops[nextIdx]);
    }
    // 从当前股道出发：继续向前，或掉头（有额外代价）
    const starts = [
      { hop: cur, cost: 0 },
      { hop: { edge: cur.edge, dir: cur.dir > 0 ? -1 : 1 } as Hop, cost: 8 },
    ];
    const path = this.pathTo(t, starts, goal);
    if (!path) {
      t.state = 'wait';
      t.waitSec += dt;
      if (t.waitSec > CONFIG.ops.stuckSec) this.resolveStuck(t);
      return;
    }
    const len = this.trainLength(t);
    const reversed = path[0].dir !== cur.dir;
    if (reversed) {
      // 掉头：车尾变车头
      const L = this.hopLen(cur);
      t.u = Math.max(0, Math.min(L, L - (t.u - len)));
    }
    this.unlockAll(t);
    t.hops = path;
    t.hi = 0;
    this.lock(t, path);
    t.stopIdx = nextIdx;
    t.stopStep = nextStep;
    t.state = 'run';
    t.waitSec = 0;
    t.v = 0;
    if (reversed) {
      // 掉头要换端，多停一会儿
      t.state = 'dwell';
      t.timer = CONFIG.ops.reverseSec;
      t.ready = true;
    }
  }

  private run(t: Train, dt: number): void {
    const ct = carType(t.typeId);
    const decel = ct.decelKmhS / 3.6;
    const accel = ct.accelKmhS / 3.6;
    const cm = this.cellMeters;
    const len = this.trainLength(t);
    const last = t.hops.length - 1;
    const lastLen = this.hopLen(t.hops[last]);
    // 停车位置：列车停在目的股道中间
    const stopU = Math.min(lastLen, Math.max(len, (lastLen + len) / 2));
    // 到停车点的距离（米）
    let dist = -t.u;
    for (let i = t.hi; i < last; i++) dist += this.hopLen(t.hops[i]);
    dist = (dist + stopU) * cm;

    // 限速：车身所在与前方股道的曲线限速
    let vLim = ct.maxSpeedKmh / 3.6;
    const lim = (i: number) => curveLimit(this.net.edges.get(t.hops[i].edge)!, cm, CONFIG.rail.curveSpeedK);
    let back = len - t.u;
    vLim = Math.min(vLim, lim(t.hi));
    for (let i = t.hi - 1; i >= 0 && back > 0; i--) {
      vLim = Math.min(vLim, lim(i));
      back -= this.hopLen(t.hops[i]);
    }
    let ahead = (this.hopLen(t.hops[t.hi]) - t.u) * cm;
    for (let i = t.hi + 1; i <= last; i++) {
      const l = lim(i);
      if (l < vLim) vLim = Math.min(vLim, Math.sqrt(l * l + 2 * decel * ahead));
      ahead += this.hopLen(t.hops[i]) * cm;
      if (ahead > 600) break;
    }
    const vStop = Math.sqrt(2 * decel * Math.max(0, dist - 0.3));
    const vAllowed = Math.min(vLim, vStop);
    const v1 = t.v < vAllowed ? Math.min(vAllowed, t.v + accel * dt) : vAllowed;
    let move = ((t.v + v1) / 2) * dt;
    if (move >= dist) move = Math.max(0, dist);
    t.v = v1;
    t.u += move / cm;
    while (t.hi < last && t.u >= this.hopLen(t.hops[t.hi])) {
      t.u -= this.hopLen(t.hops[t.hi]);
      t.hi++;
    }
    this.releaseBehind(t, len);

    if (dist - move < 0.05) {
      t.v = 0;
      const e = this.net.edges.get(t.hops[last].edge)!;
      if (e.role === 'depot') {
        this.unlockAll(t);
        t.state = 'depot';
        t.hops = [];
        t.toDepot = false;
        t.timer = 0;
        this.onEvent?.({ type: 'changed' });
        return;
      }
      t.arrivals++;
      t.state = 'dwell';
      t.timer = CONFIG.ops.dwellSec;
    }
  }

  /** 车尾完全驶离的股道立即解锁 */
  private releaseBehind(t: Train, len: number): void {
    let back = len - t.u;
    let keepFrom = t.hi;
    while (back > 0 && keepFrom > 0) {
      keepFrom--;
      back -= this.hopLen(t.hops[keepFrom]);
    }
    if (keepFrom === 0) return;
    const dropped = t.hops.splice(0, keepFrom);
    t.hi -= keepFrom;
    const still = new Set(t.hops.flatMap((h) => this.keysOf(h)));
    for (const h of dropped) for (const k of this.keysOf(h)) if (!still.has(k) && this.locks.get(k) === t.id) this.locks.delete(k);
  }

  /** 等进路太久：把列车撤回车辆基地（腾出站台），并通知玩家 */
  private resolveStuck(t: Train): void {
    this.unlockAll(t);
    t.state = 'depot';
    t.hops = [];
    t.v = 0;
    t.waitSec = 0;
    // 过一阵再试着出库
    t.timer = CONFIG.ops.stuckSec;
    this.onEvent?.({ type: 'stuck', train: t, line: this.line(t.lineId) });
  }
}
