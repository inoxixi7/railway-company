import { nearestOnPiece, pieceAt, pieceLength, splitPiece, type Piece, type Pt } from './geometry';

export type StationType = 'single' | 'side' | 'island';
export type Structure = 'ground' | 'viaduct' | 'bridge' | 'tunnel';

export const STATION_TYPE_NAMES: Record<StationType, string> = { single: '一面一线', side: '相对式', island: '岛式' };
export const STRUCTURE_NAMES: Record<Structure, string> = { ground: '地面', viaduct: '高架', bridge: '桥梁', tunnel: '隧道' };

/** 纵断面采样间隔（格）= 10 m */
export const Z_STEP = 0.5;

/** 车站：由一条或两条站台股道（以及岛式两端的咽喉）组成 */
export interface StationRec {
  id: number;
  name: string;
  type: StationType;
  /** 站台中心与方向 */
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** 既有终点站（大城市方向），不能拆除 */
  external?: boolean;
  cost: number;
  openDay: number;
}

/** 车辆基地：接在一条股道上的尽头线，列车在这里购入、存放 */
export interface DepotRec {
  id: number;
  /** 尽头线（基地股道）的轨道 id */
  edgeId: number;
  cost: number;
  openDay: number;
}

/**
 * 节点：轨道的端点、接头或道岔。
 * (hx, hy) 是过节点的切线方向；每条相连的轨道从节点的「正侧」或「反侧」离开。
 * 列车只能从一侧的轨道驶向另一侧的轨道。
 */
export interface RNode {
  id: number;
  x: number;
  y: number;
  /** 轨面高度（米） */
  z: number;
  hx: number;
  hy: number;
  /** 平面交叉：与之共用同一位置的另一条线的节点 */
  crossWith?: number;
}

/** 一段股道：从节点 a 到节点 b 的一条直线或圆弧（每段只有一条股道） */
export interface REdge {
  id: number;
  a: number;
  b: number;
  piece: Piece;
  /** 轨面高度采样（米），从 a 到 b 等间距 */
  zs: number[];
  structure: Structure[];
  /** 造价（円），拆除时按比例退还 */
  cost: number;
  /** 竣工的日历日；在此之前是工地 */
  openDay: number;
  /** 属于哪个车站，以及是站台股道还是咽喉 */
  stationId?: number;
  role?: 'platform' | 'throat' | 'depot';
}

export interface EdgeEnd {
  edge: REdge;
  end: 'a' | 'b';
  /** 这条轨道从节点的哪一侧离开：+1 正侧，-1 反侧 */
  side: 1 | -1;
}

export interface NetworkData {
  nodes: RNode[];
  edges: REdge[];
  stations: StationRec[];
  depots: DepotRec[];
  nextId: number;
}

/**
 * 轨道网络（纯数据 + 拓扑操作）。可序列化为 NetworkData。
 */
export class RailNetwork {
  nodes = new Map<number, RNode>();
  edges = new Map<number, REdge>();
  stations = new Map<number, StationRec>();
  depots = new Map<number, DepotRec>();
  private nextId = 1;
  /** 每次结构变化加一，供渲染与运营层判断是否需要重建 */
  version = 0;

  newId(): number {
    return this.nextId++;
  }

