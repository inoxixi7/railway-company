import { cumulativeLength, lerp, nearestOnPolyline, pointInPolygon, smoothstep, v, type Vec2 } from '../geom';
import { fbm } from '../noise';
import { hash2 } from '../rng';
import { MVP_LAYOUT, type MapLayout } from './layout';
import { cellIndex, cornerIndex } from './query';
import { Cover, RoadKind, type MapData } from './types';

interface RiverModel {
  line: Vec2[];
  cum: number[];
  /** 格点（offset=0）或格中心（offset=0.5）上的距离场 */
  cornerField?: DistanceField;
  cellField?: DistanceField;
  halfWidth: number;
  /** 沿河位置 s∈[0,1] 的水面高度 */
  level: (s: number) => number;
  /** 河谷宽度（格），随山地程度变化 */
  valley: (mountain: number) => number;
}

/** 由布局确定性地生成地图 */
export function generateMap(layout: MapLayout = MVP_LAYOUT, cellMeters = 20): MapData {
  const N = layout.size;
  const C = N + 1;
  const seed = layout.seed;
  const { plain } = layout;

  const plainAt = (_x: number, y: number) => lerp(plain.northElevation, plain.southElevation, y / N);

  /** 山地相对平原的高度与 0..1 的山地程度 */
  const mountainAt = (x: number, y: number): { h: number; m: number } => {
    let h = 0;
    let m = 0;
    for (const mt of layout.mountains) {
      const dx = (x - mt.cx) / mt.rx;
      const dy = (y - mt.cy) / mt.ry;
      const g = Math.exp(-(dx * dx + dy * dy));
      const rough = fbm(x / 14, y / 14, seed + 7, 4) * mt.rough * g;
      h += mt.peak * g + rough;
      m = Math.max(m, Math.min(1, g * 2.5));
    }
    return { h: Math.max(0, h), m };
  };

  const mainLine = layout.river.path;
  const mainCum = cumulativeLength(mainLine);
  const main: RiverModel = {
    line: mainLine,
    cum: mainCum,
    halfWidth: layout.river.halfWidth,
    level: (s) => {
      const p = pointAt(mainLine, mainCum, s);
      return plainAt(p.x, p.y) - layout.river.depthBelowPlain;
    },
    valley: (mt) => 4 + mt * 16,
  };
  const tribLine = layout.tributary.path;
  const tribCum = cumulativeLength(tribLine);
  const junction = tribLine[tribLine.length - 1];
  const junctionLevel = main.level(nearestOnPolyline(junction, mainLine, mainCum).s);
  const trib: RiverModel = {
    line: tribLine,
    cum: tribCum,
    halfWidth: layout.tributary.halfWidth,
    level: (s) => junctionLevel + layout.tributary.rise * (1 - s),
    valley: () => 3,
  };
  const rivers = [main, trib];
  for (const r of rivers) {
    // 河谷最宽 halfWidth + 0.5 + 20 格，再多留 1 格
    const reach = r.halfWidth + 22;
    r.cornerField = distanceField(r.line, r.cum, C, 0, reach);
    r.cellField = distanceField(r.line, r.cum, N, 0.5, reach);
  }

  // ---- 格点高度 ----
  const heights = new Float32Array(C * C);
  for (let y = 0; y <= N; y++) {
    for (let x = 0; x <= N; x++) {
      const base = plainAt(x, y) + fbm(x * plain.noiseScale, y * plain.noiseScale, seed, 3) * plain.noiseAmp;
      const mt = mountainAt(x, y);
      let h = base + mt.h;
      // 河床与岸坡：高度只取决于到河心的距离，岸线因此是平滑的
      let riverH = Infinity;
      for (const r of rivers) {
        const hit = r.cornerField!.at(x, y);
        if (hit.dist === Infinity) continue;
        const wl = r.level(hit.s);
        const bank = wl + 1.2;
        const slopeStart = r.halfWidth + 0.2;
        const slopeEnd = r.halfWidth + 1.4;
        if (hit.dist < slopeEnd) {
          const k = Math.max(0, (hit.dist - slopeStart) / (slopeEnd - slopeStart));
          riverH = Math.min(riverH, lerp(wl - 1.5, bank, k));
        } else {
          const t = smoothstep(slopeEnd, slopeEnd + r.valley(mt.m), hit.dist);
          h = Math.min(h, lerp(bank, Math.max(h, bank), t));
        }
      }
      if (riverH !== Infinity) h = riverH;
      heights[y * C + x] = h;
    }
  }

  // ---- 地表 ----
  const cover = new Uint8Array(N * N).fill(Cover.Grass);
  const waterLevel = new Float32Array(N * N).fill(Number.NaN);

  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const p = v(cx + 0.5, cy + 0.5);
      const i = cy * N + cx;
      if (layout.farmlands.some((poly) => pointInPolygon(p, poly))) cover[i] = Cover.Farmland;
      const inForest =
        layout.forests.some((poly) => pointInPolygon(p, poly)) ||
        layout.forestCircles.some((c) => Math.hypot(p.x - c.cx, p.y - c.cy) <= c.r);
      // 森林边缘稍作随机，避免太规整
      if (inForest && hash2(cx, cy, seed + 3) > 0.08) cover[i] = Cover.Forest;
      for (const r of rivers) {
        const hit = r.cellField!.at(cx, cy);
        if (hit.dist <= r.halfWidth) {
          cover[i] = Cover.Water;
          const wl = r.level(hit.s);
          waterLevel[i] = Number.isNaN(waterLevel[i]) ? wl : Math.min(waterLevel[i], wl);
        }
      }
    }
  }

  const map: MapData = {
    version: 1,
    name: layout.name,
    width: N,
    height: N,
    cellMeters,
    heights,
    cover,
    waterLevel,
    roads: new Uint8Array(N * N),
    roadLines: layout.roads.map((line) => line.map((p) => ({ x: p.x, y: p.y }))),
    rivers: rivers.map((r) => ({
      halfWidth: r.halfWidth,
      points: r.line.map((p, i) => ({ x: p.x, y: p.y, level: r.level(r.cum[i] / r.cum[r.cum.length - 1]) })),
    })),
    terminals: [],
    rail: new Uint8Array(N * N),
  };

  // ---- 小镇：整平并标记 ----
  const t = layout.town;
  flattenRect(map, t.x, t.y, t.w, t.h, 0.75, 3);
  for (let cy = t.y; cy < t.y + t.h; cy++) {
    for (let cx = t.x; cx < t.x + t.w; cx++) {
      const i = cellIndex(map, cx, cy);
      if (cover[i] !== Cover.Water) cover[i] = Cover.Town;
    }
  }

  // ---- 终点站：完全整平 ----
  const tm = layout.terminal;
  const elev = flattenRect(map, tm.x, tm.y, tm.w, tm.h, 1, 4);
  for (let cy = tm.y; cy < tm.y + tm.h; cy++) {
    for (let cx = tm.x; cx < tm.x + tm.w; cx++) cover[cellIndex(map, cx, cy)] = Cover.Facility;
  }
  map.terminals.push({
    id: tm.id,
    name: tm.name,
    rect: { x: tm.x, y: tm.y, w: tm.w, h: tm.h },
    platforms: tm.platforms,
    elevation: elev,
    connectSide: 'west',
    entry: { x: tm.x, y: tm.y + tm.h / 2 },
  });

  // ---- 道路 ----
  for (const line of layout.roads) rasterizeRoad(map, line);

  return map;
}

