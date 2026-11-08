/**
 * 游戏日历（参考星露谷）：每月 10 天、一年 12 个月共 120 天。
 * 游戏时间 = 从 1960 年 1 月 1 日 00:00 起的秒数。
 */
export const DAY_SEC = 86400;
export const DAYS_PER_MONTH = 10;
export const MONTH_SEC = DAYS_PER_MONTH * DAY_SEC;
export const YEAR_SEC = 12 * MONTH_SEC;

export function dateParts(sec: number): { year: number; month: number; day: number } {
  const d = Math.floor(sec / DAY_SEC);
  return { year: 1960 + Math.floor(d / 120), month: Math.floor((d % 120) / DAYS_PER_MONTH) + 1, day: (d % DAYS_PER_MONTH) + 1 };
}

export function formatDate(sec: number): string {
  const d = dateParts(sec);
  return `${d.year}年${d.month}月${d.day}日`;
}

export function formatClock(sec: number): string {
  const t = sec % DAY_SEC;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const days = Math.ceil(sec / 86400);
  if (days >= 2 * DAYS_PER_MONTH) return `约 ${Math.round(days / DAYS_PER_MONTH)} 个月`;
  return `${days} 天`;
}

export function formatYen(v: number): string {
  if (Math.abs(v) >= 100_000_000) return `${(v / 100_000_000).toFixed(2)} 亿円`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 10_000).toLocaleString('zh-CN')} 万円`;
  return `${Math.round(v)} 円`;
}
