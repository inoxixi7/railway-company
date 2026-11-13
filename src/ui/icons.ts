/** 线条图标（24×24），颜色跟随文字 */
const PATHS: Record<string, string> = {
  track: '<path d="M8 3 6 21M16 3l2 18M6.6 8h10.8M6.3 13h11.4M5.9 18h12.2"/>',
  station: '<path d="M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6"/>',
  land: '<path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10"/>',
  dispatch: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  more: '<path stroke-width="2.6" d="M5 12h.01M12 12h.01M19 12h.01"/>',
  yen: '<path d="M6 4l6 8 6-8M12 12v8M7 12h10M7 16h10"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
};

export type IconName = keyof typeof PATHS;

export function icon(name: string, size = 24): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
}
