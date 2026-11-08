import { CONFIG } from '../../config';
import { MONTH_SEC, YEAR_SEC } from '../calendar';
import { cellIndex, cellInfo, inBounds } from '../map/query';
import { Cover, type CellRect, type MapData } from '../map/types';
import { isBuilt, type RailLine } from '../rail/types';
import { lineAlignment } from '../rail/line';
import { hash2 } from '../rng';
import { sampleAlignment } from '../track/alignment';

export enum Owner {
  None = 0,
  Player = 1,
  Citizen = 2,
}

export enum Zone {
  None = 0,
  Residential = 1,
  Commercial = 2,
  Industrial = 3,
}

export const ZONE_NAMES: Record<Zone, string> = {
  [Zone.None]: '未分区',
  [Zone.Residential]: '住宅',
  [Zone.Commercial]: '商业',
  [Zone.Industrial]: '工业',
};

export const LEVEL_NAMES = ['低', '中', '高'];

export type Level = 0 | 1 | 2;

/** 建筑名称：[用途][经济水平][占地 1×1, 2×2] */
const BUILDING_NAMES: Record<number, string[][]> = {
  [Zone.Residential]: [['木造住宅', '木造住宅'], ['独栋住宅', '中层公寓'], ['带庭院的大宅', '公寓团地']],
  [Zone.Commercial]: [['商店街小铺', '商店街小铺'], ['杂居楼', '杂居大楼'], ['办公楼', '百货店']],
  [Zone.Industrial]: [['町工厂', '町工厂'], ['小仓库', '物流仓库'], ['工厂', '大型工厂']],
};

export interface Building {
  id: number;
  x: number;
  y: number;
  /** 边长（格）：1 或 2 */
  size: 1 | 2;
  use: Exclude<Zone, Zone.None>;
  level: Level;
  /** 外观随机种子 */
  seed: number;
  builtAt: number;
  /** 建在玩家土地上（否则为市民自建） */
  player: boolean;
}

export const buildingName = (b: Building): string => BUILDING_NAMES[b.use][b.level][b.size - 1];

/** 容量：住宅为人口，商业、工业为岗位 */
export const buildingCapacity = (b: Building): number => P.capacityPerCell[b.use - 1][b.level] * b.size * b.size;

export interface Quote {
  cells: number[];
  cost: number;
}

/** 铁路用地要拆除的建筑 */
export interface Acquisition {
  /** 需补偿的市民建筑数 */
  citizen: number;
  /** 玩家自己的建筑数（不补偿） */
  own: number;
  cost: number;
}

const YEAR = YEAR_SEC;
const DAY = 86400;
const P = CONFIG.land;

/** 土地、分区、建筑。所有数据为普通数组，方便第 5 步存档。 */
export class Land {
  readonly owner: Uint8Array;
  readonly zone: Uint8Array;
  /** 分区日期（第几天） */
  readonly zonedDay: Int32Array;
  readonly buildingAt: Int32Array;
  /** 周边建筑数，用于「开发成熟」地价加成 */
  readonly dev: Uint8Array;
  /** 铁路带来的地价倍数 */
  readonly transit: Float32Array;
  /** 到最近的已开通车站的距离（格），远于 farCells 时为 Infinity */
  readonly stationDist: Float32Array;
  readonly roadNear: Uint8Array;
  readonly buildings = new Map<number, Building>();
  private nextId = 1;

