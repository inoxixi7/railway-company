import type { GridPt } from '../track/alignment';
import type { Structure } from '../track/profile';

export type StationType = 'single' | 'side' | 'island';

export const STATION_TYPE_NAMES: Record<StationType, string> = {
  single: '一面一线',
  side: '相对式',
  island: '岛式',
};

export const stationTrackCount = (t: StationType): 1 | 2 => (t === 'single' ? 1 : 2);

export interface Construction {
  /** 完工时刻（秒）；null = 已完工 */
  readyAt: number | null;
  startedAt: number;
}

/** 一次铺设的一段线路，自带纵断面 */
export interface TrackSpan {
  id: number;
  /** 起止里程（格） */
  s0: number;
  s1: number;
  tracks: 1 | 2;
  /** 纵断面采样（从 s0 起，等间距 step 格） */
  step: number;
  z: number[];
  structure: Structure[];
  cost: number;
  build: Construction;
  /** 既有终点站内的股道（由终点站模型绘制） */
  external?: boolean;
}

export interface Station {
  id: number;
  name: string;
  type: StationType;
  /** 中心里程（格） */
  s: number;
  /** 站台方向：线路在此处为东西向（'h'）或南北向（'v'） */
  orient: 'h' | 'v';
  /** 既有终点站（大城市方向）的 id；玩家建的为 null */
  externalId: string | null;
  cost: number;
  build: Construction;
}

export interface Depot {
  /** 占地（格） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 出入库线连接的车站 */
  stationId: number;
  cost: number;
  build: Construction;
}

export interface RailLine {
  /** 线路折点（格点），按里程顺序 */
  points: GridPt[];
  /** 每个折点的曲线半径（格），建成后固定 */
  radii: number[];
  spans: TrackSpan[];
  stations: Station[];
  depot: Depot | null;
}

export const isBuilt = (c: Construction, now: number): boolean => c.readyAt === null || now >= c.readyAt;