interface DistanceField {
  at(x: number, y: number): { dist: number; s: number };
}

/**
 * 只在折线附近 reach 格内计算「到折线的距离 + 沿线位置」，其余为 Infinity。
 * 比逐点遍历全部线段快得多（手机上生成地图要快）。
 */
function distanceField(line: Vec2[], cum: number[], size: number, offset: number, reach: number): DistanceField {
  const dist = new Float32Array(size * size).fill(Infinity);
  const sArr = new Float32Array(size * size);
  const total = cum[cum.length - 1];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach - offset));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x) + reach - offset));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach - offset));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y) + reach - offset));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + offset;
        const py = y + offset;
        let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
        const k = y * size + x;
        if (d < dist[k]) {
          dist[k] = d;
          sArr[k] = (cum[i] + Math.sqrt(len2) * t) / total;
        }
      }
    }
  }
  return { at: (x, y) => ({ dist: dist[y * size + x], s: sArr[y * size + x] }) };
}

function pointAt(line: Vec2[], cum: number[], s: number): Vec2 {
  const target = s * cum[cum.length - 1];
  for (let i = 1; i < line.length; i++) {
    if (cum[i] >= target) {
      const seg = cum[i] - cum[i - 1];
      const t = seg > 0 ? (target - cum[i - 1]) / seg : 0;
      return v(lerp(line[i - 1].x, line[i].x, t), lerp(line[i - 1].y, line[i].y, t));
    }
  }
  return line[line.length - 1];
}

/**
 * 把矩形区域的格点整平到平均高度（strength=1 完全整平），
 * 并在外侧 margin 格内平滑过渡。返回整平后的高度。
 */
function flattenRect(m: MapData, x: number, y: number, w: number, h: number, strength: number, margin: number): number {
  let sum = 0;
  let n = 0;
  for (let cy = y; cy <= y + h; cy++) {
    for (let cx = x; cx <= x + w; cx++) {
      sum += m.heights[cornerIndex(m, cx, cy)];
      n++;
    }
  }
  const avg = sum / n;
  for (let cy = Math.max(0, y - margin); cy <= Math.min(m.height, y + h + margin); cy++) {
    for (let cx = Math.max(0, x - margin); cx <= Math.min(m.width, x + w + margin); cx++) {
      const dx = Math.max(x - cx, 0, cx - (x + w));
      const dy = Math.max(y - cy, 0, cy - (y + h));
      const d = Math.max(dx, dy);
      const k = cornerIndex(m, cx, cy);
      const wgt = strength * (1 - smoothstep(0, margin + 1, d));
      m.heights[k] = lerp(m.heights[k], avg, wgt);
    }
  }
  return avg;
}

/** 沿折线标记道路格（4 连通，避免斜向断开）；水上为桥 */
function rasterizeRoad(m: MapData, line: Vec2[]): void {
  let prev: [number, number] | null = null;
  const mark = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx >= m.width || cy >= m.height) return;
    const i = cellIndex(m, cx, cy);
    m.roads[i] = m.cover[i] === Cover.Water ? RoadKind.Bridge : RoadKind.Road;
  };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = Math.min(m.width - 1, Math.floor(lerp(a.x, b.x, t)));
      const cy = Math.min(m.height - 1, Math.floor(lerp(a.y, b.y, t)));
      if (prev && prev[0] !== cx && prev[1] !== cy) mark(cx, prev[1]);
      mark(cx, cy);
      prev = [cx, cy];
    }
  }
}
