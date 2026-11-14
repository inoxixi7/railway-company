import { CONFIG } from '../../config';
import { cellIndex, inBounds } from '../map/query';
import { Cover, type MapData } from '../map/types';
import { biarc, intersectPieces, pieceAt, pieceLength, pieceRadius, reversePiece, tangentArc, type Piece, type Pt } from './geometry';
import { type RailNetwork, type REdge, type RNode, type Structure, Z_STEP } from './network';
import { computeProfile, summarizeProfile, type Profile, type ProfileConstraint, type ProfileSummary } from './profile';

/** 草案的起点或终点接在哪里 */
export type Anchor =
  | { kind: 'free' }
  | { kind: 'node'; id: number }
  | { kind: 'edge'; id: number; s: number }
  /** 一次铺两条时接在一对平行端点上：[正侧, 反侧] */
  | { kind: 'pair'; ids: [number, number] };

export interface Draft {
  /** 一次铺几条股道：1 = 单条，2 = 两条平行（复线） */
  mode: 1 | 2;
  start: Anchor;
  startPt: Pt;
  /** 草案中心线（单条时就是股道本身） */
  pieces: Piece[];
  /** 每一笔结束时的段数，用于撤销 */
  strokes: number[];
  end: Anchor;
  /** 与已有股道相交时：平面交叉或立体交叉 */
  crossing: 'flat' | 'over';
}

export const trackSpacing = (m: MapData): number => CONFIG.rail.trackSpacingM / m.cellMeters;

/** 把一段向法线方向（行进方向左转 90°，即 (-ty, tx)）平移 d */
export function offsetPiece(p: Piece, d: number): Piece {
  if (p.k === 'L') {
    const len = Math.hypot(p.bx - p.ax, p.by - p.ay) || 1;
    const nx = -(p.by - p.ay) / len;
    const ny = (p.bx - p.ax) / len;
    return { k: 'L', ax: p.ax + nx * d, ay: p.ay + ny * d, bx: p.bx + nx * d, by: p.by + ny * d };
  }
  return { ...p, r: p.r - d * Math.sign(p.sweep) };
}

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const neg = (a: Pt): Pt => ({ x: -a.x, y: -a.y });

export interface StartPick {
  anchor: Anchor;
  pt: Pt;
  /** 可以出发的方向；空 = 自由起点 */
  dirs: Pt[];
  /** 这个起点只能铺单条 */
  single: boolean;
}

/** 在 (x, y) 附近确定草案的起点：吸附到端点、已有股道（分岔）或自由地面 */
export function pickStart(net: RailNetwork, m: MapData, x: number, y: number, mode: 1 | 2): StartPick {
  const node = net.nearestNode(x, y, CONFIG.rail.snapNodeCells);
  if (node) {
    const ends = net.edgesAt(node.id);
    if (ends.length === 1) {
      const out = neg(net.leaveDir(ends[0].edge, ends[0].end));
      if (mode === 2) {
        const sib = net.pairSibling(node.id, trackSpacing(m));
        if (sib) {
          const mid = { x: (node.x + sib.x) / 2, y: (node.y + sib.y) / 2 };
          const plus = (node.x - mid.x) * -out.y + (node.y - mid.y) * out.x > 0;
          return { anchor: { kind: 'pair', ids: plus ? [node.id, sib.id] : [sib.id, node.id] }, pt: mid, dirs: [out], single: false };
        }
      }
      return { anchor: { kind: 'node', id: node.id }, pt: { x: node.x, y: node.y }, dirs: [out], single: true };
    }
    const h = { x: node.hx, y: node.hy };
    const dirs = [h, neg(h)].filter((d) => net.canAttach(node.id, d));
    if (dirs.length) return { anchor: { kind: 'node', id: node.id }, pt: { x: node.x, y: node.y }, dirs, single: true };
  }
  const hit = net.nearestEdge(x, y, CONFIG.rail.snapEdgeCells);
  if (hit && hit.edge.stationId === undefined) {
    const p = pieceAt(hit.edge.piece, hit.s);
    return { anchor: { kind: 'edge', id: hit.edge.id, s: hit.s }, pt: { x: p.x, y: p.y }, dirs: [{ x: p.tx, y: p.ty }, { x: -p.tx, y: -p.ty }], single: true };
  }
  return { anchor: { kind: 'free' }, pt: { x, y }, dirs: [], single: false };
}

export interface Stroke {
  pieces: Piece[];
  end: Anchor;
}

