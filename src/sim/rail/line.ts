import { CONFIG } from '../../config';
import { cellIndex, inBounds } from '../map/query';
import { Cover, type ExternalTerminal, type MapData } from '../map/types';
import { buildAlignment, dirIndex, sampleAlignment, type Alignment, type AlignmentRules, type GridPt } from '../track/alignment';
import { computeProfile, summarizeProfile, SAMPLE_STEP, type Profile, type ProfileSummary, type Structure } from '../track/profile';
import type { Acquisition } from '../land/land';
import { stationTrackCount, type Depot, type RailLine, type Station, type StationType, type TrackSpan } from './types';

export const DAY = 86400;

/** 工期（天）→ 实际施工秒数；0 = 立即完工 */
export const buildSeconds = (days: number): number => days * DAY * CONFIG.rail.constructionTimeScale;

export function alignmentRules(m: MapData): AlignmentRules {
  return { preferredRadius: CONFIG.rail.preferredRadiusM / m.cellMeters, minRadius: CONFIG.rail.minRadiusM / m.cellMeters };
}

const key = (p: GridPt) => `${p.x},${p.y}`;

/** 线路的线形（已建折点半径固定） */
export function lineAlignment(m: MapData, line: RailLine): Alignment {
  const fixed = new Map<string, number>();
  line.points.forEach((p, i) => {
    if (line.radii[i] > 0) fixed.set(key(p), line.radii[i]);
  });
  return buildAlignment(line.points, alignmentRules(m), (p) => fixed.get(key(p)));
}

export function spanAt(line: RailLine, s: number): TrackSpan | null {
  for (const sp of line.spans) if (s >= sp.s0 - 1e-6 && s <= sp.s1 + 1e-6) return sp;
  return null;
}

/** 里程 s 处的轨面高度（米） */
export function zAt(line: RailLine, s: number): number {
  const sp = spanAt(line, s) ?? (s < 0 ? line.spans[0] : line.spans[line.spans.length - 1]);
  const u = Math.max(0, Math.min(sp.z.length - 1, (s - sp.s0) / sp.step));
  const i = Math.min(sp.z.length - 2, Math.floor(u));
  const t = u - i;
  return sp.z[i] + (sp.z[i + 1] - sp.z[i]) * t;
}

export function structureAt(line: RailLine, s: number): Structure {
  const sp = spanAt(line, s);
  if (!sp) return 'ground';
  const i = Math.max(0, Math.min(sp.structure.length - 1, Math.round((s - sp.s0) / sp.step)));
  return sp.structure[i];
}

export function lineLength(line: RailLine): number {
  return line.spans.length ? line.spans[line.spans.length - 1].s1 : 0;
}

/** 线路两端：端点与「向外」的方向 */
export function lineEnds(line: RailLine): { start: { pt: GridPt; dir: number }; end: { pt: GridPt; dir: number } } | null {
  const p = line.points;
  if (p.length < 2) return null;
  const n = p.length;
  return {
    start: { pt: p[0], dir: dirIndex(p[0].x - p[1].x, p[0].y - p[1].y) },
    end: { pt: p[n - 1], dir: dirIndex(p[n - 1].x - p[n - 2].x, p[n - 1].y - p[n - 2].y) },
  };
}

// ---------------------------------------------------------------- 草案

export type DraftAnchor = 'new' | 'start' | 'end';

export interface Draft {
  anchor: DraftAnchor;
  /** 从锚点出发的折点（第一个点为锚点） */
  points: GridPt[];
  tracks: 1 | 2;
}

export interface DraftIssue {
  at: GridPt | null;
  message: string;
}

export interface DraftEval {
  ok: boolean;
  issues: DraftIssue[];
  /** 合并后的整条线 */
  merged: { points: GridPt[]; radii: number[]; alignment: Alignment };
  /** 新建部分在合并后线路上的里程区间 */
  s0: number;
  s1: number;
  /** 按里程递增方向的纵断面 */
  profile: Profile;
  summary: ProfileSummary;
  terminal: ExternalTerminal | null;
  /** 拆迁（World.evaluate 填入） */
  acquisition?: Acquisition;
  /** 如果从起点延长，旧线路里程整体后移的量 */
  shift: number;
}

