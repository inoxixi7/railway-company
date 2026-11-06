let timer: number | undefined;

/** 短暂提示，不使用常驻卡片 */
export function toast(text: string, ms = 1800): void {
  const el = document.getElementById('toast')!;
  el.textContent = text;
  el.classList.add('show');
  window.clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.remove('show'), ms);
}
