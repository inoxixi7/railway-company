/**
 * 可调参数集中在这里（数据驱动）。
 */
export const CONFIG = {
  map: {
    /** 每格边长（米） */
    cellMeters: 20,
  },
  render: {
    /** 高度在画面中的放大倍数（只影响画面；坡度、海拔等计算一律用真实米数） */
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
  /**
   * 日历时钟（城市视图）：与列车运行的时钟互相独立。
   * 城市生长、地价、收支都按日历结算。
   */
  calendar: {
    startYear: 1960,
    /** ×1 时现实多少秒过一天 */
    secondsPerDay: 5,
    /** 速度档：0 = 暂停 */
    speeds: [0, 1, 3],
  },
  /** 铁路（造价、工期、半径等均为暂定数值） */
  rail: {
    /** 最小曲线半径（米） */
    minRadiusM: 160,
    /** 曲线限速 V = k·√R（km/h） */
    curveSpeedK: 4.5,
    /** 正线最大坡度（‰）与车站内最大坡度（‰） */
    maxGradePermil: 25,
    stationMaxGradePermil: 10,
    /** 纵断面平滑窗口（米） */
    profileSmoothM: 300,
    /** 高出地面超过此值（米）→ 高架；低于地面超过此值（米）→ 隧道 */
    viaductAboveM: 8,
    tunnelBelowM: 15,
    /** 桥下净空：轨面高出水面（米）；立体交叉时高出下方轨面（米） */
    bridgeClearanceM: 4,
    overpassClearanceM: 6.5,
    /** 复线轨道中心间距（米） */
    trackSpacingM: 4,
    /** 每公里造价（円）：复线；单线按比例 */
    costPerKmDouble: { ground: 100_000_000, viaduct: 300_000_000, bridge: 350_000_000, tunnel: 500_000_000 },
    singleTrackCostRatio: 0.6,
    /** 每公里工期（日历天） */
    daysPerKm: { ground: 30, viaduct: 90, bridge: 90, tunnel: 180 },
    minDays: 10,
    /** 车站：6 节编组站台 120 m = 6 格 */
    stationLengthCells: 6,
    stationCost: { single: 20_000_000, side: 40_000_000, island: 45_000_000 },
    stationDays: 30,
    /** 拆除退款比例 */
    refundRatio: 0.5,
    /** 铺轨时吸附到已有节点 / 轨道的距离（格） */
    snapNodeCells: 1.6,
    snapEdgeCells: 1.2,
  },
  /** 列车运行（与日历脱钩：列车按好看的速度一直跑） */
  ops: {
    /** 现实 1 秒 = 运行多少秒 */
    timeScale: 30,
    /** 停站时间（运行秒） */
    dwellSec: 30,
    /** 折返（掉头）额外时间（运行秒） */
    reverseSec: 60,
    /** 等进路超过这么久（运行秒）视为卡死，把列车撤回车辆基地 */
    stuckSec: 900,
    /** 靠左行驶：逆向股道的寻路代价倍数 */
    wrongSideFactor: 4,
    /** 车辆基地：尽头线长度（格）、与正线的横向距离（格）、造价、工期 */
    depot: { lengthCells: 6, offsetCells: 1.4, leadCells: 6, cost: 200_000_000, days: 60, capacity: 8 },
  },
  gesture: {
    /** 超过这个距离（px）算拖动 */
    dragThresholdPx: 8,
    /** 按住超过这个时间（ms）算长按 */
    longPressMs: 500,
  },
} as const;
