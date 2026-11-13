import { describe, expect, it } from 'vitest';
import { Calendar } from '../src/game/calendar';

describe('日历时钟', () => {
  it('×1 时 5 秒过一天，暂停时不走', () => {
    const c = new Calendar();
    expect(c.advance(4.9, 1)).toEqual([]);
    expect(c.advance(0.2, 1)).toEqual([1]);
    expect(c.advance(100, 0)).toEqual([]);
    expect(c.date()).toEqual({ year: 1960, month: 1, dayOfMonth: 2 });
  });

  it('快进时一次可以跨多天，逐天返回', () => {
    const c = new Calendar();
    expect(c.advance(5, 3)).toEqual([1, 2, 3]);
  });

  it('按真实日历：1960 是闰年，一年 366 天', () => {
    const c = new Calendar();
    c.day = 31 + 28;
    expect(c.date()).toEqual({ year: 1960, month: 2, dayOfMonth: 29 });
    c.day = 366;
    expect(c.date()).toEqual({ year: 1961, month: 1, dayOfMonth: 1 });
    expect(c.isYearStart(366)).toBe(true);
    expect(c.isMonthStart(31)).toBe(true);
    expect(c.isMonthStart(32)).toBe(false);
  });
});
