import { CONFIG } from '../../config';
import { cellIndex, groundHeight, inBounds } from '../map/query';
import { Cover, type MapData } from '../map/types';
import { earthworks, trackSpacing } from './draft';
import { biarc, pieceAt, pieceLength, type Piece, type Pt } from './geometry';
import { type RailNetwork, type REdge, type StationRec, type StationType, type Structure, Z_STEP } from './network';

/** 岛式车站两端咽喉的长度（格）：股道间距从 8 m 收到 4 m */
const THROAT = 2;
/** 岛式站台两条股道的间距（格）= 8 m */
const ISLAND_SPACING = 0.4;

/** 站端交叉渡线：直线过渡 0.5 格 + 渡线 3 格 + 直线 0.5 格 */
const XO_LEAD = 0.5;
const XO_LEN = 3;

export interface PlanPiece {
  piece: Piece;
  role: 'platform' | 'throat';
  /** 交叉渡线的两条斜线在中点相交：同一条斜线的两段共用节点，两条斜线之间不共用 */
  chain?: string;
}

export interface StationPlan {
  type: StationType;
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** 独立放置时要新建的股道 */
  pieces: PlanPiece[];
  /** 交叉渡线的交点（平面交叉） */
  crossPoints: Pt[];
  /** 在已有股道上建站时：要改成站台的股道 id 与范围 */
  onTrack: { edgeId: number; s0: number; s1: number }[];
  z: number;
  ok: boolean;
  issues: string[];
  cost: number;
  /** 占地（用于预览）：沿轴线向两端的长度与半宽 */
  extent: [number, number];
  halfWidth: number;
}

const line = (a: Pt, b: Pt): Piece => ({ k: 'L', ax: a.x, ay: a.y, bx: b.x, by: b.y });

/**
 * 独立放置的车站：中心 (x, y)，方向 (hx, hy)。
 * crossover：两股道车站的两端是否带交叉渡线（[反方向端, 正方向端]），让列车可以换股道、折返。
 */
export function planStation(net: RailNetwork, m: MapData, type: StationType, x: number, y: number, hx: number, hy: number, crossover: [boolean, boolean] = [true, true]): StationPlan {
  const len = Math.hypot(hx, hy) || 1;
  hx /= len;
  hy /= len;
  const nx = -hy;
  const ny = hx;
  const L = CONFIG.rail.stationLengthCells / 2;
  const half = trackSpacing(m) / 2;
  const at = (along: number, off: number): Pt => ({ x: x + hx * along + nx * off, y: y + hy * along + ny * off });
  const pieces: PlanPiece[] = [];
  const crossPoints: Pt[] = [];
  const extent: [number, number] = [L, L];
  if (type === 'single') {
    pieces.push({ piece: line(at(-L, 0), at(L, 0)), role: 'platform' });
  } else {
    const po = type === 'island' ? ISLAND_SPACING / 2 : half;
    for (const sg of [1, -1]) pieces.push({ piece: line(at(-L, po * sg), at(L, po * sg)), role: 'platform' });
    // 两端：e = -1 反方向端，+1 正方向端。各段都按「离开站台」的方向建
    ([-1, 1] as const).forEach((e, idx) => {
      const h = { x: hx * e, y: hy * e };
      let a0 = L;
      if (type === 'island') {
        for (const sg of [1, -1]) {
          const t = biarc(at(e * L, po * sg), h, at(e * (L + THROAT), half * sg), h);
          if (t) for (const piece of t) pieces.push({ piece, role: 'throat' });
        }
        a0 = L + THROAT;
      }
      if (crossover[idx]) {
        const p0 = a0 + XO_LEAD;
        const p1 = p0 + XO_LEN;
        const p2 = p1 + XO_LEAD;
        for (const sg of [1, -1]) {
          pieces.push({ piece: line(at(e * a0, half * sg), at(e * p0, half * sg)), role: 'throat' });
          pieces.push({ piece: line(at(e * p0, half * sg), at(e * p1, half * sg)), role: 'throat' });
          pieces.push({ piece: line(at(e * p1, half * sg), at(e * p2, half * sg)), role: 'throat' });
          const xo = biarc(at(e * p0, half * sg), h, at(e * p1, -half * sg), h);
          if (xo) for (const piece of xo) pieces.push({ piece, role: 'throat', chain: `${idx}:${sg}` });
        }
        crossPoints.push(at(e * (p0 + XO_LEN / 2), 0));
        a0 = p2;
      }
      extent[idx] = a0;
    });
  }
  const halfWidth = type === 'single' ? 0.7 : type === 'side' ? 0.9 : 1;

  const issues: string[] = [];
  let sum = 0;
  let k = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  let bad: string | null = null;
  for (let a = -extent[0]; a <= extent[1]; a += 0.5) {
    for (const o of [-halfWidth, 0, halfWidth]) {
      const p = at(a, o);
      const cx = Math.floor(p.x);
      const cy = Math.floor(p.y);
      if (!inBounds(m, cx, cy) || p.x < 0 || p.y < 1 || p.x > m.width || p.y > m.height - 1) {
        bad = '超出地图范围';
        continue;
      }
      const cover = m.cover[cellIndex(m, cx, cy)];
      if (cover === Cover.Water) bad = '不能建在河上';
      if (cover === Cover.Facility) bad = '与既有设施重叠';
      const g = groundHeight(m, p.x, p.y);
      sum += g;
      k++;
      minH = Math.min(minH, g);
      maxH = Math.max(maxH, g);
    }
    const c = at(a, 0);
    if (net.nearestEdge(c.x, c.y, halfWidth + 0.3)) bad = bad ?? '与已有股道重叠（要在股道上建站，请直接点那条股道）';
  }
  if (bad) issues.push(bad);
  if (!bad && maxH - minH > 8) issues.push(`地面高差 ${(maxH - minH).toFixed(0)} m，车站需要较平的地（≤ 8 m）`);
  return { type, x, y, hx, hy, pieces, crossPoints, onTrack: [], z: k ? sum / k : 0, ok: issues.length === 0, issues, cost: CONFIG.rail.stationCost[type], extent, halfWidth };
}

