import * as THREE from 'three';
import { CONFIG } from '../config';
import { cornerHeight } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import { CameraRig } from './cameraRig';
import { metersToY } from './coords';
import { pickGround } from './pick';
import { buildRoads } from './roads';
import { buildRail } from './rail';
import { buildTerrainMesh, buildTerrainSkirt } from './terrainMesh';
import { buildTrees } from './trees';
import { buildWaterMesh } from './water';
import type { RailNetwork } from '../sim/rail/network';

/**
 * 城市视图（3D）。只在需要时重绘，并限制最高帧率。
 */
export class MapView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  /** 草案、候选位置等临时显示 */
  readonly overlay = new THREE.Group();
  private selection: THREE.LineLoop;
  private frameRequested = false;
  private lastRender = 0;
  private animations = new Set<(now: number) => boolean>();
  private frames: number[] = [];
  private powerSave = false;
  /** 会随地形修整而重建的部分：地面、侧壁、树、道路 */
  private terrain: THREE.Object3D[];
  private rail: THREE.Group | null = null;
  onFps: ((fps: number) => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly map: MapData,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
    this.rig = new CameraRig(map.width, map.height);
    this.rig.state.ty = metersToY(map, 20);

    this.scene.add(new THREE.HemisphereLight(0xe8f1ff, 0x6b5a40, 1.6));
    const sun = new THREE.DirectionalLight(0xfff3df, 1.9);
    sun.position.set(-0.8, 0.9, 0.3);
    this.scene.add(sun);

    this.terrain = [buildTerrainMesh(map), buildTerrainSkirt(map), buildTrees(map), buildRoads(map)];
    this.scene.add(...this.terrain, buildWaterMesh(map), this.overlay);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.selection = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.selection.renderOrder = 10;
    this.selection.visible = false;
    this.scene.add(this.selection);
  }

  /** 天空颜色随界面主题变化 */
  setSky(color: number): void {
    this.renderer.setClearColor(color);
    this.invalidate();
  }

  setPowerSave(on: boolean): void {
    this.powerSave = on;
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const maxPr = this.powerSave ? CONFIG.render.powerSaveMaxPixelRatio : CONFIG.render.maxPixelRatio;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPr));
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    this.invalidate();
  }

  /** 地形被修整（路堤、路堑、车站整平）后重建 */
  rebuildTerrain(): void {
    for (const o of this.terrain) {
      this.scene.remove(o);
      disposeTree(o);
    }
    this.terrain = [buildTerrainMesh(this.map), buildTerrainSkirt(this.map), buildTrees(this.map), buildRoads(this.map)];
    this.scene.add(...this.terrain);
    this.invalidate();
  }

  /** 轨道网络变化或有区段竣工后重建铁路模型 */
  setRail(net: RailNetwork, today: number): void {
    if (this.rail) {
      this.scene.remove(this.rail);
      disposeTree(this.rail, false);
    }
    this.rail = buildRail(net, this.map, today);
    this.scene.add(this.rail);
    this.invalidate();
  }

  /** 草案、候选位置等临时显示 */
  setOverlay(objs: THREE.Object3D[]): void {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      disposeTree(c);
    }
    for (const o of objs) this.overlay.add(o);
    this.invalidate();
  }

  /** 屏幕点 → 地面（格坐标，小数） */
  pickPoint(sx: number, sy: number): { x: number; y: number } | null {
    this.rig.update();
    const { origin, dir } = this.rig.screenRay(sx, sy);
    const p = pickGround(this.map, origin, dir);
    return p ? { x: p.x, y: p.z } : null;
  }

  setSelection(cell: { x: number; y: number } | null): void {
    this.selection.visible = !!cell;
    if (cell) {
      const pos = this.selection.geometry.getAttribute('position') as THREE.BufferAttribute;
      const water = this.map.waterLevel[cell.y * this.map.width + cell.x];
      const corners = [
        [cell.x, cell.y],
        [cell.x + 1, cell.y],
        [cell.x + 1, cell.y + 1],
        [cell.x, cell.y + 1],
      ];
      corners.forEach(([x, y], i) => {
        const g = cornerHeight(this.map, x, y);
        pos.setXYZ(i, x, metersToY(this.map, Number.isNaN(water) ? g : Math.max(water, g)) + 0.03, y);
      });
      pos.needsUpdate = true;
      this.selection.geometry.computeBoundingSphere();
    }
    this.invalidate();
  }

  /** 添加逐帧动画；回调返回 false 时结束 */
  animate(fn: (now: number) => boolean): void {
    this.animations.add(fn);
    this.invalidate();
  }

  invalidate(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.frameRequested = false;
    // 留 2ms 余量，避免在 60Hz 屏幕上掉到 20fps
    if (now - this.lastRender < 1000 / CONFIG.render.maxFps - 2) {
      this.invalidate();
      return;
    }
    this.lastRender = now;
    for (const fn of [...this.animations]) if (!fn(now)) this.animations.delete(fn);
    this.rig.update();
    this.renderer.render(this.scene, this.rig.camera);
    if (this.onFps) {
      this.frames.push(now);
      while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
      this.onFps(this.frames.length);
    }
    if (this.animations.size) this.invalidate();
  };
}

function disposeTree(o: THREE.Object3D, materials = true): void {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    mesh.geometry?.dispose();
    if (!materials) return;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      (x as THREE.MeshLambertMaterial).map?.dispose();
      x.dispose();
    }
  });
}
