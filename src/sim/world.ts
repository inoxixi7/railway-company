import { CONFIG } from '../config';
import { formatYen, toDate } from './calendar';
import { Land, type Quote, type Zone } from './land/land';
import { cellIndex, inBounds } from './map/query';
import { Cover, type CellRect, type MapData } from './map/types';
import {
  addDepot,
  addStation,
  applyDraft,
  depotCandidate,
  evaluateDraft,
  lineAlignment,
  railCells,
  stationCandidate,
  stationFootprint,
  type DepotCandidate,
  type Draft,
  type StationCandidate,
} from './rail/line';
import { isBuilt, type RailLine, type Station, type StationType, type TrackSpan } from './rail/types';
import { carType } from './rail/vehicles';
import { newOpsState, OpsSim, type OpsState, type Train } from './ops/sim';
import { buildTopology } from './ops/topology';
import { sampleAlignment } from './track/alignment';

export type WorldEvent =
  | { type: 'lineChanged' }
  | { type: 'terrainChanged' }
  | { type: 'landChanged'; forestCleared: boolean }
  | { type: 'opened'; what: string }
  | { type: 'notice'; text: string };

/**
 * 整个游戏状态与固定步长模拟。纯逻辑，不依赖渲染。
 */
export class World {
  time: number = CONFIG.ops.startTimeSec;
  line: RailLine | null = null;
  ops: OpsState = newOpsState();
  sim: OpsSim | null = null;
  money: number = CONFIG.economy.startMoney;
  /** 累计投资 */
  spent = 0;
  readonly land: Land;
  private nextId = 1;
  private openKey = '';
  private stationNo = 1;
  private listeners: ((e: WorldEvent) => void)[] = [];

  constructor(readonly map: MapData) {
    this.land = new Land(map);
  }

