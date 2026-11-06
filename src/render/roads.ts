import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cellIndex, groundHeight } from '../sim/map/query';
import { RoadKind, type MapData } from '../sim/map/types';
import { metersToY } from './coords';

/** 道路宽约 8 m */
const HALF_WIDTH = 0.2;

/** 沿道路中心线生成贴地的带状网格；过河处抬到桥面高度并加桥墩 */
export function buildRoads(m: MapData): THREE.Group {
  const verts: number[] = [];
  const piers: THREE.BufferGeometry[] = [];
  for (const line of m.roadLines) {
    const pts = resample(line, 0.5);
    // 每个中心线采样点的高度：周围 1 格内有水 → 桥面高度，否则贴地
    const deck = (x: number, y: number): number | null => {
      let wl = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = Math.floor(x) + dx;
          const cy = Math.floor(y) + dy;
          if (cx < 0 || cy < 0 || cx >= m.width || cy >= m.height) continue;
          const w = m.waterLevel[cellIndex(m, cx, cy)];
          if (!Number.isNaN(w)) wl = Math.max(wl, w);
        }
      }
      return wl === -Infinity ? null : metersToY(m, wl + 2.5);
    };
    const heights = pts.map((p) => {
      const ground = metersToY(m, groundHeight(m, p.x, p.y)) + 0.025;
      const d = deck(p.x, p.y);
      return d === null ? ground : Math.max(ground, d);
    });
    pts.forEach((p, i) => {
      const cx = Math.floor(p.x);
      const cy = Math.floor(p.y);
      if (i % 3 !== 0 || cx < 0 || cy < 0 || cx >= m.width || cy >= m.height) return;
      const k = cellIndex(m, cx, cy);
      if (m.roads[k] !== RoadKind.Bridge) return;
      const top = metersToY(m, m.waterLevel[k] + 2.5);
      const bottom = metersToY(m, m.waterLevel[k] - 1.5);
      const g = new THREE.BoxGeometry(0.1, top - bottom, 0.1);
      g.translate(p.x, (top + bottom) / 2, p.y);
      piers.push(g);
    });
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * HALF_WIDTH;
      const ny = (dx / len) * HALF_WIDTH;
      const ha = heights[i];
      const hb = heights[i + 1];
      const p = [
        [a.x + nx, ha, a.y + ny],
        [a.x - nx, ha, a.y - ny],
        [b.x - nx, hb, b.y - ny],
        [b.x + nx, hb, b.y + ny],
      ];
      // 两个三角形（法线朝上）
      for (const k of [0, 2, 1, 0, 3, 2]) verts.push(...p[k]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: 0x6a6866, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  const group = new THREE.Group();
  group.name = 'roads';
  group.add(new THREE.Mesh(geo, mat));
  if (piers.length) group.add(new THREE.Mesh(mergeGeometries(piers), new THREE.MeshLambertMaterial({ color: 0x9a958c })));
  return group;
}

function resample(line: { x: number; y: number }[], step: number): { x: number; y: number }[] {
  const out = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}
