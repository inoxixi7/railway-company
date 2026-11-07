import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { Owner, Zone } from '../src/sim/land/land';
import { generateMap } from '../src/sim/map/generate';
import { cellIndex } from '../src/sim/map/query';
import { Cover } from '../src/sim/map/types';
import { World } from '../src/sim/world';

const DAY = 86400;
const LINE = [
  { x: 150, y: 196 },
  { x: 200, y: 196 },
];

function runMonths(w: World, months: number): void {
  // 只推进月度生长，不跑列车
  for (let i = 0; i < months * 30; i++) {
    w.time = (Math.floor(w.time / DAY) + 1) * DAY - 1;
    w.step();
  }
}

/** 东南农田里一条带车站的线 */
function lineWorld() {
  const w = new World(generateMap());
  expect(w.confirmDraft({ anchor: 'new', tracks: 2, points: LINE })).toBe(true);
  const c = w.stationCandidate(175, 196, 'side')!;
  expect(c.issues).toEqual([]);
  w.placeStation(c, 'side');
  return w;
}

describe('土地', () => {
  it('小镇有既有房屋，开局资金到账', () => {
    const w = new World(generateMap());
    expect(w.money).toBe(CONFIG.economy.startMoney);
    expect(w.land.stats().buildings).toBeGreaterThan(100);
  });

  it('买地扣款；水面、已建房的格子买不了', () => {
    const w = new World(generateMap());
    const m = w.map;
    const q = w.quoteLand({ x: 180, y: 220, w: 5, h: 5 });
    expect(q.cells.length).toBe(25);
    expect(w.buyLand({ x: 180, y: 220, w: 5, h: 5 })).toBe(true);
    expect(w.money).toBeCloseTo(CONFIG.economy.startMoney - q.cost);
    expect(w.quoteLand({ x: 180, y: 220, w: 5, h: 5 }).cells.length).toBe(0);
    const water = m.cover.indexOf(Cover.Water);
    expect(w.quoteLand({ x: water % m.width, y: Math.floor(water / m.width), w: 1, h: 1 }).cells.length).toBe(0);
    const houseId = w.land.buildingAt.findIndex((id) => id > 0);
    expect(w.quoteLand({ x: houseId % m.width, y: Math.floor(houseId / m.width), w: 1, h: 1 }).cells.length).toBe(0);
  });

  it('钱不够买不了，也不能开工', () => {
    const w = new World(generateMap());
    w.money = 1;
    expect(w.buyLand({ x: 180, y: 220, w: 5, h: 5 })).toBe(false);
    expect(w.evaluate({ anchor: 'new', tracks: 2, points: LINE })!.ok).toBe(false);
    expect(w.confirmDraft({ anchor: 'new', tracks: 2, points: LINE })).toBe(false);
    expect(w.money).toBe(1);
  });

  it('草案保密 → 公布约 1.5 倍 → 开通约 3 倍；1 km 外不受影响', () => {
    const w = new World(generateMap());
    const near = cellIndex(w.map, 175, 200);
    const far = cellIndex(w.map, 175, 140);
    const p0 = w.land.price(near, 0);
    const pFar = w.land.price(far, 0);
    w.evaluate({ anchor: 'new', tracks: 2, points: LINE });
    expect(w.land.price(near, 0)).toBe(p0);
    w.confirmDraft({ anchor: 'new', tracks: 2, points: LINE });
    expect(w.land.price(near, 0) / p0).toBeCloseTo(1.5, 1);
    const c = w.stationCandidate(175, 196, 'side')!;
    w.placeStation(c, 'side');
    w.time += 400 * DAY;
    w.checkOpenings();
    expect(w.land.price(near, 0) / p0).toBeCloseTo(3, 1);
    expect(w.land.price(far, 0)).toBe(pFar);
  });

  it('站旁分区数月后开始长房、约 3 年基本填满；无站无路不长', () => {
    const w = lineWorld();
    w.time += 400 * DAY;
    w.checkOpenings();
    const r = { x: 170, y: 200, w: 10, h: 10 };
    const remote = { x: 240, y: 240, w: 5, h: 5 };
    w.buyLand(r);
    w.buyLand(remote);
    expect(w.zoneLand(r, Zone.Residential)).toBe(100);
    w.zoneLand(remote, Zone.Commercial);
    const built = (rect: typeof r) => w.land.cellsIn(rect).filter((i) => w.land.buildingAt[i]).length;
    runMonths(w, 2);
    expect(built(r)).toBe(0);
    runMonths(w, 34);
    expect(built(r)).toBeGreaterThan(80);
    expect(built(remote)).toBe(0);
  });

  it('市民自建：占用道路边的地，之后买不到', () => {
    const w = new World(generateMap());
    const before = w.land.stats().buildings;
    runMonths(w, 12);
    expect(w.land.stats().buildings).toBe(before + 22); // 360 天跨 11 个月初，每月 2 栋
    const citizen = [...w.land.buildings.values()].filter((b) => b.builtAt > 0)[0];
    const i = cellIndex(w.map, citizen.x, citizen.y);
    expect(w.land.owner[i]).toBe(Owner.Citizen);
    expect(w.quoteLand({ x: citizen.x, y: citizen.y, w: 1, h: 1 }).cells.length).toBe(0);
  });

  it('线路穿过小镇：草案报补偿，确认后拆除并扣款', () => {
    const w = new World(generateMap());
    const draft = { anchor: 'new' as const, tracks: 2 as const, points: [{ x: 26, y: 196 }, { x: 54, y: 196 }] };
    const ev = w.evaluate(draft)!;
    expect(ev.acquisition!.citizen).toBeGreaterThan(0);
    expect(ev.acquisition!.cost).toBeGreaterThan(0);
    const before = w.land.stats().buildings;
    expect(w.confirmDraft(draft)).toBe(true);
    expect(w.land.stats().buildings).toBe(before - ev.acquisition!.citizen);
    expect(w.money).toBeCloseTo(CONFIG.economy.startMoney - ev.summary.cost - ev.acquisition!.cost);
    for (const [i] of w.map.rail.entries()) if (w.map.rail[i]) expect(w.land.buildingAt[i]).toBe(0);
  });

  it('玩家土地上的新线收回该地，不补偿', () => {
    const w = new World(generateMap());
    w.buyLand({ x: 170, y: 190, w: 10, h: 10 });
    w.confirmDraft({ anchor: 'new', tracks: 2, points: LINE });
    expect(w.land.owner[cellIndex(w.map, 175, 196)]).toBe(Owner.None);
    expect(w.land.owner[cellIndex(w.map, 175, 192)]).toBe(Owner.Player);
  });

  it('工期倍率为 0：线路、车站、基地确认后立即可用', () => {
    const w = lineWorld();
    expect(w.land.stationDist[cellIndex(w.map, 175, 200)]).toBeLessThan(10);
    const st = w.line!.stations[0];
    const dc = [w.depotCandidate(st, 1)!, w.depotCandidate(st, -1)!].find((c) => c.ok)!;
    expect(w.placeDepot(dc)).toBe(true);
    expect(typeof w.buyTrain('steel', 4)).toBe('object');
  });

  it('每年 1 月 1 日收固定资产税', () => {
    const w = new World(generateMap());
    w.buyLand({ x: 180, y: 220, w: 10, h: 10 });
    const m0 = w.money;
    w.time = 364 * DAY;
    runMonths(w, 1);
    const tax = m0 - w.money;
    expect(tax).toBeGreaterThan(0);
    expect(tax).toBeLessThan(w.quoteLand({ x: 190, y: 220, w: 10, h: 10 }).cost * 0.03);
  });
});
