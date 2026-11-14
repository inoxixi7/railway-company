import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map/generate';
import { applyDraft, draftEnd, evaluateDraft, pickStart, strokeTo, type Draft } from '../src/sim/rail/draft';
import { pieceAt, pieceLength, type Pt } from '../src/sim/rail/geometry';
import { RailNetwork } from '../src/sim/rail/network';
import { addExternalTerminals, buildStation, planStation, planStationOnTrack, removeStation, removeTrack } from '../src/sim/rail/stations';

const fresh = () => {
  const map = generateMap();
  const net = new RailNetwork();
  addExternalTerminals(net, map);
  return { map, net };
};

/** 像工具那样画：从 from 出发，依次拖到各个点 */
function draw(net: RailNetwork, map: ReturnType<typeof generateMap>, mode: 1 | 2, from: Pt, to: Pt[], crossing: 'flat' | 'over' = 'over'): Draft {
  const start = pickStart(net, map, from.x, from.y, mode);
  const d: Draft = { mode: start.single ? 1 : mode, start: start.anchor, startPt: start.pt, pieces: [], strokes: [], end: { kind: 'free' }, crossing };
  let dirs = start.dirs;
  for (const t of to) {
    const e = draftEnd(d);
    const st = strokeTo(net, map, e.pt, e.dir ? [e.dir] : dirs, t, d.mode, d.start);
    expect(st, `stroke to ${t.x},${t.y}`).not.toBeNull();
    d.pieces.push(...st!.pieces);
    d.strokes.push(d.pieces.length);
    d.end = st!.end;
    dirs = [];
  }
  return d;
}

function build(net: RailNetwork, map: ReturnType<typeof generateMap>, d: Draft) {
  const ev = evaluateDraft(net, map, d)!;
  expect(ev.issues.map((i) => i.message)).toEqual([]);
  return applyDraft(net, map, d, ev, 0);
}

describe('轨道网络', () => {
  it('既有终点站：岛式两条站台股道，西端一对端点相距 4 m', () => {
    const { net } = fresh();
    const st = [...net.stations.values()][0];
    expect(st.external).toBe(true);
    expect(net.platformsOf(st.id)).toHaveLength(2);
    const west = [...net.nodes.values()].filter((n) => Math.abs(n.x - 246) < 1e-6);
    expect(west).toHaveLength(2);
    expect(Math.abs(west[0].y - west[1].y)).toBeCloseTo(0.2);
    expect(net.pairSibling(west[0].id, 0.2)?.id).toBe(west[1].id);
  });

  it('单条：逐段相切，接成连续的股道', () => {
    const { map, net } = fresh();
    const d = draw(net, map, 1, { x: 150, y: 200 }, [{ x: 180, y: 200 }, { x: 205, y: 190 }, { x: 215, y: 170 }]);
    const before = net.edges.size;
    build(net, map, d);
    expect(net.edges.size - before).toBe(3);
    // 相邻两段在节点处切线连续
    for (let i = 0; i < d.pieces.length - 1; i++) {
      const a = pieceAt(d.pieces[i], pieceLength(d.pieces[i]));
      const b = pieceAt(d.pieces[i + 1], 0);
      expect(Math.hypot(a.tx - b.tx, a.ty - b.ty)).toBeLessThan(1e-6);
    }
  });

  it('一次铺两条：得到两条相距 4 m 的平行股道，可以从末端继续铺', () => {
    const { map, net } = fresh();
    const d = draw(net, map, 2, { x: 150, y: 200 }, [{ x: 180, y: 200 }, { x: 205, y: 190 }]);
    const before = net.edges.size;
    build(net, map, d);
    expect(net.edges.size - before).toBe(4);
    const end = draftEnd(d).pt;
    const pick = pickStart(net, map, end.x, end.y, 2);
    expect(pick.anchor.kind).toBe('pair');
    const d2 = draw(net, map, 2, end, [{ x: 225, y: 175 }]);
    expect(d2.start.kind).toBe('pair');
    build(net, map, d2);
    expect(net.edges.size - before).toBe(6);
  });

  it('两条平行股道接入终点站西端', () => {
    const { map, net } = fresh();
    const d = draw(net, map, 2, { x: 200, y: 160 }, [{ x: 220, y: 158 }, { x: 246, y: 150 }]);
    expect(d.end.kind).toBe('pair');
    build(net, map, d);
    const west = [...net.nodes.values()].filter((n) => Math.abs(n.x - 246) < 1e-6);
    for (const n of west) expect(net.edgesAt(n.id)).toHaveLength(2);
  });

  it('分岔：从已有股道中间接出支线，形成道岔', () => {
    const { map, net } = fresh();
    build(net, map, draw(net, map, 1, { x: 150, y: 200 }, [{ x: 200, y: 200 }]));
    const d = draw(net, map, 1, { x: 170, y: 200.3 }, [{ x: 195, y: 190 }]);
    expect(d.start.kind).toBe('edge');
    build(net, map, d);
    const junction = [...net.nodes.values()].find((n) => net.edgesAt(n.id).length === 3)!;
    expect(junction).toBeTruthy();
    expect(junction.x).toBeCloseTo(170, 0);
    const sides = net.edgesAt(junction.id).map((e) => e.side).sort();
    expect(sides).toEqual([-1, 1, 1]);
    // 已是道岔的一侧不能再接
    expect(net.canAttach(junction.id, { x: 1, y: 0 })).toBe(false);
  });

  it('并线：把末端拖到另一条股道上，用双圆弧接顺', () => {
    const { map, net } = fresh();
    build(net, map, draw(net, map, 1, { x: 150, y: 200 }, [{ x: 220, y: 200 }]));
    const d = draw(net, map, 1, { x: 160, y: 190 }, [{ x: 175, y: 190 }, { x: 200, y: 200.2 }]);
    expect(d.end.kind).toBe('edge');
    build(net, map, d);
    expect([...net.nodes.values()].filter((n) => net.edgesAt(n.id).length === 3)).toHaveLength(1);
  });

  it('相交：平面交叉把两条股道在交点切开；立体交叉让新线高架跨过', () => {
    for (const mode of ['flat', 'over'] as const) {
      const { map, net } = fresh();
      build(net, map, draw(net, map, 1, { x: 150, y: 200 }, [{ x: 200, y: 200 }]));
      const d = draw(net, map, 1, { x: 175, y: 175 }, [{ x: 175, y: 225 }], mode);
      const ev = evaluateDraft(net, map, d)!;
      expect(ev.crossings).toHaveLength(1);
      expect(ev.issues).toEqual([]);
      applyDraft(net, map, d, ev, 0);
      const crossNodes = [...net.nodes.values()].filter((n) => n.crossWith !== undefined);
      if (mode === 'flat') {
        expect(crossNodes).toHaveLength(2);
        expect(crossNodes[0].z).toBeCloseTo(crossNodes[1].z);
      } else {
        expect(crossNodes).toHaveLength(0);
        expect(ev.profile.structure).toContain('viaduct');
        const i = Math.round(ev.crossings[0].s / ev.profile.step);
        expect(ev.profile.z[i]).toBeGreaterThan(ev.crossings[0].z + 6);
      }
    }
  });

  it('过河自动成桥；半径不足会被拒绝', () => {
    const { map, net } = fresh();
    const d = draw(net, map, 1, { x: 60, y: 196 }, [{ x: 120, y: 196 }]);
    const ev = evaluateDraft(net, map, d)!;
    expect(ev.summary.byStructureM.bridge).toBeGreaterThan(40);
    expect(ev.ok).toBe(true);
    const tight = draw(net, map, 1, { x: 150, y: 220 }, [{ x: 160, y: 220 }, { x: 163, y: 224 }]);
    expect(evaluateDraft(net, map, tight)!.issues.some((i) => i.message.includes('半径'))).toBe(true);
  });
});

