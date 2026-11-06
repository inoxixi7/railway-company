import { CONFIG } from '../config';

/**
 * 手势识别（纯逻辑，不依赖 DOM，可在 Node 中测试）。
 *
 * 单指：tap / longPress / drag（拖动的含义由使用方按当前工具决定：无工具时移动地图，铺轨时画线）
 * 双指：transform（同时给出平移、缩放、旋转），抬起全部手指时 transformEnd
 */
export type GestureEvent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'longPress'; x: number; y: number }
  | { type: 'dragStart'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; dx: number; dy: number }
  | { type: 'dragEnd'; x: number; y: number }
  | { type: 'transformStart'; cx: number; cy: number }
  /** dx/dy：中点位移；scale：本次两指距离比；rotation：本次旋转（弧度，画面顺时针为正） */
  | { type: 'transform'; cx: number; cy: number; dx: number; dy: number; scale: number; rotation: number }
  | { type: 'transformEnd' };

interface Pointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
}

type Mode = 'idle' | 'pending' | 'drag' | 'transform' | 'done';

export class GestureRecognizer {
  private pointers = new Map<number, Pointer>();
  private mode: Mode = 'idle';
  private lastMid = { x: 0, y: 0 };
  private lastDist = 1;
  private lastAngle = 0;

  constructor(
    private readonly emit: (e: GestureEvent) => void,
    private readonly opts = { dragThresholdPx: CONFIG.gesture.dragThresholdPx, longPressMs: CONFIG.gesture.longPressMs },
  ) {}

  get activeMode(): Mode {
    return this.mode;
  }

  down(id: number, x: number, y: number, t: number): void {
    this.pointers.set(id, { id, x, y, startX: x, startY: y, startT: t });
    if (this.pointers.size === 1 && this.mode === 'idle') {
      this.mode = 'pending';
    } else if (this.pointers.size === 2) {
      if (this.mode === 'drag') {
        const p = this.firstPointer();
        this.emit({ type: 'dragEnd', x: p.x, y: p.y });
      }
      if (this.mode === 'pending' || this.mode === 'drag') this.beginTransform();
    }
    // 第三根手指及以后忽略
  }

  move(id: number, x: number, y: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    const px = p.x;
    const py = p.y;
    p.x = x;
    p.y = y;
    if (this.mode === 'pending') {
      if (Math.hypot(x - p.startX, y - p.startY) > this.opts.dragThresholdPx) {
        this.mode = 'drag';
        this.emit({ type: 'dragStart', x: p.startX, y: p.startY });
        this.emit({ type: 'drag', x, y, dx: x - p.startX, dy: y - p.startY });
      }
    } else if (this.mode === 'drag') {
      this.emit({ type: 'drag', x, y, dx: x - px, dy: y - py });
    } else if (this.mode === 'transform' && this.pointers.size >= 2) {
      const [a, b] = this.twoPointers();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let rot = angle - this.lastAngle;
      if (rot > Math.PI) rot -= Math.PI * 2;
      if (rot < -Math.PI) rot += Math.PI * 2;
      this.emit({
        type: 'transform',
        cx: mid.x,
        cy: mid.y,
        dx: mid.x - this.lastMid.x,
        dy: mid.y - this.lastMid.y,
        scale: dist / this.lastDist,
        rotation: rot,
      });
      this.lastMid = mid;
      this.lastDist = dist;
      this.lastAngle = angle;
    }
  }

  up(id: number, x: number, y: number, t: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    this.pointers.delete(id);
    if (this.mode === 'pending') {
      if (t - p.startT < this.opts.longPressMs) this.emit({ type: 'tap', x, y });
      this.mode = 'idle';
    } else if (this.mode === 'drag') {
      this.emit({ type: 'dragEnd', x, y });
      this.mode = this.pointers.size ? 'done' : 'idle';
    } else if (this.mode === 'transform') {
      if (this.pointers.size === 0) {
        this.emit({ type: 'transformEnd' });
        this.mode = 'idle';
      } else if (this.pointers.size === 1) {
        // 剩一根手指：不切回单指拖动，避免画面跳动；等全部抬起
        this.emit({ type: 'transformEnd' });
        this.mode = 'done';
      }
    } else if (this.mode === 'done' && this.pointers.size === 0) {
      this.mode = 'idle';
    }
  }

  cancel(): void {
    if (this.mode === 'drag') {
      const p = this.firstPointer();
      this.emit({ type: 'dragEnd', x: p.x, y: p.y });
    }
    if (this.mode === 'transform') this.emit({ type: 'transformEnd' });
    this.pointers.clear();
    this.mode = 'idle';
  }

  /** 由宿主定时调用，用于判定长按 */
  tick(t: number): void {
    if (this.mode !== 'pending') return;
    const p = this.firstPointer();
    if (t - p.startT >= this.opts.longPressMs) {
      this.emit({ type: 'longPress', x: p.x, y: p.y });
      this.mode = 'done';
    }
  }

  private beginTransform(): void {
    const [a, b] = this.twoPointers();
    this.mode = 'transform';
    this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.lastDist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    this.lastAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.emit({ type: 'transformStart', cx: this.lastMid.x, cy: this.lastMid.y });
  }

  private firstPointer(): Pointer {
    return this.pointers.values().next().value as Pointer;
  }

  private twoPointers(): [Pointer, Pointer] {
    const it = this.pointers.values();
    return [it.next().value as Pointer, it.next().value as Pointer];
  }
}
