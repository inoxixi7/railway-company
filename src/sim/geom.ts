export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });

/** 三次贝塞尔采样 */
export function sampleCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, steps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(v(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y));
  }
  return out;
}

/** 二次贝塞尔采样 */
export function sampleQuad(p0: Vec2, p1: Vec2, p2: Vec2, steps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push(v(u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y));
  }
  return out;
}

/**
 * SVG 风格的连续三次贝塞尔：第一段给出两个控制点，后续段用 S（第一个控制点为上一段第二个控制点的镜像）。
 * segments: [[c1, c2, end], [c2', end'], ...]
 */
export function samplePathCS(start: Vec2, first: [Vec2, Vec2, Vec2], smooth: [Vec2, Vec2][], stepsPerSeg = 40): Vec2[] {
  const pts = sampleCubic(start, first[0], first[1], first[2], stepsPerSeg);
  let prevC2 = first[1];
  let prevEnd = first[2];
  for (const [c2, end] of smooth) {
    const c1 = v(2 * prevEnd.x - prevC2.x, 2 * prevEnd.y - prevC2.y);
    pts.push(...sampleCubic(prevEnd, c1, c2, end, stepsPerSeg).slice(1));
    prevC2 = c2;
    prevEnd = end;
  }
  return pts;
}

export interface PolylineHit {
  /** 到折线的距离 */
  dist: number;
  /** 沿折线的归一化位置 0..1 */
  s: number;
}

/** 点到折线的最近距离与位置 */
export function nearestOnPolyline(p: Vec2, line: Vec2[], cumLen: number[]): PolylineHit {
  let best = Infinity;
  let bestS = 0;
  const total = cumLen[cumLen.length - 1];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best) {
      best = d;
      bestS = (cumLen[i] + Math.sqrt(len2) * t) / total;
    }
  }
  return { dist: best, s: bestS };
}

export function cumulativeLength(line: Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) {
    out.push(out[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
  }
  return out;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
