import * as THREE from 'three';
import type { MapData } from '../sim/map/types';
import { farEnd, tailOf, trainLengthCells, type OpsSim, type Train } from '../sim/ops/sim';
import { magAt, type TrackLayout } from '../sim/rail/layout';
import { depotGeom, PARK_GAP, shuntProgress, zAt, type DepotGeom } from '../sim/rail/line';
import type { RailLine } from '../sim/rail/types';
import { carType } from '../sim/rail/vehicles';
import { sampleAlignment, type Alignment } from '../sim/track/alignment';
import { metersToY } from './coords';

/** 所有列车的车厢：一个实例化网格 */
export class TrainRenderer {
  readonly mesh: THREE.InstancedMesh;
  private capacity: number;
  private tmp = new THREE.Object3D();
  private color = new THREE.Color();
  /** 屏幕拾取用：每列车的车头世界坐标 */
  positions = new Map<number, THREE.Vector3>();
  private geomCache: { al: Alignment | null; depot: object; g: DepotGeom } | null = null;

  constructor(private readonly m: MapData, capacity = 128) {
    this.capacity = capacity;
    // 车体：画面上宽约 3.2 m、高 3.6 m（略宽于实物，远看也能看清；不做高度放大）
    const geo = new THREE.BoxGeometry(1, 3.6 / m.cellMeters, 3.2 / m.cellMeters);
    geo.translate(0, 1.8 / m.cellMeters + 0.06, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'trains';
  }

  update(line: RailLine | null, al: Alignment | null, layout: TrackLayout | null, sim: OpsSim | null, trains: Train[]): void {
    this.positions.clear();
    let n = 0;
    const m = this.m;
    let g: DepotGeom | null = null;
    if (line?.depot) {
      if (!this.geomCache || this.geomCache.al !== al || this.geomCache.depot !== line.depot) {
        this.geomCache = { al, depot: line.depot, g: depotGeom(m, line, line.depot) };
      }
      g = this.geomCache.g;
    }
    for (const t of trains) {
      const ct = carType(t.typeId);
      const carLen = ct.carLengthM / m.cellMeters;
      // 车辆基地内与出入库调车：沿进路折线（d 从车挡量起）摆放车厢
      let path: { pts: THREE.Vector3[]; cum: number[] } | null = null;
      let lo = 0;
      if (t.state === 'depot' || t.state === 'leaving' || t.state === 'entering') {
        if (!g || !line || t.slot < 0) continue;
        const moving = t.state !== 'depot' && al && layout && sim;
        path = this.depotPath(line, g, t, moving ? { al: al!, layout: layout!, sim: sim! } : null);
        const D = path.cum[path.cum.length - 1];
        const len = trainLengthCells(t);
        const dist = Math.max(0, D - len - PARK_GAP);
        const p = t.state === 'depot' ? 0 : shuntProgress(dist, m.cellMeters, t.moveSec - t.timer);
        lo = t.state === 'entering' ? PARK_GAP + dist * (1 - p) : PARK_GAP + dist * p;
      }
      for (let i = 0; i < t.cars; i++) {
        if (n >= this.capacity) break;
        let pos: THREE.Vector3;
        let yaw: number;
        if (path) {
          ({ pos, yaw } = at(path, lo + (i + 0.5) * carLen));
          pos.y += 0.03;
        } else {
          if (!al || !layout || !line || !sim) continue;
          const s = t.head - t.dir * (i + 0.5) * carLen;
          const side = this.sideAt(sim, t, s);
          const off = side * magAt(layout, s);
          const p = sampleAlignment(al, s);
          pos = new THREE.Vector3(p.x + p.ty * off, metersToY(m, zAt(line, s)) + 0.03, p.y - p.tx * off);
          yaw = Math.atan2(-p.ty, p.tx);
        }
        if (i === 0) this.positions.set(t.id, pos.clone());
        this.tmp.position.copy(pos);
        this.tmp.rotation.set(0, yaw, 0);
        this.tmp.scale.set(carLen - 0.06, 1, 1);
        this.tmp.updateMatrix();
        this.mesh.setMatrixAt(n, this.tmp.matrix);
        // 回送列车稍暗；先头车稍亮
        this.color.setHex(ct.color);
        if (t.retire) this.color.multiplyScalar(0.7);
        this.mesh.setColorAt(n, this.color);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * 出入库进路（世界坐标）：车挡 → 留置线 → 梯形道岔 → 接轨道岔；
   * 调车时再接上正线：经渡线到站台股道，直到车身离基地较远的一端。
   */
  private depotPath(line: RailLine, g: DepotGeom, t: Train, main: { al: Alignment; layout: TrackLayout; sim: OpsSim } | null) {
    const m = this.m;
    const h = metersToY(m, g.z);
    const pts = [...g.routes[t.slot]].reverse().map((q) => new THREE.Vector3(q.x, h, q.y));
    if (main) {
      const { al, layout, sim } = main;
      const track = t.held.map((id) => sim.topo.res[id]).find((r) => r.kind === 'track');
      const trackSide = track ? Math.sign(track.offset) : g.side;
      const sFar = farEnd(t, g.end);
      const sA = g.sJoin - g.end * 0.8;
      const sB = g.sJoin - g.end * 3.2;
      const steps = Math.max(1, Math.ceil(Math.abs(sFar - g.sJoin) / 0.25));
      for (let k = 1; k <= steps; k++) {
        const s = g.sJoin + ((sFar - g.sJoin) * k) / steps;
        const f = Math.max(0, Math.min(1, (s - sA) / (sB - sA)));
        const w = f * f * (3 - 2 * f);
        const off = magAt(layout, s) * (g.side + (trackSide - g.side) * w);
        const p = sampleAlignment(al, s);
        pts.push(new THREE.Vector3(p.x + p.ty * off, metersToY(m, zAt(line, s)), p.y - p.tx * off));
      }
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    return { pts, cum };
  }

  /** 车厢在哪一侧股道：看覆盖该位置的资源偏移符号 */
  private sideAt(sim: OpsSim, t: Train, s: number): number {
    let side: number | null = null;
    for (const id of t.held) {
      const r = sim.topo.res[id];
      if (r.kind === 'throat' || r.kind === 'lead') continue;
      if (s >= r.a - 1e-6 && s <= r.b + 1e-6) side = Math.sign(r.offset);
    }
    if (side !== null) return side;
    // 没有资源覆盖（刚释放）：按行进方向的左侧
    void tailOf;
    return t.dir > 0 ? 1 : -1;
  }
}

/** 折线上距起点 d 处的位置与朝向 */
function at(path: { pts: THREE.Vector3[]; cum: number[] }, d: number): { pos: THREE.Vector3; yaw: number } {
  const { pts, cum } = path;
  const dd = Math.max(0, Math.min(cum[cum.length - 1], d));
  let i = 1;
  while (i < pts.length - 1 && cum[i] < dd) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const f = cum[i] > cum[i - 1] ? (dd - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
  return { pos: a.clone().lerp(b, f), yaw: Math.atan2(-(b.z - a.z), b.x - a.x) };
}
