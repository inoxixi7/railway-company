import { CONFIG } from '../../config';
import { carType } from '../rail/vehicles';
import { limitAt, type Node, type Res, type Topology } from './topology';

export type TrainState = 'depot' | 'leaving' | 'dwell' | 'running' | 'entering';

export interface Train {
  id: number;
  name: string;
  typeId: string;
  cars: number;
  state: TrainState;
  /** +1 下行（里程增加），-1 上行 */
  dir: 1 | -1;
  /** 车头里程（格） */
  head: number;
  /** 速度（m/s） */
  v: number;
  /** 当前所在或最近离开的车站节点 */
  node: number;
  /** 占用/预约的资源（按行进顺序） */
  held: number[];
  departAt: number;
  timer: number;
  /** 回送入库 */
  retire: boolean;
  /** 等信号累计（秒） */
  waitSec: number;
  trips: number;
  /** 最近一次移动或到站的时刻（用于检测卡死） */
  lastProgress: number;
}

export interface Headways {
  /** 各时段发车间隔（分钟，0 = 停运），与 CONFIG.ops.periods 对应 */
  [periodId: string]: number;
}

export interface OpsState {
  trains: Train[];
  headways: Headways;
  /** 各端点站最近一次使用的发车时刻 */
  lastSlot: [number, number];
  nextTrainNo: number;
}

const CELL_M = 20;
const DEPOT_MOVE_SEC = 90;

export function trainLengthCells(t: Train): number {
  return (carType(t.typeId).carLengthM * t.cars) / CELL_M;
}

export const tailOf = (t: Train): number => t.head - t.dir * trainLengthCells(t);

/** 当前时段 */
export function periodAt(timeSec: number): (typeof CONFIG.ops.periods)[number] {
  const h = ((timeSec / 3600) % 24 + 24) % 24;
  return CONFIG.ops.periods.find((p) => h >= p.from && h < p.to) ?? CONFIG.ops.periods[0];
}

export function headwayAt(ops: OpsState, timeSec: number): number {
  const p = periodAt(timeSec);
  return (ops.headways[p.id] ?? p.headwayMin) * 60;
}

/**
 * 第一层（安全，永远自动）+ 第二层（按发车间隔排班）的列车运行模拟。
 */
export class OpsSim {
  constructor(
    public topo: Topology,
    public state: OpsState,
  ) {}

  private get res(): Res[] {
    return this.topo.res;
  }

  private nodeCount(): number {
    return this.topo.nodes.length;
  }

  // ------------------------------------------------------------ 资源

  private free(ids: number[]): boolean {
    return ids.every((id) => this.res[id].holder === null);
  }

  private take(t: Train, ids: number[]): void {
    for (const id of ids) {
      this.res[id].holder = t.id;
      t.held.push(id);
    }
  }

  private releaseAll(t: Train): void {
    for (const id of t.held) if (this.res[id].holder === t.id) this.res[id].holder = null;
    t.held = [];
  }

  /** 在节点 n 为方向 dir 选择一条空闲股道 */
  private pickTrack(n: Node, dir: 1 | -1): number | null {
    if (n.tracks === 1) return this.res[n.trackRes[0]].holder === null ? n.trackRes[0] : null;
    const pref = dir > 0 ? 0 : 1;
    if (!n.isEnd) return this.res[n.trackRes[pref]].holder === null ? n.trackRes[pref] : null;
    for (const i of [pref, 1 - pref]) if (this.res[n.trackRes[i]].holder === null) return n.trackRes[i];
    return null;
  }

