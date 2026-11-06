import { samplePathCS, sampleQuad, v, type Vec2 } from '../geom';

/**
 * MVP 固定地图的布局（按已确认的「地图草案 v2」）。
 * 单位：格（256×256，20 m/格）。x 向东，y 向南。
 */
export const MVP_LAYOUT = {
  name: 'MVP 地图',
  size: 256,
  seed: 1960,

  /** 平原基准高度：北高南低（米） */
  plain: { northElevation: 30, southElevation: 12, noiseAmp: 3, noiseScale: 1 / 24 },

  /** 东北山地：椭圆高斯，peak 为相对平原的高度 */
  mountains: [
    { cx: 215, cy: -5, rx: 70, ry: 45, peak: 122, rough: 22 },
    { cx: 0, cy: 0, rx: 40, ry: 30, peak: 32, rough: 8 },
  ],

  /** 干流：自北向南 */
  river: {
    path: samplePathCS(
      v(120, 0),
      [v(120, 32), v(92, 56), v(96, 92)],
      [
        [v(132, 132), v(116, 168)],
        [v(60, 208), v(48, 256)],
      ],
    ),
    /** 水面半宽（格）：约 70 m 宽 */
    halfWidth: 1.75,
    /** 水面比两岸平原低多少米 */
    depthBelowPlain: 3,
  },

  /** 支流：自东向西汇入干流 */
  tributary: {
    path: samplePathCS(v(256, 100), [v(224, 108), v(188, 100), v(160, 120)], [[v(128, 144), v(118, 152)]]),
    halfWidth: 1,
    /** 东端水面比汇流处高多少米 */
    rise: 2.5,
  },

  forests: [
    [v(100, 24), v(120, 64), v(160, 76), v(132, 92), v(108, 80), v(88, 60)],
    [v(208, 64), v(240, 60), v(256, 56), v(256, 92), v(232, 92), v(216, 76)],
    [v(0, 38), v(24, 40), v(44, 28), v(50, 48), v(40, 64), v(24, 68), v(0, 60)],
  ] as Vec2[][],
  forestCircles: [{ cx: 188, cy: 168, r: 9 }],

  farmlands: [
    [v(132, 132), v(256, 120), v(256, 256), v(152, 256), v(136, 210), v(132, 170)],
    [v(60, 120), v(120, 116), v(116, 168), v(68, 172)],
  ] as Vec2[][],

  /** 起点小镇 */
  town: { x: 24, y: 188, w: 32, h: 28 },

  /** 既有道路（折线），过水处自动成为桥 */
  roads: [
    [v(0, 202), v(80, 202), v(92, 202)],
    sampleQuad(v(92, 202), v(132, 188), v(168, 176), 40).concat(sampleQuad(v(168, 176), v(204, 164), v(256, 168), 40).slice(1)),
    [v(40, 188), v(40, 256)],
  ] as Vec2[][],

  /** 东侧边缘：大城市方向的既有终点站（6 节编组站台约 6 格，另留股道与站房） */
  terminal: { id: 'metro-terminal', name: '大城市方向终点站', x: 246, y: 147, w: 10, h: 5, platforms: 2 },
};

export type MapLayout = typeof MVP_LAYOUT;
