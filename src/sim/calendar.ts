/** 游戏时间：从 1960-01-01 00:00 起的秒数 */
const EPOCH = Date.UTC(1960, 0, 1);

export function toDate(sec: number): Date {
  return new Date(EPOCH + sec * 1000);
}

export function formatDate(sec: number): string {
  const d = toDate(sec);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function formatClock(sec: number): string {
  const d = toDate(sec);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const days = Math.ceil(sec / 86400);
  if (days >= 60) return `约 ${Math.round(days / 30)} 个月`;
  return `${days} 天`;
}

export function formatYen(v: number): string {
  if (Math.abs(v) >= 100_000_000) return `${(v / 100_000_000).toFixed(2)} 亿円`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 10_000).toLocaleString('zh-CN')} 万円`;
  return `${Math.round(v)} 円`;
}