export function evaluateDraft(m: MapData, line: RailLine | null, draft: Draft): DraftEval | null {
  let pts = draft.points;
  // 新线从终点站接线点画起：反过来，让终点站在线路末端
  if (draft.anchor === 'new' && pts.length >= 2 && m.terminals.some((t) => t.entry.x === pts[0].x && t.entry.y === pts[0].y)) {
    pts = [...pts].reverse();
  }
  if (pts.length < 2) return null;
  const issues: DraftIssue[] = [];
  const rules = alignmentRules(m);
  let merged: GridPt[];
  let fixedRadii: number[] = [];
  let startZ: number | undefined;
  let endZ: number | undefined;
  let s0: number;
  let s1: number;
  let shift = 0;
  const ends = line ? lineEnds(line) : null;

  // 是否接入既有终点站
  const last = pts[pts.length - 1];
  const terminal = m.terminals.find((t) => t.entry.x === last.x && t.entry.y === last.y) ?? null;
  if (terminal) {
    const d = dirIndex(last.x - pts[pts.length - 2].x, last.y - pts[pts.length - 2].y);
    if (d !== 0) issues.push({ at: last, message: '须从西向东笔直进入终点站' });
  }
  const draftPts = terminal ? [...pts, { x: terminal.rect.x + terminal.rect.w, y: terminal.entry.y }] : pts;

  if (draft.anchor === 'new' || !line || !ends) {
    merged = draftPts;
  } else if (draft.anchor === 'end') {
    if (key(pts[0]) !== key(ends.end.pt)) return null;
    const d = dirIndex(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    if (d !== ends.end.dir) issues.push({ at: pts[0], message: '延长时须沿线路方向笔直接出' });
    merged = [...line.points, ...draftPts.slice(1)];
    fixedRadii = line.radii;
  } else {
    if (key(pts[0]) !== key(ends.start.pt)) return null;
    const d = dirIndex(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    if (d !== ends.start.dir) issues.push({ at: pts[0], message: '延长时须沿线路方向笔直接出' });
    merged = [...[...draftPts].reverse(), ...line.points.slice(1)];
  }

  const fixed = new Map<string, number>();
  if (line) fixedRadii.forEach((r, i) => r > 0 && fixed.set(key(line.points[i]), r));
  if (line && draft.anchor === 'start') line.radii.forEach((r, i) => r > 0 && fixed.set(key(line.points[i]), r));
  const al = buildAlignment(merged, rules, (p) => fixed.get(key(p)));
  const oldLen = line ? lineLength(line) : 0;

  if (draft.anchor === 'start' && line) {
    shift = al.length - oldLen;
    s0 = 0;
    s1 = shift;
    endZ = zAt(line, 0);
  } else {
    s0 = draft.anchor === 'end' && line ? oldLen : 0;
    s1 = al.length;
    if (draft.anchor === 'end' && line) startZ = zAt(line, oldLen);
  }
  if (terminal) {
    if (draft.anchor === 'start') startZ = terminal.elevation;
    else endZ = terminal.elevation;
  }
  // 接入终点站时，站内那一段（既有）不计入草案
  const internal = terminal ? terminal.rect.w : 0;
  const ps0 = draft.anchor === 'start' && terminal ? s0 + internal : s0;
  const ps1 = draft.anchor !== 'start' && terminal ? s1 - internal : s1;

  for (const iss of al.issues) {
    issues.push({ at: iss.at, message: iss.kind === 'sharp' ? '转弯超过 90°' : `曲线半径不足（${Math.round((iss.radius ?? 0) * m.cellMeters)} m < ${CONFIG.rail.minRadiusM} m）` });
  }

  const profile = computeProfile(m, al, startZ, endZ, ps0, ps1);
  const summary = summarizeProfile(m, ps1 - ps0, profile, draft.tracks);
  if (summary.maxGradePermil > CONFIG.rail.maxGradePermil + 0.5) {
    issues.push({ at: null, message: `坡度 ${summary.maxGradePermil.toFixed(0)}‰ 超过上限 ${CONFIG.rail.maxGradePermil}‰（高差太大）` });
  }

  // 出界、穿过既有线路、穿过终点站
  const oldCells = new Set<number>();
  if (line) {
    const oldAl = lineAlignment(m, line);
    for (let s = 0; s <= oldAl.length; s += SAMPLE_STEP) {
      const p = sampleAlignment(oldAl, s);
      oldCells.add(cellIndex(m, Math.floor(p.x), Math.floor(p.y)));
    }
  }
  const junction = draft.anchor === 'start' ? ps1 : ps0;
  let crossing = false;
  let outside = false;
  let terminalHit = false;
  for (let s = ps0; s <= ps1; s += SAMPLE_STEP) {
    const p = sampleAlignment(al, s);
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (!inBounds(m, cx, cy) || p.x < 1 || p.y < 1 || p.x > m.width - 1 || p.y > m.height - 1) outside = true;
    else {
      if (line && Math.abs(s - junction) > 2 && oldCells.has(cellIndex(m, cx, cy))) crossing = true;
      if (m.cover[cellIndex(m, cx, cy)] === Cover.Facility) terminalHit = true;
    }
  }
  if (outside) issues.push({ at: null, message: '超出地图范围' });
  if (crossing) issues.push({ at: null, message: 'MVP 只有一条线，不能与既有线路交叉' });
  if (terminalHit) issues.push({ at: null, message: '只能从西端接入终点站' });
  if (line && terminal && line.stations.some((st) => st.externalId === terminal.id)) issues.push({ at: null, message: '已经接入终点站' });

  return {
    ok: issues.length === 0,
    issues,
    merged: { points: al.points, radii: al.radii, alignment: al },
    s0,
    s1,
    profile,
    summary,
    terminal,
    shift,
  };
}

/** 确认草案：写入线路（新建部分进入施工期） */
export function applyDraft(m: MapData, line: RailLine | null, ev: DraftEval, tracks: 1 | 2, now: number, nextId: () => number): RailLine {
  const l: RailLine = line ?? { points: [], radii: [], spans: [], stations: [], depot: null };
  if (ev.shift) {
    for (const sp of l.spans) {
      sp.s0 += ev.shift;
      sp.s1 += ev.shift;
    }
    for (const st of l.stations) st.s += ev.shift;
  }
  l.points = ev.merged.points;
  l.radii = ev.merged.radii;

  const internal = ev.terminal ? ev.terminal.rect.w : 0;
  const atStart = ev.shift > 0;
  // 新建部分
  const ps0 = atStart && ev.terminal ? ev.s0 + internal : ev.s0;
  const ps1 = !atStart && ev.terminal ? ev.s1 - internal : ev.s1;
  const n = ev.profile.z.length;
  l.spans.push({
    id: nextId(),
    s0: ps0,
    s1: ps1,
    tracks,
    step: (ps1 - ps0) / (n - 1),
    z: ev.profile.z,
    structure: ev.profile.structure,
    cost: ev.summary.cost,
    build: { startedAt: now, readyAt: now + buildSeconds(ev.summary.days) },
  });
  if (ev.terminal) {
    const t = ev.terminal;
    const a = atStart ? ev.s0 : ps1;
    const b = atStart ? ps0 : ev.s1;
    l.spans.push({
      id: nextId(),
      s0: a,
      s1: b,
      tracks: 2,
      step: (b - a) / 2,
      z: [t.elevation, t.elevation, t.elevation],
      structure: ['ground', 'ground', 'ground'],
      cost: 0,
      build: { startedAt: now, readyAt: null },
      external: true,
    });
    // 站台位于终点站东侧 6 格
    const len = CONFIG.rail.stationLengthCells;
    const sCenter = atStart ? ev.s0 + len / 2 + 1 : ev.s1 - len / 2 - 1;
    l.stations.push({
      id: nextId(),
      name: t.name,
      type: 'island',
      s: sCenter,
      orient: 'h',
      externalId: t.id,
      cost: 0,
      build: { startedAt: now, readyAt: null },
    });
  }
  l.spans.sort((a, b) => a.s0 - b.s0);
  l.stations.sort((a, b) => a.s - b.s);
  markRailCells(m, l);
  return l;
}

/** 线路这一段占用的格子 */
export function railCells(m: MapData, al: Alignment, s0 = 0, s1 = al.length): Set<number> {
  const cells = new Set<number>();
  for (let s = s0; s <= s1; s += SAMPLE_STEP / 2) {
    const p = sampleAlignment(al, s);
    // 复线宽约 1 格：两侧各 0.5 格
    for (const off of [-0.45, 0, 0.45]) {
      const cx = Math.floor(p.x - p.ty * off);
      const cy = Math.floor(p.y + p.tx * off);
      if (inBounds(m, cx, cy)) cells.add(cellIndex(m, cx, cy));
    }
  }
  return cells;
}

/** 把线路占用的格子标记到地图上 */
export function markRailCells(m: MapData, line: RailLine): void {
  for (const i of railCells(m, lineAlignment(m, line))) m.rail[i] = 1;
}

// ---------------------------------------------------------------- 车站

export interface StationCandidate {
  s: number;
  orient: 'h' | 'v' | 'd';
  center: GridPt;
  /** 线路切线（单位向量） */
  dir: GridPt;
  ok: boolean;
  issues: string[];
  /** 含拆迁补偿 */
  cost: number;
  acquisition?: Acquisition;
}

/** 在点 (x,y) 附近找一个车站位置并检查是否可建 */
export function stationCandidate(m: MapData, line: RailLine, x: number, y: number, type: StationType, now: number): StationCandidate | null {
  const al = lineAlignment(m, line);
  // 找最近的里程
  let best = Infinity;
  let bestS = 0;
  for (let s = 0; s <= al.length; s += SAMPLE_STEP) {
    const p = sampleAlignment(al, s);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best) {
      best = d;
      bestS = s;
    }
  }
  if (best > 3) return null;
  const p0 = sampleAlignment(al, bestS);
  const dir = { x: p0.tx, y: p0.ty };
  const issues: string[] = [];
  const horizontal = Math.abs(p0.ty) < 1e-6;
  const vertical = Math.abs(p0.tx) < 1e-6;
  const orient = horizontal ? 'h' : vertical ? 'v' : 'd';
  if (p0.radius !== Infinity) {
    return { s: bestS, orient, center: { x: p0.x, y: p0.y }, dir, ok: false, issues: ['车站须建在直线上'], cost: 0 };
  }
  // 站中心对齐到最近的格点（再投影回线路上）
  const g = { x: Math.round(p0.x), y: Math.round(p0.y) };
  // 中心点在线路上的里程
  const s = bestS + ((g.x - p0.x) * p0.tx + (g.y - p0.y) * p0.ty);
  const pc = sampleAlignment(al, s);
  const center = { x: pc.x, y: pc.y };
  const half = CONFIG.rail.stationLengthCells / 2;
  for (const t of [s - half, s, s + half]) {
    const q = sampleAlignment(al, t);
    if (t < -1e-6 || t > al.length + 1e-6 || q.radius !== Infinity || Math.abs(q.tx * p0.ty - q.ty * p0.tx) > 1e-6) {
      issues.push('站台 120 m 范围内须是直线');
      break;
    }
  }
  if (issues.length === 0) {
    const grade = (Math.abs(zAt(line, s + half) - zAt(line, s - half)) / (2 * half * m.cellMeters)) * 1000;
    if (grade > CONFIG.rail.stationMaxGradePermil) issues.push(`坡度 ${grade.toFixed(0)}‰，车站须 ≤ ${CONFIG.rail.stationMaxGradePermil}‰`);
    for (const t of [s - half, s, s + half]) {
      const st = structureAt(line, t);
      if (st === 'tunnel' || st === 'bridge') {
        issues.push(st === 'tunnel' ? '隧道内不能建站' : '桥上不能建站');
        break;
      }
    }
    for (const other of line.stations) {
      if (Math.abs(other.s - s) < 2 * half + 1) {
        issues.push('与其他车站太近');
        break;
      }
    }
    const sp = spanAt(line, s);
    if (type === 'single' && sp && sp.tracks === 2) issues.push('复线区间不能建一面一线车站（只有一条股道）');
    if (sp && spanAt(line, s - half)?.tracks !== spanAt(line, s + half)?.tracks) issues.push('车站不能跨在单线与复线的交界处');
  }
  void now;
  return { s, orient, center, dir, ok: issues.length === 0, issues, cost: CONFIG.rail.stationCost[type] };
}

export function addStation(line: RailLine, c: StationCandidate, type: StationType, name: string, now: number, id: number): Station {
  const sp = spanAt(line, c.s);
  const own = now + buildSeconds(CONFIG.rail.stationDays);
  const readyAt = Math.max(own, sp?.build.readyAt ?? 0);
  const st: Station = { id, name, type, s: c.s, orient: c.orient, externalId: null, cost: c.cost, build: { startedAt: now, readyAt } };
  line.stations.push(st);
  line.stations.sort((a, b) => a.s - b.s);
  return st;
}

/** 车站占用的格子：沿线路方向 L×W 的矩形（可斜向） */
export function stationCells(m: MapData, center: GridPt, dir: GridPt): number[] {
  const L = CONFIG.rail.stationLengthCells;
  const W = CONFIG.rail.stationWidthCells;
  const cells = new Set<number>();
  for (let u = -L / 2 + 0.05; u <= L / 2 - 0.05; u += 0.25) {
    for (let v = -W / 2 + 0.05; v <= W / 2 - 0.05; v += 0.25) {
      const cx = Math.floor(center.x + dir.x * u - dir.y * v);
      const cy = Math.floor(center.y + dir.y * u + dir.x * v);
      if (inBounds(m, cx, cy)) cells.add(cellIndex(m, cx, cy));
    }
  }
  return [...cells];
}

export const stationTracks = (st: Station) => stationTrackCount(st.type);

// ---------------------------------------------------------------- 车辆基地

export interface DepotCandidate {
  stationId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ok: boolean;
  issues: string[];
  /** 拆迁（World.depotCandidate 填入） */
  acquisition?: Acquisition;
}

/**
 * 车辆基地放在车站一侧（side：沿法线 (ty, -tx) 为 1，反向为 -1）。
 * 基地本身按格子横放或竖放（取接近线路的方向），斜向车站旁也一样。
 */
export function depotCandidate(m: MapData, line: RailLine, st: Station, side: 1 | -1): DepotCandidate {
  const al = lineAlignment(m, line);
  const p = sampleAlignment(al, st.s);
  const { lengthCells: L, widthCells: W } = CONFIG.rail.depot;
  const gap = CONFIG.rail.stationWidthCells / 2 + 1;
  const horizontal = Math.abs(p.tx) >= Math.abs(p.ty);
  const w = horizontal ? L : W;
  const hh = horizontal ? W : L;
  const nx = p.ty * side;
  const ny = -p.tx * side;
  const dist = gap + (w / 2) * Math.abs(nx) + (hh / 2) * Math.abs(ny);
  const r = { x: Math.round(p.x + nx * dist - w / 2), y: Math.round(p.y + ny * dist - hh / 2), w, h: hh };
  const issues: string[] = [];
  let water = false;
  let rail = false;
  let facility = false;
  let road = false;
  let minH = Infinity;
  let maxH = -Infinity;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!inBounds(m, x, y)) {
        issues.push('超出地图范围');
        return { stationId: st.id, ...r, ok: false, issues };
      }
      const i = cellIndex(m, x, y);
      if (m.cover[i] === Cover.Water) water = true;
      if (m.cover[i] === Cover.Facility) facility = true;
      if (m.rail[i]) rail = true;
      if (m.roads[i]) road = true;
      const h = m.heights[y * (m.width + 1) + x];
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  }
  if (water) issues.push('不能建在河上');
  if (rail) issues.push('与线路重叠');
  if (facility) issues.push('与既有设施重叠');
  if (road) issues.push('与既有道路重叠');
  if (maxH - minH > 6) issues.push(`地面高差 ${(maxH - minH).toFixed(0)} m，车辆基地需要平地（≤ 6 m）`);
  if (st.externalId) issues.push('不能建在既有终点站旁');
  if (line.depot) issues.push('MVP 只能建一个车辆基地');
  if (!st.externalId && structureAt(line, depotLead(m, line, { ...r, stationId: st.id }).sJoin) !== 'ground') issues.push('出入库线只能接在地面段（车站两侧都是桥、隧道或线路尽头）');
  return { stationId: st.id, ...r, ok: issues.length === 0, issues };
}

