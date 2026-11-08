import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map/generate';
import { tailOf, type Train } from '../src/sim/ops/sim';
import type { StationType } from '../src/sim/rail/types';
import { World } from '../src/sim/world';
import { DEPOT_GAP, depotCandidate, depotGeom, lineAlignment } from '../src/sim/rail/line';
import { CONFIG } from '../src/config';
import { sampleAlignment } from '../src/sim/track/alignment';

/** 搭一条从小镇东侧经过河流到东侧终点站的线 */
function buildWorld(tracks: 1 | 2, stationType: StationType, stationXs: number[]) {
  const w = new World(generateMap());
  const ok = w.confirmDraft({
    anchor: 'new',
    tracks,
    points: [
      { x: 60, y: 196 },
      { x: 150, y: 196 },
      { x: 196, y: 150 },
      { x: 246, y: 150 },
    ],
  });
  expect(ok).toBe(true);
  for (const x of stationXs) {
    const y = x <= 150 ? 196 : 150;
    const c = w.stationCandidate(x, y, stationType);
    expect(c, `x=${x}`).not.toBeNull();
    expect(c!.issues, `x=${x}`).toEqual([]);
    w.placeStation(c!, stationType);
  }
  // 完工
  w.time += 400 * 86400;
  w.checkOpenings();
  const st = w.line!.stations[0];
  const dc = [w.depotCandidate(st, 1)!, w.depotCandidate(st, -1)!].find((c) => c.ok);
  expect(dc).toBeTruthy();
  w.placeDepot(dc!);
  w.time += 100 * 86400;
  // 从早上 5 点开始
  w.time = Math.ceil(w.time / 86400) * 86400 + 5 * 3600;
  w.checkOpenings();
  expect(w.sim).not.toBeNull();
  return w;
}

function laneAt(w: World, t: Train, x: number): string | null {
  for (const id of t.held) {
    const r = w.sim!.topo.res[id];
    if (r.lane && x >= r.a - 1e-6 && x <= r.b + 1e-6) return r.lane;
  }
  return null;
}

/** 每一步都检查的安全不变量 */
function checkInvariants(w: World) {
  const res = w.sim!.topo.res;
  const trains = w.ops.trains;
  for (const r of res) {
    if (r.holder === null) continue;
    const t = trains.find((x) => x.id === r.holder);
    expect(t, `资源 ${r.label} 的占用者不存在`).toBeTruthy();
    expect(t!.held).toContain(r.id);
  }
  const onLine = trains.filter((t) => t.state === 'running' || t.state === 'dwell');
  for (const t of onLine) {
    for (const id of t.held) expect(res[id].holder, `${t.name} 持有的 ${res[id].label} 不属于它`).toBe(t.id);
  }
  // 没有碰撞：同一股道上车身不重叠
  for (let i = 0; i < onLine.length; i++) {
    for (let j = i + 1; j < onLine.length; j++) {
      const a = onLine[i];
      const b = onLine[j];
      const lo = Math.max(Math.min(a.head, tailOf(a)), Math.min(b.head, tailOf(b)));
      const hi = Math.min(Math.max(a.head, tailOf(a)), Math.max(b.head, tailOf(b)));
      if (lo > hi) continue;
      for (let x = lo; x <= hi; x += 0.1) {
        const la = laneAt(w, a, x);
        const lb = laneAt(w, b, x);
        expect(la !== null && la === lb, `${a.name} 与 ${b.name} 在里程 ${x.toFixed(1)} 相撞（${la}）`).toBe(false);
      }
    }
  }
}

function run(w: World, seconds: number, check = true) {
  for (let i = 0; i < seconds; i++) {
    w.step();
    if (check && i % 5 === 0) checkInvariants(w);
  }
}

