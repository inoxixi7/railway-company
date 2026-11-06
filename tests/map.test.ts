import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map/generate';
import { cellIndex, cellInfo, groundHeight } from '../src/sim/map/query';
import { Cover, RoadKind } from '../src/sim/map/types';

const map = generateMap();

describe('MVP 地图生成', () => {
  it('尺寸正确', () => {
    expect(map.width).toBe(256);
    expect(map.heights.length).toBe(257 * 257);
    expect(map.cover.length).toBe(256 * 256);
  });

  it('是确定性的', () => {
    const again = generateMap();
    expect(again.heights).toEqual(map.heights);
    expect(again.cover).toEqual(map.cover);
  });

  it('高度在合理范围：最高约 150 m，没有低于 0 的地面', () => {
    let max = -Infinity;
    let min = Infinity;
    for (const h of map.heights) {
      max = Math.max(max, h);
      min = Math.min(min, h);
    }
    expect(max).toBeGreaterThan(120);
    expect(max).toBeLessThan(185);
    expect(min).toBeGreaterThan(0);
  });

  it('河流南北贯穿：北边缘和南边缘都有水格', () => {
    const row = (y: number) => [...Array(256).keys()].some((x) => map.cover[cellIndex(map, x, y)] === Cover.Water);
    expect(row(0)).toBe(true);
    expect(row(255)).toBe(true);
  });

  it('水面沿干流从北向南不升高', () => {
    // 沿每行取干流水面（最西侧的水格附近即干流），检查北高南低的总体趋势
    const levelAtRow = (y: number) => {
      let best = Infinity;
      for (let x = 0; x < 256; x++) {
        const w = map.waterLevel[cellIndex(map, x, y)];
        if (!Number.isNaN(w)) best = Math.min(best, w);
      }
      return best;
    };
    expect(levelAtRow(10)).toBeGreaterThan(levelAtRow(128));
    expect(levelAtRow(128)).toBeGreaterThan(levelAtRow(250));
  });

  it('水格的地面在水面以下', () => {
    for (let i = 0; i < map.cover.length; i++) {
      if (map.cover[i] !== Cover.Water) continue;
      const x = i % 256;
      const y = Math.floor(i / 256);
      expect(groundHeight(map, x + 0.5, y + 0.5)).toBeLessThan(map.waterLevel[i]);
    }
  });

  it('既有道路跨河处是桥，并通到东西边缘', () => {
    expect(map.roads.some((r) => r === RoadKind.Bridge)).toBe(true);
    expect(map.roads[cellIndex(map, 0, 202)]).toBe(RoadKind.Road);
    const eastEdge = [...Array(256).keys()].some((y) => map.roads[cellIndex(map, 255, y)] !== RoadKind.None);
    expect(eastEdge).toBe(true);
  });

  it('东侧终点站存在且地面平整', () => {
    expect(map.terminals).toHaveLength(1);
    const t = map.terminals[0];
    expect(t.rect.x + t.rect.w).toBe(256);
    for (let y = t.rect.y; y < t.rect.y + t.rect.h; y++) {
      for (let x = t.rect.x; x < t.rect.x + t.rect.w; x++) {
        const info = cellInfo(map, x, y);
        expect(info.cover).toBe(Cover.Facility);
        expect(info.slopePermil).toBeLessThan(1);
      }
    }
  });

  it('小镇在西南，东南有大片农田，山上有森林', () => {
    expect(map.cover[cellIndex(map, 30, 195)]).toBe(Cover.Town);
    let farm = 0;
    let forest = 0;
    for (const c of map.cover) {
      if (c === Cover.Farmland) farm++;
      if (c === Cover.Forest) forest++;
    }
    expect(farm).toBeGreaterThan(10000);
    expect(forest).toBeGreaterThan(2000);
  });
});
