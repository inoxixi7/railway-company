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
  /** 资金与土地（均为已确认玩法下的暂定数值） */
  economy: {
    startMoney: 5_000_000_000,
  },
  land: {
    /** 每格（400 m²）基础地价，顺序同 Cover：草地、森林、农田、河流、城镇、设施 */
    basePriceByCover: [300_000, 150_000, 200_000, 0, 800_000, 0],
    /** 线路公布后、车站开通后的地价倍数 */
    announcedPeak: 1.5,
    stationPeak: 3,
    /** 影响范围：500 m 内满额，1 km 外无影响 */
    nearCells: 25,
    farCells: 50,
    /** 开发成熟：半径内建筑达到 devFullCount 时地价 +50% */
    devRadiusCells: 5,
    devFullCount: 40,
    devBonus: 0.5,
    /** 地价整体年涨幅 */
    annualGrowth: 0.03,
    /** 固定资产税率（每年 1 月 1 日） */
    taxRate: 0.014,
    buildableSlopePermil: 150,
    /** 起点小镇的既有房屋密度 */
    townDensity: 0.5,
    /** 分区后开始生长的延迟（天）与每月每格生长概率（约 2～3 年填满） */
    zoneDelayDays: 60,
    growthPerMonth: 0.08,
    /** 离站 800 m 外生长变慢 */
    goodStationCells: 40,
    farGrowthFactor: 0.25,
    /** 道路这个距离以内算有接入 */
    accessRoadCells: 3,
    /** 地价达到这些值（円/格）时为中、高经济水平 */
    levelPrices: [600_000, 1_600_000],
    twoByTwoChance: 0.5,
    upgradeAgeYears: 3,
    upgradePerMonth: 0.03,
    /** 市民每月自建栋数 */
    naturalPerMonth: 2,
    naturalCommercialChance: 0.15,
    /** 拆迁补偿 = 地价 × 此倍数 */
    compensationRate: 2,
    /** 每格容量：住宅=人口，商业/工业=岗位；行按用途，列按经济水平 */
    capacityPerCell: [
      [4, 8, 20],
      [3, 8, 25],
      [3, 6, 12],
    ],
  },
  /** 铁路（以下造价、工期、半径等均为暂定数值，待调） */
  rail: {
    /** 曲线理想半径（米）与最小半径（米） */
    preferredRadiusM: 400,
    minRadiusM: 160,
    /** 曲线限速 V = k·√R（km/h） */
    curveSpeedK: 4.5,
    /** 正线最大坡度（‰） */
    maxGradePermil: 25,
    /** 车站内最大坡度（‰） */
    stationMaxGradePermil: 10,
    /** 纵断面平滑窗口（米） */
    profileSmoothM: 300,
    /** 高出地面超过此值（米）→ 高架/桥梁 */
    viaductAboveM: 8,
    /** 低于地面超过此值（米）→ 隧道 */
    tunnelBelowM: 15,
    /** 桥下净空：轨面高出水面（米） */
    bridgeClearanceM: 4,
    /** 复线轨道中心间距（米） */
    trackSpacingM: 4,
    /** 每公里造价（円）：复线 */
    costPerKmDouble: { ground: 100_000_000, viaduct: 300_000_000, bridge: 350_000_000, tunnel: 500_000_000 },
    /** 单线造价相对复线的比例 */
    singleTrackCostRatio: 0.6,
    /** 工期倍率：0 = 立即完工（暂定，时间方案未定）；1 = 按下面的天数 */
    constructionTimeScale: 0,
    /** 每公里工期（天） */
    daysPerKm: { ground: 30, viaduct: 90, bridge: 90, tunnel: 180 },
    minDays: 15,
    /** 车站：造价（円）与工期（天）；6 节编组 = 120 m = 6 格 */
    stationLengthCells: 6,
    stationWidthCells: 2,
    stationCost: { single: 20_000_000, side: 40_000_000, island: 45_000_000 },
    stationDays: 30,
    /** 车辆基地（固定规格） */
    depot: { lengthCells: 8, widthCells: 6, sidings: 8, cost: 200_000_000, days: 60 },
    /** 自动闭塞区间长度上限（米） */
    blockLengthM: 800,
  },
  ops: {
    /** 开局时间：1960-01-01 08:00（秒） */
    startTimeSec: 8 * 3600,
    /** 倍速档（1 倍速 1 秒 = 游戏 1 分钟） */
    speeds: [0, 1, 4, 16, 60, 360, 1440],
    /** 每帧模拟最多花多少毫秒（达不到倍速时自动降速） */
    frameBudgetMs: 10,
    /** 中间站停车时间（秒） */
    dwellSec: 30,
    /** 终点站最短折返时间（秒） */
    turnbackSec: 120,
    /** 时段与默认发车间隔（分钟，0 = 停运） */
    periods: [
      { id: 'night', name: '深夜', from: 0, to: 5, headwayMin: 0 },
      { id: 'early', name: '清晨', from: 5, to: 7, headwayMin: 20 },
      { id: 'amPeak', name: '早高峰', from: 7, to: 9, headwayMin: 10 },
      { id: 'day', name: '平峰', from: 9, to: 17, headwayMin: 15 },
      { id: 'pmPeak', name: '晚高峰', from: 17, to: 20, headwayMin: 10 },
      { id: 'evening', name: '夜间', from: 20, to: 24, headwayMin: 20 },
    ],
  },
  gesture: {
    /** 超过这个距离（px）算拖动 */
    dragThresholdPx: 8,
    /** 按住超过这个时间（ms）算长按 */
    longPressMs: 500,
  },
} as const;
