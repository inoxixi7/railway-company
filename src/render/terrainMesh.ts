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
  sand: hex(0xd3c79a),
};

/** 每格多少个纹理像素 */
const TEXELS = 4;

type RGB = [number, number, number];

/** 每格的基础颜色（不含细节） */
function cellColors(m: MapData): Float32Array {
  const W = m.width;
  const H = m.height;
  const out = new Float32Array(W * H * 3);
  const isWater = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m.cover[y * W + x] === Cover.Water;
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const i = cellIndex(m, cx, cy);
      const info = cellInfo(m, cx, cy);
      let c: RGB;
      switch (m.cover[i] as Cover) {
        case Cover.Forest:
          c = PALETTE.forestFloor;
          break;
        case Cover.Farmland:
          // 地块：每 6×4 格一块，水田与旱地交错
          c = hash2(Math.floor(cx / 6), Math.floor(cy / 4), 11) > 0.45 ? PALETTE.farmA : PALETTE.farmB;
          break;
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
      // 河岸：紧邻水面的陆地带一点沙色
      if (m.cover[i] !== Cover.Water && m.cover[i] !== Cover.Facility) {
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (isWater(cx + dx, cy + dy)) near = true;
        if (near) c = mix(c, PALETTE.sand, 0.55);
      }
      out[i * 3] = c[0];
      out[i * 3 + 1] = c[1];
      out[i * 3 + 2] = c[2];
    }
  }
  return out;
}

/**
 * 地表颜色纹理：每格 4×4 像素，相邻地表之间平滑过渡，
 * 叠加柔和的明暗、农田垄沟与田埂、城镇的巷道纹理。
 */
export function buildCoverTexture(m: MapData): THREE.DataTexture {
  const W = m.width;
  const H = m.height;
  const TW = W * TEXELS;
  const TH = H * TEXELS;
  const base = cellColors(m);
  const data = new Uint8Array(TW * TH * 4);
  const at = (x: number, y: number, k: number) => base[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3 + k];
  for (let ty = 0; ty < TH; ty++) {
    const fy = (ty + 0.5) / TEXELS;
    const cy = Math.min(H - 1, Math.floor(fy));
    const y0 = Math.floor(fy - 0.5);
    const wy = fy - 0.5 - y0;
    for (let tx = 0; tx < TW; tx++) {
      const fx = (tx + 0.5) / TEXELS;
      const cx = Math.min(W - 1, Math.floor(fx));
      const x0 = Math.floor(fx - 0.5);
      const wx = fx - 0.5 - x0;
      const cover = m.cover[cy * W + cx] as Cover;
      // 相邻格颜色双线性混合（农田、城镇、设施保持清晰边界）
      const crisp = cover === Cover.Farmland || cover === Cover.Town || cover === Cover.Facility;
      let r: number;
      let g: number;
      let b: number;
      if (crisp) {
        r = at(cx, cy, 0);
        g = at(cx, cy, 1);
        b = at(cx, cy, 2);
      } else {
        const bl = (k: number) => (at(x0, y0, k) * (1 - wx) + at(x0 + 1, y0, k) * wx) * (1 - wy) + (at(x0, y0 + 1, k) * (1 - wx) + at(x0 + 1, y0 + 1, k) * wx) * wy;
        r = bl(0);
        g = bl(1);
        b = bl(2);
      }
      // 大尺度明暗 + 细碎变化
      let k = 1 + fbm(fx / 20, fy / 20, 9, 2) * 0.07 + fbm(fx / 2.5, fy / 2.5, 17, 1) * 0.035;
      if (cover === Cover.Farmland) {
        const px = Math.floor(cx / 6);
        const py = Math.floor(cy / 4);
        // 垄沟：每块田按自己的方向排列
        const along = hash2(px, py, 23) > 0.5 ? fx : fy;
        k *= Math.sin(along * Math.PI * 4) > 0 ? 1 : 0.93;
        // 田埂
        const ex = fx - px * 6;
        const ey = fy - py * 4;
        if (ex < 0.14 || ey < 0.14) k *= 0.8;
      } else if (cover === Cover.Town) {
        // 巷道：每 4 格一条
        const ex = fx % 4;
        const ey = fy % 4;
        if (ex < 0.16 || ey < 0.16) k *= 0.84;
      }
      const o = (ty * TW + tx) * 4;
      data[o] = clamp255(r * k);
      data[o + 1] = clamp255(g * k);
      data[o + 2] = clamp255(b * k);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
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
