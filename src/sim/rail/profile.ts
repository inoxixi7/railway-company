import { CONFIG } from '../../config';
import { cellIndex, groundHeight, inBounds } from '../map/query';
import type { MapData } from '../map/types';
import type { Pt } from './geometry';
import { Z_STEP, type Structure } from './network';

export interface ProfileConstraint {
  /** 沿线位置（格） */
  s: number;
  /** 立体交叉：此处轨面不得低于这个高度（米），并强制为高架 */
  minZ?: number;
  /** 平面交叉或接轨：此处轨面必须等于这个高度（米） */
  pinZ?: number;
}

export interface Profile {
  step: number;
  z: number[];
  ground: number[];
  structure: Structure[];
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/**
 * 自动纵断面：把沿线地面高度平滑后，在「坡度 ≤ 上限」的约束下尽量贴近地面；
 * 跨水处抬到净空以上，立体交叉处抬到下方轨面以上，接轨点高度固定。
 */
export function computeProfile(m: MapData, at: (s: number) => Pt, length: number, constraints: ProfileConstraint[] = []): Profile {
  const n = Math.max(2, Math.ceil(length / Z_STEP) + 1);
  const step = length / (n - 1);
  const ground: number[] = [];
  const water: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = at(i * step);
    ground.push(groundHeight(m, p.x, p.y));
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    let w = Number.NaN;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!inBounds(m, cx + dx, cy + dy)) continue;
      const v = m.waterLevel[cellIndex(m, cx + dx, cy + dy)];
      if (!Number.isNaN(v)) w = Number.isNaN(w) ? v : Math.max(w, v);
    }
    water.push(w);
  }

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
  // 下限包络：水面净空 + 立交净空，并按最大坡度向两侧延伸（引道）
  const lower = water.map((w) => (Number.isNaN(w) ? -Infinity : w + CONFIG.rail.bridgeClearanceM));
  const forced = new Array<boolean>(n).fill(false);
  const pins = new Map<number, number>();
  for (const c of constraints) {
    const i = clamp(Math.round(c.s / step), 0, n - 1);
    if (c.pinZ !== undefined) pins.set(i, c.pinZ);
    if (c.minZ !== undefined) {
      // 跨越处前后各 2 格都保持净空
      const span = Math.round(2 / step);
      for (let j = Math.max(0, i - span); j <= Math.min(n - 1, i + span); j++) {
        lower[j] = Math.max(lower[j], c.minZ);
        forced[j] = true;
      }
    }
  }
  for (let i = 1; i < n; i++) lower[i] = Math.max(lower[i], lower[i - 1] - dz);
  for (let i = n - 2; i >= 0; i--) lower[i] = Math.max(lower[i], lower[i + 1] - dz);

  const z = target.map((t, i) => Math.max(t, lower[i]));
  const applyPins = () => {
    for (const [i, v] of pins) z[i] = v;
  };
  applyPins();
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 1; i < n; i++) if (!pins.has(i)) z[i] = clamp(z[i], z[i - 1] - dz, z[i - 1] + dz);
    for (let i = n - 2; i >= 0; i--) if (!pins.has(i)) z[i] = clamp(z[i], z[i + 1] - dz, z[i + 1] + dz);
  }

  // 平滑：让坡度变化平缓（不会增大最大坡度）；接轨点固定，不低于净空下限
  for (let iter = 0; iter < 24; iter++) {
    let prev = z[0];
    for (let i = 1; i < n - 1; i++) {
      const cur = z[i];
      if (!pins.has(i)) z[i] = Math.max(lower[i], (prev + cur + z[i + 1]) / 3);
      prev = cur;
    }
  }

  const structure: Structure[] = z.map((zz, i) => {
    if (!Number.isNaN(water[i])) return 'bridge';
    const d = zz - ground[i];
    if (forced[i] || d > CONFIG.rail.viaductAboveM) return 'viaduct';
    if (d < -CONFIG.rail.tunnelBelowM) return 'tunnel';
    return 'ground';
  });
  return { step, z, ground, structure };
}

export interface ProfileSummary {
  lengthM: number;
  byStructureM: Record<Structure, number>;
  maxGradePermil: number;
  cost: number;
  days: number;
}

export function summarizeProfile(m: MapData, pr: Profile, tracks: 1 | 2): ProfileSummary {
  const stepM = pr.step * m.cellMeters;
  const by: Record<Structure, number> = { ground: 0, viaduct: 0, bridge: 0, tunnel: 0 };
  let maxG = 0;
  for (let i = 0; i < pr.z.length - 1; i++) {
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
  return { lengthM: (pr.z.length - 1) * stepM, byStructureM: by, maxGradePermil: maxG, cost: Math.round(cost), days: Math.max(CONFIG.rail.minDays, Math.ceil(days)) };
}
