import * as THREE from 'three';
import { CONFIG } from '../config';

const DEG = Math.PI / 180;

export interface CameraState {
  /** 视点中心（世界坐标，格） */
  tx: number;
  tz: number;
  /** 视点中心高度（世界 Y） */
  ty: number;
  /** 朝向（弧度） */
  yaw: number;
  /** 正交视野高度（格） */
  viewCells: number;
}

/**
 * 斜俯视正交相机。所有屏幕↔地面换算都在这里，保证平移/缩放/旋转时
 * 「手指下的地面点」保持不动。
 */
export class CameraRig {
  readonly camera: THREE.OrthographicCamera;
  state: CameraState;
  private width = 1;
  private height = 1;
  private readonly elevation = CONFIG.camera.elevationDeg * DEG;
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(mapW: number, mapH: number) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.bounds = { minX: 0, maxX: mapW, minZ: 0, maxZ: mapH };
    this.state = {
      tx: mapW / 2,
      tz: mapH / 2,
      ty: 0,
      yaw: CONFIG.camera.initialYawDeg * DEG,
      viewCells: CONFIG.camera.initialViewCells,
    };
  }

  setViewport(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.update();
  }

  get viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** 每像素多少格（水平方向） */
  get cellsPerPx(): number {
    return this.state.viewCells / this.height;
  }

  /** 相机在地面上的右方向与「屏幕向上」方向 */
  groundAxes(): { rx: number; rz: number; fx: number; fz: number } {
    const { yaw } = this.state;
    // 相机位于 target + (sin yaw, ·, cos yaw)，看向相反方向
    return { rx: Math.cos(yaw), rz: -Math.sin(yaw), fx: -Math.sin(yaw), fz: -Math.cos(yaw) };
  }

  /** 屏幕坐标（CSS px）→ 视点高度平面上的地面点 */
  screenToGround(sx: number, sy: number): { x: number; z: number } {
    const { rx, rz, fx, fz } = this.groundAxes();
    const k = this.cellsPerPx;
    const ox = (sx - this.width / 2) * k;
    const oy = (this.height / 2 - sy) * k / Math.sin(this.elevation);
    return { x: this.state.tx + rx * ox + fx * oy, z: this.state.tz + rz * ox + fz * oy };
  }

  /** 屏幕坐标 → 世界射线（用于拾取） */
  screenRay(sx: number, sy: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const ndc = new THREE.Vector3((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1, -1);
    const origin = ndc.clone().unproject(this.camera);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return { origin, dir };
  }

  panByScreen(dx: number, dy: number): void {
    const { rx, rz, fx, fz } = this.groundAxes();
    const k = this.cellsPerPx;
    const ox = -dx * k;
    const oy = (dy * k) / Math.sin(this.elevation);
    this.state.tx += rx * ox + fx * oy;
    this.state.tz += rz * ox + fz * oy;
    this.clamp();
  }

  /** 以屏幕点为中心缩放（factor > 1 拉近） */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToGround(sx, sy);
    const { minViewCells, maxViewCells } = CONFIG.camera;
    this.state.viewCells = Math.min(maxViewCells, Math.max(minViewCells, this.state.viewCells / factor));
    this.anchor(before, sx, sy);
  }

  /** 以屏幕点为中心旋转（弧度，正值 = 画面顺时针转） */
  rotateAt(sx: number, sy: number, dYaw: number): void {
    const before = this.screenToGround(sx, sy);
    this.state.yaw = normalizeAngle(this.state.yaw + dYaw);
    this.anchor(before, sx, sy);
  }

  /** 移动视点，使地面点 p 回到屏幕点 (sx, sy) 下 */
  private anchor(p: { x: number; z: number }, sx: number, sy: number): void {
    const after = this.screenToGround(sx, sy);
    this.state.tx += p.x - after.x;
    this.state.tz += p.z - after.z;
    this.clamp();
  }

  private clamp(): void {
    const b = this.bounds;
    this.state.tx = Math.min(b.maxX, Math.max(b.minX, this.state.tx));
    this.state.tz = Math.min(b.maxZ, Math.max(b.minZ, this.state.tz));
  }

  /** 把状态写入 three.js 相机 */
  update(): void {
    const { tx, ty, tz, yaw, viewCells } = this.state;
    const aspect = this.width / this.height;
    const halfH = viewCells / 2;
    const cam = this.camera;
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    const dist = 1500;
    const ce = Math.cos(this.elevation);
    cam.position.set(tx + Math.sin(yaw) * ce * dist, ty + Math.sin(this.elevation) * dist, tz + Math.cos(yaw) * ce * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    cam.near = 1;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}

export function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

/** 最近的吸附朝向：45° + 90°·k */
export function nearestSnapYaw(yaw: number): number {
  const q = Math.PI / 2;
  return normalizeAngle(Math.round((yaw - Math.PI / 4) / q) * q + Math.PI / 4);
}

/** 从 a 转到 b 的最短有符号角度 */
export function shortestAngle(a: number, b: number): number {
  let d = normalizeAngle(b - a);
  if (d > Math.PI) d -= Math.PI * 2;
  return d;
}