/**
 * 从 P（方向 dirs 之一；空 = 无约束）画到目标 T 的一笔。
 * 目标靠近端点或已有股道时自动吸附并用双圆弧接顺。
 */
export function strokeTo(net: RailNetwork, m: MapData, P: Pt, dirs: Pt[], T: Pt, mode: 1 | 2, exclude: Anchor): Stroke | null {
  const approach = { x: T.x - P.x, y: T.y - P.y };
  const h = dirs.length ? dirs.reduce((a, b) => (dot(b, approach) > dot(a, approach) ? b : a)) : null;
  // 终点吸附
  let Q: Pt | null = null;
  let d: Pt | null = null;
  let end: Anchor = { kind: 'free' };
  const excluded = (id: number) => (exclude.kind === 'node' && exclude.id === id) || (exclude.kind === 'pair' && exclude.ids.includes(id));
  const node = net.nearestNode(T.x, T.y, CONFIG.rail.snapNodeCells);
  if (node && !excluded(node.id)) {
    const ends = net.edgesAt(node.id);
    if (ends.length === 1) {
      const into = net.leaveDir(ends[0].edge, ends[0].end);
      const sib = mode === 2 ? net.pairSibling(node.id, trackSpacing(m)) : null;
      if (mode === 2 && sib && !excluded(sib.id)) {
        Q = { x: (node.x + sib.x) / 2, y: (node.y + sib.y) / 2 };
        d = into;
        const plus = (node.x - Q.x) * -into.y + (node.y - Q.y) * into.x > 0;
        end = { kind: 'pair', ids: plus ? [node.id, sib.id] : [sib.id, node.id] };
      } else if (mode === 1) {
        Q = { x: node.x, y: node.y };
        d = into;
        end = { kind: 'node', id: node.id };
      }
    } else if (mode === 1) {
      const hh = { x: node.hx, y: node.hy };
      const dd = dot(hh, approach) >= 0 ? hh : neg(hh);
      if (net.canAttach(node.id, neg(dd))) {
        Q = { x: node.x, y: node.y };
        d = dd;
        end = { kind: 'node', id: node.id };
      }
    }
  }
  if (!Q && mode === 1) {
    const hit = net.nearestEdge(T.x, T.y, CONFIG.rail.snapEdgeCells);
    if (hit && hit.edge.stationId === undefined && !(exclude.kind === 'edge' && exclude.id === hit.edge.id)) {
      const len = pieceLength(hit.edge.piece);
      // 离端点太近时不并线（那里会吸附到端点）
      if (hit.s > 1 && hit.s < len - 1) {
        const p = pieceAt(hit.edge.piece, hit.s);
        const t = { x: p.tx, y: p.ty };
        Q = { x: p.x, y: p.y };
        d = dot(t, approach) >= 0 ? t : neg(t);
        end = { kind: 'edge', id: hit.edge.id, s: hit.s };
      }
    }
  }
  if (Q && d) {
    if (h) {
      const ps = biarc(P, h, Q, d);
      if (ps) return { pieces: ps, end };
    } else {
      const back = tangentArc(Q, neg(d), P);
      if (back) return { pieces: [reversePiece(back)], end };
    }
    // 接不顺：按不吸附处理
  }
  if (h) {
    const p = tangentArc(P, h, T);
    return p ? { pieces: [p], end: { kind: 'free' } } : null;
  }
  if (Math.hypot(approach.x, approach.y) < 0.5) return null;
  return { pieces: [{ k: 'L', ax: P.x, ay: P.y, bx: T.x, by: T.y }], end: { kind: 'free' } };
}

/** 草案末端的位置与方向 */
export function draftEnd(d: Draft): { pt: Pt; dir: Pt | null } {
  if (!d.pieces.length) return { pt: d.startPt, dir: null };
  const last = d.pieces[d.pieces.length - 1];
  const p = pieceAt(last, pieceLength(last));
  return { pt: { x: p.x, y: p.y }, dir: { x: p.tx, y: p.ty } };
}

export interface DraftCrossing {
  x: number;
  y: number;
  /** 在中心线上的位置（格） */
  s: number;
  /** 被跨越的股道轨面高度（米） */
  z: number;
  angle: number;
}

export interface DraftEval {
  ok: boolean;
  issues: { message: string; at: Pt | null }[];
  /** 实际要建的股道（1 或 2 条链，每条与 pieces 一一对应） */
  chains: Piece[][];
  profile: Profile;
  summary: ProfileSummary;
  crossings: DraftCrossing[];
  minRadiusM: number;
}

