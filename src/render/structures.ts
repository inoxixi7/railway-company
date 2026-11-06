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

  // 股道：中心线 y+1.5 与 y+3.5（格），从站西端一直延伸到地图东边缘
  const tracks = [y + 1.5, y + 3.5];
  for (const tz of tracks) {
    box(w, 0.06, 0.32, x + w / 2, base + 0.03, tz, ballast);
    // 1067 mm 轨距 ≈ 0.053 格
    for (const off of [-0.027, 0.027]) box(w, 0.03, 0.012, x + w / 2, base + 0.075, tz + off, rail);
    // 车挡在西端以外不设：玩家从西端接线
  }
  // 岛式站台：6 节编组 120 m = 6 格，高约 1.1 m
  const platLen = 6;
  const platX = x + w - platLen / 2 - 1;
  const ph = metersToY(m, 1.1);
  box(platLen, ph, 1.2, platX, base + ph / 2, y + 2.5, platformMat);
  // 站台雨棚
  box(platLen - 0.6, 0.03, 1.0, platX, base + ph + 0.18, y + 2.5, roofMat);
  // 站房（北侧）
  box(4, 0.45, 0.9, x + w - 2.5, base + 0.225, y + 0.5, wallMat);
  box(4.1, 0.05, 1.0, x + w - 2.5, base + 0.47, y + 0.5, roofMat);
  return g;
}
