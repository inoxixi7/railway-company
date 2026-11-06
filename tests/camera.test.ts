import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig, nearestSnapYaw, shortestAngle } from '../src/render/cameraRig';

const rig = () => {
  const r = new CameraRig(256, 256);
  r.setViewport(400, 800);
  return r;
};

/** 用 three.js 相机把地面点投影回屏幕 */
const project = (r: CameraRig, x: number, z: number) => {
  r.update();
  const v = new THREE.Vector3(x, r.state.ty, z).project(r.camera);
  return { sx: ((v.x + 1) / 2) * 400, sy: ((1 - v.y) / 2) * 800 };
};

describe('相机', () => {
  it('screenToGround 与 three.js 投影一致', () => {
    const r = rig();
    for (const yaw of [0.3, Math.PI / 4, 2, 4]) {
      r.state.yaw = yaw;
      const g = r.screenToGround(50, 700);
      const s = project(r, g.x, g.z);
      expect(s.sx).toBeCloseTo(50, 3);
      expect(s.sy).toBeCloseTo(700, 3);
    }
  });

  it('平移：手指下的地面跟着手指走', () => {
    const r = rig();
    const g = r.screenToGround(100, 100);
    r.panByScreen(30, -40);
    const s = project(r, g.x, g.z);
    expect(s.sx).toBeCloseTo(130, 3);
    expect(s.sy).toBeCloseTo(60, 3);
  });

  it('缩放和旋转：中心点下的地面不动', () => {
    const r = rig();
    const g = r.screenToGround(300, 200);
    r.zoomAt(300, 200, 1.7);
    r.rotateAt(300, 200, 0.6);
    const s = project(r, g.x, g.z);
    expect(s.sx).toBeCloseTo(300, 3);
    expect(s.sy).toBeCloseTo(200, 3);
  });

  it('rotation 为正时画面顺时针转（与手势约定一致）', () => {
    const r = rig();
    // 中心正上方的点，顺时针转 90° 后应到中心右侧
    const g = r.screenToGround(200, 300);
    r.rotateAt(200, 400, Math.PI / 2);
    const s = project(r, g.x, g.z);
    expect(s.sx).toBeGreaterThan(250);
    expect(s.sy).toBeCloseTo(400, 1);
  });

  it('吸附到 45° + 90°·k', () => {
    const d = Math.PI / 180;
    expect(nearestSnapYaw(50 * d) / d).toBeCloseTo(45);
    expect(nearestSnapYaw(100 * d) / d).toBeCloseTo(135);
    expect(nearestSnapYaw(350 * d) / d).toBeCloseTo(315);
    expect(nearestSnapYaw(10 * d) / d).toBeCloseTo(45);
    expect(shortestAngle(350 * d, 10 * d) / d).toBeCloseTo(20);
  });
});
