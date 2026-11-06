import { CONFIG } from '../../config';
import { groundHeight, inBounds, cellIndex } from '../map/query';
import type { MapData } from '../map/types';
import { sampleAlignment, type Alignment } from './alignment';

/** 纵断面采样间隔（格）= 10 m */
export const SAMPLE_STEP = 0.5;

export type Structure = 'ground' | 'viaduct' | 'bridge' | 'tunnel';

export interface Profile {
  /** 每个采样点的轨面高度（米） */
  z: number[];
  ground: number[];
  structure: Structure[];
  /** 是否在水面上 */
  overWater: boolean[];
}

/**
 * 自动生成纵断面：先把地面高度平滑，再在「坡度 ≤ 上限」的约束下尽量贴近地面；
 * 跨水处抬高到净空以上。
 * startZ/endZ：固定端点的轨面高度（与已建线路或既有车站衔接）。
 */
export function computeProfile(m: MapData, al: Alignment, startZ?: number, endZ?: number, s0 = 0, s1 = al.length): Profile {
  const len = s1 - s0;
  const n = Math.max(2, Math.ceil(len / SAMPLE_STEP) + 1);
  const step = len / (n - 1);
  const ground: number[] = [];
  const water: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = sampleAlignment(al, s0 + i * step);
    ground.push(groundHeight(m, p.x, p.y));
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    let w = Number.NaN;
    // 线路宽约 1 格：周围有水都算跨水
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!inBounds(m, cx + dx, cy + dy)) continue;
      const v = m.waterLevel[cellIndex(m, cx + dx, cy + dy)];
      if (!Number.isNaN(v)) w = Number.isNaN(w) ? v : Math.max(w, v);
    }
    water.push(w);
  }

  // 平滑地面作为目标
  const win = Math.max(1, Math.round(CONFIG.rail.profileSmoothM / m.cellMeters / step / 2));
  const target = ground.map((_, i) => {
    let sum = 0;
    let k = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
      sum += ground[j];
      k++;
    }
    return sum / k;
  });
  const dz = (CONFIG.rail.maxGradePermil / 1000) * step * m.cellMeters;
  // 下限包络：跨水净空，并按最大坡度向两侧延伸（桥头引道）
  const lower = water.map((w) => (Number.isNaN(w) ? -Infinity : w + CONFIG.rail.bridgeClearanceM));
  for (let i = 1; i < n; i++) lower[i] = Math.max(lower[i], lower[i - 1] - dz);
  for (let i = n - 2; i >= 0; i--) lower[i] = Math.max(lower[i], lower[i + 1] - dz);

  const z = target.map((t, i) => Math.max(t, lower[i]));
  if (startZ !== undefined) z[0] = startZ;
  if (endZ !== undefined) z[n - 1] = endZ;
  // 坡度约束：前后各扫一遍；下限包络本身满足坡度，所以不会被压到包络以下
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 1; i < n; i++) z[i] = clamp(z[i], z[i - 1] - dz, z[i - 1] + dz);
    for (let i = n - 2; i >= 0; i--) z[i] = clamp(z[i], z[i + 1] - dz, z[i + 1] + dz);
  }

  const structure: Structure[] = z.map((zz, i) => {
    if (!Number.isNaN(water[i])) return 'bridge';
    const d = zz - ground[i];
    if (d > CONFIG.rail.viaductAboveM) return 'viaduct';
    if (d < -CONFIG.rail.tunnelBelowM) return 'tunnel';
    return 'ground';
  });
  return { z, ground, structure, overWater: water.map((w) => !Number.isNaN(w)) };
}

export interface ProfileSummary {
  lengthM: number;
  byStructureM: Record<Structure, number>;
  maxGradePermil: number;
  cost: number;
  days: number;
}

export function summarizeProfile(m: MapData, lengthCells: number, pr: Profile, tracks: 1 | 2): ProfileSummary {
  const n = pr.z.length;
  const stepM = (lengthCells / (n - 1)) * m.cellMeters;
  const by: Record<Structure, number> = { ground: 0, viaduct: 0, bridge: 0, tunnel: 0 };
  let maxG = 0;
  for (let i = 0; i < n - 1; i++) {
    by[pr.structure[i]] += stepM;
    maxG = Math.max(maxG, (Math.abs(pr.z[i + 1] - pr.z[i]) / stepM) * 1000);
  }
  const ratio = tracks === 2 ? 1 : CONFIG.rail.singleTrackCostRatio;
  let cost = 0;
  let days = 0;
  for (const k of Object.keys(by) as Structure[]) {
    cost += (by[k] / 1000) * CONFIG.rail.costPerKmDouble[k] * ratio;
    days += (by[k] / 1000) * CONFIG.rail.daysPerKm[k];
  }
  return { lengthM: lengthCells * m.cellMeters, byStructureM: by, maxGradePermil: maxG, cost: Math.round(cost), days: Math.max(CONFIG.rail.minDays, Math.ceil(days)) };
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
