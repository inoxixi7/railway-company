import { icon } from './icons';

/**
 * 唯一的面板：竖屏从底部弹出，横屏在右侧。一次只显示一个内容。
 */
export class Sheet {
  private el = document.getElementById('sheet')!;
  private iconEl = document.getElementById('sheet-icon')!;
  private titleEl = document.getElementById('sheet-title')!;
  private subEl = document.getElementById('sheet-sub')!;
  private body = document.getElementById('sheet-body')!;
  /** 当前内容的标识 */
  kind: string | null = null;
  onClose: ((kind: string) => void) | null = null;

  constructor() {
    this.el.querySelector('.sheet-close')!.addEventListener('click', () => this.close());
    // 在标题区向下滑动关闭
    let startY: number | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      startY = (e.target as HTMLElement).closest('#sheet-body') ? null : e.clientY;
    });
    this.el.addEventListener('pointerup', (e) => {
      if (startY !== null && e.clientY - startY > 40) this.close();
      startY = null;
    });
  }

  get isOpen(): boolean {
    return this.kind !== null;
  }

  show(kind: string, iconName: string, title: string, sub: string, body: Node): void {
    const reopen = this.kind !== kind;
    this.kind = kind;
    this.iconEl.innerHTML = icon(iconName, 22);
    this.titleEl.textContent = title;
    this.subEl.textContent = sub;
    this.body.replaceChildren(body);
    this.el.classList.remove('hidden');
    if (reopen) {
      // 重新播放进入动画
      this.el.style.animation = 'none';
      void this.el.offsetWidth;
      this.el.style.animation = '';
    }
  }

  setSub(sub: string): void {
    this.subEl.textContent = sub;
  }

  close(): void {
    if (this.kind === null) return;
    const kind = this.kind;
    this.kind = null;
    this.el.classList.add('hidden');
    this.onClose?.(kind);
  }
}
