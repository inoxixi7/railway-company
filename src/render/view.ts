import * as THREE from 'three';
import { CONFIG } from '../config';
import { cornerHeight } from '../sim/map/query';
import type { MapData } from '../sim/map/types';
import { CameraRig } from './cameraRig';
import { metersToY } from './coords';
import { pickGround } from './pick';
import { buildRoads } from './roads';
import { buildTerminal } from './structures';
import { buildTerrainMesh, buildTerrainSkirt } from './terrainMesh';
import { buildTrees } from './trees';
import { buildWaterMesh } from './water';

export interface ViewOptions {
  powerSave: boolean;
  showFps: boolean;
}

/**
 * 3D 视图：只在需要时重绘（invalidate），并限制最高帧率。
 */
export class MapView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  private selection: THREE.LineLoop;
  private frameRequested = false;
  private lastRender = 0;
  private animations = new Set<(now: number) => boolean>();
  private fpsFrames: number[] = [];
  onFps: ((fps: number) => void) | null = null;
  private opts: ViewOptions = { powerSave: false, showFps: false };

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly map: MapData,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0xbcd3e6);
    this.rig = new CameraRig(map.width, map.height);
    this.rig.state.ty = metersToY(map, 20);

    this.scene.add(new THREE.HemisphereLight(0xe8f1ff, 0x6b5a40, 1.6));
    const sun = new THREE.DirectionalLight(0xfff3df, 1.9);
    sun.position.set(-0.8, 0.9, 0.3);
    this.scene.add(sun);

    this.scene.add(buildTerrainMesh(map));
    this.scene.add(buildTerrainSkirt(map));
    this.scene.add(buildWaterMesh(map));
    this.scene.add(buildTrees(map));
    this.scene.add(buildRoads(map));
    for (const t of map.terminals) this.scene.add(buildTerminal(map, t));

    const selGeo = new THREE.BufferGeometry();
    selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.selection = new THREE.LineLoop(selGeo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.selection.renderOrder = 10;
    this.selection.visible = false;
    this.scene.add(this.selection);
  }

  setOptions(o: ViewOptions): void {
    this.opts = o;
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const maxPr = this.opts.powerSave ? CONFIG.render.powerSaveMaxPixelRatio : CONFIG.render.maxPixelRatio;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPr));
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    this.invalidate();
  }

  /** 屏幕点 → 格坐标 */
  pickCell(sx: number, sy: number): { x: number; y: number } | null {
    this.rig.update();
    const { origin, dir } = this.rig.screenRay(sx, sy);
    const p = pickGround(this.map, origin, dir);
    return p ? { x: Math.floor(p.x), y: Math.floor(p.z) } : null;
  }

  setSelection(cell: { x: number; y: number } | null): void {
    if (!cell) {
      this.selection.visible = false;
    } else {
      const pos = this.selection.geometry.getAttribute('position') as THREE.BufferAttribute;
      const corners: [number, number][] = [
        [cell.x, cell.y],
        [cell.x + 1, cell.y],
        [cell.x + 1, cell.y + 1],
        [cell.x, cell.y + 1],
      ];
      corners.forEach(([x, y], i) => {
        const cellWater = this.map.waterLevel[cell.y * this.map.width + cell.x];
        const h = Number.isNaN(cellWater) ? cornerHeight(this.map, x, y) : Math.max(cellWater, cornerHeight(this.map, x, y));
        pos.setXYZ(i, x, metersToY(this.map, h) + 0.03, y);
      });
      pos.needsUpdate = true;
      this.selection.geometry.computeBoundingSphere();
      this.selection.visible = true;
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
    const minInterval = 1000 / CONFIG.render.maxFps;
    // 留 2ms 余量，避免在 60Hz 屏幕上掉到 20fps
    if (now - this.lastRender < minInterval - 2) {
      this.invalidate();
      return;
    }
    this.lastRender = now;
    for (const fn of [...this.animations]) {
      if (!fn(now)) this.animations.delete(fn);
    }
    this.rig.update();
    this.renderer.render(this.scene, this.rig.camera);
    if (this.opts.showFps) {
      this.fpsFrames.push(now);
      while (this.fpsFrames.length && now - this.fpsFrames[0] > 1000) this.fpsFrames.shift();
      this.onFps?.(this.fpsFrames.length);
    }
    if (this.animations.size) this.invalidate();
  };
}
