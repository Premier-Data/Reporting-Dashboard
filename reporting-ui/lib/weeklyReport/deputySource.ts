// Weekly Report: choose where the Deputy shift rows come from.
//
// The Postgres view public.weekly_report_shifts (migrations/005) serves Excel
// rows for season < 2027 and Deputy API rows from season 2027 Week 1. Until the
// user has run that migration the view does not exist, so every failure falls
// back to the Excel-loaded deputy_shifts rows already passed in as a prop.

type Row = Record<string, unknown>;

export const WEEKLY_REPORT_VIEW = "weekly_report_shifts";
export const API_CUTOVER_SEASON = 2027;
const PAGE = 1000;

export type DeputySource = "view" | "fallback";

export interface PageResult {
  data: Row[] | null;
  error: { code?: string; message?: string; status?: number } | null;
}

/**
 * Reads every page of the view (Supabase caps a response at 1000 rows). Returns
 * null if any page errors, so the caller falls back instead of showing a
 * partially loaded report.
 */
export async function fetchAllViewRows(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult>
): Promise<Row[] | null> {
  const all: Row[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error || !data) return null;
    for (const r of data) all.push(r);
    if (data.length < PAGE) return all;
    from += PAGE;
  }
}

/** The rows the report should use, and which source they came from. */
export function pickDeputyRows(viewRows: Row[] | null, fallback: Row[]): { rows: Row[]; source: DeputySource } {
  // An empty view means the migration ran but returned nothing (or RLS hid it):
  // keep today's behaviour rather than render an empty report.
  if (viewRows && viewRows.length > 0) return { rows: viewRows, source: "view" };
  return { rows: fallback, source: "fallback" };
}

/** True when the error means the view has not been created yet. */
export function isViewMissing(error: { code?: string; status?: number } | null | undefined): boolean {
  return !!error && (error.code === "PGRST205" || error.status === 404);
}

// ── TS twin of the SQL helpers in migrations/005 (used for cross-checking) ──
// Mirrors public.deputy_season_roll_date / deputy_season_of / deputy_season_week_of
// using day-number arithmetic like the SQL does. Test: weeklyReportSeason.test.ts.

const DAY_MS = 86400000;
const toDay = (iso: string): number => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);

/** Day number (days since epoch) of the Wednesday on-or-before 1 Oct of `calYear`. */
export function sqlSeasonRollDay(calYear: number): number {
  const oct1 = Math.floor(Date.UTC(calYear, 9, 1) / DAY_MS);
  const dow = (((oct1 + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4); 0=Sun
  return oct1 - ((dow - 3 + 7) % 7);
}

export function sqlSeasonOf(iso: string): number {
  const day = toDay(iso);
  const y = new Date(day * DAY_MS).getUTCFullYear();
  return day >= sqlSeasonRollDay(y) ? y + 1 : y;
}

export function sqlSeasonWeekOf(iso: string): number {
  const day = toDay(iso);
  return Math.floor((day - sqlSeasonRollDay(sqlSeasonOf(iso) - 1)) / 7) + 1;
}
