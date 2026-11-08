import { CONFIG } from '../../config';
import type { MapData } from '../map/types';
import { depotGeom, lineAlignment, spanAt, type DepotGeom } from '../rail/line';
import { isBuilt, stationTrackCount, type RailLine, type Station } from '../rail/types';
import { sampleAlignment } from '../track/alignment';

/**
 * 运营拓扑：把线路切成互斥资源。
 * - 车站股道（每条一个）
 * - 复线区间：按方向分成若干自动闭塞区间
 * - 单线区间：两个会车点之间整段为一个资源（中间的一面一线车站也包含在内）
 * - 终点站咽喉（复线终点站折返时的渡线）
 * - 出入库线
 * 资源同一时刻只属于一列车。
 */
export type ResKind = 'track' | 'block' | 'stretch' | 'throat' | 'lead';

export interface Res {
  id: number;
  kind: ResKind;
  /** 物理股道标识（同一 lane 上的列车会互相限制）；咽喉、出入库线为 '' */
  lane: string;
  /** 里程范围（格） */
  a: number;
  b: number;
  /** 横向偏移（格，正值在下行方向左侧） */
  offset: number;
  holder: number | null;
  label: string;
}

export interface Node {
  idx: number;
  station: Station;
  tracks: 1 | 2;
  isEnd: boolean;
  /** 站台范围 */
  a: number;
  b: number;
  /** 股道资源 id（1 或 2 个；2 个时 [0] 为下行侧，[1] 为上行侧） */
  trackRes: number[];
  /** 端点站的咽喉资源 */
  throat: number | null;
  /** 是否为会车点（两股道车站或端点站） */
  passing: boolean;
}

export interface Link {
  k: number;
  double: boolean;
  a: number;
  b: number;
  /** 复线：下行/上行闭塞区间资源 id（按各自行进方向排序） */
  down: number[];
  up: number[];
  /** 单线：所属单线区间资源 id */
  stretch: number | null;
}

export interface Topology {
  nodes: Node[];
  links: Link[];
  res: Res[];
  /** 环形容量：列车可停留的位置总数（股道 + 闭塞区间） */
  ringCapacity: number;
  depotNode: number | null;
  depotLead: number | null;
  /** 车辆基地几何与出入库调车时要一并占用的正线资源 */
  depot: { geom: DepotGeom; foul: number[] } | null;
  /** 每 0.5 格的限速（m/s），从 sMin 起 */
  speedLimit: Float32Array;
  sMin: number;
  /** 车站 id → 节点序号 */
  nodeOf: Map<number, number>;
}

export const LIMIT_STEP = 0.5;