function anchorZ(net: RailNetwork, a: Anchor): number | undefined {
  if (a.kind === 'node') return net.nodes.get(a.id)?.z;
  if (a.kind === 'pair') return net.nodes.get(a.ids[0])?.z;
  if (a.kind === 'edge') {
    const e = net.edges.get(a.id);
    return e ? net.zAt(e, a.s) : undefined;
  }
  return undefined;
}

export function evaluateDraft(net: RailNetwork, m: MapData, d: Draft): DraftEval | null {
  if (!d.pieces.length) return null;
  const issues: DraftEval['issues'] = [];
  const half = trackSpacing(m) / 2;
  const chains = d.mode === 2 ? [d.pieces.map((p) => offsetPiece(p, half)), d.pieces.map((p) => offsetPiece(p, -half))] : [d.pieces];

  // 中心线的累计里程
  const starts: number[] = [];
  let total = 0;
  for (const p of d.pieces) {
    starts.push(total);
    total += pieceLength(p);
  }
  const at = (s: number): Pt => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > s) i--;
    return pieceAt(d.pieces[i], Math.min(pieceLength(d.pieces[i]), s - starts[i]));
  };

  // 半径与转角
  let minR = Infinity;
  const minCells = CONFIG.rail.minRadiusM / m.cellMeters;
  chains.forEach((chain) =>
    chain.forEach((p, i) => {
      const r = pieceRadius(p);
      minR = Math.min(minR, r);
      const mid = pieceAt(d.pieces[i], pieceLength(d.pieces[i]) / 2);
      if (r < minCells - 1e-6) issues.push({ message: `曲线半径不足（${Math.round(r * m.cellMeters)} m < ${CONFIG.rail.minRadiusM} m）`, at: mid });
      if (p.k === 'A' && Math.abs(p.sweep) > Math.PI * 1.02) issues.push({ message: '一段转弯不能超过 180°', at: mid });
    }),
  );
  if (total < 1) issues.push({ message: '太短了', at: null });

  // 接轨点能否再接
  const checkAttach = (a: Anchor, leave: Pt, pt: Pt) => {
    const ids = a.kind === 'node' ? [a.id] : a.kind === 'pair' ? a.ids : [];
    for (const id of ids) if (!net.canAttach(id, leave)) issues.push({ message: '这个端点不能再接股道', at: pt });
  };
  const first = pieceAt(d.pieces[0], 0);
  const lastP = draftEnd(d);
  checkAttach(d.start, { x: first.tx, y: first.ty }, d.startPt);
  if (lastP.dir) checkAttach(d.end, neg(lastP.dir), lastP.pt);

  // 出界、设施、与已有股道相交或重叠
  const anchorEdges = new Set<number>();
  const anchorPts: Pt[] = [d.startPt, lastP.pt];
  for (const a of [d.start, d.end]) {
    if (a.kind === 'edge') anchorEdges.add(a.id);
    const ids = a.kind === 'node' ? [a.id] : a.kind === 'pair' ? a.ids : [];
    for (const id of ids) for (const e of net.edgesAt(id)) anchorEdges.add(e.edge.id);
  }
  const nearAnchor = (x: number, y: number, r: number) => anchorPts.some((p) => Math.hypot(p.x - x, p.y - y) < r);
  let outside = false;
  let facility = false;
  let overlap: Pt | null = null;
  for (const chain of chains) {
    for (const p of chain) {
      const len = pieceLength(p);
      for (let s = 0; s <= len; s += 0.5) {
        const q = pieceAt(p, s);
        const cx = Math.floor(q.x);
        const cy = Math.floor(q.y);
        if (!inBounds(m, cx, cy) || q.x < 0.5 || q.y < 0.5 || q.x > m.width - 0.5 || q.y > m.height - 0.5) {
          outside = true;
          continue;
        }
        if (m.cover[cellIndex(m, cx, cy)] === Cover.Facility && !nearAnchor(q.x, q.y, 2)) facility = true;
        if (!overlap && !nearAnchor(q.x, q.y, 3)) {
          const hit = net.nearestEdge(q.x, q.y, 0.12);
          if (hit) {
            const t = pieceAt(hit.edge.piece, hit.s);
            // 夹角很小才算重叠（否则是相交）
            if (Math.abs(t.tx * q.ty - t.ty * q.tx) < 0.2) overlap = { x: q.x, y: q.y };
          }
        }
      }
    }
  }
  if (outside) issues.push({ message: '超出地图范围', at: null });
  if (facility) issues.push({ message: '不能穿过既有设施', at: null });
  if (overlap) issues.push({ message: '与已有股道重叠（要并线请把末端拖到那条股道上）', at: overlap });

  const crossings: DraftCrossing[] = [];
  chains.forEach((chain) =>
    chain.forEach((p, i) => {
      for (const e of net.edges.values()) {
        for (const hit of intersectPieces(p, e.piece)) {
          if (nearAnchor(hit.x, hit.y, anchorEdges.has(e.id) ? 2.5 : 0.3)) continue;
          if (e.stationId !== undefined) {
            issues.push({ message: '不能穿过车站', at: { x: hit.x, y: hit.y } });
            continue;
          }
          const scale = pieceLength(d.pieces[i]) / (pieceLength(p) || 1);
          crossings.push({ x: hit.x, y: hit.y, s: starts[i] + hit.sa * scale, z: net.zAt(e, hit.sb), angle: hit.angle });
          if (d.crossing === 'flat' && hit.angle < (25 * Math.PI) / 180) issues.push({ message: '交角太小，不能平面交叉（改用立体交叉，或并线）', at: { x: hit.x, y: hit.y } });
        }
      }
    }),
  );
  // 草案自身相交
  for (let i = 0; i < d.pieces.length; i++) {
    for (let j = i + 2; j < d.pieces.length; j++) {
      if (intersectPieces(d.pieces[i], d.pieces[j]).length) issues.push({ message: '草案自己相交了', at: null });
    }
  }

  // 纵断面
  const cons: ProfileConstraint[] = [];
  const zs = anchorZ(net, d.start);
  const ze = anchorZ(net, d.end);
  if (zs !== undefined) cons.push({ s: 0, pinZ: zs });
  if (ze !== undefined) cons.push({ s: total, pinZ: ze });
  for (const c of crossings) cons.push(d.crossing === 'flat' ? { s: c.s, pinZ: c.z } : { s: c.s, minZ: c.z + CONFIG.rail.overpassClearanceM });
  const profile = computeProfile(m, at, total, cons);
  const summary = summarizeProfile(m, profile, d.mode);
  if (summary.maxGradePermil > CONFIG.rail.maxGradePermil + 0.5) {
    issues.push({ message: `坡度 ${summary.maxGradePermil.toFixed(0)}‰ 超过上限 ${CONFIG.rail.maxGradePermil}‰（高差太大，拉长线路或改变走向）`, at: null });
  }

  return { ok: issues.length === 0, issues, chains, profile, summary, crossings, minRadiusM: minR * m.cellMeters };
}

