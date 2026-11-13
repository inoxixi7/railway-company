import { CONFIG } from '../config';

/**
 * 日历时钟：以「天」为单位的连续时间（从开局年 1 月 1 日算起）。
 * 纯逻辑，可序列化（只有 day 一个数）。
 */
export class Calendar {
  /** 从开局日起经过的天数（含小数） */
  day = 0;

  /** 推进现实时间 realSec 秒；返回这次跨过了哪些整天（用于按天结算） */
  advance(realSec: number, speed: number): number[] {
    if (speed <= 0 || realSec <= 0) return [];
    const before = Math.floor(this.day);
    this.day += (realSec * speed) / CONFIG.calendar.secondsPerDay;
    const after = Math.floor(this.day);
    const crossed: number[] = [];
    for (let d = before + 1; d <= after; d++) crossed.push(d);
    return crossed;
  }

  date(day = this.day): { year: number; month: number; dayOfMonth: number } {
    const d = new Date(Date.UTC(CONFIG.calendar.startYear, 0, 1) + Math.floor(day) * 86400000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, dayOfMonth: d.getUTCDate() };
  }

  /** 这一天是否是月初 / 年初（用于月结、年结） */
  isMonthStart(day: number): boolean {
    return this.date(day).dayOfMonth === 1;
  }

  isYearStart(day: number): boolean {
    const d = this.date(day);
    return d.month === 1 && d.dayOfMonth === 1;
  }
}

export function formatYen(v: number): string {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${sign}${(a / 100_000_000).toFixed(a >= 10_000_000_000 ? 0 : 1)} 亿`;
  if (a >= 10_000) return `${sign}${Math.round(a / 10_000).toLocaleString('zh-CN')} 万`;
  return `${sign}${Math.round(a)}`;
}
