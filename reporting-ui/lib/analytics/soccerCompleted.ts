// Pure "fixtures put in vs completed" weekly counts for soccer_games.
//
// Put in   = the fixture Date (SoccerData column A), bucketed with the unified
//            Wed->Tue season/week rule (soccerWeeks.ts -> season.ts).
// Completed = completed_date (Completion Times "Fixture Complete Time"),
//            bucketed with the SAME rule, independently of the put-in week.
//            Stored completed_season/completed_week are only a fallback when
//            the completed date is unusable.
// A game counts once per fixture (not half-games), so 20 put in / 18 completed
// reads as whole fixtures.
import { seasonWeekOfIso } from "./season";
import { soccerSeasonFor, soccerWeekFor } from "./soccerWeeks";

export type SoccerCompletedRow = {
  Date?: string | null;
  season?: number | string | null;
  week?: number | string | null;
  completed_date?: string | null;
  completed_season?: number | string | null;
  completed_week?: number | string | null;
};

export type PutInVsCompletedWeek = {
  week: number;
  /** Fixtures whose put-in date falls in this week. */
  putIn: number;
  /** Fixtures whose COMPLETED date falls in this week (any put-in week). */
  completed: number;
  /** Of this week's put-in fixtures, how many were completed in this same week. */
  completedSameWeek: number;
  /** Of this week's put-in fixtures, how many have no completed date. */
  notCompleted: number;
};

export type PutInVsCompleted = {
  weeks: PutInVsCompletedWeek[];
  byWeek: Record<number, PutInVsCompletedWeek>;
  totals: { putIn: number; completed: number; completedSameWeek: number; notCompleted: number };
};

/** yyyy-mm-dd (or ISO datetime) -> dd/mm/yyyy; en dash when missing or invalid. */
export function isoToDmy(v: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "\u2013";
}

function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Season + week of the completed date, or null when the game has none. */
export function completedSeasonWeek(
  r: SoccerCompletedRow
): { season: number; week: number } | null {
  const sw = seasonWeekOfIso(r.completed_date);
  if (sw) return sw;
  if (r.completed_date) return null; // a date was given but is not a real date
  const season = finite(r.completed_season);
  const week = finite(r.completed_week);
  return season !== null && week !== null ? { season, week } : null;
}

/**
 * Per-week put-in and completed counts for one season. A completed game counts
 * in the season/week of its completed date, so a fixture put in during the last
 * week of season N and completed in week 1 of season N+1 counts as completed in N+1.
 */
export function buildPutInVsCompleted(
  rows: readonly SoccerCompletedRow[],
  season: number
): PutInVsCompleted {
  const byWeek: Record<number, PutInVsCompletedWeek> = {};
  const slot = (week: number) =>
    (byWeek[week] ??= { week, putIn: 0, completed: 0, completedSameWeek: 0, notCompleted: 0 });
  for (const r of rows) {
    const putSeason = soccerSeasonFor(r);
    const putWeek = soccerWeekFor(r);
    const done = completedSeasonWeek(r);
    if (putSeason === season && putWeek !== null) {
      const s = slot(putWeek);
      s.putIn++;
      if (!done) s.notCompleted++;
      else if (done.season === season && done.week === putWeek) s.completedSameWeek++;
    }
    if (done && done.season === season) slot(done.week).completed++;
  }
  const weeks = Object.values(byWeek).sort((a, b) => a.week - b.week);
  const totals = { putIn: 0, completed: 0, completedSameWeek: 0, notCompleted: 0 };
  for (const w of weeks) {
    totals.putIn += w.putIn;
    totals.completed += w.completed;
    totals.completedSameWeek += w.completedSameWeek;
    totals.notCompleted += w.notCompleted;
  }
  return { weeks, byWeek, totals };
}
