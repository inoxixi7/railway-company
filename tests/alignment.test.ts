import { describe, expect, it } from 'vitest';
import { buildAlignment, dirVec, routeOctilinear, sampleAlignment } from '../src/sim/track/alignment';

const rules = { preferredRadius: 20, minRadius: 8 };

describe('线形', () => {
  it('直线长度正确', () => {
    const al = buildAlignment([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 }], rules);
    expect(al.length).toBeCloseTo(30);
    expect(al.pieces).toHaveLength(1);
  });

  it('45° 折点插入圆曲线，线形连续且切线连续', () => {
    const al = buildAlignment([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 100, y: 40 }], rules);
    expect(al.issues).toEqual([]);
    expect(al.pieces.map((p) => p.kind)).toEqual(['line', 'arc', 'line']);
    // 每段衔接处位置与方向连续
    for (let i = 1; i < al.pieces.length; i++) {
      const s = al.starts[i];
      const a = sampleAlignment(al, s - 1e-6);
      const b = sampleAlignment(al, s + 1e-6);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-3);
      expect(Math.hypot(a.tx - b.tx, a.ty - b.ty)).toBeLessThan(1e-3);
    }
    const end = sampleAlignment(al, al.length);
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(40);
    // 末端方向为东南
    expect(end.tx).toBeCloseTo(Math.SQRT1_2);
    expect(end.ty).toBeCloseTo(Math.SQRT1_2);
  });

  it('向左转也正确', () => {
    const al = buildAlignment([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 100, y: -40 }], rules);
    const end = sampleAlignment(al, al.length);
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(-40);
  });

  it('线段太短 → 半径不足；超过 90° → 急转', () => {
    const short = buildAlignment([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 2 }], rules);
    expect(short.issues.some((i) => i.kind === 'radius')).toBe(true);
    const sharp = buildAlignment([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 10, y: 30 }], rules);
    expect(sharp.issues.some((i) => i.kind === 'sharp')).toBe(true);
  });

  it('8 方向路由', () => {
    expect(routeOctilinear({ x: 0, y: 0 }, { x: 10, y: 4 })).toEqual([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 10, y: 4 }]);
    // 优先沿给定方向（东南 = 1）出发
    expect(routeOctilinear({ x: 0, y: 0 }, { x: 10, y: 4 }, 1)).toEqual([{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 10, y: 4 }]);
    expect(routeOctilinear({ x: 0, y: 0 }, { x: 5, y: 5 })).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
  });

  it('延长时新弯不与已固定的旧弯重叠：要么线形连续，要么报半径不足', () => {
    const old = buildAlignment([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 46, y: 6 }], rules);
    expect(old.issues).toEqual([]);
    const fixed = (p: { x: number; y: number }) => (p.x === 40 && p.y === 0 ? old.radii[1] : undefined);
    const tooShort = buildAlignment([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 48, y: 8 }, { x: 80, y: 8 }], rules, fixed);
    expect(tooShort.issues.map((i) => i.kind)).toContain('radius');
    for (const [x, y] of [[48, 8], [62, 22]]) {
      const al = buildAlignment([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x, y }, { x: x + 40, y }], rules, fixed);
      for (let k = 1; k < al.pieces.length; k++) {
        const a = sampleAlignment(al, al.starts[k] - 1e-6);
        const b = sampleAlignment(al, al.starts[k] + 1e-6);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-3);
        expect(Math.hypot(a.tx - b.tx, a.ty - b.ty)).toBeLessThan(1e-3);
      }
    }
  });

  it('8 个方向、左右转 45°/90°：曲线与直线都连续相切，终点正确', () => {
    for (let d = 0; d < 8; d++) {
      for (const turn of [-2, -1, 1, 2]) {
        const a = dirVec(d);
        const b = dirVec(d + turn);
        const p1 = { x: 200 + a.x * 60, y: 200 + a.y * 60 };
        const p2 = { x: p1.x + b.x * 60, y: p1.y + b.y * 60 };
        const al = buildAlignment([{ x: 200, y: 200 }, p1, p2], rules);
        expect(al.issues).toEqual([]);
        for (let k = 1; k < al.pieces.length; k++) {
          const u = sampleAlignment(al, al.starts[k] - 1e-6);
          const v = sampleAlignment(al, al.starts[k] + 1e-6);
          expect(Math.hypot(u.x - v.x, u.y - v.y), `方向 ${d} 转 ${turn}`).toBeLessThan(1e-3);
          expect(Math.hypot(u.tx - v.tx, u.ty - v.ty), `方向 ${d} 转 ${turn}`).toBeLessThan(1e-3);
        }
        const end = sampleAlignment(al, al.length);
        expect(end.x).toBeCloseTo(p2.x);
        expect(end.y).toBeCloseTo(p2.y);
      }
    }
  });
});
