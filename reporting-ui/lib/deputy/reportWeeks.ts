// Season / week / area rules for Deputy API shift data (pure, no I/O).
//
// TS twin of the SQL in migrations/007_deputy_api_shifts_all_seasons.sql
// (public.deputy_report_start_date, deputy_season2026_week1_start,
// deputy_report_week_of). Both are pinned by the same fixture list in
// reportWeeks.test.ts. Keep the constants and rules in lockstep with the SQL.
import { seasonOfDate, seasonStart, seasonEnd } from "@/lib/analytics/season";

/** API timesheets before this date are never reported (2025 is not a season). */
export const DEPUTY_REPORT_START_DATE = "2026-01-01";

/**
 * Season 2026 is SHEET-DEFINED: week 0 = everything before this date and week 1
 * starts on this Wednesday. Later seasons follow the Wed->Tue formula.
 */
export const SEASON_2026_WEEK1_START = "2026-03-25";

const DAY_MS = 86400000;
const toDate = (iso: string): Date => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const toIso = (d: Date): string => d.toISOString().slice(0, 10);

/** Season label of a yyyy-mm-dd date (same roll rule as lib/analytics/season). */
export function deputySeasonOf(iso: string): number {
  return seasonOfDate(toDate(iso));
}

/** Week number within the season (season 2026 is sheet-defined, see above). */
export function deputyWeekOf(iso: string): number {
  const d = toDate(iso);
  const season = seasonOfDate(d);
  if (season === 2026) {
    const w1 = toDate(SEASON_2026_WEEK1_START);
    if (d < w1) return 0;
    return Math.floor((d.getTime() - w1.getTime()) / DAY_MS / 7) + 1;
  }
  return Math.floor((d.getTime() - seasonStart(season).getTime()) / DAY_MS / 7) + 1;
}

export interface DeputySeasonWindow {
  season: number;
  from: string;
  to: string;
}

/**
 * One inclusive date window per season from 2026 up to the season containing
 * `todayIso`. The first window starts at DEPUTY_REPORT_START_DATE.
 */
export function deputySeasonWindows(todayIso: string): DeputySeasonWindow[] {
  const last = Math.max(2026, deputySeasonOf(todayIso));
  const out: DeputySeasonWindow[] = [];
  for (let s = 2026; s <= last; s++) {
    const start = toIso(seasonStart(s));
    out.push({
      season: s,
      from: start < DEPUTY_REPORT_START_DATE ? DEPUTY_REPORT_START_DATE : start,
      to: toIso(seasonEnd(s)),
    });
  }
  return out;
}

/**
 * Report area for a Deputy operational unit name. Blank, "0" or all-digit names
 * (deputy-read falls back to the raw unit id when a unit cannot be resolved)
 * become "Unassigned". Otherwise the deputy_area_map label, else the unit name.
 */
export function toAreaName(
  unitName: string | null | undefined,
  areaMap: Map<string, string>
): string {
  const name = (unitName ?? "").trim();
  if (!name || /^\d+$/.test(name)) return "Unassigned";
  const mapped = (areaMap.get(name) ?? "").trim();
  return mapped || name;
}