describe('列车运行（第一层安全）', () => {
  it('复线：按间隔发车、不相撞、全部车次都在推进', () => {
    const w = buildWorld(2, 'side', [64, 110, 130, 214]);
    for (let i = 0; i < 6; i++) expect(typeof w.buyTrain('steel', 4)).toBe('object');
    run(w, 6 * 3600);
    const trips = w.ops.trains.reduce((s, t) => s + t.trips, 0);
    expect(trips).toBeGreaterThan(10);
    for (const t of w.ops.trains) if (t.state !== 'depot') expect(w.time - t.lastProgress).toBeLessThan(3600);
  });

  it('单线：大量列车也不死锁（上线数受环形容量限制）', () => {
    const w = buildWorld(1, 'side', [64, 110, 130, 214]);
    for (let i = 0; i < 8; i++) w.buyTrain('steel', 4);
    for (const p of Object.keys(w.ops.headways)) w.setHeadway(p, 3);
    run(w, 8 * 3600);
    expect(w.sim!.onLine()).toBeLessThanOrEqual(w.sim!.maxOnLine());
    const trips = w.ops.trains.reduce((s, t) => s + t.trips, 0);
    expect(trips).toBeGreaterThan(8);
    for (const t of w.ops.trains) if (t.state !== 'depot') expect(w.time - t.lastProgress, t.name).toBeLessThan(2 * 3600);
  });

  it('单线 + 一面一线中间站：不死锁', () => {
    const w = buildWorld(1, 'single', [64, 110, 130, 214]);
    // 第一站要建车辆基地，换成相对式
    for (let i = 0; i < 5; i++) w.buyTrain('wood', 2);
    for (const p of Object.keys(w.ops.headways)) w.setHeadway(p, 5);
    run(w, 6 * 3600);
    const trips = w.ops.trains.reduce((s, t) => s + t.trips, 0);
    expect(trips).toBeGreaterThan(4);
    for (const t of w.ops.trains) if (t.state !== 'depot') expect(w.time - t.lastProgress, t.name).toBeLessThan(2 * 3600);
  });

  it('停运后全部回库，资源全部释放（不泄漏）', () => {
    const w = buildWorld(2, 'island', [64, 110, 130, 214]);
    for (let i = 0; i < 5; i++) w.buyTrain('steel', 6);
    run(w, 4 * 3600);
    for (const p of Object.keys(w.ops.headways)) w.setHeadway(p, 0);
    run(w, 6 * 3600);
    expect(w.ops.trains.every((t) => t.state === 'depot')).toBe(true);
    expect(w.sim!.topo.res.every((r) => r.holder === null)).toBe(true);
  });

  it('运营中向两端延长并加站：拓扑重建后依然安全', () => {
    const w = new World(generateMap());
    expect(w.confirmDraft({ anchor: 'new', tracks: 2, points: [{ x: 60, y: 196 }, { x: 120, y: 196 }] })).toBe(true);
    for (const x of [66, 112]) w.placeStation(w.stationCandidate(x, 196, 'island')!, 'island');
    w.time += 200 * 86400;
    w.checkOpenings();
    const st = w.line!.stations[0];
    w.placeDepot([w.depotCandidate(st, 1)!, w.depotCandidate(st, -1)!].find((c) => c.ok)!);
    w.time = Math.ceil((w.time + 100 * 86400) / 86400) * 86400 + 6 * 3600;
    w.checkOpenings();
    for (let i = 0; i < 4; i++) w.buyTrain('steel', 4);
    for (const p of Object.keys(w.ops.headways)) w.setHeadway(p, 5);
    run(w, 3600);
    // 向东延长（运营中施工）
    expect(w.confirmDraft({ anchor: 'end', tracks: 2, points: [{ x: 120, y: 196 }, { x: 150, y: 196 }] })).toBe(true);
    const c1 = w.stationCandidate(144, 196, 'island')!;
    expect(c1.issues).toEqual([]);
    w.placeStation(c1, 'island');
    // 向西延长：里程整体后移
    expect(w.confirmDraft({ anchor: 'start', tracks: 2, points: [{ x: 60, y: 196 }, { x: 30, y: 196 }] })).toBe(true);
    const c2 = w.stationCandidate(36, 196, 'side')!;
    expect(c2.issues).toEqual([]);
    w.placeStation(c2, 'side');
    run(w, 3600);
    // 施工完成，新区段开通
    w.time += 120 * 86400;
    w.checkOpenings();
    expect(w.sim!.topo.nodes.length).toBe(4);
    run(w, 4 * 3600);
    const trips = w.ops.trains.reduce((s, t) => s + t.trips, 0);
    expect(trips).toBeGreaterThan(20);
    for (const t of w.ops.trains) if (t.state !== 'depot') expect(w.time - t.lastProgress, t.name).toBeLessThan(3600);
  });

  it('斜向直线上可以建站；基地出入库线接到正线', () => {
    const w = buildWorld(2, 'side', [80]);
    const c = w.stationCandidate(173, 173, 'side')!;
    expect(c.orient).toBe('d');
    expect(c.issues).toEqual([]);
    const st = w.placeStation(c, 'side')!;
    expect(st).toBeTruthy();
    // 斜向车站旁也能建基地，且基地顺着线路方向
    const dc = [1, -1].flatMap((side) => [1, -1].map((end) => depotCandidate(w.map, { ...w.line!, depot: null }, st, side as 1 | -1, end as 1 | -1))).find((c) => c.ok);
    expect(dc).toBeTruthy();
    expect(Math.abs(Math.abs(dc!.geom.u.x) - Math.SQRT1_2)).toBeLessThan(1e-6);
  });

  it('出入库线：从站台外的直线正线分出，曲线不小于最小半径，留置线与正线平行', () => {
    const w = buildWorld(2, 'side', [80, 130, 214]);
    const d = w.line!.depot!;
    const g = depotGeom(w.map, w.line!, d);
    const st = w.line!.stations.find((s) => s.id === d.stationId)!;
    const al = lineAlignment(w.map, w.line!);
    // 接轨点在站台端外 DEPOT_GAP 格、靠基地一侧的正线上
    expect(Math.abs(g.sJoin - st.s)).toBeCloseTo(CONFIG.rail.stationLengthCells / 2 + DEPOT_GAP);
    const j = sampleAlignment(al, g.sJoin);
    const p0 = g.routes[0][0];
    expect(Math.hypot(p0.x - (j.x + j.ty * d.side * g.m0), p0.y - (j.y - j.tx * d.side * g.m0))).toBeLessThan(1e-6);
    const rMin = CONFIG.rail.minRadiusM / w.map.cellMeters;
    for (const r of g.routes) {
      // 出发时与正线同向
      const h0 = Math.atan2(r[1].y - r[0].y, r[1].x - r[0].x);
      expect(Math.abs(h0 - Math.atan2(g.u.y, g.u.x))).toBeLessThan(0.15);
      // 每段转角 / 长度 → 曲率半径不小于最小半径
      for (let i = 2; i < r.length; i++) {
        const a1 = Math.atan2(r[i - 1].y - r[i - 2].y, r[i - 1].x - r[i - 2].x);
        const a2 = Math.atan2(r[i].y - r[i - 1].y, r[i].x - r[i - 1].x);
        const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
        const seg = Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
        if (turn > 1e-6) expect(seg / turn).toBeGreaterThan(rMin * 0.95);
      }
      // 尽头留置线与正线平行、足够停 6 节车
      const n = r.length - 1;
      const tail = { x: r[n].x - r[n - 1].x, y: r[n].y - r[n - 1].y };
      expect(Math.abs(tail.x * g.n.x + tail.y * g.n.y)).toBeLessThan(1e-6);
      expect(Math.hypot(tail.x, tail.y)).toBeGreaterThanOrEqual(CONFIG.rail.depot.sidingLengthCells - 1e-6);
    }
  });

  it('出入库调车沿出入库线行驶，花的时间与进路长度相符', () => {
    const w = buildWorld(2, 'side', [80, 130, 214]);
    const t = w.buyTrain('steel', 4) as Train;
    for (let i = 0; i < 3 * 3600 && t.state === 'depot'; i++) w.step();
    expect(t.state).toBe('leaving');
    // 400 m 以上的调车，25 km/h 至少约 1 分钟
    expect(t.moveSec).toBeGreaterThan(50);
    let sec = 0;
    while (t.state === 'leaving') {
      w.step();
      sec++;
    }
    expect(Math.abs(sec - Math.ceil(t.moveSec))).toBeLessThanOrEqual(2);
    expect(t.state).toBe('dwell');
  });
});