/** 由线路构建拓扑；只包含已开通的部分。车站少于 2 个时返回 null */
export function buildTopology(m: MapData, line: RailLine, now: number): Topology | null {
  const L = CONFIG.rail.stationLengthCells;
  // 已开通的连续区间
  const spans = [...line.spans].sort((a, b) => a.s0 - b.s0);
  const intervals: [number, number][] = [];
  for (const sp of spans) {
    if (!isBuilt(sp.build, now)) continue;
    const last = intervals[intervals.length - 1];
    if (last && Math.abs(last[1] - sp.s0) < 1e-6) last[1] = sp.s1;
    else intervals.push([sp.s0, sp.s1]);
  }
  let best: { iv: [number, number]; sts: Station[] } | null = null;
  for (const iv of intervals) {
    const sts = line.stations.filter((st) => isBuilt(st.build, now) && st.s - L / 2 >= iv[0] - 1e-6 && st.s + L / 2 <= iv[1] + 1e-6);
    if (sts.length >= 2 && (!best || sts.length > best.sts.length)) best = { iv, sts };
  }
  if (!best) return null;
  const sts = best.sts.sort((a, b) => a.s - b.s);

  const res: Res[] = [];
  const add = (r: Omit<Res, 'id' | 'holder'>) => {
    res.push({ ...r, id: res.length, holder: null });
    return res.length - 1;
  };
  const sp = CONFIG.rail.trackSpacingM / m.cellMeters / 2;

  const nodes: Node[] = sts.map((st, idx) => {
    const tracks = stationTrackCount(st.type);
    const isEnd = idx === 0 || idx === sts.length - 1;
    const a = st.s - L / 2;
    const b = st.s + L / 2;
    const off = st.type === 'island' ? 0.3 : sp;
    const trackRes =
      tracks === 1
        ? [add({ kind: 'track', lane: `T${st.id}:0`, a, b, offset: 0, label: `${st.name} 1 番线` })]
        : [
            add({ kind: 'track', lane: `T${st.id}:0`, a, b, offset: off, label: `${st.name} 1 番线` }),
            add({ kind: 'track', lane: `T${st.id}:1`, a, b, offset: -off, label: `${st.name} 2 番线` }),
          ];
    return { idx, station: st, tracks, isEnd, a, b, trackRes, throat: null, passing: tracks === 2 || isEnd };
  });

  const links: Link[] = [];
  for (let k = 0; k < nodes.length - 1; k++) {
    const a = nodes[k].b;
    const b = nodes[k + 1].a;
    // 区间内任何一处是单线，就按单线处理
    let double = true;
    for (let s = a; s <= b; s += 0.5) if ((spanAt(line, s)?.tracks ?? 1) === 1) double = false;
    if ((spanAt(line, b)?.tracks ?? 1) === 1) double = false;
    // 中间的一面一线车站只有一条股道：相邻区间只能按单线运行
    for (const n of [nodes[k], nodes[k + 1]]) if (n.tracks === 1 && !n.isEnd) double = false;
    links.push({ k, double, a, b, down: [], up: [], stretch: null });
  }

  // 端点站咽喉（复线端点两股道车站折返用）
  for (const n of [nodes[0], nodes[nodes.length - 1]]) {
    if (n.tracks !== 2) continue;
    const first = n.idx === 0;
    const link = first ? links[0] : links[links.length - 1];
    if (!link?.double) continue;
    // 咽喉在站台的线路一侧外面
    const a = first ? n.b : n.a - 0.5;
    n.throat = add({ kind: 'throat', lane: '', a, b: a + 0.5, offset: 0, label: `${n.station.name} 咽喉` });
  }

  // 复线闭塞区间
  const blockLen = CONFIG.rail.blockLengthM / m.cellMeters;
  for (const link of links) {
    if (!link.double) continue;
    const len = link.b - link.a;
    const nb = Math.max(1, Math.ceil(len / blockLen));
    for (let j = 0; j < nb; j++) {
      const a = link.a + (len * j) / nb;
      const b = link.a + (len * (j + 1)) / nb;
      link.down.push(add({ kind: 'block', lane: `D${link.k}`, a, b, offset: sp, label: `下行 ${link.k + 1}-${j + 1}` }));
    }
    for (let j = nb - 1; j >= 0; j--) {
      const a = link.a + (len * j) / nb;
      const b = link.a + (len * (j + 1)) / nb;
      link.up.push(add({ kind: 'block', lane: `U${link.k}`, a, b, offset: -sp, label: `上行 ${link.k + 1}-${j + 1}` }));
    }
  }

  // 单线区间：会车点之间
  let k = 0;
  while (k < links.length) {
    if (links[k].double) {
      k++;
      continue;
    }
    let j = k;
    while (j < links.length && !links[j].double && (j === k || !nodes[j].passing)) j++;
    // links[k..j-1] 构成一个单线区间（从 nodes[k] 到 nodes[j]）
    const id = add({ kind: 'stretch', lane: `S${k}`, a: nodes[k].b, b: nodes[j].a, offset: 0, label: `单线 ${nodes[k].station.name}–${nodes[j].station.name}` });
    for (let t = k; t < j; t++) links[t].stretch = id;
    // 区间内的一面一线车站股道并入单线区间的 lane
    for (let t = k + 1; t < j; t++) for (const r of nodes[t].trackRes) res[r].lane = `S${k}`;
    k = j;
  }

  // 环形容量：会车点股道 + 闭塞区间（单线区间内的一面一线车站不计）
  let ring = 0;
  for (const n of nodes) if (n.passing) ring += n.tracks;
  for (const l of links) ring += l.down.length + l.up.length;

  // 车辆基地
  let depotNode: number | null = null;
  let depotLead: number | null = null;
  let depot: Topology['depot'] = null;
  if (line.depot && isBuilt(line.depot.build, now)) {
    const idx = nodes.findIndex((n) => n.station.id === line.depot!.stationId);
    if (idx >= 0) {
      depotNode = idx;
      const geom = depotGeom(m, line, line.depot);
      // 站台端到道岔曲线末端：调车经过的正线
      const edge = geom.end > 0 ? nodes[idx].b : nodes[idx].a;
      const a = Math.min(edge, geom.sJoin + geom.end * 2.5);
      const b = Math.max(edge, geom.sJoin + geom.end * 2.5);
      const foul = res.filter((r) => (r.kind === 'block' || r.kind === 'stretch' || r.kind === 'throat') && r.b > a + 1e-6 && r.a < b - 1e-6).map((r) => r.id);
      depotLead = add({ kind: 'lead', lane: '', a, b, offset: 0, label: '出入库线' });
      depot = { geom, foul };
    }
  }

  // 限速表（曲线）
  const al = lineAlignment(m, line);
  const sMin = best.iv[0];
  const count = Math.ceil((best.iv[1] - sMin) / LIMIT_STEP) + 1;
  const speedLimit = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = sampleAlignment(al, sMin + i * LIMIT_STEP);
    const rM = p.radius * m.cellMeters;
    speedLimit[i] = p.radius === Infinity ? 1e9 : (CONFIG.rail.curveSpeedK * Math.sqrt(rM)) / 3.6;
  }

  const nodeOf = new Map(nodes.map((n) => [n.station.id, n.idx]));
  return { nodes, links, res, ringCapacity: ring, depotNode, depotLead, depot, speedLimit, sMin, nodeOf };
}

export function limitAt(t: Topology, s: number): number {
  const i = Math.round((s - t.sMin) / LIMIT_STEP);
  return t.speedLimit[Math.max(0, Math.min(t.speedLimit.length - 1, i))];
}
