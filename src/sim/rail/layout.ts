import { CONFIG } from '../../config';
import { lineLength, spanAt } from './line';
import type { RailLine } from './types';

/**
 * 股道横向布置（用于绘制轨道与列车）：
 * 复线两条股道在 ±半间距；岛式站台处展开到 ±0.3 格；
 * 单线上的两股道车站两侧渐变展开；全部用滑动平均得到平顺的过渡。
 */
export interface TrackLayout {
  /** 采样起点与间隔（格） */
  s0: number;
  step: number;
  /** 两侧股道距中心线的距离（格）；0 表示此处只有一条股道 */
  mag: Float32Array;
}

const STEP = 0.25;
const RAMP = 2;

export function buildTrackLayout(line: RailLine, cellMeters: number): TrackLayout {
  const len = lineLength(line);
  const n = Math.ceil(len / STEP) + 1;
  const half = CONFIG.rail.trackSpacingM / cellMeters / 2;
  const L = CONFIG.rail.stationLengthCells / 2;
  const target = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * STEP;
    target[i] = (spanAt(line, s)?.tracks ?? 1) === 2 ? half : 0;
  }
  for (const st of line.stations) {
    const off = st.type === 'island' ? 0.3 : st.type === 'side' ? half : 0;
    // 站台范围及两端各 RAMP 格保持展开
    for (let i = Math.max(0, Math.floor((st.s - L) / STEP)); i <= Math.min(n - 1, Math.ceil((st.s + L) / STEP)); i++) {
      target[i] = st.type === 'single' ? 0 : off;
    }
  }
  // 滑动平均 → 平顺过渡
  const w = Math.round(RAMP / STEP);
  const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let k = 0;
    for (let j = i - w; j <= i + w; j++) {
      const jj = Math.max(0, Math.min(n - 1, j));
      sum += target[jj];
      k++;
    }
    mag[i] = sum / k;
  }
  // 车站站台范围内保持完整宽度（不被平均削弱）
  for (const st of line.stations) {
    if (st.type === 'single') continue;
    const off = st.type === 'island' ? 0.3 : half;
    for (let i = Math.max(0, Math.ceil((st.s - L) / STEP)); i <= Math.min(n - 1, Math.floor((st.s + L) / STEP)); i++) mag[i] = off;
  }
  return { s0: 0, step: STEP, mag };
}

export function magAt(l: TrackLayout, s: number): number {
  const i = Math.max(0, Math.min(l.mag.length - 1, Math.round((s - l.s0) / l.step)));
  return l.mag[i];
}
