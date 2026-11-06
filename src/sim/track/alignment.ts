/**
 * 线形：8 方向折线（顶点在格点上）+ 每个折点自动插入圆曲线。
 * 长度单位为「格」。
 */
export interface GridPt {
  x: number;
  y: number;
}

export interface LinePiece {
  kind: 'line';
  ax: number;
  ay: number;
  bx: number;
  by: number;
  len: number;
}

export interface ArcPiece {
  kind: 'arc';
  cx: number;
  cy: number;
  r: number;
  /** 起始角（弧度，从圆心指向起点） */
  a0: number;
  /** 有符号转角（弧度） */
  sweep: number;
  len: number;
}

export type Piece = LinePiece | ArcPiece;

export interface AlignmentIssue {
  /** 出问题的折点（格点） */
  at: GridPt;
  kind: 'radius' | 'sharp';
  /** 可达到的最大半径（格） */
  radius?: number;
}

export interface Alignment {
  points: GridPt[];
  /** 每个折点的曲线半径（格），首末点为 0 */
  radii: number[];
  pieces: Piece[];
  /** 每段的起始里程（格） */
  starts: number[];
  length: number;
  issues: AlignmentIssue[];
}

export interface AlignmentRules {
  /** 理想半径（格） */
  preferredRadius: number;
  /** 最小半径（格） */
  minRadius: number;
}

const DIRS: GridPt[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];

/** 方向编号 0..7（东起顺时针，y 向南），非 8 方向返回 -1 */
export function dirIndex(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return -1;
  if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) return -1;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  return DIRS.findIndex((d) => d.x === sx && d.y === sy);
}

export const dirVec = (i: number): GridPt => DIRS[((i % 8) + 8) % 8];

/** 去掉重复点和共线的中间点 */
export function simplify(points: GridPt[]): GridPt[] {
  const out: GridPt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = last;
      if (dirIndex(b.x - a.x, b.y - a.y) === dirIndex(p.x - b.x, p.y - b.y)) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * 从 a 到 b 的 8 方向路线（最多两段：直线 + 45° 斜线）。
 * preferDir：第一段优先使用的方向（延长线路时为线路末端方向）。
 */
export function routeOctilinear(a: GridPt, b: GridPt, preferDir = -1): GridPt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [a];
  if (dirIndex(dx, dy) >= 0) return [a, b];
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const diag = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  // 两种分解：先直后斜，或先斜后直
  const straightFirst: GridPt = adx > ady ? { x: a.x + sx * (adx - diag), y: a.y } : { x: a.x, y: a.y + sy * (ady - diag) };
  const diagFirst: GridPt = { x: a.x + sx * diag, y: a.y + sy * diag };
  const d1 = dirIndex(straightFirst.x - a.x, straightFirst.y - a.y);
  const d2 = dirIndex(diagFirst.x - a.x, diagFirst.y - a.y);
  if (preferDir >= 0 && d2 === preferDir) return [a, diagFirst, b];
  if (preferDir >= 0 && d1 === preferDir) return [a, straightFirst, b];
  return [a, straightFirst, b];
}

/**
 * 由 8 方向折线生成带圆曲线的线形。
 * fixedRadius：已建成部分的折点半径保持不变（返回 undefined 则自动计算）。
 */
export function buildAlignment(raw: GridPt[], rules: AlignmentRules, fixedRadius?: (p: GridPt) => number | undefined): Alignment {
  const pts = simplify(raw);
  const issues: AlignmentIssue[] = [];
  const n = pts.length;
  if (n < 2) return { points: pts, radii: pts.map(() => 0), pieces: [], starts: [], length: 0, issues };

  const segLen = (i: number) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  // 每个内部折点的转角与切线长
  const tangent: number[] = new Array(n).fill(0);
  const turn: number[] = new Array(n).fill(0);
  const radius: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const d0 = dirIndex(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const d1 = dirIndex(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    let steps = (((d1 - d0) % 8) + 8) % 8;
    if (steps > 4) steps -= 8;
    if (Math.abs(steps) > 2) {
      issues.push({ at: pts[i], kind: 'sharp' });
      steps = Math.sign(steps) * 2;
    }
    const theta = (steps * Math.PI) / 4;
    turn[i] = theta;
    const t = Math.tan(Math.abs(theta) / 2);
    // 可用切线长：两侧线段的一半（首末段可用全长）
    const availPrev = i === 1 ? segLen(0) : segLen(i - 1) / 2;
    const availNext = i === n - 2 ? segLen(n - 2) : segLen(i) / 2;
    const fixed = fixedRadius?.(pts[i]);
    const r = fixed ?? Math.min(rules.preferredRadius, Math.min(availPrev, availNext) / t);
    radius[i] = r;
    tangent[i] = r * t;
    if (r < rules.minRadius - 1e-9) issues.push({ at: pts[i], kind: 'radius', radius: r });
  }

  const pieces: Piece[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = segLen(i);
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const s0 = tangent[i];
    const s1 = L - tangent[i + 1];
    if (s1 - s0 > 1e-9) {
      pieces.push({ kind: 'line', ax: a.x + ux * s0, ay: a.y + uy * s0, bx: a.x + ux * s1, by: a.y + uy * s1, len: s1 - s0 });
    }
    // 折点 b 处的圆曲线
    const j = i + 1;
    if (j < n - 1 && tangent[j] > 1e-9) {
      const theta = turn[j];
      const r = radius[j];
      const tx = b.x - ux * tangent[j];
      const ty = b.y - uy * tangent[j];
      // 左法线（y 向南的坐标系里，转角为正 = 顺时针 = 向右转）
      const side = Math.sign(theta);
      const nx = -uy * side * -1;
      const ny = ux * side;
      const cx = tx + nx * r;
      const cy = ty + ny * r;
      pieces.push({ kind: 'arc', cx, cy, r, a0: Math.atan2(ty - cy, tx - cx), sweep: theta, len: r * Math.abs(theta) });
    }
  }
  const starts: number[] = [];
  let acc = 0;
  for (const p of pieces) {
    starts.push(acc);
    acc += p.len;
  }
  return { points: pts, radii: radius, pieces, starts, length: acc, issues };
}

export interface AlignmentSample {
  x: number;
  y: number;
  /** 单位切向量 */
  tx: number;
  ty: number;
  /** 曲线半径（格），直线为 Infinity */
  radius: number;
}

/** 按里程（格）取点 */
export function sampleAlignment(al: Alignment, s: number): AlignmentSample {
  const ss = Math.max(0, Math.min(al.length, s));
  let lo = 0;
  let hi = al.pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (al.starts[mid] <= ss) lo = mid;
    else hi = mid - 1;
  }
  const p = al.pieces[lo];
  const u = ss - al.starts[lo];
  if (p.kind === 'line') {
    const t = p.len > 0 ? u / p.len : 0;
    return { x: p.ax + (p.bx - p.ax) * t, y: p.ay + (p.by - p.ay) * t, tx: (p.bx - p.ax) / p.len, ty: (p.by - p.ay) / p.len, radius: Infinity };
  }
  const ang = p.a0 + (Math.sign(p.sweep) * u) / p.r;
  const x = p.cx + Math.cos(ang) * p.r;
  const y = p.cy + Math.sin(ang) * p.r;
  const sg = Math.sign(p.sweep);
  return { x, y, tx: -Math.sin(ang) * sg, ty: Math.cos(ang) * sg, radius: p.r };
}