  toJSON(): NetworkData {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()], stations: [...this.stations.values()], depots: [...this.depots.values()], nextId: this.nextId };
  }

  static fromJSON(d: NetworkData): RailNetwork {
    const n = new RailNetwork();
    for (const x of d.nodes) n.nodes.set(x.id, x);
    for (const e of d.edges) n.edges.set(e.id, e);
    for (const st of d.stations) n.stations.set(st.id, st);
    for (const dp of d.depots) n.depots.set(dp.id, dp);
    n.nextId = d.nextId;
    return n;
  }

  addNode(x: number, y: number, z: number, hx: number, hy: number): RNode {
    const len = Math.hypot(hx, hy) || 1;
    const node: RNode = { id: this.newId(), x, y, z, hx: hx / len, hy: hy / len };
    this.nodes.set(node.id, node);
    this.version++;
    return node;
  }

  addEdge(e: Omit<REdge, 'id'>): REdge {
    const edge: REdge = { ...e, id: this.newId() };
    this.edges.set(edge.id, edge);
    this.version++;
    return edge;
  }

  /** 轨道在节点处离开的方向（单位向量） */
  leaveDir(edge: REdge, end: 'a' | 'b'): Pt {
    if (end === 'a') {
      const p = pieceAt(edge.piece, 0);
      return { x: p.tx, y: p.ty };
    }
    const p = pieceAt(edge.piece, pieceLength(edge.piece));
    return { x: -p.tx, y: -p.ty };
  }

  edgesAt(nodeId: number): EdgeEnd[] {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    const out: EdgeEnd[] = [];
    for (const edge of this.edges.values()) {
      for (const end of ['a', 'b'] as const) {
        if (edge[end] !== nodeId) continue;
        const d = this.leaveDir(edge, end);
        out.push({ edge, end, side: d.x * node.hx + d.y * node.hy >= 0 ? 1 : -1 });
      }
    }
    return out;
  }

  /** 节点在方向 dir 一侧还能不能再接一条轨道（每侧最多两条，且不能两侧都是两条） */
  canAttach(nodeId: number, dir: Pt): boolean {
    const node = this.nodes.get(nodeId)!;
    const side = dir.x * node.hx + dir.y * node.hy >= 0 ? 1 : -1;
    const ends = this.edgesAt(nodeId);
    const same = ends.filter((e) => e.side === side).length;
    const other = ends.length - same;
    if (same >= 2) return false;
    if (same === 1 && other >= 2) return false;
    // 车站股道的端点和平交点不设道岔
    if (same === 1 && (node.crossWith !== undefined || ends.some((e) => e.edge.stationId !== undefined))) return false;
    return true;
  }

  edgeLength(e: REdge): number {
    return pieceLength(e.piece);
  }

  /** 轨面高度（米） */
  zAt(e: REdge, s: number): number {
    const len = pieceLength(e.piece);
    const u = (Math.max(0, Math.min(len, s)) / len) * (e.zs.length - 1);
    const i = Math.min(e.zs.length - 2, Math.floor(u));
    return e.zs[i] + (e.zs[i + 1] - e.zs[i]) * (u - i);
  }

  structureAt(e: REdge, s: number): Structure {
    const len = pieceLength(e.piece);
    const i = Math.round((Math.max(0, Math.min(len, s)) / len) * (e.structure.length - 1));
    return e.structure[i];
  }

  /** 在 s 处把一段轨道切成两段，返回新节点 */
  splitEdge(edgeId: number, s: number): RNode {
    const e = this.edges.get(edgeId)!;
    const len = pieceLength(e.piece);
    const m = pieceAt(e.piece, s);
    const node = this.addNode(m.x, m.y, this.zAt(e, s), m.tx, m.ty);
    const [p1, p2] = splitPiece(e.piece, s);
    const resample = (from: number, to: number) => {
      const n = Math.max(2, Math.ceil((to - from) / Z_STEP) + 1);
      const zs: number[] = [];
      const st: Structure[] = [];
      for (let i = 0; i < n; i++) {
        const q = from + ((to - from) * i) / (n - 1);
        zs.push(this.zAt(e, q));
        st.push(this.structureAt(e, q));
      }
      return { zs, structure: st };
    };
    const share = s / len;
    this.edges.delete(edgeId);
    this.addEdge({ a: e.a, b: node.id, piece: p1, ...resample(0, s), cost: e.cost * share, openDay: e.openDay });
    this.addEdge({ a: node.id, b: e.b, piece: p2, ...resample(s, len), cost: e.cost * (1 - share), openDay: e.openDay });
    return node;
  }

  removeEdge(edgeId: number): void {
    const e = this.edges.get(edgeId);
    if (!e) return;
    this.edges.delete(edgeId);
    for (const id of [e.a, e.b]) {
      if (this.edgesAt(id).length > 0) continue;
      const n = this.nodes.get(id);
      if (n?.crossWith !== undefined) {
        const other = this.nodes.get(n.crossWith);
        if (other) delete other.crossWith;
      }
      this.nodes.delete(id);
    }
    this.version++;
  }

  nearestNode(x: number, y: number, maxDist: number): RNode | null {
    let best: RNode | null = null;
    let bd = maxDist;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  nearestEdge(x: number, y: number, maxDist: number): { edge: REdge; s: number; dist: number } | null {
    let best: { edge: REdge; s: number; dist: number } | null = null;
    for (const edge of this.edges.values()) {
      const hit = nearestOnPiece(edge.piece, x, y);
      if (hit.dist <= maxDist && (!best || hit.dist < best.dist)) best = { edge, s: hit.s, dist: hit.dist };
    }
    return best;
  }

  /** 车站的站台股道 */
  platformsOf(stationId: number): REdge[] {
    return [...this.edges.values()].filter((e) => e.stationId === stationId && e.role === 'platform');
  }

  edgesOfStation(stationId: number): REdge[] {
    return [...this.edges.values()].filter((e) => e.stationId === stationId);
  }

  /** 与 node 成对的平行端点（相距一个股道间距、方向相同、都是自由端），用于一次铺两条 */
  pairSibling(nodeId: number, spacing: number): RNode | null {
    const n = this.nodes.get(nodeId)!;
    const mine = this.edgesAt(nodeId);
    if (mine.length !== 1) return null;
    for (const m of this.nodes.values()) {
      if (m.id === nodeId) continue;
      const d = Math.hypot(m.x - n.x, m.y - n.y);
      if (Math.abs(d - spacing) > 0.03) continue;
      // 连线须垂直于方向
      if (Math.abs((m.x - n.x) * n.hx + (m.y - n.y) * n.hy) > 0.03) continue;
      const theirs = this.edgesAt(m.id);
      if (theirs.length !== 1) continue;
      const a = this.leaveDir(mine[0].edge, mine[0].end);
      const b = this.leaveDir(theirs[0].edge, theirs[0].end);
      if (a.x * b.x + a.y * b.y > 0.99) return m;
    }
    return null;
  }
}
