// Pure weekly "games added" and "games completed" counts for soccer_games.
// The two sets are independent and are not correlated.
//
// Added     = the fixture Date (SoccerData column A, the date the fixture was
//            added), bucketed with the unified Wed->Tue season/week rule
//            (soccerWeeks.ts -> season.ts).
// Completed = completed_date (SoccerData last column "Finalised Time", falling
//            back to Completion Times for older fixtures), bucketed with the
//            SAME rule by its own date. Stored completed_season/completed_week
//            are only a fallback when the completed date is unusable.
// A game counts once per fixture (not half-games).
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

export type AddedVsCompletedWeek = {
  week: number;
  /** Games whose added date (column A) falls in this week. */
  added: number;
  /** Games whose completed date falls in this week. */
  completed: number;
};

export type AddedVsCompleted = {
  weeks: AddedVsCompletedWeek[];
  byWeek: Record<number, AddedVsCompletedWeek>;
  totals: { added: number; completed: number };
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
 * Per-week added and completed counts for one season. Each set is counted on
 * its own date, so a game completed in a different week from the one it was
 * added in counts in both weeks' own column and nothing links the two.
 */
export function buildAddedVsCompleted(
  rows: readonly SoccerCompletedRow[],
  season: number
): AddedVsCompleted {
  const byWeek: Record<number, AddedVsCompletedWeek> = {};
  const slot = (week: number) => (byWeek[week] ??= { week, added: 0, completed: 0 });
  for (const r of rows) {
    const addedWeek = soccerWeekFor(r);
    if (soccerSeasonFor(r) === season && addedWeek !== null) slot(addedWeek).added++;
    const done = completedSeasonWeek(r);
    if (done && done.season === season) slot(done.week).completed++;
  }
  const weeks = Object.values(byWeek).sort((a, b) => a.week - b.week);
  const totals = { added: 0, completed: 0 };
  for (const w of weeks) {
    totals.added += w.added;
    totals.completed += w.completed;
  }
  return { weeks, byWeek, totals };
}
export type FlowSeriesPoint = AddedVsCompletedWeek & {
  /** Cumulative added minus cumulative completed up to and including this week. */
  backlog: number;
};

/**
 * Contiguous weekly series (first to last week with any activity, empty weeks
 * as 0/0) with a running "added not yet completed" balance. The balance is a
 * count difference only; it does not pair individual games and can go negative
 * when more games are completed than were added so far.
 */
export function buildFlowSeries(flow: AddedVsCompleted): FlowSeriesPoint[] {
  if (flow.weeks.length === 0) return [];
  const first = flow.weeks[0].week;
  const last = flow.weeks[flow.weeks.length - 1].week;
  const out: FlowSeriesPoint[] = [];
  let backlog = 0;
  for (let week = first; week <= last; week++) {
    const w = flow.byWeek[week] ?? { week, added: 0, completed: 0 };
    backlog += w.added - w.completed;
    out.push({ week, added: w.added, completed: w.completed, backlog });
  }
  return out;
}

/** completed / added as a percentage rounded to 1 decimal; null when nothing was added. */
export function completionRate(added: number, completed: number): number | null {
  if (!(added > 0)) return null;
  return Math.round((completed / added) * 1000) / 10;
}