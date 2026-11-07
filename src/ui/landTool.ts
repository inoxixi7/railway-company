import { formatYen } from '../sim/calendar';
import { Zone, ZONE_NAMES } from '../sim/land/land';
import type { CellRect } from '../sim/map/types';
import type { World } from '../sim/world';
import { buildLandOverlay } from '../render/buildings';
import { buildFootprint } from '../render/railRender';
import type { MapView } from '../render/view';
import { h } from './dom';
import type { Panel } from './panel';
import { toast } from './toast';
import type { Tool } from './tools';

type Mode = 'buy' | Zone;

const MODES: [Mode, string][] = [
  ['buy', '买地'],
  [Zone.Residential, ZONE_NAMES[Zone.Residential]],
  [Zone.Commercial, ZONE_NAMES[Zone.Commercial]],
  [Zone.Industrial, ZONE_NAMES[Zone.Industrial]],
  [Zone.None, '解除'],
];

/** 土地工具：拖框选格，买地或指定分区 */
export class LandTool implements Tool {
  readonly id = 'land' as const;
  private mode: Mode = 'buy';
  private start: { x: number; y: number } | null = null;
  private rect: CellRect | null = null;

  constructor(
    private world: World,
    private view: MapView,
    private panel: Panel,
    private onExit: () => void,
  ) {
    this.render();
  }

  private select(x: number, y: number): void {
    const s = this.start!;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const r = { x: Math.min(s.x, cx), y: Math.min(s.y, cy), w: Math.abs(cx - s.x) + 1, h: Math.abs(cy - s.y) + 1 };
    const o = this.rect;
    if (o && o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h) return;
    this.rect = r;
    this.render();
  }

  dragStart(x: number, y: number): void {
    this.start = { x: Math.floor(x), y: Math.floor(y) };
    this.select(x, y);
  }

  drag(x: number, y: number): void {
    if (this.start) this.select(x, y);
  }

  tap(x: number, y: number): void {
    this.dragStart(x, y);
  }

  private confirm(): void {
    const r = this.rect;
    if (!r) return;
    if (this.mode === 'buy') {
      if (!this.world.buyLand(r)) return void toast('资金不足');
      toast('已购买土地');
    } else {
      const n = this.world.zoneLand(r, this.mode);
      toast(this.mode === Zone.None ? `已解除 ${n} 格` : `已设为${ZONE_NAMES[this.mode]}区 ${n} 格`);
    }
    this.rect = null;
    this.render();
  }

  private render(): void {
    const w = this.world;
    const r = this.rect;
    const quote = r && this.mode === 'buy' ? w.quoteLand(r) : null;
    const count = r ? (quote ? quote.cells.length : w.land.zonableCells(r).length) : 0;
    const affordable = !quote || quote.cost <= w.money;
    const objs: Parameters<MapView['setOverlay']>[0] = [buildLandOverlay(w.map, w.land)];
    if (r) objs.push(buildFootprint(w.map, r.x, r.y, r.w, r.h, count > 0 && affordable));
    this.view.setOverlay(objs);

    let summary = this.mode === 'buy' ? '拖框选择要买的土地' : '拖框选择自己的土地来分区';
    if (r) {
      if (quote) summary = count ? `${count} 格（${(count * 0.04).toFixed(2)} ha） · ${formatYen(quote.cost)}` : '这里没有可买的土地';
      else summary = count ? `可分区 ${count} 格` : '这里没有可分区的空地（须是自己的地）';
    }
    const body = h('div');
    body.append(
      h(
        'div',
        { class: 'seg' },
        ...MODES.map(([m, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: this.mode === m ? 'on' : '',
              onclick: () => {
                this.mode = m;
                this.render();
              },
            },
            label,
          ),
        ),
      ),
    );
    const s = w.land.stats();
    body.append(h('p', { class: 'note' }, `已有土地 ${s.ownedCells} 格 · 地图建筑 ${s.buildings} 栋 · 人口 ${s.population} · 岗位 ${s.jobs}`));
    body.append(h('p', { class: 'note' }, this.mode === 'buy' ? '公布线路后沿线地价上涨，车站开通后涨得更多。未开发土地每年缴固定资产税。' : '车站附近或道路旁的分区，数月后开始长出建筑；离站 800 m 外明显变慢。'));
    if (!affordable) body.append(h('ul', { class: 'issues' }, h('li', {}, '资金不足')));
    body.append(
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.onExit() }, '完成'),
        h('button', { type: 'button', class: 'btn primary', disabled: !count || !affordable, onclick: () => this.confirm() }, this.mode === 'buy' ? '购买' : '确认'),
      ),
    );
    this.panel.show('tool', '土地', summary, body, true);
  }

  dispose(): void {
    this.view.setOverlay([]);
  }
}