  /**
   * 尝试把进路向前延伸一步（原子操作：要么全部锁定，要么都不锁）。
   * 只延伸到下一个停车站的股道为止。返回是否有新的锁定。
   */
  private extend(t: Train): boolean {
    const { nodes, links } = this.topo;
    const frontier = t.held.length ? this.res[t.held[t.held.length - 1]] : null;
    if (!frontier) return false;
    if (frontier.kind === 'track') {
      // 已锁定到某个车站股道：只有当这是当前所在站时才继续向前
      const at = this.nodeOfTrack(frontier.id);
      if (at === null || at !== t.node) return false;
      const j = at + t.dir;
      if (j < 0 || j >= nodes.length) return false;
      const link = links[Math.min(at, j)];
      const here = nodes[at];
      if (link.double) {
        const first = (t.dir > 0 ? link.down : link.up)[0];
        const ids = [first];
        if (here.throat !== null) ids.unshift(here.throat);
        if (!this.free(ids)) return false;
        this.take(t, ids);
        return true;
      }
      // 单线：整段区间 + 对面会车点股道
      const stretch = link.stretch!;
      let q = j;
      while (q > 0 && q < nodes.length - 1 && !nodes[q].passing) q += t.dir;
      const track = this.pickTrack(nodes[q], t.dir);
      if (track === null || !this.free([stretch])) return false;
      this.take(t, [stretch, track]);
      return true;
    }
    if (frontier.kind === 'block') {
      const link = links.find((l) => l.down.includes(frontier.id) || l.up.includes(frontier.id))!;
      const list = t.dir > 0 ? link.down : link.up;
      const i = list.indexOf(frontier.id);
      if (i < list.length - 1) {
        if (!this.free([list[i + 1]])) return false;
        this.take(t, [list[i + 1]]);
        return true;
      }
      const j = t.dir > 0 ? link.k + 1 : link.k;
      const n = nodes[j];
      const track = this.pickTrack(n, t.dir);
      if (track === null) return false;
      const ids = [track];
      if (n.throat !== null) ids.push(n.throat);
      if (!this.free(ids)) return false;
      this.take(t, ids);
      return true;
    }
    return false;
  }

  private nodeOfTrack(resId: number): number | null {
    for (const n of this.topo.nodes) if (n.trackRes.includes(resId)) return n.idx;
    return null;
  }

  /** 进路终点（里程）：最远锁定资源的远端 */
  private authorityEnd(t: Train): number {
    let end = t.head;
    for (const id of t.held) {
      const r = this.res[id];
      if (r.kind === 'throat' || r.kind === 'lead') continue;
      const far = t.dir > 0 ? r.b : r.a;
      if (t.dir > 0 ? far > end : far < end) end = far;
    }
    return end;
  }

  private stopPoint(n: Node, dir: 1 | -1): number {
    return dir > 0 ? n.b - 0.1 : n.a + 0.1;
  }

  // ------------------------------------------------------------ 排班（第二层）

  private nextSlot(end: 0 | 1, notBefore: number): number {
    const last = this.state.lastSlot[end];
    let t = Math.max(notBefore, last + 1);
    // 最多向后找 2 天
    for (let guard = 0; guard < 2 * 24 * 60; guard++) {
      const h = headwayAt(this.state, t);
      if (h > 0) {
        const p = periodAt(t);
        const day = Math.floor(t / 86400) * 86400;
        // 另一端的发车时刻错开「单程 + 折返」，让到达的列车正好赶上
        const start = day + p.from * 3600 + (end === 1 ? this.halfCycleSec() % h : 0);
        const k = Math.ceil((t - start) / h);
        const slot = start + k * h;
        if (slot < day + p.to * 3600 && slot > last) return slot;
        if (slot <= last) {
          t = last + 1;
          continue;
        }
        t = day + p.to * 3600;
      } else {
        t = Math.floor(t / 60) * 60 + 60;
      }
    }
    return Infinity;
  }

  /** 估算单程运行时间（秒）：按加速、限速、减速逐区间计算，含中间站停车 */
  oneWaySec(typeId = this.state.trains[0]?.typeId ?? 'steel'): number {
    const ct = carType(typeId);
    const a = ct.accelKmhS / 3.6;
    const b = ct.decelKmhS / 3.6;
    let run = 0;
    for (const l of this.topo.links) {
      const lenM = (l.b - l.a + CONFIG.rail.stationLengthCells) * CELL_M;
      let vmax = ct.maxSpeedKmh / 3.6;
      for (let s = l.a; s <= l.b; s += 0.5) vmax = Math.min(vmax, limitAt(this.topo, s));
      const vPeak = Math.min(vmax, Math.sqrt((2 * lenM * a * b) / (a + b)));
      const accelDist = (vPeak * vPeak) / (2 * a) + (vPeak * vPeak) / (2 * b);
      run += vPeak / a + vPeak / b + Math.max(0, lenM - accelDist) / vPeak;
    }
    return run + Math.max(0, this.nodeCount() - 2) * CONFIG.ops.dwellSec;
  }

  /** 单程 + 折返（留 10% 余量），取整到分钟 */
  halfCycleSec(): number {
    return Math.ceil((this.oneWaySec() * 1.1 + CONFIG.ops.turnbackSec) / 60) * 60;
  }

