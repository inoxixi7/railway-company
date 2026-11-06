import * as THREE from 'three';
import { CONFIG } from '../config';
import type { MapData } from '../sim/map/types';
import { tailOf, type OpsSim, type Train } from '../sim/ops/sim';
import { magAt, type TrackLayout } from '../sim/rail/layout';
import { zAt } from '../sim/rail/line';
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
    const parkedSlots = new Map<number, number>();
    for (const t of trains) {
      const ct = carType(t.typeId);
      const carLen = ct.carLengthM / m.cellMeters;
      for (let i = 0; i < t.cars; i++) {
        if (n >= this.capacity) break;
        let pos: THREE.Vector3;
        let yaw: number;
        if (t.state === 'depot') {
          if (!line?.depot) continue;
          const d = line.depot;
          const slot = parkedSlots.get(t.id) ?? parkedSlots.size;
          parkedSlots.set(t.id, slot);
          const horizontal = d.w > d.h;
          const sidings = CONFIG.rail.depot.sidings;
          const k = (slot + 0.5) / sidings;
          const h = metersToY(m, m.heights[d.y * (m.width + 1) + d.x]) + 0.03;
          const along = 0.5 + (i + 0.5) * carLen;
          pos = horizontal ? new THREE.Vector3(d.x + along, h, d.y + 0.3 + k * (d.h - 0.6)) : new THREE.Vector3(d.x + 0.3 + k * (d.w - 0.6), h, d.y + along);
          yaw = horizontal ? 0 : -Math.PI / 2;
        } else {
          if (!al || !layout || !line || !sim) continue;
          const s = t.head - t.dir * (i + 0.5) * carLen;
          const side = this.sideAt(sim, t, s);
          const off = side * magAt(layout, s);
          const p = sampleAlignment(al, s);
          pos = new THREE.Vector3(p.x + p.ty * off, metersToY(m, zAt(line, s)) + 0.03, p.y - p.tx * off);
          yaw = Math.atan2(-p.ty, p.tx);
          if (i === 0) this.positions.set(t.id, pos.clone());
        }
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
