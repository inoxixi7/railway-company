/** 车型目录（游戏化近似，名称为架空） */
export interface CarType {
  id: string;
  name: string;
  year: number;
  /** 每辆车长（米） */
  carLengthM: number;
  doors: number;
  capacityPerCar: number;
  maxSpeedKmh: number;
  /** 起动加速度（km/h/s） */
  accelKmhS: number;
  /** 常用减速度（km/h/s） */
  decelKmhS: number;
  minCars: number;
  maxCars: number;
  /** 每辆价格（円，暂定） */
  pricePerCar: number;
  /** 涂装颜色 */
  color: number;
  airConditioning: boolean;
}

export const CAR_TYPES: CarType[] = [
  {
    id: 'wood',
    name: '木造电车',
    year: 1920,
    carLengthM: 15,
    doors: 2,
    capacityPerCar: 90,
    maxSpeedKmh: 65,
    accelKmhS: 1.8,
    decelKmhS: 3.0,
    minCars: 1,
    maxCars: 4,
    pricePerCar: 6_000_000,
    color: 0x8a5a3c,
    airConditioning: false,
  },
  {
    id: 'steel',
    name: '钢制通勤车',
    year: 1955,
    carLengthM: 18,
    doors: 3,
    capacityPerCar: 125,
    maxSpeedKmh: 95,
    accelKmhS: 2.5,
    decelKmhS: 3.5,
    minCars: 2,
    maxCars: 6,
    pricePerCar: 15_000_000,
    color: 0xd9822b,
    airConditioning: false,
  },
];

export const carType = (id: string): CarType => {
  const t = CAR_TYPES.find((c) => c.id === id);
  if (!t) throw new Error(`未知车型 ${id}`);
  return t;
};