/** 三次曲线：从 a 沿 aDir 出发，沿 bDir 到达 b（道岔、出入库线用） */
export function leadCurve(a: GridPt, aDir: GridPt, b: GridPt, bDir: GridPt, n = 24): GridPt[] {
  const k = Math.hypot(b.x - a.x, b.y - a.y) * 0.4;
  const p1 = { x: a.x + aDir.x * k, y: a.y + aDir.y * k };
  const p2 = { x: b.x - bDir.x * k, y: b.y - bDir.y * k };
  const out: GridPt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push({ x: w[0] * a.x + w[1] * p1.x + w[2] * p2.x + w[3] * b.x, y: w[0] * a.y + w[1] * p1.y + w[2] * p2.y + w[3] * b.y });
  }
  return out;
}

type DepotRect = Pick<Depot, 'x' | 'y' | 'w' | 'h' | 'stationId'>;

/**
 * 出入库线：留置线经梯形道岔在咽喉汇合，再以曲线道岔接到车站外侧的正线上。
 * axis·sign 为出库方向；tan 为接轨处列车出库后沿正线的行进方向。
 */
export function depotLead(m: MapData, line: RailLine, d: DepotRect) {
  const st = line.stations.find((s) => s.id === d.stationId)!;
  const al = lineAlignment(m, line);
  const p = sampleAlignment(al, st.s);
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  const perp = Math.abs((cx - p.x) * p.ty - (cy - p.y) * p.tx);
  const reach = CONFIG.rail.stationLengthCells / 2 + 2 + perp * 1.6;
  // 接轨点优先选在地面段（不接在桥上、隧道里），两端都不行时取线路内的一端
  const fits = (dd: number) => st.s + dd * reach > 0.5 && st.s + dd * reach < al.length - 0.5;
  const onGround = (dd: number) => fits(dd) && structureAt(line, st.s + dd * reach) === 'ground';
  const dir = onGround(1) ? 1 : onGround(-1) ? -1 : fits(1) ? 1 : -1;
  const sJoin = Math.max(0, Math.min(al.length, st.s + dir * reach));
  const horizontal = d.w > d.h;
  const sign = Math.sign(((horizontal ? 1 : 0) * p.tx + (horizontal ? 0 : 1) * p.ty) * dir) || 1;
  const axis = horizontal ? { x: sign, y: 0 } : { x: 0, y: sign };
  const half = (horizontal ? d.w : d.h) / 2 + 1.2;
  const throat = { x: cx + axis.x * half, y: cy + axis.y * half };
  const j = sampleAlignment(al, sJoin);
  // 留置线出口（基地内、离咽喉一端 1.4 格处）
  const sidings = CONFIG.rail.depot.sidings;
  const exits: GridPt[] = [];
  for (let i = 0; i < sidings; i++) {
    const t = (i + 0.5) / sidings;
    exits.push(
      horizontal
        ? { x: cx + sign * (d.w / 2 - 1.4), y: d.y + 0.3 + t * (d.h - 0.6) }
        : { x: d.x + 0.3 + t * (d.w - 0.6), y: cy + sign * (d.h / 2 - 1.4) },
    );
  }
  return { throat, join: { x: j.x, y: j.y }, sJoin, dir, sign, axis, tan: { x: j.tx * dir, y: j.ty * dir }, exits };
}

