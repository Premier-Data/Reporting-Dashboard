// Season helpers for TT data.
//
// A "season" is NOT a calendar year. The 2027 season runs 1 Oct 2026 –
// 30 Sep 2027 (and so on). TT_Games rows carry an explicit `season` column
// stamped from the source sheet in sync-deputy.js, so for games the season is
// authoritative and date-independent.
//
// deputy_shifts rows have NO season column — only shift_date. To scope shifts
// to a season we therefore fall back to the season's DATE WINDOW (the Oct→Sep
// window below). This is the single source of truth for that boundary.

/** First day (inclusive) of a season: 1 Oct of the PREVIOUS calendar year. */
export function seasonStart(season: number): Date {
  // 2027 season starts 2026-10-01.
  return new Date(Date.UTC(season - 1, 9, 1, 0, 0, 0)); // month 9 = October
}

/** Last day (inclusive) of a season: 30 Sep of the season's calendar year. */
export function seasonEnd(season: number): Date {
  // 2027 season ends 2027-09-30 (end of day).
  return new Date(Date.UTC(season, 8, 30, 23, 59, 59, 999)); // month 8 = September
}

/**
 * Which season a given date falls in, by the Oct→Sep window. A date on/after
 * 1 Oct belongs to the NEXT calendar year's season. Used ONLY for sources that
 * lack an explicit season (deputy_shifts); never override a row's own season.
 */
export function seasonOfDate(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based; 9 = October
  return m >= 9 ? y + 1 : y;
}

/** Is a date within the given season's Oct→Sep window? */
export function dateInSeason(date: Date, season: number): boolean {
  return date >= seasonStart(season) && date <= seasonEnd(season);
}

/**
 * The distinct seasons present in a set of TT_Games rows (reading the explicit
 * `season` column), newest first. Rows with no season are reported via
 * `hasUnknown` so the UI can offer an "unknown" bucket rather than hiding them.
 */
export function seasonsFromTT(
  ttRows: Array<{ season?: number | null }>
): { years: number[]; hasUnknown: boolean } {
  const set = new Set<number>();
  let hasUnknown = false;
  for (const r of ttRows) {
    const s = Number(r?.season);
    if (r?.season == null || !Number.isFinite(s)) hasUnknown = true;
    else set.add(s);
  }
  return { years: [...set].sort((a, b) => b - a), hasUnknown };
}