export interface ApplyResult {
  edgeIds: number[];
  cost: number;
  openDay: number;
}

/** 确认草案：写入网络（进入施工期），并修整路基 */
export function applyDraft(net: RailNetwork, m: MapData, d: Draft, ev: DraftEval, today: number): ApplyResult {
  const openDay = today + ev.summary.days;
  const totalLen = d.pieces.reduce((s, p) => s + pieceLength(p), 0);
  const pr = ev.profile;
  const zAtS = (s: number) => {
    const u = Math.max(0, Math.min(pr.z.length - 1, s / pr.step));
    const i = Math.min(pr.z.length - 2, Math.floor(u));
    return pr.z[i] + (pr.z[i + 1] - pr.z[i]) * (u - i);
  };
  const stAtS = (s: number): Structure => pr.structure[Math.max(0, Math.min(pr.structure.length - 1, Math.round(s / pr.step)))];
  const costPerCell = ev.summary.cost / (totalLen * ev.chains.length || 1);
  const edgeIds: number[] = [];

  // 把接在已有股道中间的锚点变成节点（先处理终点，避免起点切分后 id 失效时找不到）
  const resolveEdgeAnchor = (a: Anchor, pt: Pt): RNode | null => {
    if (a.kind !== 'edge') return null;
    const hit = net.nearestEdge(pt.x, pt.y, 0.5);
    if (!hit) return null;
    return net.splitEdge(hit.edge.id, hit.s);
  };
  const endPt = draftEnd(d).pt;
  const startNodeFromEdge = resolveEdgeAnchor(d.start, d.startPt);
  const endNodeFromEdge = resolveEdgeAnchor(d.end, endPt);

  ev.chains.forEach((chain, k) => {
    let s = 0;
    let prev: RNode | null = null;
    chain.forEach((piece, i) => {
      const cl = pieceLength(d.pieces[i]);
      const a0 = pieceAt(piece, 0);
      if (i === 0) {
        if (d.start.kind === 'node') prev = net.nodes.get(d.start.id)!;
        else if (d.start.kind === 'pair') prev = net.nodes.get(d.start.ids[k])!;
        else if (startNodeFromEdge) prev = startNodeFromEdge;
        else prev = net.addNode(a0.x, a0.y, zAtS(0), a0.tx, a0.ty);
      }
      const last = i === chain.length - 1;
      const b0 = pieceAt(piece, pieceLength(piece));
      let next: RNode;
      if (last && d.end.kind === 'node') next = net.nodes.get(d.end.id)!;
      else if (last && d.end.kind === 'pair') next = net.nodes.get(d.end.ids[k])!;
      else if (last && endNodeFromEdge) next = endNodeFromEdge;
      else next = net.addNode(b0.x, b0.y, zAtS(s + cl), b0.tx, b0.ty);
      const n = Math.max(2, Math.ceil(pieceLength(piece) / Z_STEP) + 1);
      const zs: number[] = [];
      const structure: Structure[] = [];
      for (let j = 0; j < n; j++) {
        const q = s + (cl * j) / (n - 1);
        zs.push(zAtS(q));
        structure.push(stAtS(q));
      }
      // 两端与节点高度对齐
      zs[0] = prev!.z;
      zs[n - 1] = next.z;
      const e = net.addEdge({ a: prev!.id, b: next.id, piece, zs, structure, cost: Math.round(costPerCell * pieceLength(piece)), openDay });
      edgeIds.push(e.id);
      prev = next;
      s += cl;
    });
  });

  // 平面交叉：把两条股道都在交点处切开，交点处的两个节点互相关联
  if (d.crossing === 'flat') {
    for (const c of ev.crossings) {
      const hits = [...net.edges.values()]
        .map((e) => ({ e, hit: nearestOnEdge(e, c.x, c.y) }))
        .filter((h) => h.hit.dist < 0.3 && h.hit.s > 0.2 && h.hit.s < pieceLength(h.e.piece) - 0.2);
      const mine = hits.find((h) => edgeIds.includes(h.e.id));
      const other = hits.find((h) => !edgeIds.includes(h.e.id));
      if (!mine || !other) continue;
      const n1 = net.splitEdge(mine.e.id, mine.hit.s);
      const n2 = net.splitEdge(other.e.id, other.hit.s);
      n1.crossWith = n2.id;
      n2.crossWith = n1.id;
      n1.z = n2.z;
    }
  }

  earthworks(net, m, edgeIds);
  return { edgeIds: [...net.edges.values()].filter((e) => e.openDay === openDay && e.stationId === undefined).map((e) => e.id), cost: ev.summary.cost, openDay };
}

