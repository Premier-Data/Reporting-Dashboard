import { absoluteWeekIndex, seasonWeekOfIso } from "./season";

// Season-aware week helpers. Bare week numbers repeat across seasons
// (2025 W24..53, 2026 W1..52, ...), so cross-season maths uses a continuous
// index. The date is authoritative; stored season/week are a fallback only.

type WeekLike = {
  Date?: unknown;
  shift_date?: unknown;
  season?: unknown;
  Week?: unknown;
  week?: unknown;
};

/** Derived { season, week } of a row: from its date, else from stored columns. */
export function seasonWeekOfRow(
  r: WeekLike
): { season: number; week: number } | null {
  const d = seasonWeekOfIso(r.Date ?? r.shift_date);
  if (d) return d;
  const season = Number(r.season);
  const week = Number(r.Week ?? r.week);
  if (Number.isFinite(season) && Number.isFinite(week)) return { season, week };
  return null;
}

/** Continuous week index of a row, or NaN when it cannot be placed. */
export function rowAbsoluteWeek(r: WeekLike): number {
  const sw = seasonWeekOfRow(r);
  return sw ? absoluteWeekIndex(sw.season, sw.week) : NaN;
}

/** Rows of the given season (derived from the row date); `null` = all rows. */
export function filterRowsBySeason<T extends WeekLike>(
  rows: readonly T[],
  season: number | null
): T[] {
  if (season === null) return [...rows];
  return rows.filter((r) => seasonWeekOfRow(r)?.season === season);
}

/** `${season}-${week}` key, or null when the row cannot be placed. */
export function seasonWeekKey(r: WeekLike): string | null {
  const sw = seasonWeekOfRow(r);
  return sw ? `${sw.season}-${sw.week}` : null;
}

export type WeekBucket = {
  key: string;
  idx: number;
  season: number;
  week: number;
};

/** Season-qualified bucket for a row (key + chronological index), or null. */
export function weekBucket(r: WeekLike): WeekBucket | null {
  const sw = seasonWeekOfRow(r);
  if (!sw) return null;
  return {
    key: `${sw.season}-${sw.week}`,
    idx: absoluteWeekIndex(sw.season, sw.week),
    season: sw.season,
    week: sw.week,
  };
}

/**
 * Adds an axis `label` to chronologically ordered buckets: `W{week}` when one
 * season is present, `{season} W{week}` otherwise.
 */
export function withWeekLabels<T extends { season: number; week: number }>(
  rows: readonly T[]
): (T & { label: string })[] {
  const multi = new Set(rows.map((r) => r.season)).size > 1;
  return rows.map((r) => ({
    ...r,
    label: multi ? `${r.season} W${r.week}` : `W${r.week}`,
  }));
}
