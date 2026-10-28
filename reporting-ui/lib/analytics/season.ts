// Season helpers for TT data.
//
// A "season" is NOT a calendar year. A season starts in LATE SEPTEMBER (Week 1
// can begin on e.g. 30 Sep) and runs ~12 months. TT_Games rows carry an
// explicit `season` column stamped from the source sheet in sync-deputy.js, so
// for games the season is authoritative and date-independent.
//
// deputy_shifts rows are scoped by the season DATE WINDOW below when needed.
// This file is the single source of truth for that boundary and MUST match
// deputySeasonFromDate() in sync-deputy.js.
//
// Boundary rule: WEEK 1 is the Wed→Tue week that CONTAINS 1 October, and the
// season begins at the start of that week. So the season rolls on the
// Wednesday ON-OR-BEFORE 1 October. For 2026 that is Wed 30 Sep 2026 (1 Oct
// 2026 is a Thursday), which is exactly Week 1 in the source sheet. This floats
// to the correct Wednesday every year, so a Wed→Tue Week 1 is never split
// across two seasons.
//
// Weeks run Wednesday→Tuesday (DOW 3 = Wednesday).
const SEASON_WEEK_START_DOW = 3; // Wednesday

/**
 * The Wednesday on-or-before 1 October of `calendarYear` — the first day of the
 * season LABELLED (calendarYear + 1). Pure UTC date math.
 */
function seasonRollDate(calendarYear: number): Date {
  // 1 October of the given calendar year.
  const oct1 = new Date(Date.UTC(calendarYear, 9, 1, 0, 0, 0));
  const dow = oct1.getUTCDay(); // 0=Sun..6=Sat
  // Days to step back to reach the most recent Wednesday (0 if Oct 1 IS a Wed).
  const back = (dow - SEASON_WEEK_START_DOW + 7) % 7;
  return new Date(oct1.getTime() - back * 24 * 60 * 60 * 1000);
}

/** First day (inclusive) of a season: the Wed starting the week with 1 Oct. */
export function seasonStart(season: number): Date {
  // 2027 season starts on the Wed on-or-before 1 Oct 2026 = 2026-09-30.
  return seasonRollDate(season - 1);
}

/** Last day (inclusive) of a season: the instant before the next roll. */
export function seasonEnd(season: number): Date {
  return new Date(seasonStart(season + 1).getTime() - 1);
}

/**
 * Which season a given date falls in. A date on/after this calendar year's roll
 * (the Wed starting the week containing 1 Oct) belongs to the NEXT year's
 * season. Used ONLY for sources that lack an explicit season; never override a
 * row's own season.
 */
export function seasonOfDate(date: Date): number {
  const y = date.getUTCFullYear();
  return date >= seasonRollDate(y) ? y + 1 : y;
}

/** Is a date within the given season's window? */
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
