import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { generateMap } from '../src/sim/map/generate';
import { buildAlignment } from '../src/sim/track/alignment';
import { computeProfile, summarizeProfile } from '../src/sim/track/profile';

const map = generateMap();
const rules = { preferredRadius: 20, minRadius: 8 };

describe('纵断面', () => {
  it('跨河处自动成桥，桥面高于水面净空，坡度不超过上限', () => {
    // 从小镇东侧向东穿过干流
    const al = buildAlignment([{ x: 60, y: 196 }, { x: 120, y: 196 }], rules);
    const pr = computeProfile(map, al);
    const sum = summarizeProfile(map, al.length, pr, 2);
    expect(pr.structure).toContain('bridge');
    pr.overWater.forEach((w, i) => {
      if (w) expect(pr.structure[i]).toBe('bridge');
    });
    expect(sum.maxGradePermil).toBeLessThanOrEqual(CONFIG.rail.maxGradePermil + 0.01);
    expect(sum.byStructureM.bridge).toBeGreaterThan(40);
    expect(sum.cost).toBeGreaterThan(0);
    expect(sum.days).toBeGreaterThanOrEqual(CONFIG.rail.minDays);
  });

  it('穿山时出现隧道', () => {
    const al = buildAlignment([{ x: 150, y: 40 }, { x: 255, y: 40 }], rules);
    const pr = computeProfile(map, al);
    expect(pr.structure).toContain('tunnel');
    expect(summarizeProfile(map, al.length, pr, 2).maxGradePermil).toBeLessThanOrEqual(25.01);
  });

  it('平原上基本是地面线路', () => {
    const al = buildAlignment([{ x: 150, y: 200 }, { x: 240, y: 200 }], rules);
    const pr = computeProfile(map, al);
    const s = summarizeProfile(map, al.length, pr, 2);
    expect(s.byStructureM.ground / s.lengthM).toBeGreaterThan(0.95);
    // 单线更便宜
    expect(summarizeProfile(map, al.length, pr, 1).cost).toBeLessThan(s.cost);
  });
});
