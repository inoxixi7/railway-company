import { Cover, type MapData } from './types';

export const cornerIndex = (m: MapData, x: number, y: number): number => y * (m.width + 1) + x;
export const cellIndex = (m: MapData, x: number, y: number): number => y * m.width + x;

export function inBounds(m: MapData, cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < m.width && cy < m.height;
}

export function cornerHeight(m: MapData, x: number, y: number): number {
  const cx = Math.max(0, Math.min(m.width, x));
  const cy = Math.max(0, Math.min(m.height, y));
  return m.heights[cornerIndex(m, cx, cy)];
}

/**
 * 任意位置的地面高度（米）。与渲染的三角剖分一致：
 * 每格沿 (x,y)-(x+1,y+1) 对角线切成两个三角形。
 */
export function groundHeight(m: MapData, x: number, y: number): number {
  const fx = Math.max(0, Math.min(m.width - 1e-6, x));
  const fy = Math.max(0, Math.min(m.height - 1e-6, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = cornerHeight(m, x0, y0);
  const h10 = cornerHeight(m, x0 + 1, y0);
  const h01 = cornerHeight(m, x0, y0 + 1);
  const h11 = cornerHeight(m, x0 + 1, y0 + 1);
  if (tx >= ty) return h00 + (h10 - h00) * tx + (h11 - h10) * ty;
  return h00 + (h11 - h01) * tx + (h01 - h00) * ty;
}

/** 地表（含水面）高度 */
export function surfaceHeight(m: MapData, x: number, y: number): number {
  const g = groundHeight(m, x, y);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (inBounds(m, cx, cy)) {
    const w = m.waterLevel[cellIndex(m, cx, cy)];
    if (!Number.isNaN(w) && w > g) return w;
  }
  return g;
}

export interface CellInfo {
  x: number;
  y: number;
  cover: Cover;
  /** 平均海拔（米） */
  elevation: number;
  /** 最大坡度（‰） */
  slopePermil: number;
  waterLevel: number | null;
  road: number;
}

export function cellInfo(m: MapData, cx: number, cy: number): CellInfo {
  const h00 = cornerHeight(m, cx, cy);
  const h10 = cornerHeight(m, cx + 1, cy);
  const h01 = cornerHeight(m, cx, cy + 1);
  const h11 = cornerHeight(m, cx + 1, cy + 1);
  const gx = Math.max(Math.abs(h10 - h00), Math.abs(h11 - h01));
  const gy = Math.max(Math.abs(h01 - h00), Math.abs(h11 - h10));
  const i = cellIndex(m, cx, cy);
  const w = m.waterLevel[i];
  return {
    x: cx,
    y: cy,
    cover: m.cover[i] as Cover,
    elevation: (h00 + h10 + h01 + h11) / 4,
    slopePermil: (Math.max(gx, gy) / m.cellMeters) * 1000,
    waterLevel: Number.isNaN(w) ? null : w,
    road: m.roads[i],
  };
}