  /** 往返一圈所需时间（秒） */
  cycleTimeSec(): number {
    return 2 * this.halfCycleSec();
  }

  requiredTrains(now: number): number {
    const h = headwayAt(this.state, now);
    if (h <= 0) return 0;
    return Math.ceil(this.cycleTimeSec() / h);
  }

  /** 线路上（不在车辆基地内）的列车数 */
  onLine(): number {
    return this.state.trains.filter((t) => t.state !== 'depot').length;
  }

  /** 环形容量限制下最多可上线的列车数（防死锁） */
  maxOnLine(): number {
    return Math.max(0, this.topo.ringCapacity - 1);
  }

  private manageService(now: number): void {
    const { depotNode, depotLead } = this.topo;
    if (depotNode === null || depotLead === null) return;
    const required = this.requiredTrains(now);
    const active = this.state.trains.filter((t) => t.state !== 'depot' && !t.retire);
    if (active.length > required) {
      let surplus = active.length - required;
      for (const t of active) {
        if (surplus <= 0) break;
        if (t.state === 'leaving') continue;
        t.retire = true;
        surplus--;
      }
    } else if (active.length < required) {
      // 先撤回已标记回送的列车
      const flagged = this.state.trains.find((t) => t.retire && t.state !== 'depot' && t.state !== 'entering');
      if (flagged) {
        flagged.retire = false;
        return;
      }
      if (this.onLine() + 1 > this.maxOnLine()) return;
      const parked = this.state.trains.find((t) => t.state === 'depot');
      if (!parked) return;
      const n = this.topo.nodes[depotNode];
      // 方向：端点站只能向内；中间站选列车较少的方向
      let dir: 1 | -1;
      if (depotNode === 0) dir = 1;
      else if (depotNode === this.nodeCount() - 1) dir = -1;
      else {
        const down = active.filter((t) => t.dir > 0).length;
        dir = down <= active.length - down ? 1 : -1;
      }
      const track = this.pickTrack(n, dir);
      if (track === null || this.res[depotLead].holder !== null) return;
      parked.dir = dir;
      parked.node = depotNode;
      parked.head = this.stopPoint(n, dir);
      parked.v = 0;
      parked.state = 'leaving';
      parked.timer = DEPOT_MOVE_SEC;
      parked.retire = false;
      parked.lastProgress = now;
      this.take(parked, [depotLead, track]);
    }
  }

  // ------------------------------------------------------------ 主循环

  step(now: number, dt: number): void {
    if (Math.floor(now / 60) !== Math.floor((now - dt) / 60)) this.manageService(now);
    for (const t of this.state.trains) {
      switch (t.state) {
        case 'depot':
          break;
        case 'leaving':
          t.timer -= dt;
          if (t.timer <= 0) {
            this.releaseIds(t, [this.topo.depotLead!]);
            t.state = 'dwell';
            t.lastProgress = now;
            this.scheduleDeparture(t, now, false);
          }
          break;
        case 'entering':
          t.timer -= dt;
          if (t.timer <= 0) {
            this.releaseAll(t);
            t.state = 'depot';
            t.retire = false;
          }
          break;
        case 'dwell':
          this.dwell(t, now);
          break;
        case 'running':
          this.run(t, now, dt);
          break;
      }
    }
  }

  private releaseIds(t: Train, ids: number[]): void {
    for (const id of ids) {
      if (this.res[id].holder === t.id) this.res[id].holder = null;
      t.held = t.held.filter((h) => h !== id);
    }
  }

  private scheduleDeparture(t: Train, now: number, arrived: boolean): void {
    const n = this.topo.nodes[t.node];
    const lastIdx = this.nodeCount() - 1;
    const atEnd = (t.node === 0 && t.dir > 0) || (t.node === lastIdx && t.dir < 0);
    if (atEnd && !t.retire) {
      const ready = now + (arrived ? CONFIG.ops.turnbackSec : CONFIG.ops.dwellSec);
      const end: 0 | 1 = t.node === 0 ? 0 : 1;
      const slot = this.nextSlot(end, ready);
      if (slot !== Infinity) this.state.lastSlot[end] = slot;
      t.departAt = slot === Infinity ? ready : slot;
    } else {
      t.departAt = now + (arrived && atEnd ? CONFIG.ops.turnbackSec : CONFIG.ops.dwellSec);
    }
    void n;
  }

