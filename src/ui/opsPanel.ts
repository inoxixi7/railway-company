import { CONFIG } from '../config';
import { formatClock, formatDuration, formatYen } from '../sim/calendar';
import { headwayAt, periodAt, type Train } from '../sim/ops/sim';
import { isBuilt, STATION_TYPE_NAMES, type Station } from '../sim/rail/types';
import { CAR_TYPES, carType } from '../sim/rail/vehicles';
import { buildingCapacity, Zone } from '../sim/land/land';
import type { World } from '../sim/world';
import { h, kv } from './dom';
import type { Panel } from './panel';
import { toast } from './toast';

const HEADWAY_OPTIONS = [0, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 60];

export function trainStatus(world: World, t: Train): string {
  const sim = world.sim;
  const dir = t.dir > 0 ? '下行' : '上行';
  const nodeName = (i: number) => sim?.topo.nodes[i]?.station.name ?? '—';
  switch (t.state) {
    case 'depot':
      return '在车辆基地';
    case 'leaving':
      return '出库中';
    case 'entering':
      return '入库中';
    case 'dwell':
      if (t.departAt > world.time + 90) return `停在${nodeName(t.node)}（${formatClock(t.departAt)} 发）`;
      return `停在${nodeName(t.node)}${t.retire ? '（回送）' : ''}`;
    case 'running': {
      const next = nodeName(t.node + t.dir);
      const v = Math.round(t.v * 3.6);
      return `${dir} 开往${next} · ${v} km/h${v === 0 ? '（等信号）' : ''}${t.retire ? ' · 回送' : ''}`;
    }
  }
}

const OPS_TABS = [
  ['overview', '概况'],
  ['timetable', '发车'],
  ['fleet', '车辆'],
  ['estate', '地产'],
] as const;
type OpsTab = (typeof OPS_TABS)[number][0];
/** 记住上次打开的分页 */
let opsTab: OpsTab = 'overview';

