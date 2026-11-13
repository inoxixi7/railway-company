/**
 * 地图数据格式。全部为普通数组/类型化数组，可序列化；
 * 将来导入真实地图时只需产出同样的结构。
 *
 * 坐标：x 向东，y 向南，单位为格。格 (cx, cy) 覆盖 [cx, cx+1) × [cy, cy+1)。
 * 高度存于格点（(width+1)×(height+1)），单位米。
 */
export enum Cover {
  Grass = 0,
  Forest = 1,
  Farmland = 2,
  Water = 3,
  Town = 4,
  /** 既有车站等设施占用 */
  Facility = 5,
}

export const COVER_NAMES: Record<Cover, string> = {
  [Cover.Grass]: '草地',
  [Cover.Forest]: '森林',
  [Cover.Farmland]: '农田',
  [Cover.Water]: '河流',
  [Cover.Town]: '城镇',
  [Cover.Facility]: '设施',
};

export enum RoadKind {
  None = 0,
  Road = 1,
  Bridge = 2,
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 地图外大城市方向的既有终点站 */
export interface ExternalTerminal {
  id: string;
  name: string;
  /** 占地 */
  rect: CellRect;
  /** 站台数 */
  platforms: number;
  /** 地面高度（米） */
  elevation: number;
  /** 线路接入方向：玩家从这一侧接线 */
  connectSide: 'west';
  /** 接线点（格点）：玩家的线路须从西向东到达这里 */
  entry: { x: number; y: number };
}

export interface MapData {
  version: 1;
  name: string;
  width: number;
  height: number;
  cellMeters: number;
  /** 格点高度（米），长度 (width+1)*(height+1)，索引 y*(width+1)+x */
  heights: Float32Array;
  /** 每格地表类型，长度 width*height */
  cover: Uint8Array;
  /** 每格水面高度（米），无水为 NaN */
  waterLevel: Float32Array;
  /** 每格道路（占地，用于规则判断） */
  roads: Uint8Array;
  /** 道路中心线（格坐标，用于绘制平滑道路；导入真实地图时即道路折线） */
  roadLines: { x: number; y: number }[][];
  /** 河流中心线（格坐标）与各点水面高度（米），用于绘制平滑水面；导入真实地图时即河流折线 */
  rivers: { halfWidth: number; points: { x: number; y: number; level: number }[] }[];
  terminals: ExternalTerminal[];
  /** 每格是否被铁路占用（线路、车站、车辆基地） */
  rail: Uint8Array;
}
