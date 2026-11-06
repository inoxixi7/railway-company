/**
 * 唯一的信息面板：竖屏从底部弹出（上拉展开），横屏在右侧。
 * 一次只显示一个面板内容。
 */
export class Panel {
  private el = document.getElementById('panel')!;
  private title = document.getElementById('panel-title')!;
  private summary = document.getElementById('panel-summary')!;
  private body = document.getElementById('panel-body')!;
  /** 当前内容的标识，例如 "cell" / "settings" */
  kind: string | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    this.el.querySelector('.close')!.addEventListener('click', () => this.close());
    this.el.querySelector('.handle')!.addEventListener('click', () => this.el.classList.toggle('expanded'));
    // 在面板上向上/向下滑动来展开/收起
    let startY: number | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('#panel-body')) return;
      startY = e.clientY;
    });
    this.el.addEventListener('pointerup', (e) => {
      if (startY === null) return;
      const dy = e.clientY - startY;
      if (dy < -24) this.el.classList.add('expanded');
      if (dy > 24) this.el.classList.remove('expanded');
      startY = null;
    });
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  get isExpanded(): boolean {
    return this.el.classList.contains('expanded');
  }

  show(kind: string, title: string, summary: string, body: HTMLElement | string, expanded: boolean): void {
    this.kind = kind;
    this.title.textContent = title;
    this.summary.textContent = summary;
    if (typeof body === 'string') this.body.innerHTML = body;
    else this.body.replaceChildren(body);
    this.el.classList.remove('hidden');
    this.el.classList.toggle('expanded', expanded);
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    this.el.classList.remove('expanded');
    this.kind = null;
    this.onClose?.();
  }
}
