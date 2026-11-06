/**
 * 可调参数集中在这里（数据驱动）。以后可迁移到 JSON 并接入调试面板。
 */
export const CONFIG = {
  map: {
    /** 每格边长（米） */
    cellMeters: 20,
  },
  render: {
    /** 高度在画面中的放大倍数，1 = 真实比例（只影响画面；坡度、海拔等计算一律用真实米数） */
    verticalScale: 2,
    maxFps: 30,
    maxPixelRatio: 2,
    powerSaveMaxPixelRatio: 1,
  },
  camera: {
    /** 俯视仰角（度） */
    elevationDeg: 35,
    /** 初始朝向（度），45° 为斜向俯视 */
    initialYawDeg: 45,
    /** 正交视野高度（格），越小越近 */
    minViewCells: 10,
    maxViewCells: 320,
    initialViewCells: 70,
    /** 吸附动画时长（毫秒） */
    snapMs: 220,
  },
  gesture: {
    /** 超过这个距离（px）算拖动 */
    dragThresholdPx: 8,
    /** 按住超过这个时间（ms）算长按 */
    longPressMs: 500,
  },
} as const;
