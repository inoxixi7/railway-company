import * as THREE from 'three';
import type { MapData } from '../sim/map/types';
import type { Ops } from '../sim/ops/ops';
import { carType } from '../sim/ops/vehicles';
import { pieceAt } from '../sim/rail/geometry';
import { metersToY } from './coords';

/** 所有列车的车厢：一个实例化网格（一次绘制） */
export class TrainRenderer {
  readonly mesh: THREE.InstancedMesh;
  private tmp = new THREE.Object3D();
  private color = new THREE.Color();
  /** 每列车车头的世界坐标（点击拾取用） */
  heads = new Map<number, THREE.Vector3>();

  constructor(
    private m: MapData,
    private capacity = 256,
  ) {
    // 车体：画面上宽约 3.2 m、高 3.6 m（略宽于实物，远看也能看清）
    const geo = new THREE.BoxGeometry(1, 3.6 / m.cellMeters, 3.2 / m.cellMeters);
    geo.translate(0, 1.8 / m.cellMeters + 0.06, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /** 返回是否有列车在线上（需要持续重绘） */
  update(ops: Ops): boolean {
    this.heads.clear();
    let n = 0;
    for (const t of ops.data.trains) {
      if (t.state === 'depot') continue;
      const ct = carType(t.typeId);
      const carLen = ct.carLengthM / this.m.cellMeters;
      const line = ops.line(t.lineId);
      for (let i = 0; i < t.cars && n < this.capacity; i++) {
        const loc = ops.locate(t, (i + 0.5) * carLen);
        if (!loc) continue;
        const p = pieceAt(loc.edge.piece, loc.s);
        const y = metersToY(this.m, ops.net.zAt(loc.edge, loc.s)) + 0.03;
        this.tmp.position.set(p.x, y, p.y);
        this.tmp.rotation.set(0, Math.atan2(-p.ty, p.tx), 0);
        this.tmp.scale.set(carLen - 0.05, 1, 1);
        this.tmp.updateMatrix();
        this.mesh.setMatrixAt(n, this.tmp.matrix);
        this.color.setHex(line ? line.color : ct.color);
        // 先头车稍亮，回基地的列车变灰
        if (t.toDepot) this.color.setHex(0x8a8a8a);
        else if (i === 0) this.color.offsetHSL(0, 0, 0.08);
        this.mesh.setColorAt(n, this.color);
        if (i === 0) this.heads.set(t.id, this.tmp.position.clone());
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return n > 0;
  }
}
