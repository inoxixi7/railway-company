import { CONFIG } from '../config';
import type { MapData } from '../sim/map/types';

/** 世界坐标：X = 格 x，Z = 格 y，Y = 米 / 每格米数 × 垂直倍数 */
export const metersToY = (m: MapData, meters: number): number => (meters / m.cellMeters) * CONFIG.render.verticalScale;
export const yToMeters = (m: MapData, y: number): number => (y / CONFIG.render.verticalScale) * m.cellMeters;
