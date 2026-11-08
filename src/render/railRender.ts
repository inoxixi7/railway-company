import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { groundHeight } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import { buildTrackLayout, magAt, type TrackLayout } from '../sim/rail/layout';
import { depotGeom, depotPoint, lineAlignment, type DepotGeom, lineLength, spanAt, structureAt, zAt } from '../sim/rail/line';
import { isBuilt, type RailLine, type Station } from '../sim/rail/types';
import { sampleAlignment, type Alignment } from '../sim/track/alignment';
import type { Structure } from '../sim/track/profile';
import { metersToY } from './coords';

const MAT = {
  ballast: new THREE.MeshLambertMaterial({ color: 0x9b958c }),
  ballastNew: new THREE.MeshLambertMaterial({ color: 0xb08a5a }),
  rail: new THREE.MeshLambertMaterial({ color: 0x4a3f38 }),
  deck: new THREE.MeshLambertMaterial({ color: 0x9a958c }),
  pier: new THREE.MeshLambertMaterial({ color: 0xa8a39a }),
  portal: new THREE.MeshLambertMaterial({ color: 0x55504a }),
  platform: new THREE.MeshLambertMaterial({ color: 0xd8d2c4 }),
  roof: new THREE.MeshLambertMaterial({ color: 0x5a6f86 }),
  wall: new THREE.MeshLambertMaterial({ color: 0xe9e2d2 }),
  scaffold: new THREE.MeshLambertMaterial({ color: 0xe0a040 }),
  depotPad: new THREE.MeshLambertMaterial({ color: 0x9d968b }),
  shed: new THREE.MeshLambertMaterial({ color: 0x6d7f74 }),
  switchHead: new THREE.MeshLambertMaterial({ color: 0xd2453a }),
};

/** 画面上的道床与轨道宽度（格）：比实物略宽，远看也能看清 */
const BALLAST_W = 0.26;
const TRACK_W = 0.1;

/** 合并前统一属性：非索引、只保留 position 与 normal */
function normalizeGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

/** 线路在 (s, 横向偏移) 处的世界坐标 */
export function railPoint(m: MapData, line: RailLine, al: Alignment, s: number, offset: number, lift = 0): THREE.Vector3 {
  const p = sampleAlignment(al, s);
  // 左法线（下行方向左侧）
  const x = p.x + p.ty * offset;
  const z = p.y - p.tx * offset;
  return new THREE.Vector3(x, metersToY(m, zAt(line, s)) + lift, z);
}

