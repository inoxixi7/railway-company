type Attr = string | boolean | ((e: Event) => void);

/** 创建元素。on 开头的属性是事件；html 属性写入 innerHTML */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, Attr> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v as string;
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** 数据格子：小标题 + 大数值（可带单位） */
export function stat(label: string, value: string, unit = '', cls = ''): HTMLElement {
  const v = h('div', { class: `v num ${cls}` }, value);
  if (unit) v.append(' ', h('small', {}, unit));
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, label), v);
}