  private dwell(t: Train, now: number): void {
    if (now < t.departAt) return;
    // 回送列车到达车辆基地所在站：入库
    if (t.retire && t.node === this.topo.depotNode && this.topo.depotLead !== null) {
      if (this.res[this.topo.depotLead].holder === null) {
        this.take(t, [this.topo.depotLead]);
        t.state = 'entering';
        t.timer = DEPOT_MOVE_SEC;
        t.v = 0;
      }
      return;
    }
    // 还有前方已锁定的区间（单线区间内的中间站）或能锁定新的区间就出发
    if (this.nextStop(t) === null) return;
    this.extend(t);
    const auth = this.authorityEnd(t);
    if (t.dir > 0 ? auth > t.head + 0.15 : auth < t.head - 0.15) {
      t.state = 'running';
      return;
    }
    t.waitSec += 1;
  }

  /** 下一个停车点（里程），没有则 null */
  private nextStop(t: Train): number | null {
    const j = t.node + t.dir;
    if (j < 0 || j >= this.nodeCount()) return null;
    return this.stopPoint(this.topo.nodes[j], t.dir);
  }

  private run(t: Train, now: number, dt: number): void {
    // 尽量把进路延伸到下一个停车站
    for (let k = 0; k < 4 && this.extend(t); k++);
    const ct = carType(t.typeId);
    const decel = ct.decelKmhS / 3.6;
    const stop = this.nextStop(t);
    let target = this.authorityEnd(t);
    // 闭塞区间之间留出 2 m 余量（除非终点就是停车点）
    if (stop !== null && (t.dir > 0 ? stop < target : stop > target)) target = stop;
    else target -= t.dir * 0.1;
    // 物理保护：不得接近同一股道上的前车尾部
    target = this.guard(t, target);

    const distM = Math.max(0, (target - t.head) * t.dir * CELL_M);
    const vStop = Math.sqrt(2 * decel * Math.max(0, distM - 0.5));
    let vAllowed = Math.min(ct.maxSpeedKmh / 3.6, vStop, this.limitAhead(t, decel));
    if (distM < 0.05) vAllowed = 0;

    // 坡度
    const accel = ct.accelKmhS / 3.6;
    const v0 = t.v;
    let v1 = v0 < vAllowed ? Math.min(vAllowed, v0 + accel * dt) : vAllowed;
    v1 = Math.max(0, v1);
    let moveM = ((v0 + v1) / 2) * dt;
    if (moveM > distM) {
      moveM = distM;
      v1 = distM < 0.5 ? 0 : v1;
    }
    t.v = v1;
    t.head += (t.dir * moveM) / CELL_M;
    if (moveM > 0.01) t.lastProgress = now;
    else t.waitSec += dt;

    this.releaseBehind(t);

    // 到站
    if (stop !== null && Math.abs(stop - t.head) < 0.01 && t.v < 0.5) {
      t.v = 0;
      t.node += t.dir;
      t.lastProgress = now;
      const lastIdx = this.nodeCount() - 1;
      const isEnd = (t.node === lastIdx && t.dir > 0) || (t.node === 0 && t.dir < 0);
      if (isEnd) {
        // 折返：车尾变车头
        t.head = tailOf(t);
        t.dir = t.dir > 0 ? -1 : 1;
        t.trips++;
        t.state = 'dwell';
        this.scheduleDeparture(t, now, true);
        // 回送列车在端点站立即折返
        if (t.retire) t.departAt = now + CONFIG.ops.turnbackSec;
      } else {
        t.state = 'dwell';
        t.departAt = now + CONFIG.ops.dwellSec;
      }
    }
  }

  /** 前方限速（考虑制动距离）与车身所在处的限速 */
  private limitAhead(t: Train, decel: number): number {
    let v = Infinity;
    const len = trainLengthCells(t);
    for (let x = 0; x <= len; x += 0.5) v = Math.min(v, limitAt(this.topo, t.head - t.dir * x));
    const look = (t.v * t.v) / (2 * decel) / CELL_M + 1;
    for (let x = 0.5; x <= look; x += 0.5) {
      const lim = limitAt(this.topo, t.head + t.dir * x);
      v = Math.min(v, Math.sqrt(lim * lim + 2 * decel * x * CELL_M));
    }
    return v;
  }