/** 生成沿线带状网格：在 [s0,s1] 内、偏移由 offsetFn 给出、宽 width、抬高 lift */
function ribbon(
  m: MapData,
  line: RailLine,
  al: Alignment,
  s0: number,
  s1: number,
  offsetFn: (s: number) => number,
  width: number,
  lift: number,
  thick = 0,
): THREE.BufferGeometry | null {
  if (s1 - s0 < 0.05) return null;
  const n = Math.max(1, Math.ceil((s1 - s0) / 0.25));
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const p = sampleAlignment(al, s);
    const off = offsetFn(s);
    const y = metersToY(m, zAt(line, s)) + lift;
    const cx = p.x + p.ty * off;
    const cz = p.y - p.tx * off;
    // 左右边（法线 = (ty, -tx)）
    pos.push(cx + p.ty * width / 2, y, cz - p.tx * width / 2);
    pos.push(cx - p.ty * width / 2, y, cz + p.tx * width / 2);
    if (thick > 0) {
      pos.push(cx + p.ty * width / 2, y - thick, cz - p.tx * width / 2);
      pos.push(cx - p.ty * width / 2, y - thick, cz + p.tx * width / 2);
    }
  }
  const stride = thick > 0 ? 4 : 2;
  for (let i = 0; i < n; i++) {
    const a = i * stride;
    const b = (i + 1) * stride;
    // 顶面朝上（逆时针，从上方看）
    idx.push(a, a + 1, b, a + 1, b + 1, b);
    if (thick > 0) {
      idx.push(a + 2, a, b + 2, a, b, b + 2);
      idx.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 把 [s0,s1] 按结构类型切成若干段 */
function structureRuns(line: RailLine, s0: number, s1: number): { a: number; b: number; st: Structure }[] {
  const runs: { a: number; b: number; st: Structure }[] = [];
  for (let s = s0; s < s1; s += 0.5) {
    const st = structureAt(line, Math.min(s1, s + 0.25));
    const b = Math.min(s1, s + 0.5);
    const last = runs[runs.length - 1];
    if (last && last.st === st) last.b = b;
    else runs.push({ a: s, b, st });
  }
  return runs;
}

/** 整条线路（轨道、桥隧、车站、车辆基地）。线路变化时整体重建 */
export function buildRail(m: MapData, line: RailLine, now: number): { group: THREE.Group; layout: TrackLayout; alignment: Alignment } {
  const group = new THREE.Group();
  group.name = 'rail';
  const al = lineAlignment(m, line);
  const layout = buildTrackLayout(line, m.cellMeters);
  const geos: Record<string, THREE.BufferGeometry[]> = {};
  const put = (k: keyof typeof MAT, g: THREE.BufferGeometry | null) => {
    if (g) (geos[k] ??= []).push(normalizeGeo(g));
  };

  for (const sp of line.spans) {
    if (sp.external) continue;
    const built = isBuilt(sp.build, now);
    for (const run of structureRuns(line, sp.s0, sp.s1)) {
      if (run.st === 'tunnel') continue;
      // 股道：mag > 0 处两条（±mag），否则一条（0）
      const lanes: ((s: number) => number)[] = [];
      const anyDouble = (() => {
        for (let s = run.a; s <= run.b; s += 0.25) if (magAt(layout, s) > 0.01) return true;
        return false;
      })();
      const anySingle = (() => {
        for (let s = run.a; s <= run.b; s += 0.25) if (magAt(layout, s) <= 0.01) return true;
        return false;
      })();
      if (anyDouble) lanes.push((s) => magAt(layout, s), (s) => -magAt(layout, s));
      if (anySingle && !anyDouble) lanes.push(() => 0);
      if (anySingle && anyDouble) {
        // 单复线过渡段：中间一条只画在 mag≈0 的部分
        let a: number | null = null;
        for (let s = run.a; s <= run.b + 1e-6; s += 0.25) {
          const single = magAt(layout, s) <= 0.01;
          if (single && a === null) a = s;
          if ((!single || s >= run.b) && a !== null) {
            put(built ? 'ballast' : 'ballastNew', ribbon(m, line, al, a, Math.min(run.b, s), () => 0, BALLAST_W, 0.03));
            if (built) put('rail', ribbon(m, line, al, a, Math.min(run.b, s), () => 0, TRACK_W, 0.045));
            a = null;
          }
        }
      }
      for (const lane of lanes) {
        put(built ? 'ballast' : 'ballastNew', ribbon(m, line, al, run.a, run.b, lane, BALLAST_W, 0.03));
        if (built) put('rail', ribbon(m, line, al, run.a, run.b, lane, TRACK_W, 0.045));
      }
      // 桥面与桥墩
      if (run.st === 'bridge' || run.st === 'viaduct') {
        const w = (spanAt(line, (run.a + run.b) / 2)?.tracks ?? 1) === 2 ? 0.55 : 0.3;
        put('deck', ribbon(m, line, al, run.a, run.b, () => 0, w, 0.0, 0.08));
        for (let s = run.a + 0.5; s < run.b; s += 2) {
          const p = railPoint(m, line, al, s, 0);
          const ground = metersToY(m, groundHeight(m, p.x, p.z) - 2);
          const h = p.y - 0.08 - ground;
          if (h <= 0.05) continue;
          const g = new THREE.BoxGeometry(0.1, h, 0.25);
          const pt = sampleAlignment(al, s);
          g.rotateY(Math.atan2(-pt.ty, pt.tx));
          g.translate(p.x, ground + h / 2, p.z);
          put('pier', g);
        }
      }
    }
    // 隧道口
    for (const run of structureRuns(line, sp.s0, sp.s1)) {
      if (run.st !== 'tunnel') continue;
      for (const s of [run.a, run.b]) {
        const p = railPoint(m, line, al, s, 0);
        const pt = sampleAlignment(al, s);
        const g = new THREE.BoxGeometry(0.15, 0.35, 0.8);
        g.rotateY(Math.atan2(-pt.ty, pt.tx));
        g.translate(p.x, p.y + 0.15, p.z);
        put('portal', g);
      }
    }
  }

  for (const st of line.stations) if (!st.externalId) buildStation(m, line, al, layout, st, now, put);
  if (line.depot) buildDepot(m, line, layout, now, put);

  for (const [k, list] of Object.entries(geos)) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(list), MAT[k as keyof typeof MAT]);
    mesh.name = `rail-${k}`;
    group.add(mesh);
  }
  void lineLength;
  return { group, layout, alignment: al };
}

