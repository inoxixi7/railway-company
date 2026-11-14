import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { groundHeight } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import type { DraftEval } from '../sim/rail/draft';
import { pieceAt, pieceLength, type Piece, type Pt } from '../sim/rail/geometry';
import type { RailNetwork, REdge, StationRec, Structure } from '../sim/rail/network';
import type { StationPlan } from '../sim/rail/stations';
import { metersToY } from './coords';

/** 画面上的道床与轨道宽度（格）：比实物略宽，远看也能看清 */
const BALLAST_W = 0.19;
const TRACK_W = 0.075;

const MAT = {
  ballast: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0x9b958c }),
  site: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xb98f5c }),
  rail: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0x4a3f38 }),
  deck: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xa39e95 }),
  pier: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xb0aba2 }),
  portal: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0x55504a }),
  platform: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xdbd5c7 }),
  scaffold: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xe0a040 }),
  roof: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0x5a6f86 }),
  wall: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xeae3d3 }),
};
type MatKey = keyof typeof MAT;

interface Sample {
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** 世界 Y */
  h: number;
}

/** 沿一串采样点生成带状网格（可带厚度） */
function ribbon(samples: Sample[], offset: number, width: number, lift: number, thick = 0): THREE.BufferGeometry | null {
  if (samples.length < 2) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const p of samples) {
    // 法线 (-ty, tx)
    const cx = p.x - p.ty * offset;
    const cz = p.y + p.tx * offset;
    const y = p.h + lift;
    pos.push(cx - (p.ty * width) / 2, y, cz + (p.tx * width) / 2, cx + (p.ty * width) / 2, y, cz - (p.tx * width) / 2);
    if (thick > 0) pos.push(cx - (p.ty * width) / 2, y - thick, cz + (p.tx * width) / 2, cx + (p.ty * width) / 2, y - thick, cz - (p.tx * width) / 2);
  }
  const stride = thick > 0 ? 4 : 2;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = i * stride;
    const b = (i + 1) * stride;
    // 顶面朝上
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    if (thick > 0) idx.push(a, a + 2, b, a + 2, b + 2, b, a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function normalize(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position') out.deleteAttribute(name);
  out.computeVertexNormals();
  return out;
}

class Batch {
  private geos: Partial<Record<MatKey, THREE.BufferGeometry[]>> = {};
  put(k: MatKey, g: THREE.BufferGeometry | null): void {
    if (g) (this.geos[k] ??= []).push(normalize(g));
  }
  box(k: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, yaw = 0): void {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (yaw) g.rotateY(yaw);
    g.translate(x, y, z);
    this.put(k, g);
  }
  build(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [k, list] of Object.entries(this.geos)) {
      if (list?.length) group.add(new THREE.Mesh(mergeGeometries(list), MAT[k as MatKey]));
    }
    return group;
  }
}

function edgeSamples(net: RailNetwork, m: MapData, e: REdge, s0: number, s1: number): Sample[] {
  const n = Math.max(1, Math.ceil((s1 - s0) / 0.25));
  const out: Sample[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const p = pieceAt(e.piece, s);
    out.push({ x: p.x, y: p.y, tx: p.tx, ty: p.ty, h: metersToY(m, net.zAt(e, s)) });
  }
  return out;
}

/** 把一段股道按构造类型切成连续的几段 */
function runs(net: RailNetwork, e: REdge): { a: number; b: number; st: Structure }[] {
  const len = pieceLength(e.piece);
  const out: { a: number; b: number; st: Structure }[] = [];
  for (let s = 0; s < len - 1e-9; s += 0.5) {
    const b = Math.min(len, s + 0.5);
    const st = net.structureAt(e, (s + b) / 2);
    const last = out[out.length - 1];
    if (last && last.st === st) last.b = b;
    else out.push({ a: s, b, st });
  }
  return out;
}

/** 整个轨道网络（股道、桥隧、车站）。网络变化或有区段竣工时整体重建 */
export function buildRail(net: RailNetwork, m: MapData, today: number): THREE.Group {
  const batch = new Batch();
  for (const e of net.edges.values()) {
    const open = today >= e.openDay;
    for (const run of runs(net, e)) {
      const sm = edgeSamples(net, m, e, run.a, run.b);
      if (run.st === 'tunnel') {
        // 隧道内不画，只在洞口立一个门
        for (const p of [sm[0], sm[sm.length - 1]]) batch.box('portal', 0.12, 0.34, 0.34, p.x, p.h + 0.15, p.y, Math.atan2(-p.ty, p.tx));
        continue;
      }
      batch.put(open ? 'ballast' : 'site', ribbon(sm, 0, BALLAST_W, 0.03));
      if (open) batch.put('rail', ribbon(sm, 0, TRACK_W, 0.045));
      if (run.st === 'bridge' || run.st === 'viaduct') {
        batch.put('deck', ribbon(sm, 0, 0.24, 0.0, 0.07));
        for (let i = 2; i < sm.length - 1; i += 8) {
          const p = sm[i];
          const ground = metersToY(m, groundHeight(m, p.x, p.y) - 2);
          const hgt = p.h - 0.07 - ground;
          if (hgt > 0.05) batch.box('pier', 0.09, hgt, 0.16, p.x, ground + hgt / 2, p.y, Math.atan2(-p.ty, p.tx));
        }
      }
    }
  }
  for (const st of net.stations.values()) stationModel(batch, net, m, st, today >= st.openDay);
  return batch.build('rail');
}

