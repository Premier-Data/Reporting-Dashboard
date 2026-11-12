// Shared soccer week bucketing (pure). Used by the Reporting > TT Games >
// Soccer card (components/SoccerGames.tsx) and the Operations Games tab.
//
// Rule (unified, see season.ts): weeks run Wed->Tue, season N starts on the
// Wednesday on or before 1 Oct of year N-1 and that day is Week 1. Season and
// week come straight from the fixture Date. The stored soccer_games.season /
// week columns are only a fallback when the Date is missing or invalid.
import { seasonWeekOfIso } from "./season";

function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Week number for one soccer row, or null if it cannot be bucketed. */
export function soccerWeekFor(r: { Date?: unknown; week?: unknown }): number | null {
  return seasonWeekOfIso(r.Date)?.week ?? finite(r.week);
}

/** Season for one soccer row, or null if it cannot be determined. */
export function soccerSeasonFor(r: { Date?: unknown; season?: unknown }): number | null {
  return seasonWeekOfIso(r.Date)?.season ?? finite(r.season);
}