  on(fn: (e: WorldEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: WorldEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private id = () => this.nextId++;

  /** 固定步长：dt 固定为 1 秒 */
  step(): void {
    this.time += 1;
    if (this.time % 60 === 0) this.checkOpenings();
    if (this.time % 86400 === 0) this.newDay();
    this.sim?.step(this.time, 1);
  }

  private newDay(): void {
    const d = toDate(this.time);
    if (d.getUTCDate() !== 1) return;
    const r = this.land.monthly(this.time);
    if (r.changed) this.emit({ type: 'landChanged', forestCleared: r.forestCleared });
    if (d.getUTCMonth() === 0) {
      const tax = this.land.annualTax(this.time);
      if (tax > 0) {
        this.money -= tax;
        this.emit({ type: 'notice', text: `缴纳固定资产税 ${formatYen(tax)}` });
      }
    }
  }

  /** 建设类支出：同时计入累计投资 */
  private invest(amount: number): void {
    this.money -= amount;
    this.spent += amount;
  }

  /** 施工完成 → 重建运营拓扑 */
  checkOpenings(force = false): void {
    if (!this.line) return;
    const parts: string[] = [];
    for (const sp of this.line.spans) if (isBuilt(sp.build, this.time)) parts.push(`s${sp.id}`);
    for (const st of this.line.stations) if (isBuilt(st.build, this.time)) parts.push(`t${st.id}`);
    if (this.line.depot && isBuilt(this.line.depot.build, this.time)) parts.push('d');
    const key = parts.join(',');
    if (key === this.openKey && !force) return;
    const before = new Set(this.openKey.split(','));
    this.openKey = key;
    for (const p of parts) {
      if (before.has(p)) continue;
      if (p.startsWith('t')) {
        const st = this.line.stations.find((s) => `t${s.id}` === p);
        if (st && !st.externalId) this.emit({ type: 'opened', what: `${st.name}落成` });
      } else if (p === 'd') this.emit({ type: 'opened', what: '车辆基地落成' });
      else {
        const sp = this.line.spans.find((s) => `s${s.id}` === p);
        if (sp && sp.cost > 0) this.emit({ type: 'opened', what: `线路区段竣工（${((sp.s1 - sp.s0) * this.map.cellMeters / 1000).toFixed(1)} km）` });
      }
    }
    this.land.refreshTransit(this.line, this.time);
    const topo = buildTopology(this.map, this.line, this.time);
    if (!topo) {
      this.sim = null;
    } else if (this.sim) {
      this.sim.rebind(topo);
    } else {
      this.sim = new OpsSim(topo, this.ops);
    }
    this.emit({ type: 'lineChanged' });
  }

  // ------------------------------------------------------------ 指令

  evaluate(draft: Draft) {
    const ev = evaluateDraft(this.map, this.line, draft);
    if (!ev) return null;
    // shortcut: 隧道段也按地面拆迁，山地几乎没有建筑；隧道穿过城区时再区分
    ev.acquisition = this.land.quoteAcquire(railCells(this.map, ev.merged.alignment, ev.s0, ev.s1), this.time);
    if (ev.summary.cost + ev.acquisition.cost > this.money) {
      ev.issues.push({ at: null, message: '资金不足' });
      ev.ok = false;
    }
    return ev;
  }

  confirmDraft(draft: Draft): boolean {
    const ev = this.evaluate(draft);
    if (!ev || !ev.ok) return false;
    this.land.acquire(railCells(this.map, ev.merged.alignment, ev.s0, ev.s1));
    if (ev.shift && this.sim) {
      for (const t of this.ops.trains) t.head += ev.shift;
    }
    this.line = applyDraft(this.map, this.line, ev, draft.tracks, this.time, this.id);
    this.invest(ev.summary.cost + ev.acquisition!.cost);
    this.land.refreshTransit(this.line, this.time);
    this.emit({ type: 'landChanged', forestCleared: false });
    const span = this.line.spans.find((s) => s.cost === ev.summary.cost && s.build.startedAt === this.time);
    if (span) this.earthworks(span);
    // 里程整体后移时须立即重建拓扑
    this.checkOpenings(ev.shift > 0);
    this.emit({ type: 'lineChanged' });
    return true;
  }

  stationCandidate(x: number, y: number, type: StationType): StationCandidate | null {
    const c = this.line ? stationCandidate(this.map, this.line, x, y, type, this.time) : null;
    if (!c) return null;
    c.acquisition = this.land.quoteAcquire(this.land.cellsIn(stationFootprint(c, c.center)), this.time);
    c.cost += c.acquisition.cost;
    if (c.cost > this.money) {
      c.issues.push('资金不足');
      c.ok = false;
    }
    return c;
  }

  placeStation(c: StationCandidate, type: StationType): Station | null {
    if (!this.line || !c.ok) return null;
    const st = addStation(this.line, c, type, `${this.stationNo++}号站`, this.time, this.id());
    const cells = this.land.cellsIn(stationFootprint(c, c.center));
    this.land.acquire(cells);
    for (const i of cells) this.map.rail[i] = 1;
    this.invest(c.cost);
    this.emit({ type: 'landChanged', forestCleared: false });
    this.checkOpenings();
    this.emit({ type: 'lineChanged' });
    return st;
  }

  depotCandidate(st: Station, side: 1 | -1): DepotCandidate | null {
    const c = this.line ? depotCandidate(this.map, this.line, st, side) : null;
    if (!c) return null;
    c.acquisition = this.land.quoteAcquire(this.land.cellsIn(c), this.time);
    if (CONFIG.rail.depot.cost + c.acquisition.cost > this.money) {
      c.issues.push('资金不足');
      c.ok = false;
    }
    return c;
  }

  placeDepot(c: DepotCandidate): boolean {
    if (!this.line || !c.ok) return false;
    this.land.acquire(this.land.cellsIn(c));
    addDepot(this.map, this.line, c, this.time);
    this.invest(CONFIG.rail.depot.cost + (c.acquisition?.cost ?? 0));
    this.emit({ type: 'landChanged', forestCleared: false });
    this.emit({ type: 'terrainChanged' });
    this.checkOpenings();
    this.emit({ type: 'lineChanged' });
    return true;
  }

  renameStation(id: number, name: string): void {
    const st = this.line?.stations.find((s) => s.id === id);
    if (st && name.trim()) {
      st.name = name.trim().slice(0, 12);
      this.emit({ type: 'lineChanged' });
    }
  }

  /** 购买列车（交付到车辆基地） */
  buyTrain(typeId: string, cars: number): Train | string {
    const depot = this.line?.depot;
    if (!depot) return '需要先建车辆基地';
    if (!isBuilt(depot.build, this.time)) return '车辆基地尚未落成';
    const parked = this.ops.trains.filter((t) => t.state === 'depot').length;
    if (parked >= CONFIG.rail.depot.sidings) return `车辆基地留置线已满（${CONFIG.rail.depot.sidings} 条）`;
    const ct = carType(typeId);
    const n = Math.max(ct.minCars, Math.min(ct.maxCars, cars));
    if (ct.pricePerCar * n > this.money) return '资金不足';
    const no = this.ops.nextTrainNo++;
    const t: Train = {
      id: this.id(),
      name: `${no}号列车`,
      typeId,
      cars: n,
      state: 'depot',
      dir: 1,
      head: 0,
      v: 0,
      node: 0,
      held: [],
      departAt: 0,
      timer: 0,
      retire: false,
      waitSec: 0,
      trips: 0,
      lastProgress: this.time,
    };
    this.ops.trains.push(t);
    this.invest(ct.pricePerCar * n);
    this.emit({ type: 'lineChanged' });
    return t;
  }

  quoteLand(r: CellRect): Quote {
    return this.land.quoteBuy(r, this.time);
  }

  buyLand(r: CellRect): boolean {
    const q = this.quoteLand(r);
    if (!q.cells.length || q.cost > this.money) return false;
    this.land.buy(q.cells);
    this.money -= q.cost;
    this.emit({ type: 'landChanged', forestCleared: false });
    return true;
  }

  /** 返回实际改分区的格数 */
  zoneLand(r: CellRect, z: Zone): number {
    const cells = this.land.zonableCells(r);
    this.land.setZone(cells, z, this.time);
    return cells.length;
  }

  setHeadway(periodId: string, minutes: number): void {
    this.ops.headways[periodId] = Math.max(0, Math.min(120, Math.round(minutes)));
    this.emit({ type: 'lineChanged' });
  }

  /** 路堤/路堑：把线路两侧地面修整到轨道高度 */
  private earthworks(span: TrackSpan): void {
    const m = this.map;
    const al = lineAlignment(m, this.line!);
    const C = m.width + 1;
    const touched = new Map<number, { h: number; w: number }>();
    for (let i = 0; i < span.z.length; i++) {
      if (span.structure[i] !== 'ground') continue;
      const s = span.s0 + i * span.step;
      const p = sampleAlignment(al, s);
      const formation = span.z[i] - 0.6;
      const R = 3;
      for (let y = Math.floor(p.y - R); y <= Math.ceil(p.y + R); y++) {
        for (let x = Math.floor(p.x - R); x <= Math.ceil(p.x + R); x++) {
          if (x < 0 || y < 0 || x > m.width || y > m.height) continue;
          const d = Math.hypot(x - p.x, y - p.y);
          if (d > R) continue;
          // 1 格内完全整平，之外线性过渡（坡面）
          const w = d <= 1 ? 1 : 1 - (d - 1) / (R - 1);
          const k = y * C + x;
          const prev = touched.get(k);
          if (!prev || w > prev.w) touched.set(k, { h: formation, w });
        }
      }
    }
    for (const [k, { h, w }] of touched) {
      const x = k % C;
      const y = Math.floor(k / C);
      // 不改动水边
      let nearWater = false;
      for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        if (inBounds(m, x + dx, y + dy) && m.cover[cellIndex(m, x + dx, y + dy)] === Cover.Water) nearWater = true;
      }
      if (nearWater) continue;
      m.heights[k] = m.heights[k] + (h - m.heights[k]) * w;
    }
    this.emit({ type: 'terrainChanged' });
  }
}