function buildStation(
  m: MapData,
  line: RailLine,
  al: Alignment,
  layout: TrackLayout,
  st: Station,
  now: number,
  put: (k: keyof typeof MAT, g: THREE.BufferGeometry | null) => void,
): void {
  const L = CONFIG.rail.stationLengthCells;
  const a = st.s - L / 2;
  const b = st.s + L / 2;
  const built = isBuilt(st.build, now);
  const ph = 1.1 / m.cellMeters; // 站台高 1.1 m（物体不做高度放大）
  const mag = magAt(layout, st.s);
  const plat = built ? 'platform' : 'scaffold';
  if (st.type === 'island') {
    put(plat, ribbon(m, line, al, a, b, () => 0, mag * 2 - 0.2, ph, ph));
    if (built) put('roof', ribbon(m, line, al, a + 0.5, b - 0.5, () => 0, mag * 2 - 0.3, ph + 0.17, 0.02));
  } else if (st.type === 'side') {
    for (const side of [1, -1]) {
      put(plat, ribbon(m, line, al, a, b, () => side * (mag + 0.17), 0.18, ph, ph));
      if (built) put('roof', ribbon(m, line, al, a + 1, b - 1, () => side * (mag + 0.2), 0.14, ph + 0.17, 0.02));
    }
  } else {
    put(plat, ribbon(m, line, al, a, b, () => 0.2, 0.18, ph, ph));
    if (built) put('roof', ribbon(m, line, al, a + 1.5, b - 1.5, () => 0.22, 0.14, ph + 0.17, 0.02));
  }
  // 站房：站台一侧的小楼
  if (built) {
    const p = railPoint(m, line, al, st.s, -(mag + 0.75));
    const pt = sampleAlignment(al, st.s);
    const g = new THREE.BoxGeometry(1.6, 4 / m.cellMeters, 0.5);
    g.rotateY(Math.atan2(-pt.ty, pt.tx));
    const ground = metersToY(m, groundHeight(m, p.x, p.z));
    g.translate(p.x, Math.max(ground, p.y - 0.05) + 2 / m.cellMeters, p.z);
    put('wall', g);
  }
}

