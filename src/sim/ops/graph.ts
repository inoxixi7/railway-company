import { pieceAt, pieceLength, pieceRadius } from '../rail/geometry';
import type { RailNetwork, REdge } from '../rail/network';

/** 沿一段股道朝某个方向行驶：dir = +1 从 a 到 b，-1 从 b 到 a */
export interface Hop {
  edge: number;
  dir: 1 | -1;
}

/** 从一个 hop 的末端节点可以接着走的 hop（只能从节点的一侧驶向另一侧） */
export function nextHops(net: RailNetwork, hop: Hop): Hop[] {
  const e = net.edges.get(hop.edge);
  if (!e) return [];
  const nodeId = hop.dir > 0 ? e.b : e.a;
  const ends = net.edgesAt(nodeId);
  const mine = ends.find((x) => x.edge.id === e.id && x.end === (hop.dir > 0 ? 'b' : 'a'));
  if (!mine) return [];
  return ends.filter((x) => x.side !== mine.side).map((x) => ({ edge: x.edge.id, dir: x.end === 'a' ? 1 : -1 }) as Hop);
}

/** hop 末端的节点 */
export function hopEndNode(net: RailNetwork, hop: Hop): number {
  const e = net.edges.get(hop.edge)!;
  return hop.dir > 0 ? e.b : e.a;
}

/**
 * 靠左行驶：如果这段股道在行进方向的左侧紧挨着另一条平行股道，
 * 说明自己在一对股道的右边，逆着习惯方向，寻路时加罚。
 */
export class KeepLeft {
  private version = -1;
  private cache = new Map<string, boolean>();

  constructor(
    private net: RailNetwork,
    private spacing: number,
  ) {}

  wrongSide(hop: Hop): boolean {
    if (this.version !== this.net.version) {
      this.version = this.net.version;
      this.cache.clear();
    }
    const key = `${hop.edge}:${hop.dir}`;
    let v = this.cache.get(key);
    if (v === undefined) {
      const e = this.net.edges.get(hop.edge)!;
      const len = pieceLength(e.piece);
      const p = pieceAt(e.piece, len / 2);
      // 行进方向的左侧：y 向南的坐标里是 (ty, -tx)·dir
      const lx = p.x + p.ty * hop.dir * this.spacing;
      const ly = p.y - p.tx * hop.dir * this.spacing;
      v = false;
      for (const o of this.net.edges.values()) {
        if (o.id === e.id || o.role === 'depot') continue;
        const q = nearest(o, lx, ly);
        if (q < 0.06) {
          v = true;
          break;
        }
      }
      this.cache.set(key, v);
    }
    return v;
  }
}

function nearest(e: REdge, x: number, y: number): number {
  const len = pieceLength(e.piece);
  let best = Infinity;
  const n = Math.max(2, Math.ceil(len / 0.5));
  for (let i = 0; i <= n; i++) {
    const p = pieceAt(e.piece, (len * i) / n);
    best = Math.min(best, Math.hypot(p.x - x, p.y - y));
  }
  return best;
}

export interface PathQuery {
  /** 起点状态（列车所在股道的两个方向），可带初始代价（掉头） */
  starts: { hop: Hop; cost: number }[];
  /** 到达这段股道即为终点（路径以它结尾） */
  isGoal: (e: REdge) => boolean;
  /** 这段股道（或它末端的平交点）现在不能用 */
  blocked: (hop: Hop) => boolean;
  /** 代价倍数（靠左行驶等） */
  factor: (hop: Hop) => number;
}

/** Dijkstra：返回从起点股道到目标股道的 hop 序列（含首尾） */
export function findPath(net: RailNetwork, q: PathQuery): Hop[] | null {
  const key = (h: Hop) => h.edge * 2 + (h.dir > 0 ? 1 : 0);
  const dist = new Map<number, number>();
  const prev = new Map<number, Hop | null>();
  const hops = new Map<number, Hop>();
  const open: { h: Hop; d: number }[] = [];
  for (const s of q.starts) {
    const k = key(s.hop);
    dist.set(k, s.cost);
    prev.set(k, null);
    hops.set(k, s.hop);
    open.push({ h: s.hop, d: s.cost });
  }
  const startEdges = new Set(q.starts.map((s) => s.hop.edge));
  while (open.length) {
    // 网络不大，线性找最小值即可
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].d < open[bi].d) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.h);
    if (cur.d > (dist.get(ck) ?? Infinity)) continue;
    const ce = net.edges.get(cur.h.edge)!;
    if (!startEdges.has(ce.id) && q.isGoal(ce)) {
      const path: Hop[] = [];
      let k: number | undefined = ck;
      while (k !== undefined) {
        path.push(hops.get(k)!);
        const p: Hop | null | undefined = prev.get(k);
        k = p ? key(p) : undefined;
      }
      return path.reverse();
    }
    for (const nh of nextHops(net, cur.h)) {
      if (q.blocked(nh)) continue;
      const ne = net.edges.get(nh.edge)!;
      const d = cur.d + pieceLength(ne.piece) * q.factor(nh);
      const nk = key(nh);
      if (d < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, d);
        prev.set(nk, cur.h);
        hops.set(nk, nh);
        open.push({ h: nh, d });
      }
    }
  }
  return null;
}

/** 股道的曲线限速（m/s） */
export function curveLimit(e: REdge, cellMeters: number, k: number): number {
  const r = pieceRadius(e.piece);
  return r === Infinity ? Infinity : (k * Math.sqrt(r * cellMeters)) / 3.6;
}
