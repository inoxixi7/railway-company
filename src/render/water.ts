import * as THREE from 'three';
import type { MapData } from '../sim/map/types';
import { metersToY } from './coords';

/** 水面比河道本身宽出的量（格）：岸坡挡住多余的部分，岸线由地形与水面相交得到 */
const MARGIN = 1.6;

/**
 * 水面：沿每条河的中心线生成平滑的带状网格，高度取各点的水面高度。
 * 不再按格画方块，岸线不会出现锯齿。
 */
export function buildWaterMesh(m: MapData): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const river of m.rivers) {
    const pts = river.points;
    const half = river.halfWidth + MARGIN;
    const start = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      const y = metersToY(m, pts[i].level);
      pos.push(pts[i].x + nx * half, y, pts[i].y + ny * half, pts[i].x - nx * half, y, pts[i].y - ny * half);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const k = start + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x4a8fc9, side: THREE.DoubleSide }));
  mesh.name = 'water';
  return mesh;
}