function buildDepot(m: MapData, line: RailLine, layout: TrackLayout, now: number, put: (k: keyof typeof MAT, g: THREE.BufferGeometry | null) => void): void {
  const d = line.depot!;
  const built = isBuilt(d.build, now);
  const g = depotGeom(m, line, d);
  const h = metersToY(m, g.z);
  const yaw = Math.atan2(-g.u.y, g.u.x);
  /** 基地坐标中的长方体（a 沿线、b 横向；y 为底面高度） */
  const box = (a0: number, a1: number, b0: number, b1: number, y: number, height: number) => {
    const geo = new THREE.BoxGeometry(a1 - a0, height, b1 - b0);
    geo.rotateY(yaw);
    const c = depotPoint(g, (a0 + a1) / 2, (b0 + b1) / 2);
    geo.translate(c.x, y + height / 2, c.y);
    return geo;
  };
  const { a0, a1, b0, b1 } = g.pad;
  put(built ? 'depotPad' : 'scaffold', box(a0, a1, b0, b1, h, 0.02));
  if (!built) return;
  const al = lineAlignment(m, line);
  const P = (q: { x: number; y: number }) => new THREE.Vector3(q.x, h, q.y);
  const track = (pts: THREE.Vector3[]) => {
    for (let i = 1; i < pts.length; i++) {
      put('ballast', strip(pts[i - 1], pts[i], BALLAST_W, 0.03));
      put('rail', strip(pts[i - 1], pts[i], TRACK_W, 0.045));
    }
  };
  /** 转辙器标志（白柱红头），放在道岔起点外侧 */
  const switchStand = (p: THREE.Vector3, nx: number, nz: number) => {
    const s1 = new THREE.BoxGeometry(0.07, 0.12, 0.07);
    s1.translate(p.x + nx * 0.22, p.y + 0.09, p.z + nz * 0.22);
    put('wall', s1);
    const top = new THREE.BoxGeometry(0.1, 0.05, 0.1);
    top.translate(p.x + nx * 0.22, p.y + 0.17, p.z + nz * 0.22);
    put('switchHead', top);
  };
  const N = g.lanes.length;
  // 道岔曲线 + 梯形线 + 最外侧留置线
  track(g.routes[N - 1].map(P));
  // 其余留置线：从梯形线上的分岔点起
  for (let i = 0; i < N - 1; i++) track(g.routes[i].slice(g.branchAt).map(P));
  // 转辙器：接轨道岔（正线外侧）与梯形线上各分岔道岔
  switchStand(P(g.routes[0][0]), -g.n.x, -g.n.y);
  for (let i = 0; i < N - 1; i++) switchStand(P(g.routes[i][g.branchAt]), -g.n.x, -g.n.y);
  // 车挡
  for (const b of g.lanes) put('switchHead', box(g.aFar, g.aFar + 0.12, b - 0.1, b + 0.1, h + 0.02, 0.07));
  // 复线：接轨点与站台之间设渡线，两条正线的列车都能出入库
  const mag = magAt(layout, g.sJoin);
  if (mag > 0.01) {
    const sA = g.sJoin - g.end * 0.8;
    const sB = g.sJoin - g.end * 3.2;
    if (Math.min(sA, sB) > 0 && Math.max(sA, sB) < al.length) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const s = sA + ((sB - sA) * k) / 8;
        const f = k / 8;
        const w = f * f * (3 - 2 * f);
        pts.push(railPoint(m, line, al, s, magAt(layout, s) * g.side * (1 - 2 * w)));
      }
      track(pts);
      switchStand(pts[0], g.n.x, g.n.y);
      switchStand(pts[8], -g.n.x, -g.n.y);
    }
  }
  // 检修库：最外侧两条留置线的尽头带屋顶；场坪入口旁有乘务员室
  put('shed', box(g.aFar - 4, g.aFar - 0.2, g.lanes[N - 2] - 0.25, g.lanes[N - 1] + 0.25, h + 0.02, 0.3));
  put('wall', box(a0 + 0.6, a0 + 1.6, b1 - 0.45, b1 - 0.05, h + 0.02, 0.18));
}