  private laneAt(t: Train, x: number): string | null {
    for (const id of t.held) {
      const r = this.res[id];
      if (r.lane && x >= r.a - 1e-6 && x <= r.b + 1e-6) return r.lane;
    }
    return null;
  }

  private guard(t: Train, target: number): number {
    let limit = target;
    for (const o of this.state.trains) {
      if (o === t || o.state === 'depot' || o.state === 'leaving' || o.state === 'entering') continue;
      const lo = Math.min(o.head, tailOf(o));
      const hi = Math.max(o.head, tailOf(o));
      const near = t.dir > 0 ? lo : hi;
      // 只看前方
      if (t.dir > 0 ? near <= t.head : near >= t.head) continue;
      if (t.dir > 0 ? near > limit + 1 : near < limit - 1) continue;
      const lt = this.laneAt(t, near);
      const lo2 = this.laneAt(o, near);
      if (lt && lo2 && lt === lo2) {
        const safe = near - t.dir * 0.5;
        if (t.dir > 0 ? safe < limit : safe > limit) limit = safe;
      }
    }
    return limit;
  }

  /** 车尾完全通过的资源立即释放 */
  private releaseBehind(t: Train): void {
    const tail = tailOf(t);
    const keep: number[] = [];
    for (const id of t.held) {
      const r = this.res[id];
      const passed = t.dir > 0 ? tail > r.b + 1e-6 : tail < r.a - 1e-6;
      if (passed && r.kind !== 'lead') {
        if (r.holder === t.id) r.holder = null;
      } else keep.push(id);
    }
    t.held = keep;
  }

  // ------------------------------------------------------------ 拓扑变化

  /**
   * 线路开通新区段或新车站后换用新拓扑：
   * 按列车所在位置重新占用资源（与其他列车冲突时不占用，由物理保护兜底）。
   */
  rebind(topo: Topology): void {
    const oldTopo = this.topo;
    this.topo = topo;
    for (const t of this.state.trains) {
      if (t.state === 'depot') continue;
      const oldStation = oldTopo.nodes[t.node]?.station.id;
      t.held = [];
      if (t.state === 'leaving' || t.state === 'entering') {
        // 直接完成出入库动作
        if (t.state === 'entering') {
          t.state = 'depot';
          continue;
        }
        t.state = 'dwell';
      }
      // 最近经过（或所在）的车站节点
      let node = t.dir > 0 ? 0 : topo.nodes.length - 1;
      for (const n of topo.nodes) {
        if (t.dir > 0 && n.a <= t.head + 1e-6) node = Math.max(node, n.idx);
        if (t.dir < 0 && n.b >= t.head - 1e-6) node = Math.min(node, n.idx);
      }
      void oldStation;
      t.node = node;
      const lo = Math.min(t.head, tailOf(t));
      const hi = Math.max(t.head, tailOf(t));
      const overl = (r: Res) => r.b > lo - 1e-6 && r.a < hi + 1e-6;
      const ids: number[] = [];
      for (const n of topo.nodes) {
        if (n.b < lo || n.a > hi) continue;
        const tr = n.tracks === 1 ? n.trackRes[0] : n.trackRes[t.dir > 0 ? 0 : 1];
        ids.push(tr);
      }
      for (const l of topo.links) {
        if (l.b < lo || l.a > hi) continue;
        if (l.double) for (const id of t.dir > 0 ? l.down : l.up) if (overl(topo.res[id])) ids.push(id);
        if (!l.double && l.stretch !== null) ids.push(l.stretch);
      }
      const uniq = [...new Set(ids)].filter((id) => topo.res[id].holder === null);
      uniq.sort((a, b) => (t.dir > 0 ? topo.res[a].a - topo.res[b].a : topo.res[b].b - topo.res[a].b));
      this.take(t, uniq);
      // 停在站台上的列车保持停车状态
      const atStation = topo.nodes.find((n) => t.head >= n.a - 0.2 && t.head <= n.b + 0.2);
      if (t.state === 'dwell' && atStation) t.node = atStation.idx;
    }
  }
}

export function newOpsState(): OpsState {
  const headways: Headways = {};
  for (const p of CONFIG.ops.periods) headways[p.id] = p.headwayMin;
  return { trains: [], headways, lastSlot: [-Infinity, -Infinity], nextTrainNo: 1 };
}
