import { CONFIG } from '../../config';
import { cellIndex, inBounds } from '../map/query';
import { Cover, type ExternalTerminal, type MapData } from '../map/types';
import { buildAlignment, dirIndex, sampleAlignment, type Alignment, type AlignmentRules, type GridPt } from '../track/alignment';
import { computeProfile, summarizeProfile, SAMPLE_STEP, type Profile, type ProfileSummary, type Structure } from '../track/profile';
import type { Acquisition } from '../land/land';
import { stationTrackCount, type RailLine, type Station, type StationType, type TrackSpan } from './types';

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
  orient: 'h' | 'v';
  center: GridPt;
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
  // 站中心对齐到格点
  const center = { x: Math.round(p0.x), y: Math.round(p0.y) };
  const issues: string[] = [];
  const horizontal = Math.abs(p0.ty) < 1e-6;
  const vertical = Math.abs(p0.tx) < 1e-6;
  if (!horizontal && !vertical) {
    return { s: bestS, orient: 'h', center, ok: false, issues: ['车站只能建在东西向或南北向的直线上'], cost: 0 };
  }
  // 中心点在线路上的里程
  const s = bestS + ((center.x - p0.x) * p0.tx + (center.y - p0.y) * p0.ty);
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
  return { s, orient: horizontal ? 'h' : 'v', center, ok: issues.length === 0, issues, cost: CONFIG.rail.stationCost[type] };
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

export function stationFootprint(st: Pick<Station, 'orient'>, center: GridPt): { x: number; y: number; w: number; h: number } {
  const L = CONFIG.rail.stationLengthCells;
  const W = CONFIG.rail.stationWidthCells;
  return st.orient === 'h' ? { x: center.x - L / 2, y: center.y - W / 2, w: L, h: W } : { x: center.x - W / 2, y: center.y - L / 2, w: W, h: L };
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

/** 车辆基地放在车站一侧（side = 1 或 -1），沿线路方向居中 */
export function depotCandidate(m: MapData, line: RailLine, st: Station, side: 1 | -1): DepotCandidate {
  const al = lineAlignment(m, line);
  const p = sampleAlignment(al, st.s);
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  const { lengthCells: L, widthCells: W } = CONFIG.rail.depot;
  const gap = CONFIG.rail.stationWidthCells / 2 + 1;
  const r =
    st.orient === 'h'
      ? { x: cx - L / 2, y: side > 0 ? cy + gap : cy - gap - W, w: L, h: W }
      : { x: side > 0 ? cx + gap : cx - gap - W, y: cy - L / 2, w: W, h: L };
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
  return { stationId: st.id, ...r, ok: issues.length === 0, issues };
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
