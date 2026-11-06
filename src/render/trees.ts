import * as THREE from 'three';
import { hash2 } from '../sim/rng';
import { cellIndex, groundHeight } from '../sim/map/query';
import { Cover, type MapData } from '../sim/map/types';
import { metersToY } from './coords';

/** 森林：低多边形树，实例化绘制（一次 draw call） */
export function buildTrees(m: MapData): THREE.InstancedMesh {
  const spots: { x: number; z: number; s: number; tint: number }[] = [];
  for (let cy = 0; cy < m.height; cy++) {
    for (let cx = 0; cx < m.width; cx++) {
      if (m.cover[cellIndex(m, cx, cy)] !== Cover.Forest) continue;
      const count = hash2(cx, cy, 21) > 0.5 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        spots.push({
          x: cx + 0.2 + hash2(cx, cy, 31 + k) * 0.6,
          z: cy + 0.2 + hash2(cx, cy, 41 + k) * 0.6,
          s: 0.75 + hash2(cx, cy, 51 + k) * 0.5,
          tint: hash2(cx, cy, 61 + k),
        });
      }
    }
  }
  // 树高约 10 m（0.5 格），底部在原点
  const geo = new THREE.ConeGeometry(0.32, 0.6, 6, 1);
  geo.translate(0, 0.3, 0);
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  spots.forEach((p, i) => {
    const y = metersToY(m, groundHeight(m, p.x, p.z)) - 0.02;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.tint * Math.PI);
    mtx.compose(new THREE.Vector3(p.x, y, p.z), q, new THREE.Vector3(p.s, p.s * (0.9 + p.tint * 0.4), p.s));
    mesh.setMatrixAt(i, mtx);
    color.setHSL(0.27 + p.tint * 0.06, 0.45, 0.24 + p.tint * 0.08);
    mesh.setColorAt(i, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = 'trees';
  return mesh;
}