/** 在已有股道的直线段上建站。type 为岛式时不可用（需要独立放置） */
export function planStationOnTrack(net: RailNetwork, m: MapData, type: StationType, edge: REdge, s: number): StationPlan {
  const L = CONFIG.rail.stationLengthCells / 2;
  const len = pieceLength(edge.piece);
  const issues: string[] = [];
  const sc = Math.max(L, Math.min(len - L, s));
  const c = pieceAt(edge.piece, sc);
  const base: StationPlan = { type, x: c.x, y: c.y, hx: c.tx, hy: c.ty, pieces: [], crossPoints: [], onTrack: [], z: net.zAt(edge, sc), ok: false, issues, cost: CONFIG.rail.stationCost[type], extent: [L, L], halfWidth: type === 'single' ? 0.7 : 0.9 };
  if (edge.stationId !== undefined) issues.push('这里已经是车站');
  else if (edge.piece.k !== 'L' || len < 2 * L - 1e-6) issues.push('站台需要 120 m 的直线股道');
  if (type === 'island') issues.push('岛式车站请独立放置在空地上，再把股道接过来');
  if (issues.length) return base;
  const onTrack = [{ edgeId: edge.id, s0: sc - L, s1: sc + L }];
  if (type === 'side') {
    // 找旁边相距一个股道间距的平行股道
    const sp = trackSpacing(m);
    let found = false;
    for (const sgn of [1, -1]) {
      const q = { x: c.x - c.ty * sp * sgn, y: c.y + c.tx * sp * sgn };
      const hit = net.nearestEdge(q.x, q.y, 0.04);
      if (!hit || hit.edge.id === edge.id || hit.edge.piece.k !== 'L' || hit.edge.stationId !== undefined) continue;
      const hl = pieceLength(hit.edge.piece);
      if (hit.s - L < -1e-6 || hit.s + L > hl + 1e-6) continue;
      onTrack.push({ edgeId: hit.edge.id, s0: hit.s - L, s1: hit.s + L });
      base.x = (c.x + q.x) / 2;
      base.y = (c.y + q.y) / 2;
      found = true;
      break;
    }
    if (!found) issues.push('相对式需要两条平行的直线股道（或在空地上独立放置车站）');
  }
  for (const t of onTrack) {
    const e = net.edges.get(t.edgeId)!;
    const grade = (Math.abs(net.zAt(e, t.s1) - net.zAt(e, t.s0)) / ((t.s1 - t.s0) * m.cellMeters)) * 1000;
    if (grade > CONFIG.rail.stationMaxGradePermil) issues.push(`坡度 ${grade.toFixed(0)}‰，车站须 ≤ ${CONFIG.rail.stationMaxGradePermil}‰`);
    for (const q of [t.s0, (t.s0 + t.s1) / 2, t.s1]) {
      const st = net.structureAt(e, q);
      if (st === 'tunnel' || st === 'bridge') issues.push(st === 'tunnel' ? '隧道内不能建站' : '桥上不能建站');
    }
  }
  base.onTrack = onTrack;
  base.ok = issues.length === 0;
  return base;
}

