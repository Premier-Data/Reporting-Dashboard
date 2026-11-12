import { seasonWeekOfRow } from "./gameWeekIndex";

// Season-scoped week lists for fixture pickers (Fixtures page, Schedule
// allocation modal). Bare week numbers repeat across seasons, so a picker
// needs a season selection as well as a week.

type FixtureLike = {
  Date?: unknown;
  season?: unknown;
  Week?: unknown;
};

export type SeasonWeek = { season: number; week: number };

/** Distinct seasons that have fixtures, newest first. */
export function fixtureSeasons(games: ReadonlyArray<FixtureLike>): number[] {
  const set = new Set<number>();
  for (const g of games) {
    const sw = seasonWeekOfRow(g);
    if (sw) set.add(sw.season);
  }
  return [...set].sort((a, b) => b - a);
}

/** Distinct weeks (numeric ascending) of one season. */
export function weeksForSeason(
  games: ReadonlyArray<FixtureLike>,
  season: number
): number[] {
  const set = new Set<number>();
  for (const g of games) {
    const sw = seasonWeekOfRow(g);
    if (sw && sw.season === season) set.add(sw.week);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Default selection: the season of the newest fixture and the last week with
 * fixtures in that season. Null when no fixture can be placed.
 */
export function defaultSeasonWeek(
  games: ReadonlyArray<FixtureLike>
): SeasonWeek | null {
  const seasons = fixtureSeasons(games);
  if (seasons.length === 0) return null;
  const season = seasons[0];
  const weeks = weeksForSeason(games, season);
  return weeks.length ? { season, week: weeks[weeks.length - 1] } : null;
}

/** True when the fixture falls in the given season and week. */
export function matchesSeasonWeek(
  game: FixtureLike,
  season: number,
  week: number
): boolean {
  const sw = seasonWeekOfRow(game);
  return !!sw && sw.season === season && sw.week === week;
}
