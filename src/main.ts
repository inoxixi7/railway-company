import './style.css';
import { CONFIG } from './config';
import { GestureRecognizer, type GestureEvent } from './input/gestures';
import { nearestSnapYaw, normalizeAngle, shortestAngle } from './render/cameraRig';
import { MapView } from './render/view';
import { generateMap } from './sim/map/generate';
import { MVP_LAYOUT } from './sim/map/layout';
import { describeCell } from './ui/cellPanel';
import { Panel } from './ui/panel';
import { loadSettings, saveSettings, type Settings } from './ui/settings';
import { toast } from './ui/toast';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const fpsEl = document.getElementById('fps')!;

// 先让「正在生成地图」显示出来，再做耗时的生成
requestAnimationFrame(() => setTimeout(start, 0));

function start(): void {
  const map = generateMap();
  const view = new MapView(canvas, map);
  const rig = view.rig;
  const panel = new Panel();
  let settings: Settings = loadSettings();
  let selected: { x: number; y: number } | null = null;

  const applySettings = () => {
    view.setOptions({ powerSave: settings.powerSave, showFps: settings.showFps });
    fpsEl.classList.toggle('hidden', !settings.showFps);
  };
  view.onFps = (fps) => (fpsEl.textContent = `渲染 ${fps} fps`);
  applySettings();

  // ---------- 镜头 ----------
  const home = () => {
    const t = MVP_LAYOUT.town;
    rig.state.tx = t.x + t.w / 2;
    rig.state.tz = t.y + t.h / 2;
    rig.state.viewCells = CONFIG.camera.initialViewCells;
    view.invalidate();
  };
  home();

  let yawAnim = 0;
  /** 以屏幕中心为轴，动画旋转到目标朝向 */
  const animateYawTo = (target: number) => {
    const id = ++yawAnim;
    const from = rig.state.yaw;
    const delta = shortestAngle(from, target);
    if (Math.abs(delta) < 1e-4) return;
    const t0 = performance.now();
    const { width, height } = rig.viewport;
    let applied = 0;
    view.animate((now) => {
      if (id !== yawAnim) return false;
      const k = Math.min(1, (now - t0) / CONFIG.camera.snapMs);
      const e = 1 - (1 - k) * (1 - k);
      rig.rotateAt(width / 2, height / 2, delta * e - applied);
      applied = delta * e;
      if (k >= 1) rig.state.yaw = normalizeAngle(target);
      return k < 1;
    });
  };

  // ---------- 选择与面板 ----------
  const select = (cell: { x: number; y: number } | null) => {
    selected = cell;
    view.setSelection(cell);
  };
  panel.onClose = () => select(null);

  const showCell = (cell: { x: number; y: number }, expanded: boolean) => {
    select(cell);
    const d = describeCell(map, cell.x, cell.y);
    panel.show('cell', d.title, d.summary, d.body, expanded);
  };

  const showSettings = () => {
    select(null);
    const wrap = document.createElement('div');
    const row = (key: keyof Settings, label: string, hint: string) => {
      const el = document.createElement('label');
      el.className = 'setting';
      el.innerHTML = `<div>${label}<small>${hint}</small></div><span class="switch"><input type="checkbox"><span></span></span>`;
      const input = el.querySelector('input')!;
      input.checked = settings[key];
      input.addEventListener('change', () => {
        settings = { ...settings, [key]: input.checked };
        saveSettings(settings);
        applySettings();
      });
      wrap.appendChild(el);
    };
    row('snapRotation', '旋转吸附', '双指旋转松手后对齐到四个方向');
    row('powerSave', '省电模式', '降低渲染分辨率，减少发热');
    row('showFps', '显示帧率', '画面不变时不重绘，帧率为 0 是正常的');
    panel.show('settings', '设置', '视角与性能', wrap, true);
  };

  // ---------- 手势 ----------
  let rotatedInGesture = 0;
  const onGesture = (e: GestureEvent) => {
    switch (e.type) {
      case 'tap': {
        // 点空白处关闭面板
        if (panel.isOpen) {
          panel.close();
          return;
        }
        const cell = view.pickCell(e.x, e.y);
        if (cell) showCell(cell, false);
        return;
      }
      case 'longPress': {
        const cell = view.pickCell(e.x, e.y);
        if (cell) {
          navigator.vibrate?.(10);
          showCell(cell, true);
        }
        return;
      }
      case 'drag':
        // 当前没有工具：单指拖动 = 移动地图
        rig.panByScreen(e.dx, e.dy);
        view.invalidate();
        return;
      case 'transformStart':
        yawAnim++;
        rotatedInGesture = 0;
        return;
      case 'transform':
        rig.panByScreen(e.dx, e.dy);
        rig.zoomAt(e.cx, e.cy, e.scale);
        rig.rotateAt(e.cx, e.cy, e.rotation);
        rotatedInGesture += Math.abs(e.rotation);
        view.invalidate();
        return;
      case 'transformEnd':
        if (settings.snapRotation && rotatedInGesture > 0.01) animateYawTo(nearestSnapYaw(rig.state.yaw));
        return;
      default:
    }
  };
  const gestures = new GestureRecognizer(onGesture);

  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  let longPressTimer: number | undefined;
  let mouseRotate: { x: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    // 鼠标右键（或 Shift+左键）拖动 = 旋转
    if (e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey)) {
      mouseRotate = { x: p.x };
      yawAnim++;
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gestures.down(e.pointerId, p.x, p.y, e.timeStamp);
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => gestures.tick(performance.now()), CONFIG.gesture.longPressMs + 10);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (mouseRotate) {
      const { width, height } = rig.viewport;
      rig.rotateAt(width / 2, height / 2, (p.x - mouseRotate.x) * 0.008);
      mouseRotate.x = p.x;
      view.invalidate();
      return;
    }
    gestures.move(e.pointerId, p.x, p.y);
  });
  const end = (e: PointerEvent) => {
    const p = local(e);
    if (mouseRotate) {
      mouseRotate = null;
      if (settings.snapRotation) animateYawTo(nearestSnapYaw(rig.state.yaw));
      return;
    }
    gestures.up(e.pointerId, p.x, p.y, e.timeStamp);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => {
    mouseRotate = null;
    gestures.cancel();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      rig.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      view.invalidate();
    },
    { passive: false },
  );
  // iOS Safari 的系统缩放手势
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());

  // 键盘（桌面）：方向键平移，+/- 缩放，Q/E 旋转
  window.addEventListener('keydown', (e) => {
    const { width, height } = rig.viewport;
    const step = 60;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') rig.panByScreen(step, 0);
    else if (k === 'arrowright' || k === 'd') rig.panByScreen(-step, 0);
    else if (k === 'arrowup' || k === 'w') rig.panByScreen(0, step);
    else if (k === 'arrowdown' || k === 's') rig.panByScreen(0, -step);
    else if (k === '+' || k === '=') rig.zoomAt(width / 2, height / 2, 1.25);
    else if (k === '-') rig.zoomAt(width / 2, height / 2, 0.8);
    else if (k === 'q') rotateStep(-1);
    else if (k === 'e') rotateStep(1);
    else if (k === 'escape') panel.close();
    else return;
    view.invalidate();
  });

  const rotateStep = (dir: 1 | -1) => {
    animateYawTo(nearestSnapYaw(rig.state.yaw) + (dir * Math.PI) / 2);
  };

  // ---------- 工具栏 ----------
  document.getElementById('toolbar')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    switch (btn?.dataset.action) {
      case 'home':
        home();
        toast('回到起点小镇');
        break;
      case 'rotate-left':
        rotateStep(-1);
        break;
      case 'rotate-right':
        rotateStep(1);
        break;
      case 'settings':
        if (panel.kind === 'settings') panel.close();
        else showSettings();
        break;
      default:
    }
  });

  // ---------- 尺寸与方向变化：镜头、选中、面板都保持不变 ----------
  new ResizeObserver(() => view.resize()).observe(canvas);

  loading.remove();
  view.resize();
  toast('单指拖动移动，双指缩放和旋转，点击查看地块');

  // 仅开发模式：供自动化测试读取镜头状态
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dev = { view, rig, map, getSelected: () => selected };
}
