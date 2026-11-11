// Season / week rule: the single source of truth for the whole app.
//
// A "season" is NOT a calendar year. Weeks run Wednesday->Tuesday. Season N
// starts on the Wednesday on or before 1 Oct of year N-1 and that day is
// Week 1. There is no sheet-defined numbering and no Week 0. A season can
// have 52 or 53 weeks (season 2025 has 53).
//
// Season and week are derived from a row's DATE everywhere (TT games, soccer
// games, Deputy shifts). Stored season/week columns are only a last fallback.
// Twins that MUST match this file: deputySeasonFromDate()/seasonWeekFromDate()
// in sync-deputy.js and the SQL functions of migration 005
// (deputy_season_of, deputy_season_week_of).
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
 * Start (inclusive, a Wednesday) and end (inclusive, the following Tuesday) of
 * a given WEEK number within a season. Week 1 starts on the season roll date
 * (the Wed on-or-before 1 Oct); each subsequent week is +7 days. Used by the
 * weekly report to label columns "Wed 30-Sep → Tue 06-Oct".
 */
export function seasonWeekRange(season: number, week: number): { start: Date; end: Date } {
  const start = new Date(seasonStart(season).getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  return { start, end };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Wed 2024-09-25 = season 2025 Week 1 (origin of absoluteWeekIndex). */
const EPOCH_MS = Date.UTC(2024, 8, 25);

export type SeasonWeek = { season: number; week: number };

/** yyyy-mm-dd (or ISO datetime prefix) -> UTC Date, or null if not a real calendar date. */
export function parseIsoDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);

/** The single rule: season + week (1-based, can be 53) of a calendar date. null if invalid. */
export function seasonWeekOfIso(v: unknown): SeasonWeek | null {
  const d = parseIsoDate(v);
  if (!d) return null;
  const season = seasonOfDate(d);
  const week = Math.floor((d.getTime() - seasonStart(season).getTime()) / WEEK_MS) + 1;
  return { season, week };
}

/** Predecessor of a season-week: week-1, or the last week of the previous season when week === 1. */
export function prevSeasonWeek(season: number, week: number): SeasonWeek {
  if (week > 1) return { season, week: week - 1 };
  const last = seasonWeekOfIso(isoOf(new Date(seasonStart(season).getTime() - DAY_MS)));
  return last as SeasonWeek;
}

/** Continuous 0-based week index since Wed 2024-09-25 (season 2025 W1). For "N weeks back" maths across seasons. */
export function absoluteWeekIndex(season: number, week: number): number {
  return Math.round((seasonStart(season).getTime() - EPOCH_MS) / WEEK_MS) + (week - 1);
}

/** Descending union of season numbers from any number of sources; ignores null/NaN. */
export function unionSeasons(...sources: ReadonlyArray<Iterable<number | null | undefined>>): number[] {
  const set = new Set<number>();
  for (const src of sources) {
    for (const s of src) {
      if (s == null) continue;
      const n = Number(s);
      if (Number.isFinite(n)) set.add(n);
    }
  }
  return [...set].sort((a, b) => b - a);
}

const finiteOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Seasons derived from rows' dates (falls back to the row's stored `season` when the date is unusable). */
export function seasonsFromDates(rows: ReadonlyArray<Record<string, unknown>>, dateKey: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const sw = seasonWeekOfIso(r?.[dateKey]);
    const s = sw ? sw.season : finiteOrNull(r?.season);
    if (s != null) out.push(s);
  }
  return unionSeasons(out);
}

/** Returns a COPY of a TT_Games row with season, Week (string) and week (number) derived from `Date`. */
export function withFixtureWeekTT<T extends Record<string, unknown>>(
  row: T
): T & { season: number | null; Week: string | null; week: number | null } {
  const sw = seasonWeekOfIso(row?.Date);
  if (sw) return { ...row, season: sw.season, Week: String(sw.week), week: sw.week };
  const season = finiteOrNull(row?.season);
  const week = finiteOrNull(row?.Week ?? row?.week);
  return { ...row, season, Week: week == null ? null : String(week), week };
}

/** Same for soccer_games rows: season and week from `Date`; completed_* are left as stored. */
export function withFixtureWeekSoccer<T extends Record<string, unknown>>(
  row: T
): T & { season: number | null; week: number | null } {
  const sw = seasonWeekOfIso(row?.Date);
  if (sw) return { ...row, season: sw.season, week: sw.week };
  return { ...row, season: finiteOrNull(row?.season), week: finiteOrNull(row?.week) };
}

export const mapFixtureWeekTT = <T extends Record<string, unknown>>(rows: readonly T[]) =>
  rows.map(withFixtureWeekTT);
export const mapFixtureWeekSoccer = <T extends Record<string, unknown>>(rows: readonly T[]) =>
  rows.map(withFixtureWeekSoccer);

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