/** 车辆基地草案：场坪 + 出入库线 */
export function buildDepotPreview(m: MapData, g: DepotGeom, ok: boolean): THREE.Group {
  const group = new THREE.Group();
  const { a0, a1, b0, b1 } = g.pad;
  const c = depotPoint(g, (a0 + a1) / 2, (b0 + b1) / 2);
  group.add(buildFootprint(m, c.x - (a1 - a0) / 2, c.y - (b1 - b0) / 2, a1 - a0, b1 - b0, ok, Math.atan2(-g.u.y, g.u.x)));
  const y = metersToY(m, g.z) + 0.32;
  for (const r of g.routes) {
    const geo = new THREE.BufferGeometry().setFromPoints(r.map((q) => new THREE.Vector3(q.x, y, q.y)));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ok ? 0xffffff : 0xff6b6b, depthTest: false }));
    l.renderOrder = 7;
    group.add(l);
  }
  return group;
}

/** 两点之间的直线道床/轨道（可带坡度） */
function strip(p: THREE.Vector3, q: THREE.Vector3, width: number, lift: number): THREE.BufferGeometry {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const len = Math.hypot(dx, dz);
  const g = new THREE.BoxGeometry(len, 0.02, width);
  g.rotateZ(Math.atan2(q.y - p.y, len));
  g.rotateY(Math.atan2(-dz, dx));
  g.translate((p.x + q.x) / 2, (p.y + q.y) / 2 + lift, (p.z + q.z) / 2);
  return g;
}

const DRAFT_COLORS: Record<Structure, number> = { ground: 0xffffff, viaduct: 0xc39bff, bridge: 0x6ec6ff, tunnel: 0x444444 };

/** 草案预览：按结构着色的线，问题点画红色标记 */
export function buildDraftPreview(
  m: MapData,
  al: Alignment,
  s0: number,
  z: number[],
  structure: Structure[],
  step: number,
  issues: { x: number; y: number }[],
  ok: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'draft';
  const byKind = new Map<Structure, number[]>();
  for (let i = 0; i < z.length - 1; i++) {
    const sa = s0 + i * step;
    const sb = s0 + (i + 1) * step;
    const pa = sampleAlignment(al, sa);
    const pb = sampleAlignment(al, sb);
    const ya = metersToY(m, z[i]) + 0.08;
    const yb = metersToY(m, z[i + 1]) + 0.08;
    const w = 0.22;
    const quad = [
      [pa.x + pa.ty * w, ya, pa.y - pa.tx * w],
      [pa.x - pa.ty * w, ya, pa.y + pa.tx * w],
      [pb.x - pb.ty * w, yb, pb.y + pb.tx * w],
      [pb.x + pb.ty * w, yb, pb.y - pb.tx * w],
    ];
    const list = byKind.get(structure[i]) ?? [];
    for (const k of [0, 2, 1, 0, 3, 2]) list.push(...quad[k]);
    byKind.set(structure[i], list);
  }
  for (const [kind, verts] of byKind) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mat = new THREE.MeshBasicMaterial({
      color: ok ? DRAFT_COLORS[kind] : 0xff6b6b,
      transparent: true,
      opacity: kind === 'tunnel' ? 0.55 : 0.85,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 5;
    group.add(mesh);
  }
  for (const p of issues) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.9, 16), new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, metersToY(m, groundHeight(m, p.x, p.y)) + 0.2, p.y);
    ring.renderOrder = 6;
    group.add(ring);
  }
  return group;
}

/** 平面矩形标记（车站、车辆基地候选位置） */
export function buildFootprint(m: MapData, x: number, y: number, w: number, h: number, ok: boolean, yaw = 0): THREE.Mesh {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateX(-Math.PI / 2);
  g.rotateY(yaw);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: ok ? 0x4cd964 : 0xff3b30, transparent: true, opacity: 0.45, depthTest: false }));
  mesh.position.set(x + w / 2, metersToY(m, groundHeight(m, x + w / 2, y + h / 2)) + 0.3, y + h / 2);
  mesh.renderOrder = 6;
  return mesh;
}
