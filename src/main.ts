import './ui/style.css';
import { CONFIG } from './config';
import { Calendar } from './game/calendar';
import { GestureRecognizer, type GestureEvent } from './input/gestures';
import { nearestSnapYaw, normalizeAngle, shortestAngle } from './render/cameraRig';
import { MapView } from './render/view';
import { generateMap } from './sim/map/generate';
import { MVP_LAYOUT } from './sim/map/layout';
import { cellInfo } from './sim/map/query';
import { COVER_NAMES, RoadKind } from './sim/map/types';
import { h, stat } from './ui/dom';
import { icon } from './ui/icons';
import { loadSettings, resolveTheme, saveSettings, type Settings, type ThemeChoice } from './ui/settings';
import { Sheet } from './ui/sheet';
import { toast } from './ui/toast';

const canvas = document.getElementById('view') as HTMLCanvasElement;

// 先让「正在生成地图」显示出来，再做耗时的生成
requestAnimationFrame(() => setTimeout(start, 0));

function start(): void {
  const map = generateMap();
  const view = new MapView(canvas, map);
  const rig = view.rig;
  const sheet = new Sheet();
  const calendar = new Calendar();
  let settings: Settings = loadSettings();

  // ---------- 设置与主题 ----------
  const fpsEl = document.getElementById('fps')!;
  const applySettings = () => {
    const theme = resolveTheme(settings.theme);
    document.documentElement.dataset.theme = theme;
    view.setSky(theme === 'dark' ? 0x18202b : 0xcfe0ee);
    view.setPowerSave(settings.powerSave);
    fpsEl.classList.toggle('hidden', !settings.showFps);
    view.onFps = settings.showFps ? (fps) => (fpsEl.textContent = `渲染 ${fps} fps`) : null;
  };
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => applySettings());
  applySettings();

  // ---------- 顶栏：资金、日期、速度 ----------
  const moneyBox = document.getElementById('box-money')!;
  const dateBox = document.getElementById('box-date')!;
  const speedBox = document.getElementById('box-speed')!;
  moneyBox.innerHTML = `${icon('yen', 20)}<div><div class="k">资金</div><div class="v num" id="money-v">—</div></div>`;
  dateBox.innerHTML = `${icon('calendar', 20)}<div><div class="k num" id="date-k"></div><div class="v num" id="date-v"></div></div>`;
  const dateK = document.getElementById('date-k')!;
  const dateV = document.getElementById('date-v')!;
  let shownDay = -1;
  const updateDate = () => {
    const day = Math.floor(calendar.day);
    if (day === shownDay) return;
    shownDay = day;
    const d = calendar.date();
    dateK.textContent = `${d.year}年`;
    dateV.textContent = `${d.month}月${d.dayOfMonth}日`;
  };

  const speeds = CONFIG.calendar.speeds;
  const speedLabels = ['Ⅱ', '▶', '▶▶'];
  const speedNames = ['暂停', '正常速度', '快进'];
  let speedIdx = 1;
  let lastRunning = 1;
  let ticking = false;
  const setSpeed = (i: number) => {
    speedIdx = i;
    if (speeds[i] > 0) lastRunning = i;
    [...speedBox.children].forEach((b, k) => b.classList.toggle('on', k === i));
    if (speeds[i] > 0 && !ticking) {
      ticking = true;
      let last = performance.now();
      view.animate((now) => {
        const sp = speeds[speedIdx];
        if (sp === 0) {
          ticking = false;
          return false;
        }
        // 帧间隔过长（切后台、卡顿）时不补算
        calendar.advance(Math.min(0.25, (now - last) / 1000), sp);
        last = now;
        updateDate();
        return true;
      });
    }
  };
  speeds.forEach((_, i) => {
    speedBox.append(h('button', { type: 'button', 'aria-label': speedNames[i], onclick: () => setSpeed(i) }, speedLabels[i]));
  });
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
  /** 以屏幕中心为轴，动画旋转到目标朝向 */
  const animateYawTo = (target: number) => {
    const id = ++yawAnim;
    const delta = shortestAngle(rig.state.yaw, target);
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

  // ---------- 面板内容 ----------
  sheet.onClose = (kind) => {
    if (kind === 'cell') view.setSelection(null);
    markTiles();
  };

  const showCell = (cx: number, cy: number, detail: boolean) => {
    const info = cellInfo(map, cx, cy);
    const terminal = map.terminals.find((t) => cx >= t.rect.x && cx < t.rect.x + t.rect.w && cy >= t.rect.y && cy < t.rect.y + t.rect.h);
    const name = terminal ? terminal.name : COVER_NAMES[info.cover];
    const water = info.waterLevel !== null;
    const grid = h('div', { class: 'grid' });
    grid.append(stat(water ? '水面海拔' : '海拔', (water ? info.waterLevel! : info.elevation).toFixed(1), 'm'));
    if (water) grid.append(stat('水深', (info.waterLevel! - info.elevation).toFixed(1), 'm'));
    else grid.append(stat('坡度', info.slopePermil.toFixed(0), '‰', info.slopePermil > 25 ? 'warn' : ''));
    if (detail) {
      if (info.road !== RoadKind.None) grid.append(stat('道路', info.road === RoadKind.Bridge ? '既有道路桥' : '既有道路'));
      if (terminal) grid.append(stat('站台', `${terminal.platforms}`, '条'), stat('接线', '从西端接入'));
      grid.append(stat('距西边', ((cx * map.cellMeters) / 1000).toFixed(2), 'km'), stat('距北边', ((cy * map.cellMeters) / 1000).toFixed(2), 'km'));
    }
    const body = h('div', {}, grid);
    if (!water && info.slopePermil > 25) body.append(h('p', { class: 'note' }, '坡度超过普通铁路的上限 25‰，线路经过这里需要桥隧或绕行。'));
    view.setSelection({ x: cx, y: cy });
    sheet.show('cell', 'pin', name, `格 (${cx}, ${cy})`, body);
    markTiles();
  };

  const showSettings = () => {
    const body = h('div');
    const themeSeg = h('div', { class: 'seg' });
    const themes: [ThemeChoice, string][] = [['auto', '自动'], ['light', '浅色'], ['dark', '深色']];
    const renderTheme = () => {
      themeSeg.replaceChildren(
        ...themes.map(([v, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: settings.theme === v ? 'on' : '',
              onclick: () => {
                settings = { ...settings, theme: v };
                saveSettings(settings);
                applySettings();
                renderTheme();
              },
            },
            label,
          ),
        ),
      );
    };
    renderTheme();
    body.append(h('div', { class: 'setting' }, h('div', {}, '界面主题', h('small', {}, '自动 = 跟随系统')), themeSeg));
    const toggle = (key: 'snapRotation' | 'powerSave' | 'showFps', label: string, hint: string) => {
      const input = h('input', { type: 'checkbox', 'aria-label': label });
      input.checked = settings[key];
      input.addEventListener('change', () => {
        settings = { ...settings, [key]: input.checked };
        saveSettings(settings);
        applySettings();
      });
      body.append(h('label', { class: 'setting' }, h('div', {}, label, h('small', {}, hint)), h('span', { class: 'switch' }, input, h('span'))));
    };
    toggle('snapRotation', '旋转吸附', '双指旋转松手后对齐到四个方向');
    toggle('powerSave', '省电模式', '降低渲染分辨率，减少发热');
    toggle('showFps', '显示帧率', '画面不变时不重绘，帧率低是正常的');
    view.setSelection(null);
    sheet.show('settings', 'settings', '设置', '', body);
    markTiles();
  };

  const showMore = () => {
    const item = (ic: string, label: string, fn: () => void) => h('button', { type: 'button', class: 'btn', html: `${icon(ic, 20)}<span>${label}</span>`, onclick: fn });
    const body = h(
      'div',
      { class: 'list' },
      item('home', '回到起点小镇', () => {
        home();
        sheet.close();
      }),
      item('rotate', '视角旋转 90°', () => rotateStep(1)),
      item('settings', '设置', showSettings),
    );
    view.setSelection(null);
    sheet.show('more', 'more', '更多', '', body);
    markTiles();
  };

  // ---------- 工具栏 ----------
  const toolbar = document.getElementById('toolbar')!;
  const tiles: { id: string; ic: string; label: string; soon?: string }[] = [
    { id: 'track', ic: 'track', label: '铺轨', soon: '铺轨在第 2 步重做（任意角度、可分岔）' },
    { id: 'station', ic: 'station', label: '车站', soon: '车站在第 2 步重做' },
    { id: 'land', ic: 'land', label: '土地', soon: '买地与分区在第 3 步重做' },
    { id: 'dispatch', ic: 'dispatch', label: '调度', soon: '调度（运行指令所）在第 2 步加入' },
    { id: 'more', ic: 'more', label: '更多' },
  ];
  for (const t of tiles) {
    toolbar.append(
      h('button', {
        type: 'button',
        class: `tile${t.soon ? ' soon' : ''}`,
        'data-id': t.id,
        'aria-label': t.label,
        html: `${icon(t.ic, 24)}<span>${t.label}</span>`,
        onclick: () => {
          if (t.soon) toast(t.soon);
          else if (sheet.kind === 'more' || sheet.kind === 'settings') sheet.close();
          else showMore();
        },
      }),
    );
  }
  function markTiles(): void {
    for (const el of toolbar.children) {
      const id = (el as HTMLElement).dataset.id;
      el.classList.toggle('on', id === 'more' && (sheet.kind === 'more' || sheet.kind === 'settings'));
    }
  }

  // ---------- 手势 ----------
  let rotated = 0;
  const inspect = (sx: number, sy: number, detail: boolean) => {
    const p = view.pickPoint(sx, sy);
    if (p) showCell(Math.floor(p.x), Math.floor(p.y), detail);
  };
  const onGesture = (e: GestureEvent) => {
    switch (e.type) {
      case 'tap':
        // 点空白处关闭面板
        if (sheet.isOpen) sheet.close();
        else inspect(e.x, e.y, false);
        return;
      case 'longPress':
        navigator.vibrate?.(10);
        inspect(e.x, e.y, true);
        return;
      case 'drag':
        rig.panByScreen(e.dx, e.dy);
        view.invalidate();
        return;
      case 'transformStart':
        yawAnim++;
        rotated = 0;
        return;
      case 'transform':
        rig.panByScreen(e.dx, e.dy);
        rig.zoomAt(e.cx, e.cy, e.scale);
        rig.rotateAt(e.cx, e.cy, e.rotation);
        rotated += Math.abs(e.rotation);
        view.invalidate();
        return;
      case 'transformEnd':
        if (settings.snapRotation && rotated > 0.01) animateYawTo(nearestSnapYaw(rig.state.yaw));
        return;
      default:
    }
  };
  const gestures = new GestureRecognizer(onGesture);

  const local = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let longPressTimer: number | undefined;
  let mouseRotate: { x: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    if (e.pointerType === 'mouse' && e.button === 2) {
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
    if (mouseRotate) {
      mouseRotate = null;
      if (settings.snapRotation) animateYawTo(nearestSnapYaw(rig.state.yaw));
      return;
    }
    const p = local(e);
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
  // iOS Safari 的系统缩放手势
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());

  // 键盘（桌面）
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
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
    else if (k === ' ') setSpeed(speeds[speedIdx] === 0 ? lastRunning : 0);
    else if (k === 'escape') sheet.close();
    else return;
    e.preventDefault();
    view.invalidate();
  });

  // 尺寸与方向变化：镜头、选中、面板都保持不变
  new ResizeObserver(() => view.resize()).observe(canvas);

  document.getElementById('loading')!.remove();
  view.resize();
  updateDate();
  setSpeed(1);
  toast('单指拖动移动，双指缩放和旋转，点击查看地块');

  // 仅开发模式：供自动化测试读取状态
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dev = { view, rig, map, calendar, sheet, setSpeed };
}
