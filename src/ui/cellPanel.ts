import { formatDate, formatYen } from '../sim/calendar';
import { buildingCapacity, buildingName, LEVEL_NAMES, Owner, Zone, ZONE_NAMES, type Building } from '../sim/land/land';
import { cellIndex, cellInfo } from '../sim/map/query';
import { COVER_NAMES, RoadKind } from '../sim/map/types';
import type { World } from '../sim/world';

const GRADE_LIMIT_PERMIL = 25;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function describeBuilding(world: World, b: Building): { title: string; summary: string; body: string } {
  const m = world.map;
  const side = b.size * m.cellMeters;
  const rows: [string, string][] = [
    ['用途', ZONE_NAMES[b.use]],
    ['经济水平', `${LEVEL_NAMES[b.level]}档`],
    ['占地', `${side}×${side} m（${b.size * b.size} 格）`],
    [b.use === Zone.Residential ? '人口' : '岗位', `${buildingCapacity(b)}`],
    ['所有权', b.player ? '本公司土地' : '市民'],
    ['建成', b.builtAt > 0 ? formatDate(b.builtAt) : '开局前已有'],
    ['地价', `${formatYen(world.land.price(cellIndex(m, b.x, b.y), world.time))}/格`],
  ];
  return {
    title: buildingName(b),
    summary: `${ZONE_NAMES[b.use]} · ${LEVEL_NAMES[b.level]}档 · ${b.player ? '本公司土地' : '市民'}`,
    body: `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`,
  };
}

export function describeCell(world: World, cx: number, cy: number): { title: string; summary: string; body: string } {
  const m = world.map;
  const land = world.land;
  const i = cellIndex(m, cx, cy);
  const info = cellInfo(m, cx, cy);
  const terminal = m.terminals.find((t) => cx >= t.rect.x && cx < t.rect.x + t.rect.w && cy >= t.rect.y && cy < t.rect.y + t.rect.h);
  const coverName = terminal ? terminal.name : COVER_NAMES[info.cover];
  const elev = info.waterLevel !== null ? info.waterLevel : info.elevation;
  const rows: [string, string][] = [];
  rows.push(['地表', esc(coverName)]);
  rows.push([info.waterLevel !== null ? '水面海拔' : '海拔', `${elev.toFixed(1)} m`]);
  if (info.waterLevel === null) {
    const steep = info.slopePermil > GRADE_LIMIT_PERMIL;
    rows.push(['坡度', `<span class="${steep ? 'warn' : ''}">${info.slopePermil.toFixed(0)}‰${steep ? '（超过普通铁路上限 25‰）' : ''}</span>`]);
  } else {
    rows.push(['水深', `约 ${(info.waterLevel - info.elevation).toFixed(1)} m`]);
  }
  if (info.road === RoadKind.Road) rows.push(['道路', '既有道路']);
  if (info.road === RoadKind.Bridge) rows.push(['道路', '既有道路桥']);
  if (terminal) {
    rows.push(['站台', `${terminal.platforms} 条（6 节编组）`]);
    rows.push(['接线', '从车站西端接入']);
  }
  const price = land.price(i, world.time);
  if (price > 0) rows.push(['地价', `${formatYen(price)}/格`]);
  const owner = land.owner[i];
  if (owner) rows.push(['所有权', owner === Owner.Player ? `本公司 · ${ZONE_NAMES[land.zone[i] as Zone]}` : '市民']);
  rows.push(['位置', `距西边 ${((cx * m.cellMeters) / 1000).toFixed(2)} km，距北边 ${((cy * m.cellMeters) / 1000).toFixed(2)} km`]);

  const body = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  return {
    title: `格 (${cx}, ${cy})`,
    summary: `${coverName} · 海拔 ${elev.toFixed(0)} m`,
    body,
  };
}