  constructor(readonly map: MapData) {
    const n = map.width * map.height;
    this.owner = new Uint8Array(n);
    this.zone = new Uint8Array(n);
    this.zonedDay = new Int32Array(n);
    this.buildingAt = new Int32Array(n);
    this.dev = new Uint8Array(n);
    this.transit = new Float32Array(n).fill(1);
    this.stationDist = new Float32Array(n).fill(Infinity);
    this.roadNear = new Uint8Array(n);
    const R = P.accessRoadCells;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.roads[cellIndex(map, x, y)]) continue;
        this.stamp(x, y, R, (i) => (this.roadNear[i] = 1));
      }
    }
    this.seedTown();
  }

  /** 起点小镇的既有房屋 */
  private seedTown(): void {
    const m = this.map;
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const i = cellIndex(m, x, y);
        if (m.cover[i] !== Cover.Town || m.roads[i] || hash2(x, y, 71) > P.townDensity) continue;
        const roadside = x > 0 && y > 0 && [i - 1, i + 1, i - m.width, i + m.width].some((k) => m.roads[k]);
        const use = roadside && hash2(x, y, 72) < 0.6 ? Zone.Commercial : Zone.Residential;
        this.owner[i] = Owner.Citizen;
        this.addBuilding(x, y, 1, use, hash2(x, y, 73) < 0.25 ? 1 : 0, 0, false);
      }
    }
  }

  private stamp(cx: number, cy: number, r: number, fn: (i: number, d: number) => void): void {
    const m = this.map;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(m.height - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(m.width - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) fn(cellIndex(m, x, y), d);
      }
    }
  }

  private addBuilding(x: number, y: number, size: 1 | 2, use: Building['use'], level: Level, now: number, player: boolean): Building {
    const b: Building = { id: this.nextId++, x, y, size, use, level, seed: hash2(x, y, now % 9973), builtAt: now, player };
    this.buildings.set(b.id, b);
    for (const i of this.cellsIn({ x, y, w: size, h: size })) this.buildingAt[i] = b.id;
    this.bumpDev(x, y, 1);
    return b;
  }

  private removeBuilding(b: Building): void {
    this.buildings.delete(b.id);
    for (const i of this.cellsIn({ x: b.x, y: b.y, w: b.size, h: b.size })) {
      this.buildingAt[i] = 0;
      if (!b.player) this.owner[i] = Owner.None;
    }
    this.bumpDev(b.x, b.y, -1);
  }

  private bumpDev(x: number, y: number, d: number): void {
    this.stamp(x + 0.5, y + 0.5, P.devRadiusCells, (i) => (this.dev[i] = Math.max(0, Math.min(255, this.dev[i] + d))));
  }

  cellsIn(r: CellRect): number[] {
    const m = this.map;
    const out: number[] = [];
    for (let y = Math.floor(r.y); y < Math.ceil(r.y + r.h); y++) {
      for (let x = Math.floor(r.x); x < Math.ceil(r.x + r.w); x++) {
        if (inBounds(m, x, y)) out.push(cellIndex(m, x, y));
      }
    }
    return out;
  }

  /** 每格地价（円） */
  price(i: number, now: number): number {
    const base = P.basePriceByCover[this.map.cover[i]] ?? 0;
    const mature = 1 + P.devBonus * Math.min(1, this.dev[i] / P.devFullCount);
    return base * this.transit[i] * mature * (1 + P.annualGrowth) ** (now / YEAR);
  }

  /** 距离衰减：near 以内 1，far 以外 0 */
  private falloff(d: number): number {
    return Math.max(0, Math.min(1, (P.farCells - d) / (P.farCells - P.nearCells)));
  }

  /** 线路公布、车站开通后重算（草案阶段不调用，所以草案是保密的） */
  refreshTransit(line: RailLine | null, now: number): void {
    this.transit.fill(1);
    this.stationDist.fill(Infinity);
    if (!line) return;
    const al = lineAlignment(this.map, line);
    const raise = (x: number, y: number, peak: number) =>
      this.stamp(x, y, P.farCells, (i, d) => {
        this.transit[i] = Math.max(this.transit[i], 1 + (peak - 1) * this.falloff(d));
      });
    for (let s = 0; s <= al.length; s += 4) {
      const p = sampleAlignment(al, s);
      raise(p.x, p.y, P.announcedPeak);
    }
    for (const st of line.stations) {
      if (!isBuilt(st.build, now)) continue;
      const p = sampleAlignment(al, st.s);
      raise(p.x, p.y, P.stationPeak);
      this.stamp(p.x, p.y, P.farCells, (i, d) => (this.stationDist[i] = Math.min(this.stationDist[i], d)));
    }
  }

  private buyable(i: number): boolean {
    const m = this.map;
    const c = m.cover[i];
    return this.owner[i] === Owner.None && !m.rail[i] && !m.roads[i] && c !== Cover.Water && c !== Cover.Facility;
  }

  quoteBuy(r: CellRect, now: number): Quote {
    const cells = this.cellsIn(r).filter((i) => this.buyable(i));
    return { cells, cost: cells.reduce((sum, i) => sum + this.price(i, now), 0) };
  }

  buy(cells: number[]): void {
    for (const i of cells) if (this.buyable(i)) this.owner[i] = Owner.Player;
  }

  private buildable(i: number): boolean {
    const m = this.map;
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    return cellInfo(m, x, y).slopePermil <= P.buildableSlopePermil;
  }

  /** 可以改分区的格子：自己的地、没有建筑、不太陡 */
  zonableCells(r: CellRect): number[] {
    return this.cellsIn(r).filter((i) => this.owner[i] === Owner.Player && !this.buildingAt[i] && this.buildable(i));
  }

  setZone(cells: number[], z: Zone, now: number): void {
    const day = Math.floor(now / DAY);
    for (const i of cells) {
      this.zone[i] = z;
      this.zonedDay[i] = day;
    }
  }

  private levelFor(i: number, now: number): Level {
    const [mid, high] = P.levelPrices;
    const p = this.price(i, now);
    return p >= high ? 2 : p >= mid ? 1 : 0;
  }

  /** 拆除这些格子上的建筑的补偿报价 */
  quoteAcquire(cells: Iterable<number>, now: number): Acquisition {
    const seen = new Set<number>();
    const q: Acquisition = { citizen: 0, own: 0, cost: 0 };
    for (const i of cells) {
      const id = this.buildingAt[i];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const b = this.buildings.get(id)!;
      if (b.player) q.own++;
      else {
        q.citizen++;
        q.cost += b.size * b.size * this.price(i, now) * P.compensationRate;
      }
    }
    return q;
  }

  /** 铁路用地：拆除建筑，并收回格子的所有权和分区 */
  acquire(cells: Iterable<number>): void {
    for (const i of cells) {
      const b = this.buildings.get(this.buildingAt[i]);
      if (b) this.removeBuilding(b);
      this.owner[i] = Owner.None;
      this.zone[i] = Zone.None;
    }
  }

  /** 每月一次的生长；返回是否有变化、是否砍伐了森林 */
  monthly(now: number): { changed: boolean; forestCleared: boolean } {
    const m = this.map;
    const month = Math.floor(now / MONTH_SEC);
    const day = Math.floor(now / DAY);
    const roll = (x: number, y: number, k: number) => hash2(x, y, month * 8 + k);
    let changed = false;
    let forestCleared = false;

    // 玩家分区上的新建筑
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const i = cellIndex(m, x, y);
        const use = this.zone[i] as Zone;
        if (use === Zone.None || this.buildingAt[i] || day - this.zonedDay[i] < P.zoneDelayDays) continue;
        const dist = this.stationDist[i];
        if (dist === Infinity && !this.roadNear[i]) continue;
        const rate = dist <= P.goodStationCells ? P.growthPerMonth : P.growthPerMonth * P.farGrowthFactor;
        if (roll(x, y, 1) >= rate) continue;
        const level = this.levelFor(i, now);
        const size = level >= 1 && roll(x, y, 2) < P.twoByTwoChance && this.fits2x2(x, y, use) ? 2 : 1;
        for (const k of this.cellsIn({ x, y, w: size, h: size })) {
          if (m.cover[k] === Cover.Forest) {
            m.cover[k] = Cover.Grass;
            forestCleared = true;
          }
        }
        this.addBuilding(x, y, size, use as Building['use'], level, now, true);
        changed = true;
      }
    }

    // 地价上涨后的重建
    for (const b of this.buildings.values()) {
      if (b.level >= 2 || now - b.builtAt < P.upgradeAgeYears * YEAR) continue;
      if (this.levelFor(cellIndex(m, b.x, b.y), now) <= b.level || roll(b.x, b.y, 3) >= P.upgradePerMonth) continue;
      b.level = (b.level + 1) as Level;
      b.builtAt = now;
      b.seed = hash2(b.x, b.y, month);
      changed = true;
    }

    // 市民自建：城镇边缘与道路沿线
    const spots: { i: number; r: number }[] = [];
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const i = cellIndex(m, x, y);
        if (!this.buyable(i) || m.cover[i] === Cover.Forest) continue;
        if (!this.roadNear[i] && !this.dev[i]) continue;
        if (this.buildable(i)) spots.push({ i, r: roll(x, y, 4) });
      }
    }
    spots.sort((a, b) => a.r - b.r);
    for (const { i } of spots.slice(0, P.naturalPerMonth)) {
      const x = i % m.width;
      const y = Math.floor(i / m.width);
      this.owner[i] = Owner.Citizen;
      const use = this.roadNear[i] && roll(x, y, 5) < P.naturalCommercialChance ? Zone.Commercial : Zone.Residential;
      this.addBuilding(x, y, 1, use, Math.min(1, this.levelFor(i, now)) as Level, now, false);
      changed = true;
    }
    return { changed, forestCleared };
  }

  private fits2x2(x: number, y: number, use: Zone): boolean {
    const cells = this.cellsIn({ x, y, w: 2, h: 2 });
    return cells.length === 4 && cells.every((i) => this.zone[i] === use && !this.buildingAt[i] && this.owner[i] === Owner.Player);
  }

  /** 年度固定资产税 */
  annualTax(now: number): number {
    let sum = 0;
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === Owner.Player) sum += this.price(i, now);
    return sum * P.taxRate;
  }

  stats(): { ownedCells: number; buildings: number; population: number; jobs: number } {
    let ownedCells = 0;
    for (const o of this.owner) if (o === Owner.Player) ownedCells++;
    let population = 0;
    let jobs = 0;
    for (const b of this.buildings.values()) {
      const n = buildingCapacity(b);
      if (b.use === Zone.Residential) population += n;
      else jobs += n;
    }
    return { ownedCells, buildings: this.buildings.size, population, jobs };
  }
}
