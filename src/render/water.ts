import * as THREE from 'three';
import { cellIndex } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import { metersToY } from './coords';

/** 每个水格一块水面四边形，按格的水面高度放置（合并成一个网格） */
export function buildWaterMesh(m: MapData): THREE.Mesh {
  const verts: number[] = [];
  for (let cy = 0; cy < m.height; cy++) {
    for (let cx = 0; cx < m.width; cx++) {
      const wl = m.waterLevel[cellIndex(m, cx, cy)];
      if (Number.isNaN(wl)) continue;
      const y = metersToY(m, wl);
      verts.push(cx, y, cy, cx, y, cy + 1, cx + 1, y, cy + 1, cx, y, cy, cx + 1, y, cy + 1, cx + 1, y, cy);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: 0x4f93cf });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  return mesh;
}
