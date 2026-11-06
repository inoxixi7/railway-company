import type * as THREE from 'three';
import { surfaceHeight } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import { metersToY } from './coords';

/**
 * 沿射线在高度图上步进，求与地表（含水面）的交点。
 * 比对 13 万个三角形做射线检测快得多。
 */
export function pickGround(m: MapData, origin: THREE.Vector3, dir: THREE.Vector3): { x: number; z: number } | null {
  const maxY = metersToY(m, 400);
  // 先把射线推进到 maxY 平面
  if (dir.y >= 0) return null;
  let t = Math.max(0, (origin.y - maxY) / -dir.y);
  const step = 0.25 / Math.max(0.2, Math.hypot(dir.x, dir.z));
  const h = (tt: number) => {
    const x = origin.x + dir.x * tt;
    const z = origin.z + dir.z * tt;
    return { x, z, above: origin.y + dir.y * tt - metersToY(m, surfaceHeight(m, x, z)) };
  };
  for (let i = 0; i < 20000; i++) {
    const nt = t + step;
    const cur = h(nt);
    if (cur.above <= 0) {
      // 二分细化
      let lo = t;
      let hi = nt;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (h(mid).above > 0) lo = mid;
        else hi = mid;
      }
      const p = h(hi);
      if (p.x < 0 || p.z < 0 || p.x >= m.width || p.z >= m.height) return null;
      return { x: p.x, z: p.z };
    }
    t = nt;
    if (origin.y + dir.y * t < metersToY(m, -50)) break;
  }
  return null;
}
