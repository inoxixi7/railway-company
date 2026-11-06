import * as THREE from 'three';
import { fbm } from '../sim/noise';
import { hash2 } from '../sim/rng';
import { cellIndex, cellInfo } from '../sim/map/query';
import { Cover, type MapData } from '../sim/map/types';
import { metersToY } from './coords';

const hex = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

const PALETTE = {
  grass: hex(0x8dbb63),
  grassHigh: hex(0x9c9a6a),
  rock: hex(0x8f8577),
  forestFloor: hex(0x557f3f),
  farmA: hex(0xd8cb84),
  farmB: hex(0xa9c86a),
  waterBed: hex(0x5d7f8f),
  town: hex(0xc8b9a3),
  facility: hex(0xa9a49b),
};

/** 每格一个像素的地表颜色纹理（最近邻采样，格子边界清晰） */
export function buildCoverTexture(m: MapData): THREE.DataTexture {
  const N = m.width;
  const data = new Uint8Array(N * m.height * 4);
  for (let cy = 0; cy < m.height; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const i = cellIndex(m, cx, cy);
      const info = cellInfo(m, cx, cy);
      let c: [number, number, number];
      switch (m.cover[i] as Cover) {
        case Cover.Forest:
          c = PALETTE.forestFloor;
          break;
        case Cover.Farmland: {
          // 地块：每 6×4 格一块，水田/旱地交错，块内按行做条纹
          const plot = hash2(Math.floor(cx / 6), Math.floor(cy / 4), 11) > 0.45;
          const base = plot ? PALETTE.farmA : PALETTE.farmB;
          const stripe = cy % 2 === 0 ? 1 : 0.93;
          c = [base[0] * stripe, base[1] * stripe, base[2] * stripe];
          break;
        }
        case Cover.Water:
          c = PALETTE.waterBed;
          break;
        case Cover.Town:
          c = PALETTE.town;
          break;
        case Cover.Facility:
          c = PALETTE.facility;
          break;
        default: {
          const t = Math.min(1, Math.max(0, (info.elevation - 60) / 70));
          c = mix(PALETTE.grass, PALETTE.grassHigh, t);
          if (info.slopePermil > 450) c = mix(c, PALETTE.rock, 0.6);
        }
      }
      // 大尺度的柔和明暗 + 很轻的逐格变化
      const jitter = 1 + fbm(cx / 18, cy / 18, 9, 2) * 0.06 + (hash2(cx, cy, 5) - 0.5) * 0.025;
      const k = (cy * N + cx) * 4;
      data[k] = clamp255(c[0] * jitter);
      data[k + 1] = clamp255(c[1] * jitter);
      data[k + 2] = clamp255(c[2] * jitter);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, m.height, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 地形网格：每个格点一个顶点，每格两个三角形（对角线 (x,y)-(x+1,y+1)，与 groundHeight 一致） */
export function buildTerrainMesh(m: MapData): THREE.Mesh {
  const W = m.width;
  const H = m.height;
  const C = W + 1;
  const pos = new Float32Array(C * (H + 1) * 3);
  const uv = new Float32Array(C * (H + 1) * 2);
  for (let y = 0; y <= H; y++) {
    for (let x = 0; x <= W; x++) {
      const k = y * C + x;
      pos[k * 3] = x;
      pos[k * 3 + 1] = metersToY(m, m.heights[k]);
      pos[k * 3 + 2] = y;
      uv[k * 2] = x / W;
      uv[k * 2 + 1] = y / H;
    }
  }
  const index = new Uint32Array(W * H * 6);
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = y * C + x;
      const b = a + 1;
      const c = a + C;
      const d = c + 1;
      // 逆时针（从上往下看，+Y 朝上）
      index[n++] = a;
      index[n++] = d;
      index[n++] = b;
      index[n++] = a;
      index[n++] = c;
      index[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  const tex = buildCoverTexture(m);
  // DataTexture 第一行对应 v=0；我们让 uv.y = y/H，flipY=false（DataTexture 默认）
  const mat = new THREE.MeshLambertMaterial({ map: tex, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  return mesh;
}

/** 地图四周的侧壁，让地图看起来像一块「地台」 */
export function buildTerrainSkirt(m: MapData): THREE.Mesh {
  const W = m.width;
  const H = m.height;
  const C = W + 1;
  const bottom = metersToY(m, -10);
  const verts: number[] = [];
  const edge = (pts: [number, number][]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const h0 = metersToY(m, m.heights[y0 * C + x0]);
      const h1 = metersToY(m, m.heights[y1 * C + x1]);
      verts.push(x0, h0, y0, x1, h1, y1, x1, bottom, y1, x0, h0, y0, x1, bottom, y1, x0, bottom, y0);
    }
  };
  const range = (n: number) => [...Array(n + 1).keys()];
  edge(range(W).map((x) => [x, H] as [number, number])); // 南
  edge(range(H).map((y) => [W, H - y] as [number, number])); // 东
  edge(range(W).map((x) => [W - x, 0] as [number, number])); // 北
  edge(range(H).map((y) => [0, y] as [number, number])); // 西
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: 0x7a634a, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, mat);
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