/** 按方案建站，返回车站记录 */
export function buildStation(net: RailNetwork, m: MapData, plan: StationPlan, name: string, today: number, opts: { external?: boolean; z?: number; openDay?: number } = {}): StationRec {
  const id = net.newId();
  let openDay = opts.openDay ?? today + CONFIG.rail.stationDays;
  const z = opts.z ?? plan.z;
  const newEdges: number[] = [];
  const flat = (piece: Piece) => {
    const n = Math.max(2, Math.ceil(pieceLength(piece) / Z_STEP) + 1);
    return { zs: new Array<number>(n).fill(z), structure: new Array<Structure>(n).fill('ground') };
  };
  // 独立放置：把各段首尾相接建成股道。交叉渡线的交点上，两条斜线各有自己的节点
  const isCross = (p: Pt) => plan.crossPoints.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 1e-4);
  const made: { x: number; y: number; id: number; chain?: string }[] = [];
  const nodeAt = (p: { x: number; y: number; tx: number; ty: number }, chain?: string) => {
    const cross = isCross(p);
    const hit = made.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 1e-4 && (!cross || n.chain === chain));
    if (hit) return net.nodes.get(hit.id)!;
    const node = net.addNode(p.x, p.y, z, p.tx, p.ty);
    made.push({ x: p.x, y: p.y, id: node.id, chain: cross ? chain : undefined });
    return node;
  };
  for (const pp of plan.pieces) {
    const a = nodeAt(pieceAt(pp.piece, 0), pp.chain);
    const b = nodeAt(pieceAt(pp.piece, pieceLength(pp.piece)), pp.chain);
    const e = net.addEdge({ a: a.id, b: b.id, piece: pp.piece, ...flat(pp.piece), cost: 0, openDay, stationId: id, role: pp.role });
    newEdges.push(e.id);
  }
  for (const c of plan.crossPoints) {
    const pair = made.filter((n) => Math.hypot(n.x - c.x, n.y - c.y) < 1e-4);
    if (pair.length === 2) {
      net.nodes.get(pair[0].id)!.crossWith = pair[1].id;
      net.nodes.get(pair[1].id)!.crossWith = pair[0].id;
    }
  }
  // 在已有股道上：切出站台那一段
  for (const t of plan.onTrack) {
    const e = net.edges.get(t.edgeId)!;
    const len = pieceLength(e.piece);
    openDay = Math.max(openDay, e.openDay);
    let target = e;
    if (t.s1 < len - 1e-6) {
      const n = net.splitEdge(target.id, t.s1);
      target = net.edgesAt(n.id).find((x) => x.end === 'b')!.edge;
    }
    if (t.s0 > 1e-6) {
      const n = net.splitEdge(target.id, t.s0);
      target = net.edgesAt(n.id).find((x) => x.end === 'a')!.edge;
    }
    target.stationId = id;
    target.role = 'platform';
  }
  if (newEdges.length) earthworks(net, m, newEdges);
  const rec: StationRec = { id, name, type: plan.type, x: plan.x, y: plan.y, hx: plan.hx, hy: plan.hy, external: opts.external, cost: opts.external ? 0 : plan.cost, openDay };
  for (const e of net.edgesOfStation(id)) e.openDay = Math.max(e.openDay, e.stationId === id && plan.onTrack.length ? e.openDay : openDay);
  net.stations.set(id, rec);
  net.version++;
  return rec;
}

/** 地图上既有的终点站（大城市方向）：岛式，西端两个端点供玩家接线 */
export function addExternalTerminals(net: RailNetwork, m: MapData): void {
  for (const t of m.terminals) {
    // 站台在终点站场地的东侧；西端带交叉渡线，伸到场地外 4 格，玩家从那里接线
    const cx = t.entry.x + THROAT + CONFIG.rail.stationLengthCells / 2;
    const plan = planStation(net, m, 'island', cx, t.entry.y, 1, 0, [true, false]);
    buildStation(net, m, plan, t.name, 0, { external: true, z: t.elevation, openDay: 0 });
  }
}

/** 拆除车站：站台股道变回普通股道（之后可以再拆股道）。返回退款 */
export function removeStation(net: RailNetwork, stationId: number): number {
  const st = net.stations.get(stationId);
  if (!st || st.external) return 0;
  for (const e of net.edgesOfStation(stationId)) {
    delete e.stationId;
    delete e.role;
  }
  net.stations.delete(stationId);
  net.version++;
  return Math.round(st.cost * CONFIG.rail.refundRatio);
}

/** 拆除一段股道，返回退款；车站股道须先拆车站 */
export function removeTrack(net: RailNetwork, edgeId: number): number | string {
  const e = net.edges.get(edgeId);
  if (!e) return '找不到这段股道';
  if (e.stationId !== undefined) return '这是车站的股道，请先拆除车站';
  net.removeEdge(edgeId);
  return Math.round(e.cost * CONFIG.rail.refundRatio);
}
