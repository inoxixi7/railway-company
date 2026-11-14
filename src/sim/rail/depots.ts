import { CONFIG } from '../../config';
import { cellIndex, groundHeight, inBounds } from '../map/query';
import { Cover, type MapData } from '../map/types';
import { earthworks } from './draft';
import { biarc, pieceAt, pieceLength, type Piece, type Pt } from './geometry';
import { type DepotRec, type RailNetwork, type REdge, type Structure, Z_STEP } from './network';

export interface DepotPlan {
  edgeId: number;
  /** 接轨点在股道上的位置 */
  s: number;
  /** 出入库线（道岔后的两段圆弧）与基地尽头线 */
  lead: Piece[];
  stub: Piece;
  /** 基地场地的中心、方向与半长半宽（预览与画面用） */
  x: number;
  y: number;
  hx: number;
  hy: number;
  z: number;
  ok: boolean;
  issues: string[];
}

/**
 * 车辆基地：点股道旁的平地，从股道上接出一条出入库线，通到与股道平行的尽头线。
 * (x, y) 是点击位置，决定基地在股道的哪一侧、朝哪个方向。
 */
export function planDepot(net: RailNetwork, m: MapData, edge: REdge, s: number, x: number, y: number): DepotPlan {
  const d = CONFIG.ops.depot;
  const len = pieceLength(edge.piece);
  const p = pieceAt(edge.piece, s);
  const issues: string[] = [];
  // 点击位置在股道的哪一侧（法线 (-ty, tx)）
  const side = (x - p.x) * -p.ty + (y - p.y) * p.tx >= 0 ? 1 : -1;
  // 沿股道的方向：点击位置偏向哪头就朝哪头
  const along = (x - p.x) * p.tx + (y - p.y) * p.ty >= 0 ? 1 : -1;
  const h: Pt = { x: p.tx * along, y: p.ty * along };
  const n: Pt = { x: -p.ty * side, y: p.tx * side };
  const P: Pt = { x: p.x, y: p.y };
  const Q: Pt = { x: p.x + h.x * d.leadCells + n.x * d.offsetCells, y: p.y + h.y * d.leadCells + n.y * d.offsetCells };
  const lead = biarc(P, h, Q, h) ?? [];
  const end: Pt = { x: Q.x + h.x * d.lengthCells, y: Q.y + h.y * d.lengthCells };
  const stub: Piece = { k: 'L', ax: Q.x, ay: Q.y, bx: end.x, by: end.y };
  const plan: DepotPlan = { edgeId: edge.id, s, lead, stub, x: (Q.x + end.x) / 2 + n.x * 0.9, y: (Q.y + end.y) / 2 + n.y * 0.9, hx: h.x, hy: h.y, z: net.zAt(edge, s), ok: false, issues };

  if (edge.stationId !== undefined) issues.push('不能接在车站股道上（接在车站外面的直线股道）');
  if (edge.role === 'depot') issues.push('这里已经是车辆基地');
  if (edge.piece.k !== 'L') issues.push('出入库线须从直线股道接出');
  if (s < 1 || s > len - 1) issues.push('离股道端点太近');
  if (net.structureAt(edge, s) !== 'ground') issues.push('只能接在地面股道上');
  if (!lead.length) issues.push('这里接不出出入库线');
  if (issues.length) return plan;

  // 场地：出入库线 + 尽头线两侧
  let minH = Infinity;
  let maxH = -Infinity;
  let bad: string | null = null;
  const check = (q: Pt) => {
    const cx = Math.floor(q.x);
    const cy = Math.floor(q.y);
    if (!inBounds(m, cx, cy) || q.x < 1 || q.y < 1 || q.x > m.width - 1 || q.y > m.height - 1) {
      bad = '超出地图范围';
      return;
    }
    const cover = m.cover[cellIndex(m, cx, cy)];
    if (cover === Cover.Water) bad = '不能建在河上';
    if (cover === Cover.Facility) bad = '与既有设施重叠';
    const g = groundHeight(m, q.x, q.y);
    minH = Math.min(minH, g);
    maxH = Math.max(maxH, g);
  };
  for (let a = 0; a <= d.lengthCells; a += 0.5) {
    for (const o of [0, 0.9, 1.8]) check({ x: Q.x + h.x * a + n.x * o, y: Q.y + h.y * a + n.y * o });
    const c = { x: Q.x + h.x * a, y: Q.y + h.y * a };
    const hit = net.nearestEdge(c.x, c.y, 0.5);
    if (hit) bad = bad ?? '与已有股道重叠';
  }
  if (bad) issues.push(bad);
  else if (maxH - minH > 6) issues.push(`地面高差 ${(maxH - minH).toFixed(0)} m，车辆基地需要平地（≤ 6 m）`);
  plan.ok = issues.length === 0;
  return plan;
}

export function buildDepot(net: RailNetwork, m: MapData, plan: DepotPlan, today: number): DepotRec {
  const z = plan.z;
  const openDay = today + CONFIG.ops.depot.days;
  const junction = net.splitEdge(plan.edgeId, plan.s);
  const flat = (piece: Piece) => {
    const k = Math.max(2, Math.ceil(pieceLength(piece) / Z_STEP) + 1);
    return { zs: new Array<number>(k).fill(z), structure: new Array<Structure>(k).fill('ground') };
  };
  let prev = junction;
  const ids: number[] = [];
  const pieces = [...plan.lead, plan.stub];
  let stubId = 0;
  pieces.forEach((piece, i) => {
    const e0 = pieceAt(piece, pieceLength(piece));
    const next = net.addNode(e0.x, e0.y, z, e0.tx, e0.ty);
    const isStub = i === pieces.length - 1;
    const e = net.addEdge({ a: prev.id, b: next.id, piece, ...flat(piece), cost: 0, openDay, ...(isStub ? { role: 'depot' as const } : {}) });
    ids.push(e.id);
    if (isStub) stubId = e.id;
    prev = next;
  });
  earthworks(net, m, ids);
  const rec: DepotRec = { id: net.newId(), edgeId: stubId, cost: CONFIG.ops.depot.cost, openDay };
  net.depots.set(rec.id, rec);
  net.version++;
  return rec;
}