/** 出入库线与梯形道岔占用的格子 */
export function depotLeadCells(m: MapData, line: RailLine, d: DepotRect): number[] {
  const L = depotLead(m, line, d);
  const paths = [leadCurve(L.throat, L.axis, L.join, L.tan), ...L.exits.map((e) => leadCurve(e, L.axis, L.throat, L.axis, 8))];
  const cells = new Set<number>();
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (let t = 0; t <= len; t += 0.25) {
        for (const off of [-0.45, 0, 0.45]) {
          const x = a.x + ((b.x - a.x) * t) / len - ((b.y - a.y) / len) * off;
          const y = a.y + ((b.y - a.y) * t) / len + ((b.x - a.x) / len) * off;
          if (inBounds(m, Math.floor(x), Math.floor(y))) cells.add(cellIndex(m, Math.floor(x), Math.floor(y)));
        }
      }
    }
  }
  return [...cells];
}

export function addDepot(m: MapData, line: RailLine, c: DepotCandidate, now: number): void {
  const st = line.stations.find((s) => s.id === c.stationId)!;
  const own = now + buildSeconds(CONFIG.rail.depot.days);
  line.depot = { x: c.x, y: c.y, w: c.w, h: c.h, stationId: c.stationId, cost: CONFIG.rail.depot.cost, build: { startedAt: now, readyAt: Math.max(own, st.build.readyAt ?? 0) } };
  // 整平并标记占地
  let sum = 0;
  let k = 0;
  for (let y = c.y; y <= c.y + c.h; y++) for (let x = c.x; x <= c.x + c.w; x++) (sum += m.heights[y * (m.width + 1) + x]), k++;
  const avg = sum / k;
  for (let y = c.y; y <= c.y + c.h; y++) for (let x = c.x; x <= c.x + c.w; x++) m.heights[y * (m.width + 1) + x] = avg;
  for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) m.rail[cellIndex(m, x, y)] = 1;
}

export { stationTrackCount };
