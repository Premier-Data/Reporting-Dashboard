// Pure soccer adapter for the Operations "Games" tab. Reuses the shared
// aggregation core in opsGames.ts (half a game per team side; same analyst on
// both sides = 1).
//
// Week rule: identical to the Reporting > Soccer Games card (see
// soccerWeeks.ts): Week 1 starts on the Wednesday on/before the earliest TT
// Week 1 date of the season, earlier dates are Week 0 (pre-season), and the
// stored soccer_games.week is only a fallback. Columns are labelled by the
// week-ending Saturday.

import {
  aggregateGames,
  type GameEntry,
  type OpsGamesAnalystRow,
  type OpsGamesWeek,
} from "./opsGames";
import { buildWeekOneAnchors, soccerWeekFor } from "./soccerWeeks";

export type SoccerGameRow = {
  game_key: string;
  Date: string | null; // yyyy-mm-dd
  season: number | null;
  week: number | string | null; // stored (October formula) - fallback only
  home_allocated: string | null;
  away_allocated: string | null;
  Location: string | null;
};

export const MIXED_KEY = "Mixed";

export type SoccerLocationRow = {
  key: string; // e.g. "AUS", or "Mixed"
  byWeek: Record<number, number>;
  total: number;
};

export type OpsSoccerReport = {
  season: number;
  weeks: OpsGamesWeek[];
  analysts: OpsGamesAnalystRow[];
  totalsByWeek: Record<number, number>;
  /** Single-code locations by total desc, then Mixed last (if any). */
  locations: SoccerLocationRow[];
  totals: { all: number };
  excluded: { placeholderHalfGames: number; skippedRows: number };
};

/** A clean single location code (letters only, e.g. AUS / PHL / VN), else Mixed. */
export function soccerLocationKey(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2,5}$/.test(s) ? s : MIXED_KEY;
}

function seasonOf(r: { season: number | null }): number | null {
  const s = Number(r.season);
  return r.season !== null && r.season !== undefined && Number.isFinite(s) ? s : null;
}

export function soccerSeasons(rows: SoccerGameRow[]): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    const s = seasonOf(r);
    if (s !== null) set.add(s);
  }
  return [...set].sort((a, b) => b - a);
}

/**
 * @param rows   soccer_games rows
 * @param ttRows TT rows (season, Week, Date) used only to anchor Week 1
 */
export function buildSoccerOpsReport(
  rows: SoccerGameRow[],
  ttRows: ReadonlyArray<Record<string, unknown>>,
  season: number
): OpsSoccerReport {
  const anchors = buildWeekOneAnchors(ttRows);
  const entries: GameEntry[] = [];
  for (const r of rows) {
    if (seasonOf(r) !== season) continue;
    entries.push({
      week: soccerWeekFor(r, anchors),
      date: r.Date,
      home: r.home_allocated,
      away: r.away_allocated,
      loc: soccerLocationKey(r.Location),
    });
  }
  const core = aggregateGames(entries);
  const keys = Object.keys(core.locTotals);
  const singles = keys
    .filter((k) => k !== MIXED_KEY)
    .sort((a, b) => core.locTotals[b] - core.locTotals[a] || a.localeCompare(b));
  const ordered = keys.includes(MIXED_KEY) ? [...singles, MIXED_KEY] : singles;
  return {
    season,
    weeks: core.weeks,
    analysts: core.analysts,
    totalsByWeek: core.totalsByWeek,
    locations: ordered.map((key) => ({
      key,
      byWeek: core.locByWeek[key],
      total: core.locTotals[key],
    })),
    totals: { all: core.all },
    excluded: core.excluded,
  };
}
