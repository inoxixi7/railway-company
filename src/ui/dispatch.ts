import { CONFIG } from '../config';
import { formatYen } from '../game/calendar';
import type { Game } from '../game/game';
import type { Line } from '../sim/ops/ops';
import { CAR_TYPES, carType } from '../sim/ops/vehicles';
import { pieceAt, pieceLength } from '../sim/rail/geometry';
import { h } from './dom';
import { icon } from './icons';
import { toast } from './toast';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * 调度总览（全屏）：线路示意图 + 线路配车 + 买车。
 * 没有自己的时钟，显示的就是地图上正在跑的列车。
 */
export class Dispatch {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private list: HTMLElement;
  private timer: number | undefined;
  private buyType = 'steel';
  private buyCars = 4;

  constructor(
    private game: Game,
    private onNewLine: () => void,
  ) {
    this.canvas = h('canvas', { class: 'dp-map' });
    this.list = h('div', { class: 'dp-list' });
    this.el = h(
      'section',
      { id: 'dispatch', class: 'hidden' },
      h('header', { class: 'dp-head' }, h('span', { class: 'sheet-icon', html: icon('dispatch', 22) }), h('h2', {}, '调度总览'), h('button', { type: 'button', class: 'sheet-close', 'aria-label': '关闭', onclick: () => this.close() }, '✕')),
      h('div', { class: 'dp-body' }, this.canvas, this.list),
    );
    document.getElementById('app')!.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(): void {
    this.el.classList.remove('hidden');
    this.renderList();
    this.draw();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      this.draw();
      this.updateLive();
    }, 250);
  }

  close(): void {
    this.el.classList.add('hidden');
    window.clearInterval(this.timer);
  }

  // ------------------------------------------------------------ 示意图

  private draw(): void {
    const { net, ops } = this.game;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (c.width !== w * dpr || c.height !== hgt * dpr) {
      c.width = w * dpr;
      c.height = hgt * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg').trim();
    const mut = css.getPropertyValue('--mut').trim();
    g.clearRect(0, 0, w, hgt);
    // 取景：所有股道的范围
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of net.nodes.values()) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    if (x0 === Infinity) return;
    const pad = 28;
    const scale = Math.min((w - pad * 2) / Math.max(20, x1 - x0), (hgt - pad * 2) / Math.max(20, y1 - y0));
    const ox = (w - (x1 - x0) * scale) / 2 - x0 * scale;
    const oy = (hgt - (y1 - y0) * scale) / 2 - y0 * scale;
    const X = (x: number) => x * scale + ox;
    const Y = (y: number) => y * scale + oy;

    const lineOfTrain = new Map<number, Line | null>();
    for (const t of ops.data.trains) lineOfTrain.set(t.id, ops.line(t.lineId));
    // 股道：空闲为灰色，被列车锁定的用线路颜色
    g.lineCap = 'round';
    for (const e of net.edges.values()) {
      const len = pieceLength(e.piece);
      const owner = ops.ownerOf(e.id);
      const open = this.game.today >= e.openDay;
      g.beginPath();
      const n = Math.max(1, Math.ceil(len / 1));
      for (let i = 0; i <= n; i++) {
        const p = pieceAt(e.piece, (len * i) / n);
        if (i === 0) g.moveTo(X(p.x), Y(p.y));
        else g.lineTo(X(p.x), Y(p.y));
      }
      g.setLineDash(open ? [] : [3, 4]);
      g.lineWidth = owner !== undefined ? 3 : e.role === 'platform' ? 2.5 : 1.5;
      g.strokeStyle = owner !== undefined ? hex(lineOfTrain.get(owner)?.color ?? 0x888888) : e.role === 'platform' ? fg : mut;
      g.stroke();
    }
    g.setLineDash([]);
    // 车站名
    g.font = '600 11px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
    g.textAlign = 'center';
    for (const st of net.stations.values()) {
      g.fillStyle = fg;
      g.fillText(st.name, X(st.x), Y(st.y) - 9);
    }
    for (const d of net.depots.values()) {
      const e = net.edges.get(d.edgeId);
      if (!e) continue;
      const p = pieceAt(e.piece, pieceLength(e.piece) / 2);
      g.fillStyle = mut;
      g.fillText('基地', X(p.x), Y(p.y) + 14);
    }
    // 列车
    for (const t of ops.data.trains) {
      if (t.state === 'depot') continue;
      const loc = ops.locate(t, 0);
      if (!loc) continue;
      const p = pieceAt(loc.edge.piece, loc.s);
      const line = lineOfTrain.get(t.id);
      g.beginPath();
      g.arc(X(p.x), Y(p.y), 7, 0, Math.PI * 2);
      g.fillStyle = hex(line?.color ?? 0x888888);
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = t.state === 'wait' ? '#ff3b30' : '#ffffff';
      g.stroke();
      g.fillStyle = '#ffffff';
      g.font = '700 9px -apple-system, sans-serif';
      g.fillText(t.name.replace('号列车', ''), X(p.x), Y(p.y) + 3);
      g.font = '600 11px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
    }
  }

  // ------------------------------------------------------------ 列表

  private lineSummary(line: Line): string {
    const { ops } = this.game;
    const trains = ops.trainsOn(line.id);
    const hw = ops.headwaySec(line);
    const waiting = trains.filter((t) => t.state === 'wait').length;
    const parts = [`列车 ${trains.length} / ${ops.maxTrains(line)}`];
    parts.push(hw ? `约每 ${Math.max(1, Math.round(hw / 60))} 分一班` : trains.length ? '走不通' : '还没有车');
    if (waiting) parts.push(`${waiting} 列在等进路`);
    return parts.join(' · ');
  }

  private updateLive(): void {
    for (const el of this.list.querySelectorAll<HTMLElement>('[data-line]')) {
      const line = this.game.ops.line(Number(el.dataset.line));
      if (line) el.textContent = this.lineSummary(line);
    }
  }

  private renderList(): void {
    const { net, ops } = this.game;
    const list = this.list;
    list.replaceChildren();
    const parked = () => ops.data.trains.filter((t) => t.state === 'depot' && t.lineId === null);

    list.append(h('h3', {}, '线路'));
    if (!ops.data.lines.length) list.append(h('p', { class: 'note' }, '还没有线路。先建好车站和股道，再新建线路、配车。'));
    for (const line of ops.data.lines) {
      const names = line.stops.map((id) => net.stations.get(id)?.name ?? '（已拆除）').join(' → ');
      list.append(
        h(
          'div',
          { class: 'dp-card' },
          h('i', { class: 'dp-color', style: `background:${hex(line.color)}` }),
          h('div', { class: 'dp-main' }, h('b', {}, line.name), h('span', { class: 'dp-stops' }, names), h('span', { class: 'dp-sub', 'data-line': String(line.id) }, this.lineSummary(line))),
          h(
            'div',
            { class: 'dp-actions' },
            h(
              'button',
              {
                type: 'button',
                'aria-label': '减少一列',
                onclick: () => {
                  const t = ops.trainsOn(line.id).pop();
                  if (t) ops.assign(t.id, null);
                  this.renderList();
                },
              },
              '−',
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-label': '增加一列',
                onclick: () => {
                  const t = parked()[0];
                  if (!t) toast('车辆基地里没有空闲的列车，先买车');
                  else {
                    const err = ops.assign(t.id, line.id);
                    if (err) toast(err, 3000);
                  }
                  this.renderList();
                },
              },
              '＋',
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-label': '删除线路',
                class: 'danger',
                onclick: () => {
                  ops.removeLine(line.id);
                  this.renderList();
                },
              },
              '删',
            ),
          ),
        ),
      );
    }
    list.append(
      h(
        'button',
        {
          type: 'button',
          class: 'btn go dp-new',
          onclick: () => {
            if (net.stations.size < 2) {
              toast('至少要有两个车站');
              return;
            }
            this.close();
            this.onNewLine();
          },
        },
        '新建线路（在地图上依次点站）',
      ),
    );

    list.append(h('h3', {}, '车辆'));
    const depots = [...net.depots.values()];
    if (!depots.length) {
      list.append(h('p', { class: 'note' }, '还没有车辆基地。在「车站」工具里选「车辆基地」，点直线股道旁的平地建一个。'));
      return;
    }
    const ct = carType(this.buyType);
    this.buyCars = Math.max(ct.minCars, Math.min(ct.maxCars, this.buyCars));
    const typeSeg = h(
      'div',
      { class: 'seg' },
      ...CAR_TYPES.map((c) =>
        h(
          'button',
          {
            type: 'button',
            class: c.id === this.buyType ? 'on' : '',
            onclick: () => {
              this.buyType = c.id;
              this.renderList();
            },
          },
          c.name,
        ),
      ),
    );
    const step = (d: number) => () => {
      this.buyCars += d;
      this.renderList();
    };
    list.append(
      typeSeg,
      h('p', { class: 'note' }, `${ct.maxSpeedKmh} km/h · 定员 ${ct.capacityPerCar * this.buyCars} 人 · ${formatYen(ct.pricePerCar * this.buyCars)}円`),
      h(
        'div',
        { class: 'btns' },
        h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': '减少一节', onclick: step(-1) }, '−'), h('span', {}, `${this.buyCars} 节`), h('button', { type: 'button', 'aria-label': '增加一节', onclick: step(1) }, '＋')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn go',
            onclick: () => {
              // 买到最空的基地
              const depot = depots
                .filter((d) => this.game.today >= d.openDay)
                .sort((a, b) => ops.data.trains.filter((t) => t.depotId === a.id).length - ops.data.trains.filter((t) => t.depotId === b.id).length)[0];
              if (!depot) {
                toast('车辆基地尚未落成');
                return;
              }
              const r = this.game.buyTrain(depot.id, this.buyType, this.buyCars);
              toast(typeof r === 'string' ? r : `购入${r.name}，停在车辆基地`);
              this.renderList();
            },
          },
          '购买列车',
        ),
      ),
    );
    const all = ops.data.trains;
    list.append(h('p', { class: 'note' }, `共 ${all.length} 列：空闲 ${parked().length} 列，基地每个可停 ${CONFIG.ops.depot.capacity} 列。累计投资 ${formatYen(this.game.spent)}円`));
  }
}
