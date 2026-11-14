import { describe, expect, it } from 'vitest';
import { biarc, intersectPieces, nearestOnPiece, pieceAt, pieceLength, reversePiece, splitPiece, tangentArc, type Piece } from '../src/sim/rail/geometry';

const E = { x: 1, y: 0 };
const end = (p: Piece) => pieceAt(p, pieceLength(p));

describe('轨道几何', () => {
  it('相切圆弧：起点切线等于给定方向，终点落在目标上', () => {
    for (const T of [{ x: 10, y: 4 }, { x: 10, y: -4 }, { x: 3, y: 9 }, { x: -2, y: 6 }]) {
      const p = tangentArc({ x: 0, y: 0 }, E, T)!;
      const a = pieceAt(p, 0);
      expect(a.tx).toBeCloseTo(1);
      expect(a.ty).toBeCloseTo(0);
      const b = end(p);
      expect(b.x).toBeCloseTo(T.x);
      expect(b.y).toBeCloseTo(T.y);
    }
  });

  it('目标在正前方 → 直线；在正后方 → 无解', () => {
    expect(tangentArc({ x: 0, y: 0 }, E, { x: 10, y: 0.01 })!.k).toBe('L');
    expect(tangentArc({ x: 0, y: 0 }, E, { x: -5, y: 0 })).toBeNull();
  });

  it('双圆弧：两端方向都满足，中间切线连续', () => {
    const h2 = { x: 0, y: 1 };
    const ps = biarc({ x: 0, y: 0 }, E, { x: 12, y: 9 }, h2)!;
    expect(ps).toHaveLength(2);
    const a = pieceAt(ps[0], 0);
    expect([a.tx, a.ty]).toEqual([expect.closeTo(1), expect.closeTo(0)]);
    const j0 = end(ps[0]);
    const j1 = pieceAt(ps[1], 0);
    expect(Math.hypot(j0.x - j1.x, j0.y - j1.y)).toBeLessThan(1e-6);
    expect(Math.hypot(j0.tx - j1.tx, j0.ty - j1.ty)).toBeLessThan(1e-6);
    const b = end(ps[1]);
    expect(b.x).toBeCloseTo(12);
    expect(b.y).toBeCloseTo(9);
    expect(b.tx).toBeCloseTo(0, 5);
    expect(b.ty).toBeCloseTo(1, 5);
  });

  it('双圆弧：平行偏移（S 弯）', () => {
    const ps = biarc({ x: 0, y: 0 }, E, { x: 20, y: 3 }, E)!;
    const b = end(ps[1]);
    expect(b.y).toBeCloseTo(3);
    expect(b.tx).toBeCloseTo(1, 5);
  });

  it('切分与反向保持几何不变', () => {
    const p = tangentArc({ x: 0, y: 0 }, E, { x: 10, y: 6 })!;
    const len = pieceLength(p);
    const [a, b] = splitPiece(p, len * 0.3);
    expect(pieceLength(a) + pieceLength(b)).toBeCloseTo(len);
    const m = pieceAt(p, len * 0.3);
    expect(end(a).x).toBeCloseTo(m.x);
    expect(pieceAt(b, 0).ty).toBeCloseTo(m.ty);
    const r = reversePiece(p);
    expect(pieceAt(r, 0).x).toBeCloseTo(10);
    expect(pieceAt(r, 0).tx).toBeCloseTo(-end(p).tx);
  });

  it('最近点与交点', () => {
    const p = tangentArc({ x: 0, y: 0 }, E, { x: 10, y: 6 })!;
    const m = pieceAt(p, 4);
    const n = nearestOnPiece(p, m.x + m.ty * 0.5, m.y - m.tx * 0.5);
    expect(n.s).toBeCloseTo(4, 3);
    expect(n.dist).toBeCloseTo(0.5, 3);
    const a: Piece = { k: 'L', ax: 0, ay: 0, bx: 10, by: 0 };
    const b: Piece = { k: 'L', ax: 5, ay: -5, bx: 5, by: 5 };
    const hits = intersectPieces(a, b);
    expect(hits).toHaveLength(1);
    expect(hits[0].sa).toBeCloseTo(5);
    expect(hits[0].sb).toBeCloseTo(5);
    expect(hits[0].angle).toBeCloseTo(Math.PI / 2);
  });
});
