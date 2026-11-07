import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from '../sim/rng';
import { Owner, Zone, type Building, type Land } from '../sim/land/land';
import { cornerHeight, groundHeight } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import { metersToY } from './coords';

/** 一层楼高（世界单位）：3 m，含垂直放大 */
const FLOOR = 0.3;

const COLOR = {
  plot: 0xa89f8c,
  garden: 0x72945b,
  wood: 0xa98660,
  plaster: 0xe2d7c1,
  mortar: 0xcdc5b6,
  concrete: 0xc0c3c0,
  brick: 0xa8654d,
  tile: 0x4b5058,
  tileBlue: 0x41586e,
  tin: 0x8c6e58,
  metal: 0x9ba4a9,
  glass: 0x3e5367,
  awning: 0xc4553f,
  sign: 0xe5b23f,
};

function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}

/** 底面中心在 (x, y0, z) 的长方体 */
function box(x: number, y0: number, z: number, w: number, h: number, d: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y0 + h / 2, z);
  return paint(g, color);
}

/** 人字屋顶：屋脊沿 X 方向 */
function gable(x: number, y0: number, z: number, w: number, h: number, d: number, color: number): THREE.BufferGeometry {
  const [l, r, f, b] = [x - w / 2, x + w / 2, z + d / 2, z - d / 2];
  const t = y0 + h;
  // prettier-ignore
  const p = [
    l,y0,f, r,y0,f, r,t,z,  l,y0,f, r,t,z, l,t,z,
    r,y0,b, l,y0,b, l,t,z,  r,y0,b, l,t,z, r,t,z,
    l,y0,b, l,y0,f, l,t,z,
    r,y0,f, r,y0,b, r,t,z,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
  g.computeVertexNormals();
  return paint(g, color);
}

/** 楼层窗带：比墙略大一圈的深色薄盒 */
function windows(x: number, z: number, w: number, d: number, floors: number, y0 = 0): THREE.BufferGeometry[] {
  const out = [];
  for (let i = 0; i < floors; i++) out.push(box(x, y0 + (i + 0.4) * FLOOR, z, w + 0.02, FLOOR * 0.38, d + 0.02, COLOR.glass));
  return out;
}

const plot = (size: number, color: number = COLOR.plot) => box(0, -0.6, 0, size - 0.04, 0.62, size - 0.04, color);

function sawtooth(x: number, z: number, w: number, d: number, y0: number, n: number): THREE.BufferGeometry[] {
  const out = [];
  for (let i = 0; i < n; i++) out.push(gable(x, y0, z + (i - (n - 1) / 2) * (d / n), w, 0.2, d / n, COLOR.tin));
  return out;
}

/** 18 种昭和建筑（3 用途 × 3 经济水平 × 2 占地），按部件拼出 */
function shape(use: Building['use'], level: number, size: number): THREE.BufferGeometry[] {
  if (use === Zone.Residential) {
    if (size === 1) {
      if (level === 0) return [plot(1), box(0, 0, 0, 0.62, FLOOR, 0.52, COLOR.wood), gable(0, FLOOR, 0, 0.72, 0.2, 0.64, COLOR.tile)];
      if (level === 1) return [plot(1), box(0, 0, 0, 0.66, FLOOR * 2, 0.56, COLOR.plaster), gable(0, FLOOR * 2, 0, 0.76, 0.2, 0.68, COLOR.tileBlue)];
      return [plot(1, COLOR.garden), box(-0.08, 0, 0, 0.62, FLOOR * 2, 0.6, COLOR.mortar), gable(-0.08, FLOOR * 2, 0, 0.74, 0.22, 0.72, COLOR.tile), box(0.32, 0, 0.1, 0.24, FLOOR, 0.3, COLOR.wood)];
    }
    if (level <= 1) return [plot(2), box(0, 0, 0, 1.6, FLOOR * 4, 0.7, COLOR.concrete), ...windows(0, 0, 1.6, 0.7, 4), box(0, FLOOR * 4, 0, 1.64, 0.04, 0.74, COLOR.mortar)];
    return [plot(2, COLOR.garden), box(0, 0, -0.42, 1.6, FLOOR * 5, 0.56, COLOR.concrete), ...windows(0, -0.42, 1.6, 0.56, 5), box(0, 0, 0.42, 1.6, FLOOR * 5, 0.56, COLOR.concrete), ...windows(0, 0.42, 1.6, 0.56, 5)];
  }
  if (use === Zone.Commercial) {
    if (size === 1) {
      if (level === 0) return [plot(1), box(0, 0, 0, 0.8, FLOOR * 2, 0.7, COLOR.mortar), ...windows(0, 0, 0.8, 0.7, 1, FLOOR), box(0, FLOOR * 0.8, 0.42, 0.8, 0.05, 0.2, COLOR.awning), box(0, FLOOR * 2, 0.3, 0.7, 0.14, 0.04, COLOR.sign)];
      if (level === 1) return [plot(1), box(0, 0, 0, 0.84, FLOOR * 3, 0.8, COLOR.brick), ...windows(0, 0, 0.84, 0.8, 3), box(0.3, FLOOR * 3, 0.4, 0.06, 0.34, 0.2, COLOR.sign)];
      return [plot(1), box(0, 0, 0, 0.84, FLOOR * 6, 0.84, COLOR.concrete), ...windows(0, 0, 0.84, 0.84, 6), box(0, FLOOR * 6, 0, 0.5, 0.16, 0.5, COLOR.metal)];
    }
    if (level <= 1) return [plot(2), box(0, 0, 0, 1.7, FLOOR * 5, 1.4, COLOR.mortar), ...windows(0, 0, 1.7, 1.4, 5), box(0, FLOOR * 5, 0.7, 1.4, 0.24, 0.05, COLOR.sign)];
    return [plot(2), box(0, 0, 0, 1.8, FLOOR * 8, 1.7, COLOR.concrete), ...windows(0, 0, 1.8, 1.7, 8), box(0, FLOOR * 8, 0, 0.9, 0.3, 0.9, COLOR.metal), box(0, FLOOR * 8, 0.86, 1.6, 0.3, 0.05, COLOR.sign)];
  }
  // 工业
  if (size === 1) {
    if (level === 0) return [plot(1), box(0, 0, 0, 0.8, FLOOR, 0.76, COLOR.wood), ...sawtooth(0, 0, 0.8, 0.76, FLOOR, 2)];
    if (level === 1) return [plot(1), box(0, 0, 0, 0.84, FLOOR * 1.4, 0.76, COLOR.metal), gable(0, FLOOR * 1.4, 0, 0.9, 0.16, 0.82, COLOR.tin)];
    return [plot(1), box(-0.08, 0, 0, 0.68, FLOOR * 2, 0.8, COLOR.metal), ...sawtooth(-0.08, 0, 0.68, 0.8, FLOOR * 2, 2), box(0.36, 0, 0.2, 0.1, 1.1, 0.1, COLOR.brick)];
  }
  if (level <= 1) return [plot(2), box(0, 0, 0, 1.76, FLOOR * 1.6, 1.3, COLOR.metal), gable(0, FLOOR * 1.6, 0, 1.84, 0.24, 1.38, COLOR.tin)];
  return [plot(2), box(-0.1, 0, 0, 1.5, FLOOR * 2, 1.7, COLOR.metal), ...sawtooth(-0.1, 0, 1.5, 1.7, FLOOR * 2, 4), box(0.8, 0, -0.6, 0.16, 1.9, 0.16, COLOR.brick), box(0.8, 0, 0.4, 0.3, 0.7, 0.3, COLOR.concrete)];
}

const geometries = new Map<string, THREE.BufferGeometry>();
const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

function geometryFor(key: string, b: Building): THREE.BufferGeometry {
  let g = geometries.get(key);
  if (!g) {
    g = mergeGeometries(shape(b.use, b.level, b.size))!;
    geometries.set(key, g);
  }
  return g;
}

/** 所有建筑：同种建筑一个 InstancedMesh（几何体共享，只在建筑变化时重建实例） */
export function buildBuildings(m: MapData, land: Land): THREE.Group {
  const groups = new Map<string, Building[]>();
  for (const b of land.buildings.values()) {
    const key = `${b.use}-${b.level}-${b.size}`;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  const out = new THREE.Group();
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const one = new THREE.Vector3(1, 1, 1);
  for (const [key, list] of groups) {
    const mesh = new THREE.InstancedMesh(geometryFor(key, list[0]), material, list.length);
    list.forEach((b, i) => {
      const cx = b.x + b.size / 2;
      const cz = b.y + b.size / 2;
      const top = Math.max(
        cornerHeight(m, b.x, b.y),
        cornerHeight(m, b.x + b.size, b.y),
        cornerHeight(m, b.x, b.y + b.size),
        cornerHeight(m, b.x + b.size, b.y + b.size),
      );
      q.setFromAxisAngle(up, Math.floor(b.seed * 4) * (Math.PI / 2));
      mtx.compose(new THREE.Vector3(cx, metersToY(m, top), cz), q, one);
      mesh.setMatrixAt(i, mtx);
      const t = 0.84 + hash2(b.x, b.y, 91) * 0.16;
      mesh.setColorAt(i, color.setRGB(t, t * (0.96 + b.seed * 0.04), t * (0.92 + b.seed * 0.08)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    out.add(mesh);
  }
  out.name = 'buildings';
  return out;
}

const ZONE_COLOR: Record<Zone, number> = {
  [Zone.None]: 0xffffff,
  [Zone.Residential]: 0x4cd964,
  [Zone.Commercial]: 0x3b9dff,
  [Zone.Industrial]: 0xffc23d,
};

/** 玩家土地与分区的半透明覆盖层（只在土地工具中显示） */
export function buildLandOverlay(m: MapData, land: Land): THREE.Mesh {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < land.owner.length; i++) {
    if (land.owner[i] !== Owner.Player) continue;
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    c.set(ZONE_COLOR[land.zone[i] as Zone]);
    const v = (px: number, py: number) => {
      pos.push(px, metersToY(m, groundHeight(m, px, py)) + 0.05, py);
      col.push(c.r, c.g, c.b);
    };
    const [a, b] = [x + 0.04, x + 0.96];
    const [e, f] = [y + 0.04, y + 0.96];
    v(a, e), v(a, f), v(b, f), v(a, e), v(b, f), v(b, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
  mesh.renderOrder = 5;
  return mesh;
}