/** 运营面板：按经营类别分页（概况、发车间隔、车辆、地产） */
export function showOpsPanel(world: World, panel: Panel): () => void {
  const body = h('div');
  const status = h('div');
  const list = h('ul', { class: 'trains' });

  // 发车间隔
  const table = h('table', { class: 'hw' });
  for (const p of CONFIG.ops.periods) {
    const sel = h('select', {
      'aria-label': `${p.name}发车间隔`,
      onchange: (e: Event) => world.setHeadway(p.id, Number((e.target as HTMLSelectElement).value)),
    });
    for (const m of HEADWAY_OPTIONS) {
      const o = h('option', { value: String(m) }, m === 0 ? '停运' : `每 ${m} 分`);
      if ((world.ops.headways[p.id] ?? p.headwayMin) === m) o.selected = true;
      sel.append(o);
    }
    table.append(h('tr', {}, h('td', {}, `${p.name}  ${p.from}:00–${p.to}:00`), h('td', {}, sel)));
  }

  // 购车
  let typeId = 'steel';
  let cars = 4;
  const buyInfo = h('span', { class: 'note' });
  const typeSeg = h('div', { class: 'seg' });
  const carsLabel = h('span', {}, '');
  const refreshBuy = () => {
    const ct = carType(typeId);
    cars = Math.max(ct.minCars, Math.min(ct.maxCars, cars));
    typeSeg.replaceChildren(
      ...CAR_TYPES.map((c) =>
        h(
          'button',
          {
            type: 'button',
            class: c.id === typeId ? 'on' : '',
            onclick: () => {
              typeId = c.id;
              refreshBuy();
            },
          },
          c.name,
        ),
      ),
    );
    carsLabel.textContent = `${cars} 节`;
    buyInfo.textContent = `${ct.maxSpeedKmh} km/h · 定员 ${ct.capacityPerCar * cars} 人 · ${formatYen(ct.pricePerCar * cars)}（编组 ${ct.minCars}–${ct.maxCars} 节）`;
  };
  refreshBuy();
  const buy = h(
    'div',
    {},
    typeSeg,
    h(
      'div',
      { class: 'row', style: 'align-items:center' },
      h(
        'span',
        { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': '减少一节', onclick: () => ((cars -= 1), refreshBuy()) }, '−'),
        carsLabel,
        h('button', { type: 'button', 'aria-label': '增加一节', onclick: () => ((cars += 1), refreshBuy()) }, '+'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onclick: () => {
            const r = world.buyTrain(typeId, cars);
            toast(typeof r === 'string' ? r : `购入${r.name}（${carType(typeId).name}×${r.cars}）`);
            refresh();
          },
        },
        '购买列车',
      ),
    ),
    buyInfo,
  );

  const finance = h('div');
  const estate = h('div');
  const pages: Record<OpsTab, HTMLElement> = {
    overview: h('div', {}, status, h('h3', {}, '资金'), finance),
    timetable: h('div', {}, h('h3', {}, '发车间隔（普通，各站停车）'), table),
    fleet: h('div', {}, h('h3', {}, '购买列车'), buy, h('h3', {}, '列车'), list),
    estate: h('div', {}, estate),
  };
  const tabs = h('div', { class: 'seg tabs', role: 'tablist' });
  const page = h('div');
  const showTab = (t: OpsTab) => {
    opsTab = t;
    tabs.replaceChildren(
      ...OPS_TABS.map(([id, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': id === t ? 'true' : 'false', class: id === t ? 'on' : '', onclick: () => showTab(id) }, label),
      ),
    );
    page.replaceChildren(pages[t]);
  };
  showTab(opsTab);
  body.append(tabs, page);

  const refresh = () => {
    const sim = world.sim;
    const owned = world.ops.trains.length;
    const rows: [string, Node | string][] = [];
    if (!sim) {
      rows.push(['状态', world.line ? '尚未开通（需要至少两个已落成的车站）' : '还没有线路']);
    } else {
      const hw = headwayAt(world.ops, world.time);
      const need = sim.requiredTrains(world.time);
      rows.push(['运营区间', `${sim.topo.nodes[0].station.name} ⇄ ${sim.topo.nodes[sim.topo.nodes.length - 1].station.name}（${sim.topo.nodes.length} 站）`]);
      rows.push(['当前时段', `${periodAt(world.time).name} · ${hw ? `每 ${hw / 60} 分` : '停运'}`]);
      rows.push(['往返一圈', `约 ${Math.round(sim.cycleTimeSec() / 60)} 分`]);
      const short = need > owned;
      rows.push(['所需列车', h('span', { class: short ? 'warn' : '' }, `${need} 列（拥有 ${owned} 列，线上 ${sim.onLine()} 列）`)]);
      if (short && hw) {
        const actual = owned > 0 ? Math.ceil(sim.cycleTimeSec() / owned / 60) : 0;
        rows.push(['', h('span', { class: 'warn' }, owned ? `车不够，实际间隔约 ${actual} 分` : '还没有列车')]);
      }
      if (need > sim.maxOnLine()) rows.push(['', h('span', { class: 'warn' }, `线路最多同时容纳 ${sim.maxOnLine()} 列（防死锁），可增加会车站或改复线`)]);
      if (sim.topo.depotNode === null) rows.push(['车辆基地', h('span', { class: 'warn' }, world.line?.depot ? '尚未落成' : '还没有（无法购车）')]);
    }
    status.replaceChildren(kv(rows));
    const land = world.land;
    finance.replaceChildren(
      kv([
        ['资金', h('span', { class: world.money < 0 ? 'warn' : '' }, formatYen(world.money))],
        ['累计投资', formatYen(world.spent)],
        ['预计固定资产税', `${formatYen(land.annualTax(world.time))}/年（1 月 1 日缴纳）`],
      ]),
    );
    const own = [...land.buildings.values()].filter((b) => b.player);
    const st = land.stats();
    let ownPop = 0;
    let ownJobs = 0;
    for (const b of own) {
      if (b.use === Zone.Residential) ownPop += buildingCapacity(b);
      else ownJobs += buildingCapacity(b);
    }
    estate.replaceChildren(
      kv([
        ['自有土地', `${st.ownedCells} 格（${(st.ownedCells * 0.04).toFixed(2)} ha）`],
        ['土地估值', formatYen(land.annualTax(world.time) / CONFIG.land.taxRate)],
        ['自有地上建筑', `${own.length} 栋`],
        ['自有地人口 / 岗位', `${ownPop} 人 / ${ownJobs} 个`],
        ['全图人口 / 岗位', `${st.population} 人 / ${st.jobs} 个`],
      ]),
      h('p', { class: 'note' }, '买地和分区请用工具栏的「土地」。'),
    );
    list.replaceChildren(
      ...world.ops.trains.map((t) => h('li', {}, h('b', {}, t.name), ` ${carType(t.typeId).name}×${t.cars} · `, trainStatus(world, t))),
    );
    if (!world.ops.trains.length) list.append(h('li', { class: 'note' }, '还没有列车'));
  };
  refresh();
  panel.show('ops', '运营', '概况 · 发车 · 车辆 · 地产', body, true);
  return refresh;
}

export function showTrainPanel(world: World, panel: Panel, t: Train): () => void {
  const body = h('div');
  const refresh = () => {
    const ct = carType(t.typeId);
    body.replaceChildren(
      kv([
        ['车型', `${ct.name} × ${t.cars} 节`],
        ['状态', trainStatus(world, t)],
        ['定员', `${ct.capacityPerCar * t.cars} 人`],
        ['最高速度', `${ct.maxSpeedKmh} km/h`],
        ['折返次数', `${t.trips}`],
        ['累计等信号', `${Math.round(t.waitSec / 60)} 分`],
      ]),
    );
  };
  refresh();
  panel.show('train', t.name, trainStatus(world, t), body, false);
  return () => {
    refresh();
    (document.getElementById('panel-summary') as HTMLElement).textContent = trainStatus(world, t);
  };
}

export function showStationPanel(world: World, panel: Panel, st: Station): () => void {
  const body = h('div');
  const refresh = () => {
    const built = isBuilt(st.build, world.time);
    const rows: [string, Node | string][] = [
      ['形式', st.externalId ? '既有终点站（岛式，2 条股道）' : STATION_TYPE_NAMES[st.type]],
      ['状态', built ? '已落成' : `施工中，还需 ${formatDuration((st.build.readyAt ?? 0) - world.time)}`],
    ];
    if (world.line?.depot?.stationId === st.id) rows.push(['车辆基地', '有（出入库线接在本站）']);
    body.replaceChildren(kv(rows));
    if (!st.externalId) {
      body.append(
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                const name = window.prompt('车站名称', st.name);
                if (name) {
                  world.renameStation(st.id, name);
                  (document.getElementById('panel-title') as HTMLElement).textContent = st.name;
                }
              },
            },
            '改名',
          ),
        ),
      );
    }
  };
  refresh();
  panel.show('station', st.name, st.externalId ? '大城市方向' : STATION_TYPE_NAMES[st.type], body, false);
  return refresh;
}