/** 沿车站轴线的采样（站台、雨棚用） */
function axisSamples(st: { x: number; y: number; hx: number; hy: number }, half: number, h: number): Sample[] {
  const out: Sample[] = [];
  for (let a = -half; a <= half + 1e-9; a += 0.5) out.push({ x: st.x + st.hx * a, y: st.y + st.hy * a, tx: st.hx, ty: st.hy, h });
  return out;
}

function stationModel(batch: Batch, net: RailNetwork, m: MapData, st: StationRec, open: boolean): void {
  const plats = net.platformsOf(st.id);
  if (!plats.length) return;
  const h = metersToY(m, net.zAt(plats[0], 0));
  const L = CONFIG.rail.stationLengthCells / 2;
  const ph = 1.1 / m.cellMeters;
  const mat: MatKey = open ? 'platform' : 'scaffold';
  // 站台相对车站轴线的横向位置
  const offsets = st.type === 'island' ? [0] : st.type === 'side' ? [0.33, -0.33] : [0.24];
  const width = st.type === 'island' ? 0.24 : 0.2;
  for (const o of offsets) {
    batch.put(mat, ribbon(axisSamples(st, L, h), o, width, ph, ph));
    if (open) batch.put('roof', ribbon(axisSamples(st, L - 1, h), o, width - 0.04, ph + 0.17, 0.02));
  }
  if (open) {
    // 站房
    const o = st.type === 'island' ? 0.75 : st.type === 'side' ? 0.62 : 0.5;
    batch.box('wall', 1.4, 0.2, 0.36, st.x - st.hy * o, h + 0.1, st.y + st.hx * o, Math.atan2(-st.hy, st.hx));
  }
}

const DRAFT_COLORS: Record<Structure, number> = { ground: 0xffffff, viaduct: 0xc39bff, bridge: 0x6ec6ff, tunnel: 0x555555 };

/** 草案预览：按构造着色的带子（始终画在最上层），问题处画红圈 */
export function buildDraftPreview(m: MapData, ev: DraftEval, centerline: Piece[]): THREE.Group {
  const group = new THREE.Group();
  const pr = ev.profile;
  const byKind = new Map<Structure, THREE.BufferGeometry[]>();
  for (const chain of ev.chains) {
    let s = 0;
    chain.forEach((piece, i) => {
      const cl = pieceLength(centerline[i]);
      const len = pieceLength(piece);
      const n = Math.max(1, Math.ceil(len / 0.25));
      let cur: Sample[] = [];
      let kind: Structure | null = null;
      for (let j = 0; j <= n; j++) {
        const q = s + (cl * j) / n;
        const u = Math.max(0, Math.min(pr.z.length - 1, q / pr.step));
        const k0 = Math.min(pr.z.length - 2, Math.floor(u));
        const z = pr.z[k0] + (pr.z[k0 + 1] - pr.z[k0]) * (u - k0);
        const st = pr.structure[Math.round(u)];
        const p = pieceAt(piece, (len * j) / n);
        const smp = { x: p.x, y: p.y, tx: p.tx, ty: p.ty, h: metersToY(m, z) };
        cur.push(smp);
        if (kind !== null && st !== kind) {
          const g = ribbon(cur, 0, 0.2, 0.09);
          if (g) (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push(g);
          cur = [smp];
        }
        kind = st;
      }
      const g = ribbon(cur, 0, 0.2, 0.09);
      if (g && kind) (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push(g);
      s += cl;
    });
  }
  for (const [kind, list] of byKind) {
    const mesh = new THREE.Mesh(
      mergeGeometries(list.map(normalize)),
      new THREE.MeshBasicMaterial({ color: ev.ok ? DRAFT_COLORS[kind] : 0xff6b6b, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = 5;
    group.add(mesh);
  }
  for (const c of ev.crossings) group.add(marker(m, c, 0xffc233, 0.45));
  for (const i of ev.issues) if (i.at) group.add(marker(m, i.at, 0xff3b30, 0.7));
  return group;
}

/** 圆环标记 */
export function marker(m: MapData, p: Pt, color: number, r: number): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.65, r, 20), new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(p.x, metersToY(m, groundHeight(m, p.x, p.y)) + 0.25, p.y);
  ring.renderOrder = 6;
  return ring;
}

/** 车站候选位置：占地矩形 + 股道 */
export function buildStationPreview(m: MapData, plan: StationPlan): THREE.Group {
  const group = new THREE.Group();
  const h = metersToY(m, plan.z) + 0.2;
  const g = new THREE.PlaneGeometry(plan.extent[0] + plan.extent[1], plan.halfWidth * 2);
  g.translate((plan.extent[1] - plan.extent[0]) / 2, 0, 0);
  g.rotateX(-Math.PI / 2);
  const rect = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: plan.ok ? 0x34c759 : 0xff3b30, transparent: true, opacity: 0.45, depthTest: false }));
  rect.rotation.y = Math.atan2(-plan.hy, plan.hx);
  rect.position.set(plan.x, h, plan.y);
  rect.renderOrder = 5;
  group.add(rect);
  const lines: THREE.BufferGeometry[] = [];
  for (const { piece } of plan.pieces) {
    const len = pieceLength(piece);
    const sm: Sample[] = [];
    for (let s = 0; s <= len + 1e-9; s += 0.25) {
      const p = pieceAt(piece, Math.min(len, s));
      sm.push({ x: p.x, y: p.y, tx: p.tx, ty: p.ty, h });
    }
    const r = ribbon(sm, 0, 0.1, 0.02);
    if (r) lines.push(normalize(r));
  }
  if (lines.length) {
    const mesh = new THREE.Mesh(mergeGeometries(lines), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 6;
    group.add(mesh);
  }
  return group;
}