describe('车站', () => {
  it('独立放置：相对式两条站台股道，铺轨可以吸附到两端', () => {
    const { map, net } = fresh();
    const plan = planStation(net, map, 'side', 170, 200, 1, 0);
    expect(plan.issues).toEqual([]);
    const st = buildStation(net, map, plan, '1号站', 0);
    expect(net.platformsOf(st.id)).toHaveLength(2);
    const d = draw(net, map, 2, { x: 173, y: 200 }, [{ x: 200, y: 195 }]);
    expect(d.start.kind).toBe('pair');
    build(net, map, d);
  });

  it('不能建在河上；岛式两端有咽喉收到 4 m 间距', () => {
    const { map, net } = fresh();
    const wx = [...Array(256).keys()].find((x) => !Number.isNaN(map.waterLevel[196 * 256 + x]))!;
    expect(planStation(net, map, 'side', wx, 196.5, 1, 0).ok).toBe(false);
    const plan = planStation(net, map, 'island', 170, 210, 0.6, 0.8);
    expect(plan.issues).toEqual([]);
    const st = buildStation(net, map, plan, 'X', 0);
    expect(net.edgesOfStation(st.id).filter((e) => e.role === 'throat').length).toBe(8);
    const ends = [...net.nodes.values()].filter((n) => net.edgesAt(n.id).length === 1 && Math.hypot(n.x - 170, n.y - 210) < 6);
    expect(ends).toHaveLength(4);
    expect(net.pairSibling(ends[0].id, 0.2)).not.toBeNull();
  });

  it('在已有股道上建站，再拆除车站和股道', () => {
    const { map, net } = fresh();
    build(net, map, draw(net, map, 1, { x: 150, y: 200 }, [{ x: 200, y: 200 }]));
    const hit = net.nearestEdge(175, 200, 1)!;
    const plan = planStationOnTrack(net, map, 'single', hit.edge, hit.s);
    expect(plan.issues).toEqual([]);
    const st = buildStation(net, map, plan, '2号站', 0);
    const plats = net.platformsOf(st.id);
    expect(plats).toHaveLength(1);
    expect(pieceLength(plats[0].piece)).toBeCloseTo(6);
    expect(typeof removeTrack(net, plats[0].id)).toBe('string');
    expect(removeStation(net, st.id)).toBeGreaterThan(0);
    expect(typeof removeTrack(net, plats[0].id)).toBe('number');
    expect(planStationOnTrack(net, map, 'side', net.nearestEdge(155, 200, 1)!.edge, 3).ok).toBe(false);
  });
});
