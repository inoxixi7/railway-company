import { describe, expect, it } from 'vitest';
import { GestureRecognizer, type GestureEvent } from '../src/input/gestures';

const make = () => {
  const events: GestureEvent[] = [];
  const g = new GestureRecognizer((e) => events.push(e), { dragThresholdPx: 8, longPressMs: 500 });
  return { g, events, types: () => events.map((e) => e.type) };
};

describe('手势识别', () => {
  it('短按不动 = 点击', () => {
    const { g, types } = make();
    g.down(1, 100, 100, 0);
    g.move(1, 103, 102);
    g.up(1, 103, 102, 200);
    expect(types()).toEqual(['tap']);
  });

  it('按住不动超过阈值 = 长按，之后抬起不再算点击', () => {
    const { g, types } = make();
    g.down(1, 100, 100, 0);
    g.tick(300);
    expect(types()).toEqual([]);
    g.tick(520);
    g.up(1, 100, 100, 600);
    expect(types()).toEqual(['longPress']);
  });

  it('移动超过阈值 = 拖动，位移累计等于手指移动', () => {
    const { g, events, types } = make();
    g.down(1, 0, 0, 0);
    g.move(1, 20, 0);
    g.move(1, 30, 10);
    g.up(1, 30, 10, 100);
    expect(types()).toEqual(['dragStart', 'drag', 'drag', 'dragEnd']);
    const drags = events.filter((e) => e.type === 'drag') as Extract<GestureEvent, { type: 'drag' }>[];
    expect(drags.reduce((s, e) => s + e.dx, 0)).toBe(30);
    expect(drags.reduce((s, e) => s + e.dy, 0)).toBe(10);
  });

  it('拖动中 tick 不会触发长按', () => {
    const { g, types } = make();
    g.down(1, 0, 0, 0);
    g.move(1, 50, 0);
    g.tick(1000);
    expect(types()).not.toContain('longPress');
  });

  it('双指捏合与旋转', () => {
    const { g, events } = make();
    g.down(1, 100, 100, 0);
    g.down(2, 200, 100, 10);
    // 第二指移到 (300,100)：距离 100 → 200
    g.move(2, 300, 100);
    const z = events.at(-1) as Extract<GestureEvent, { type: 'transform' }>;
    expect(z.type).toBe('transform');
    expect(z.scale).toBeCloseTo(2);
    expect(z.rotation).toBeCloseTo(0);
    // 第二指转到正下方：画面顺时针 90°
    g.move(2, 100, 300);
    const r = events.at(-1) as Extract<GestureEvent, { type: 'transform' }>;
    expect(r.rotation).toBeCloseTo(Math.PI / 2);
    g.up(1, 100, 100, 100);
    g.up(2, 100, 300, 110);
    expect(events.filter((e) => e.type === 'transformEnd')).toHaveLength(1);
    expect(events.some((e) => e.type === 'tap')).toBe(false);
  });

  it('单指拖动中加第二指 → 结束拖动转为双指；剩一指时不恢复拖动', () => {
    const { g, types } = make();
    g.down(1, 0, 0, 0);
    g.move(1, 20, 0);
    g.down(2, 100, 0, 50);
    g.move(2, 120, 0);
    g.up(2, 120, 0, 100);
    g.move(1, 60, 0);
    g.up(1, 60, 0, 150);
    expect(types()).toEqual(['dragStart', 'drag', 'dragEnd', 'transformStart', 'transform', 'transformEnd']);
  });
});
