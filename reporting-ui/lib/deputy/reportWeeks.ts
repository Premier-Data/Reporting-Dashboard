// Season / week / area rules for Deputy API shift data (pure, no I/O).
//
// Thin wrapper over the single shared rule in lib/analytics/season.ts. SQL twin:
// migration 005 (deputy_season_of, deputy_season_week_of) used by 008's
// deputy_report_week_of. Pinned by the fixture list in reportWeeks.test.ts.
import { seasonStart, seasonEnd, seasonWeekOfIso } from "@/lib/analytics/season";

/**
 * Fetch lower bound only (twin of SQL deputy_report_start_date()). Deputy
 * history starts 2025-03-11, so this is "all history" in practice.
 */
export const DEPUTY_HISTORY_START = "2025-01-01";

const toIso = (d: Date): string => d.toISOString().slice(0, 10);

/** Season label of a yyyy-mm-dd date. NaN when the date is invalid. */
export function deputySeasonOf(iso: string): number {
  return seasonWeekOfIso(iso)?.season ?? NaN;
}

/** Week number within the season (1-based, season 2025 has 53). NaN when invalid. */
export function deputyWeekOf(iso: string): number {
  return seasonWeekOfIso(iso)?.week ?? NaN;
}

export interface DeputySeasonWindow {
  season: number;
  from: string;
  to: string;
}

/**
 * One inclusive date window per season from the one containing
 * DEPUTY_HISTORY_START up to the season containing `todayIso`. The first
 * window starts at DEPUTY_HISTORY_START.
 */
export function deputySeasonWindows(todayIso: string): DeputySeasonWindow[] {
  const first = deputySeasonOf(DEPUTY_HISTORY_START);
  const last = Math.max(first, deputySeasonOf(todayIso));
  const out: DeputySeasonWindow[] = [];
  for (let s = first; s <= last; s++) {
    const start = toIso(seasonStart(s));
    out.push({
      season: s,
      from: start < DEPUTY_HISTORY_START ? DEPUTY_HISTORY_START : start,
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
