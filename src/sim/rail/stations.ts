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

export interface StationPlan {
  type: StationType;
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** 站台股道与咽喉（独立放置时新建） */
  platforms: Piece[];
  throats: Piece[];
  /** 在已有股道上建站时：要改成站台的股道 id 与范围 */
  onTrack: { edgeId: number; s0: number; s1: number }[];
  z: number;
  ok: boolean;
  issues: string[];
  cost: number;
  /** 占地（用于预览）：中心线两端与半宽 */
  halfLength: number;
  halfWidth: number;
}

const line = (ax: number, ay: number, bx: number, by: number): Piece => ({ k: 'L', ax, ay, bx, by });

/** 独立放置的车站：中心 (x, y)，方向 (hx, hy) */
export function planStation(net: RailNetwork, m: MapData, type: StationType, x: number, y: number, hx: number, hy: number): StationPlan {
  const len = Math.hypot(hx, hy) || 1;
  hx /= len;
  hy /= len;
  const nx = -hy;
  const ny = hx;
  const L = CONFIG.rail.stationLengthCells / 2;
  const half = trackSpacing(m) / 2;
  const at = (along: number, off: number): Pt => ({ x: x + hx * along + nx * off, y: y + hy * along + ny * off });
  const platforms: Piece[] = [];
  const throats: Piece[] = [];
  let halfLength = L;
  if (type === 'single') {
    const a = at(-L, 0);
    const b = at(L, 0);
    platforms.push(line(a.x, a.y, b.x, b.y));
  } else if (type === 'side') {
    for (const o of [half, -half]) {
      const a = at(-L, o);
      const b = at(L, o);
      platforms.push(line(a.x, a.y, b.x, b.y));
    }
  } else {
    halfLength = L + THROAT;
    for (const sgn of [1, -1]) {
      const o = (ISLAND_SPACING / 2) * sgn;
      const a = at(-L, o);
      const b = at(L, o);
      platforms.push(line(a.x, a.y, b.x, b.y));
      const h = { x: hx, y: hy };
      const west = biarc(at(-L - THROAT, half * sgn), h, a, h);
      const east = biarc(b, h, at(L + THROAT, half * sgn), h);
      if (west) throats.push(...west);
      if (east) throats.push(...east);
    }
  }
  const halfWidth = type === 'single' ? 0.7 : type === 'side' ? 0.9 : 1;

  const issues: string[] = [];
  let sum = 0;
  let k = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  let bad: string | null = null;
  for (let a = -halfLength; a <= halfLength; a += 0.5) {
    for (const o of [-halfWidth, 0, halfWidth]) {
      const p = at(a, o);
      const cx = Math.floor(p.x);
      const cy = Math.floor(p.y);
      if (!inBounds(m, cx, cy) || p.x < 1 || p.y < 1 || p.x > m.width - 1 || p.y > m.height - 1) {
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
  return { type, x, y, hx, hy, platforms, throats, onTrack: [], z: k ? sum / k : 0, ok: issues.length === 0, issues, cost: CONFIG.rail.stationCost[type], halfLength, halfWidth };
}

/** 在已有股道的直线段上建站。type 为岛式时不可用（需要独立放置） */
export function planStationOnTrack(net: RailNetwork, m: MapData, type: StationType, edge: REdge, s: number): StationPlan {
  const L = CONFIG.rail.stationLengthCells / 2;
  const len = pieceLength(edge.piece);
  const issues: string[] = [];
  const sc = Math.max(L, Math.min(len - L, s));
  const c = pieceAt(edge.piece, sc);
  const base: StationPlan = { type, x: c.x, y: c.y, hx: c.tx, hy: c.ty, platforms: [], throats: [], onTrack: [], z: net.zAt(edge, sc), ok: false, issues, cost: CONFIG.rail.stationCost[type], halfLength: L, halfWidth: type === 'single' ? 0.7 : 0.9 };
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
  // 独立放置：把各段首尾相接建成股道
  const nodeAt = (p: { x: number; y: number; tx: number; ty: number }) => {
    const near = [...net.nodes.values()].find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 1e-4);
    return near ?? net.addNode(p.x, p.y, z, p.tx, p.ty);
  };
  const add = (piece: Piece, role: 'platform' | 'throat') => {
    const a = nodeAt(pieceAt(piece, 0));
    const b = nodeAt(pieceAt(piece, pieceLength(piece)));
    const e = net.addEdge({ a: a.id, b: b.id, piece, ...flat(piece), cost: 0, openDay, stationId: id, role });
    newEdges.push(e.id);
  };
  for (const p of plan.platforms) add(p, 'platform');
  for (const p of plan.throats) add(p, 'throat');
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
  if (newEdges.length && !opts.external) earthworks(net, m, newEdges);
  const rec: StationRec = { id, name, type: plan.type, x: plan.x, y: plan.y, hx: plan.hx, hy: plan.hy, external: opts.external, cost: opts.external ? 0 : plan.cost, openDay };
  for (const e of net.edgesOfStation(id)) e.openDay = Math.max(e.openDay, e.stationId === id && plan.onTrack.length ? e.openDay : openDay);
  net.stations.set(id, rec);
  net.version++;
  return rec;
}

/** 地图上既有的终点站（大城市方向）：岛式，西端两个端点供玩家接线 */
export function addExternalTerminals(net: RailNetwork, m: MapData): void {
  for (const t of m.terminals) {
    const cx = t.entry.x + THROAT + CONFIG.rail.stationLengthCells / 2;
    const plan = planStation(net, m, 'island', cx, t.entry.y, 1, 0);
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
