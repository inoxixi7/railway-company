/**
 * 轨道几何：每段是一条直线或一段圆弧。
 * 坐标单位为格，x 向东、y 向南；角度用 atan2(y, x)。
 */
export interface Pt {
  x: number;
  y: number;
}

export interface LinePiece {
  k: 'L';
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface ArcPiece {
  k: 'A';
  cx: number;
  cy: number;
  r: number;
  /** 起点相对圆心的角度 */
  a0: number;
  /** 有符号转角 */
  sweep: number;
}

export type Piece = LinePiece | ArcPiece;

export interface PiecePoint {
  x: number;
  y: number;
  /** 行进方向的单位切向量 */
  tx: number;
  ty: number;
}

export function pieceLength(p: Piece): number {
  return p.k === 'L' ? Math.hypot(p.bx - p.ax, p.by - p.ay) : Math.abs(p.sweep) * p.r;
}

/** 曲线半径（格），直线为 Infinity */
export function pieceRadius(p: Piece): number {
  return p.k === 'L' ? Infinity : p.r;
}

/** 按距起点的弧长 s 取点 */
export function pieceAt(p: Piece, s: number): PiecePoint {
  if (p.k === 'L') {
    const len = Math.hypot(p.bx - p.ax, p.by - p.ay) || 1;
    const tx = (p.bx - p.ax) / len;
    const ty = (p.by - p.ay) / len;
    return { x: p.ax + tx * s, y: p.ay + ty * s, tx, ty };
  }
  const sg = Math.sign(p.sweep) || 1;
  const a = p.a0 + (sg * s) / p.r;
  return { x: p.cx + Math.cos(a) * p.r, y: p.cy + Math.sin(a) * p.r, tx: -Math.sin(a) * sg, ty: Math.cos(a) * sg };
}

export function reversePiece(p: Piece): Piece {
  if (p.k === 'L') return { k: 'L', ax: p.bx, ay: p.by, bx: p.ax, by: p.ay };
  return { k: 'A', cx: p.cx, cy: p.cy, r: p.r, a0: p.a0 + p.sweep, sweep: -p.sweep };
}

/** 在弧长 s 处把一段切成两段 */
export function splitPiece(p: Piece, s: number): [Piece, Piece] {
  if (p.k === 'L') {
    const m = pieceAt(p, s);
    return [
      { k: 'L', ax: p.ax, ay: p.ay, bx: m.x, by: m.y },
      { k: 'L', ax: m.x, ay: m.y, bx: p.bx, by: p.by },
    ];
  }
  const da = (Math.sign(p.sweep) * s) / p.r;
  return [
    { ...p, sweep: da },
    { ...p, a0: p.a0 + da, sweep: p.sweep - da },
  ];
}

/**
 * 从点 P 沿方向 h 出发、经过点 T 的圆弧（与 h 相切）。
 * T 几乎在 h 的延长线上时返回直线。T 在身后时返回 null。
 */
export function tangentArc(P: Pt, h: Pt, T: Pt): Piece | null {
  const dx = T.x - P.x;
  const dy = T.y - P.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return null;
  const cross = h.x * dy - h.y * dx;
  const dot = h.x * dx + h.y * dy;
  if (Math.abs(cross) < 0.01 * L) {
    if (dot <= 0) return null;
    return { k: 'L', ax: P.x, ay: P.y, bx: P.x + h.x * dot, by: P.y + h.y * dot };
  }
  const sg = Math.sign(cross);
  const r = (L * L) / (2 * Math.abs(cross));
  const cx = P.x - h.y * r * sg;
  const cy = P.y + h.x * r * sg;
  return { k: 'A', cx, cy, r, a0: Math.atan2(P.y - cy, P.x - cx), sweep: sg * 2 * Math.atan2(Math.abs(cross), dot) };
}

/**
 * 双圆弧：从 P（方向 h1）到 Q（到达方向 h2）的两段相切圆弧，全程切线连续。
 * 无解时返回 null。
 */
export function biarc(P: Pt, h1: Pt, Q: Pt, h2: Pt): Piece[] | null {
  const vx = Q.x - P.x;
  const vy = Q.y - P.y;
  const tx = h1.x + h2.x;
  const ty = h1.y + h2.y;
  const vt = vx * tx + vy * ty;
  const vv = vx * vx + vy * vy;
  const k = 2 * (1 - (h1.x * h2.x + h1.y * h2.y));
  let d: number;
  if (Math.abs(k) < 1e-9) {
    const vh = vx * h1.x + vy * h1.y;
    if (vh <= 1e-9) return null;
    d = vv / (4 * vh);
  } else {
    const disc = vt * vt + k * vv;
    if (disc < 0) return null;
    d = (-vt + Math.sqrt(disc)) / k;
  }
  if (!(d > 1e-6)) return null;
  // 两段圆弧的衔接点
  const J = { x: (P.x + Q.x + d * (h1.x - h2.x)) / 2, y: (P.y + Q.y + d * (h1.y - h2.y)) / 2 };
  const first = tangentArc(P, h1, J);
  if (!first) return null;
  const end = pieceAt(first, pieceLength(first));
  const second = tangentArc(J, { x: end.tx, y: end.ty }, Q);
  if (!second) return null;
  return [first, second];
}

/** 把一段采样成折线（含两端） */
export function samplePiece(p: Piece, step = 0.25): { x: number; y: number; s: number }[] {
  const len = pieceLength(p);
  const n = Math.max(1, Math.ceil(len / step));
  const out: { x: number; y: number; s: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (len * i) / n;
    const q = pieceAt(p, s);
    out.push({ x: q.x, y: q.y, s });
  }
  return out;
}

/** 点到一段的最近点 */
export function nearestOnPiece(p: Piece, x: number, y: number): { s: number; dist: number } {
  const len = pieceLength(p);
  if (p.k === 'L') {
    const q = pieceAt(p, 0);
    const s = Math.max(0, Math.min(len, (x - p.ax) * q.tx + (y - p.ay) * q.ty));
    const m = pieceAt(p, s);
    return { s, dist: Math.hypot(x - m.x, y - m.y) };
  }
  // 圆弧：把点的方位角换算成弧长，再夹到范围内
  const sg = Math.sign(p.sweep) || 1;
  let da = (Math.atan2(y - p.cy, x - p.cx) - p.a0) * sg;
  const two = Math.PI * 2;
  da = ((da % two) + two) % two;
  const span = Math.abs(p.sweep);
  // 落在弧外：取较近的端点
  if (da > span) da = da - span < two - da ? span : 0;
  const s = da * p.r;
  const m = pieceAt(p, s);
  return { s, dist: Math.hypot(x - m.x, y - m.y) };
}

/** 两段的交点（按折线近似求），返回各自的弧长位置与夹角（弧度，0..π/2） */
export function intersectPieces(a: Piece, b: Piece): { sa: number; sb: number; x: number; y: number; angle: number }[] {
  const pa = samplePiece(a, 0.5);
  const pb = samplePiece(b, 0.5);
  const out: { sa: number; sb: number; x: number; y: number; angle: number }[] = [];
  for (let i = 0; i < pa.length - 1; i++) {
    const a0 = pa[i];
    const a1 = pa[i + 1];
    for (let j = 0; j < pb.length - 1; j++) {
      const b0 = pb[j];
      const b1 = pb[j + 1];
      const rx = a1.x - a0.x;
      const ry = a1.y - a0.y;
      const qx = b1.x - b0.x;
      const qy = b1.y - b0.y;
      const den = rx * qy - ry * qx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((b0.x - a0.x) * qy - (b0.y - a0.y) * qx) / den;
      const u = ((b0.x - a0.x) * ry - (b0.y - a0.y) * rx) / den;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const sin = Math.abs(den) / (Math.hypot(rx, ry) * Math.hypot(qx, qy));
      out.push({ sa: a0.s + (a1.s - a0.s) * t, sb: b0.s + (b1.s - b0.s) * u, x: a0.x + rx * t, y: a0.y + ry * t, angle: Math.asin(Math.min(1, sin)) });
    }
  }
  return out;
}
