import './style.css';
import { CONFIG } from './config';
import { GestureRecognizer, type GestureEvent } from './input/gestures';
import { nearestSnapYaw, normalizeAngle, shortestAngle } from './render/cameraRig';
import { MapView } from './render/view';
import { formatClock, formatDate } from './sim/calendar';
import { generateMap } from './sim/map/generate';
import { MVP_LAYOUT } from './sim/map/layout';
import { lineAlignment } from './sim/rail/line';
import { sampleAlignment } from './sim/track/alignment';
import { World } from './sim/world';
import { describeCell } from './ui/cellPanel';
import { h } from './ui/dom';
import { showOpsPanel, showStationPanel, showTrainPanel } from './ui/opsPanel';
import { Panel } from './ui/panel';
import { loadSettings, saveSettings, type Settings } from './ui/settings';
import { toast } from './ui/toast';
import { DepotTool, StationTool, TrackTool, type Tool, type ToolId } from './ui/tools';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;
const fpsEl = document.getElementById('fps')!;

// 先让「正在生成地图」显示出来，再做耗时的生成
requestAnimationFrame(() => setTimeout(start, 0));

function start(): void {
  const map = generateMap();
  const world = new World(map);
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

  // ---------- 世界事件 ----------
  world.on((e) => {
    updateHud();
    if (e.type === 'lineChanged') view.rebuildRail(world);
    if (e.type === 'terrainChanged') view.rebuildTerrain();
    if (e.type === 'opened') toast(e.what, 2500);
    if (e.type === 'notice') toast(e.text, 2500);
  });

  // ---------- 时间 ----------
  const speeds = CONFIG.ops.speeds;
  let speedIdx = 1;
  let lastSpeedIdx = 1;
  let acc = 0;
  let lastFrame = 0;
  let running = false;
  const speedEl = document.getElementById('stat-speed')!;
  const dateEl = document.getElementById('stat-date')!;
  const clockEl = document.getElementById('stat-clock')!;
  const speedbar = document.getElementById('speedbar')!;
  /** 面板内容的定时刷新 */
  let panelRefresh: (() => void) | null = null;
  let lastPanelRefresh = 0;

  function updateHud() {
    dateEl.textContent = formatDate(world.time);
    clockEl.textContent = formatClock(world.time);
    speedEl.textContent = speeds[speedIdx] === 0 ? '⏸ 暂停' : `▶ ×${speeds[speedIdx]}`;
  }

  const setSpeed = (i: number) => {
    speedIdx = i;
    if (speeds[i] > 0) lastSpeedIdx = i;
    updateHud();
    renderSpeedbar();
    if (speeds[i] > 0 && !running) startLoop();
  };

  const renderSpeedbar = () => {
    speedbar.replaceChildren(
      ...speeds.map((v, i) =>
        h(
          'button',
          {
            type: 'button',
            class: i === speedIdx ? 'active' : '',
            'aria-label': v === 0 ? '暂停' : `${v} 倍速`,
            onclick: () => {
              setSpeed(i);
              speedbar.classList.add('hidden');
            },
          },
          v === 0 ? '⏸' : `×${v}`,
        ),
      ),
    );
  };
  document.getElementById('stat-speed-btn')!.addEventListener('click', () => {
    renderSpeedbar();
    speedbar.classList.toggle('hidden');
  });

  const startLoop = () => {
    running = true;
    lastFrame = performance.now();
    view.animate((now) => {
      const sp = speeds[speedIdx];
      if (sp === 0) {
        running = false;
        return false;
      }
      const realDt = Math.min(0.25, (now - lastFrame) / 1000);
      lastFrame = now;
      // 1 倍速：现实 1 秒 = 游戏 1 分钟
      acc += realDt * 60 * sp;
      const t0 = performance.now();
      let steps = 0;
      while (acc >= 1) {
        world.step();
        acc -= 1;
        steps++;
        // 超出每帧预算时丢弃剩余时间（设备跟不上该倍速）
        if ((steps & 63) === 0 && performance.now() - t0 > CONFIG.ops.frameBudgetMs) {
          acc = 0;
          break;
        }
      }
      view.updateTrains(world);
      updateHud();
      if (panelRefresh && now - lastPanelRefresh > 500) {
        lastPanelRefresh = now;
        panelRefresh();
      }
      return true;
    });
  };

  // 切到后台：自动暂停
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && speeds[speedIdx] > 0) setSpeed(0);
  });

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
  const rotateStep = (dir: 1 | -1) => animateYawTo(nearestSnapYaw(rig.state.yaw) + (dir * Math.PI) / 2);

  // ---------- 工具与面板 ----------
  let tool: Tool | null = null;
  const toolbar = document.getElementById('toolbar')!;
  const markActive = () => {
    for (const b of toolbar.querySelectorAll('button')) {
      const a = (b as HTMLElement).dataset.action;
      b.classList.toggle('active', (!!tool && a === tool.id) || (a === 'ops' && panel.kind === 'ops') || (a === 'settings' && panel.kind === 'settings'));
    }
  };
  const exitTool = () => {
    tool?.dispose();
    tool = null;
    if (panel.kind === 'tool') panel.close();
    markActive();
  };
  const enterTool = (id: ToolId) => {
    exitTool();
    panelRefresh = null;
    select(null);
    if (id === 'track') tool = new TrackTool(world, view, panel, exitTool);
    if (id === 'station') tool = new StationTool(world, view, panel, exitTool);
    if (id === 'depot') tool = new DepotTool(world, view, panel, exitTool);
    markActive();
  };

  const select = (cell: { x: number; y: number } | null) => {
    selected = cell;
    view.setSelection(cell);
  };
  panel.onClose = () => {
    panelRefresh = null;
    select(null);
    if (tool) {
      tool.dispose();
      tool = null;
    }
    markActive();
  };

  const showCell = (cell: { x: number; y: number }, expanded: boolean) => {
    select(cell);
    panelRefresh = null;
    const d = describeCell(map, cell.x, cell.y);
    panel.show('cell', d.title, d.summary, d.body, expanded);
  };

  const showSettings = () => {
    exitTool();
    select(null);
    panelRefresh = null;
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
    markActive();
  };

  /** 点击：优先列车，其次车站，最后地块 */
  const inspect = (sx: number, sy: number, expanded: boolean) => {
    // 列车（屏幕距离 32px 以内）
    let bestTrain: { id: number; d: number } | null = null;
    for (const [id, p] of view.trains.positions) {
      const s = view.toScreen(p);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < 32 && (!bestTrain || d < bestTrain.d)) bestTrain = { id, d };
    }
    if (bestTrain) {
      const t = world.ops.trains.find((x) => x.id === bestTrain!.id)!;
      select(null);
      panelRefresh = showTrainPanel(world, panel, t);
      return;
    }
    const p = view.pickPoint(sx, sy);
    if (!p) return;
    if (world.line) {
      const al = lineAlignment(map, world.line);
      for (const st of world.line.stations) {
        const q = sampleAlignment(al, st.s);
        const dx = Math.abs(p.x - q.x);
        const dy = Math.abs(p.y - q.y);
        const L = CONFIG.rail.stationLengthCells / 2;
        const inside = st.orient === 'h' ? dx <= L && dy <= 1.2 : dy <= L && dx <= 1.2;
        if (inside) {
          select(null);
          panelRefresh = showStationPanel(world, panel, st);
          return;
        }
      }
    }
    showCell({ x: Math.floor(p.x), y: Math.floor(p.y) }, expanded);
  };

  // ---------- 手势 ----------
  let rotatedInGesture = 0;
  let toolDrag = false;
  const onGesture = (e: GestureEvent) => {
    switch (e.type) {
      case 'tap': {
        speedbar.classList.add('hidden');
        if (tool) {
          const p = view.pickPoint(e.x, e.y);
          if (p) tool.tap(p.x, p.y);
          return;
        }
        // 点空白处关闭面板
        if (panel.isOpen) {
          panel.close();
          return;
        }
        inspect(e.x, e.y, false);
        return;
      }
      case 'longPress':
        navigator.vibrate?.(10);
        inspect(e.x, e.y, true);
        return;
      case 'dragStart': {
        // 铺轨工具中：单指拖动 = 画线
        toolDrag = !!tool?.dragStart;
        if (toolDrag) {
          const p = view.pickPoint(e.x, e.y);
          if (p) tool!.dragStart!(p.x, p.y);
        }
        return;
      }
      case 'drag':
        if (toolDrag) {
          const p = view.pickPoint(e.x, e.y);
          if (p) tool?.drag?.(p.x, p.y);
          return;
        }
        rig.panByScreen(e.dx, e.dy);
        view.invalidate();
        return;
      case 'dragEnd':
        if (toolDrag) tool?.dragEnd?.();
        toolDrag = false;
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
    if (e.pointerType === 'mouse' && (e.button === 2 || (e.shiftKey && !tool))) {
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
  canvas.addEventListener('pointerup', (e) => {
    const p = local(e);
    if (mouseRotate) {
      mouseRotate = null;
      if (settings.snapRotation) animateYawTo(nearestSnapYaw(rig.state.yaw));
      return;
    }
    gestures.up(e.pointerId, p.x, p.y, e.timeStamp);
  });
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
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
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
    else if (k === ' ') setSpeed(speeds[speedIdx] === 0 ? lastSpeedIdx : 0);
    else if (k === 'escape') {
      exitTool();
      panel.close();
    } else return;
    e.preventDefault();
    view.invalidate();
  });

  toolbar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    const action = btn?.dataset.action;
    speedbar.classList.add('hidden');
    switch (action) {
      case 'track':
      case 'station':
      case 'depot':
        if (tool?.id === action) exitTool();
        else enterTool(action);
        break;
      case 'ops':
        if (panel.kind === 'ops') panel.close();
        else {
          exitTool();
          select(null);
          panelRefresh = showOpsPanel(world, panel);
        }
        markActive();
        break;
      case 'home':
        home();
        toast('回到起点小镇');
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

  new ResizeObserver(() => view.resize()).observe(canvas);

  loading.remove();
  view.resize();
  updateHud();
  setSpeed(1);
  toast('点「铺轨」开始修第一条线');

  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dev = { view, rig, map, world, getSelected: () => selected, setSpeed };
}