function nearestOnEdge(e: REdge, x: number, y: number): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity };
  const len = pieceLength(e.piece);
  for (let s = 0; s <= len; s += 0.1) {
    const p = pieceAt(e.piece, s);
    const dd = Math.hypot(p.x - x, p.y - y);
    if (dd < best.dist) best = { s, dist: dd };
  }
  return best;
}

/** 路堤/路堑：把地面段两侧的地面修整到路基高度 */
export function earthworks(net: RailNetwork, m: MapData, edgeIds: number[]): void {
  const C = m.width + 1;
  const touched = new Map<number, { h: number; w: number }>();
  for (const id of edgeIds) {
    const e = net.edges.get(id);
    if (!e) continue;
    const len = pieceLength(e.piece);
    for (let s = 0; s <= len; s += 0.5) {
      if (net.structureAt(e, s) !== 'ground') continue;
      const p = pieceAt(e.piece, s);
      const formation = net.zAt(e, s) - 0.6;
      const R = 2.6;
      for (let y = Math.floor(p.y - R); y <= Math.ceil(p.y + R); y++) {
        for (let x = Math.floor(p.x - R); x <= Math.ceil(p.x + R); x++) {
          if (x < 0 || y < 0 || x > m.width || y > m.height) continue;
          const dd = Math.hypot(x - p.x, y - p.y);
          if (dd > R) continue;
          const w = dd <= 0.9 ? 1 : 1 - (dd - 0.9) / (R - 0.9);
          const k = y * C + x;
          const prev = touched.get(k);
          if (!prev || w > prev.w) touched.set(k, { h: formation, w });
        }
      }
    }
  }
  for (const [k, { h, w }] of touched) {
    const x = k % C;
    const y = Math.floor(k / C);
    let nearWater = false;
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      if (inBounds(m, x + dx, y + dy) && m.cover[cellIndex(m, x + dx, y + dy)] === Cover.Water) nearWater = true;
    }
    if (!nearWater) m.heights[k] += (h - m.heights[k]) * w;
  }
}
