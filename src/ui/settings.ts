export type ThemeChoice = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: ThemeChoice;
  /** 双指旋转松手后吸附到四个方向 */
  snapRotation: boolean;
  /** 省电模式：降低渲染分辨率 */
  powerSave: boolean;
  showFps: boolean;
}

const KEY = 'railway-company:settings';
const DEFAULTS: Settings = { theme: 'auto', snapRotation: true, powerSave: false, showFps: false };

/** 设置只是个人偏好，存在 localStorage；读写失败时使用默认值 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* 隐私模式等情况下不可用 */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

/** 实际生效的主题（auto 跟随系统） */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'auto') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
