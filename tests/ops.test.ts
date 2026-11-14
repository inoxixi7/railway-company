import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map/generate';
import { Ops, newOpsData, type Train } from '../src/sim/ops/ops';
import { applyDraft, draftEnd, evaluateDraft, pickStart, strokeTo, type Draft } from '../src/sim/rail/draft';
import { buildDepot, planDepot } from '../src/sim/rail/depots';
import type { Pt } from '../src/sim/rail/geometry';
import { RailNetwork } from '../src/sim/rail/network';
import { addExternalTerminals, buildStation, planStation } from '../src/sim/rail/stations';

type M = ReturnType<typeof generateMap>;

function lay(net: RailNetwork, map: M, mode: 1 | 2, from: Pt, to: Pt[]) {
  const start = pickStart(net, map, from.x, from.y, mode);
  const d: Draft = { mode: start.single ? 1 : mode, start: start.anchor, startPt: start.pt, pieces: [], strokes: [], end: { kind: 'free' }, crossing: 'over' };
  let dirs = start.dirs;
  for (const t of to) {
    const e = draftEnd(d);
    const st = strokeTo(net, map, e.pt, e.dir ? [e.dir] : dirs, t, d.mode, d.start)!;
    d.pieces.push(...st.pieces);
    d.end = st.end;
    dirs = [];
  }
  const ev = evaluateDraft(net, map, d)!;
  expect(ev.issues.map((i) => i.message)).toEqual([]);
  applyDraft(net, map, d, ev, 0);
  return d;
}

/** 两座相对式车站（两端自带交叉渡线）+ 中间一对平行股道 + 车辆基地 */
function setup(crossovers: boolean) {
  const map = generateMap();
  const net = new RailNetwork();
  addExternalTerminals(net, map);
  const xo: [boolean, boolean] = [crossovers, crossovers];
  const s1 = buildStation(net, map, planStation(net, map, 'side', 150, 200, 1, 0, xo), 'A', 0);
  const s2 = buildStation(net, map, planStation(net, map, 'side', 210, 200, 1, 0, xo), 'B', 0);
  const e = crossovers ? 7 : 3;
  const d = lay(net, map, 2, { x: 150 + e, y: 200 }, [{ x: 210 - e, y: 200 }]);
  expect(d.end.kind).toBe('pair');
  const hit = net.nearestEdge(172, 200.1, 0.05)!;
  const plan = planDepot(net, map, hit.edge, hit.s, 173, 203);
  expect(plan.issues).toEqual([]);
  const depot = buildDepot(net, map, plan, 0);
  const ops = new Ops(net, newOpsData(), map.cellMeters, () => 1000);
  const line = ops.addLine([s1.id, s2.id]);
  return { map, net, ops, line, depot };
}

/** 安全不变量：列车车身所在的股道都锁在自己名下，且没有两列车在同一段股道上 */
function check(ops: Ops) {
  const seen = new Map<number, number>();
  for (const t of ops.data.trains) {
    if (t.state === 'depot') continue;
    const len = ops.trainLength(t);
    for (let back = 0; back <= len; back += 0.25) {
      const loc = ops.locate(t, back)!;
      expect(ops.ownerOf(loc.edge.id), `${t.name} 车身下的股道未锁定`).toBe(t.id);
      const other = seen.get(loc.edge.id);
      expect(other === undefined || other === t.id, `${t.name} 与另一列车在同一段股道上`).toBe(true);
      seen.set(loc.edge.id, t.id);
    }
  }
}

function run(ops: Ops, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    ops.step(1);
    if (i % 3 === 0) check(ops);
  }
}

describe('列车运行', () => {
  it('没有渡线时，一列车在自己的股道上往返', () => {
    const { ops, line, depot } = setup(false);
    const t = ops.buyTrain(depot.id, 'steel', 4) as Train;
    expect(ops.assign(t.id, line.id)).toBeNull();
    run(ops, 3600);
    expect(t.arrivals).toBeGreaterThan(12);
    expect(ops.headwaySec(line)).toBeGreaterThan(30);
  });

  it('车站自带渡线：三列车循环运行，没有列车卡死；超过上限时不能再加车', () => {
    const { ops, line, depot } = setup(true);
    let stuck = 0;
    ops.onEvent = (e) => {
      if (e.type === 'stuck') stuck++;
    };
    const trains: Train[] = [];
    expect(ops.maxTrains(line)).toBe(3);
    for (let i = 0; i < 3; i++) {
      const t = ops.buyTrain(depot.id, 'steel', 4) as Train;
      expect(ops.assign(t.id, line.id)).toBeNull();
      trains.push(t);
    }
    const extra = ops.buyTrain(depot.id, 'steel', 4) as Train;
    expect(ops.assign(extra.id, line.id)).toContain('最多');
    run(ops, 2 * 3600);
    expect(stuck).toBe(0);
    for (const t of trains) expect(t.arrivals, t.name).toBeGreaterThan(10);
  });

  it('撤回车辆基地后所有锁都释放', () => {
    const { ops, line, depot, net } = setup(true);
    const trains: Train[] = [];
    for (let i = 0; i < 3; i++) {
      const t = ops.buyTrain(depot.id, 'wood', 2) as Train;
      ops.assign(t.id, line.id);
      trains.push(t);
    }
    run(ops, 1800);
    for (const t of trains) ops.assign(t.id, null);
    run(ops, 3600);
    expect(trains.every((t) => t.state === 'depot')).toBe(true);
    for (const e of net.edges.values()) expect(ops.ownerOf(e.id)).toBeUndefined();
  });

  it('线路可达性与间隔估算', () => {
    const { ops, line, net } = setup(false);
    const ext = [...net.stations.values()].find((s) => s.external)!;
    expect(ops.reachable(line.stops[0], line.stops[1])).toBe(true);
    expect(ops.reachable(line.stops[0], ext.id)).toBe(false);
    expect(ops.roundTripSec(line)).toBeGreaterThan(120);
  });
});
