import * as THREE from 'three';
import type { ExternalTerminal, MapData } from '../sim/map/types';
import { metersToY } from './coords';

/**
 * 东侧既有终点站：两条股道（东西向，向东通往地图外的大城市）、一座岛式站台、站房。
 * 西侧是玩家接线的一端。
 */
export function buildTerminal(m: MapData, t: ExternalTerminal): THREE.Group {
  const g = new THREE.Group();
  g.name = `terminal:${t.id}`;
  const base = metersToY(m, t.elevation);
  const { x, y, w } = t.rect;

  const ballast = new THREE.MeshLambertMaterial({ color: 0x8a8279 });
  const rail = new THREE.MeshLambertMaterial({ color: 0x4a4440 });
  const platformMat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a6f86 });
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xe9e2d2 });

  const box = (sx: number, sy: number, sz: number, px: number, py: number, pz: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    mesh.position.set(px, py, pz);
    g.add(mesh);
  };

  // 岛式：两条股道在中心线 ±0.3 格（东西向，向东通往地图外）；西端为玩家接线点
  const cy = t.entry.y;
  for (const off of [-0.3, 0.3]) {
    const tz = cy + off;
    box(w, 0.06, 0.16, x + w / 2, base + 0.03, tz, ballast);
    // 1067 mm 轨距 ≈ 0.053 格
    for (const r of [-0.027, 0.027]) box(w, 0.03, 0.012, x + w / 2, base + 0.075, tz + r, rail);
  }
  // 岛式站台：6 节编组 120 m = 6 格，高 1.1 m（物体不做高度放大），位于东侧
  const platLen = 6;
  const platX = x + w - platLen / 2 - 1;
  const ph = 1.1 / m.cellMeters;
  box(platLen, ph, 0.4, platX, base + ph / 2, cy, platformMat);
  box(platLen - 0.6, 0.02, 0.36, platX, base + ph + 0.17, cy, roofMat);
  // 站房（北侧）
  box(4, 0.4, 0.9, x + w - 2.5, base + 0.2, y + 0.5, wallMat);
  box(4.1, 0.04, 1.0, x + w - 2.5, base + 0.42, y + 0.5, roofMat);
  return g;
}
