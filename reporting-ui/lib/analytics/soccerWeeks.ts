// Shared soccer week bucketing (pure). Used by the Reporting > TT Games >
// Soccer card (components/SoccerGames.tsx) and the Operations Games tab.
//
// Rule: soccer weeks follow the TT/Deputy season. Week 1 starts on the
// Wednesday on/before the earliest TT Week 1 date of that season; each week is
// Wed->Tue. Dates before that Wednesday are Week 0 (pre-season). Only when a
// season has no TT anchor (or the row has no valid date) is the stored
// soccer_games.week (October formula) used as a fallback.

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

type Loose = Record<string, unknown>;

/** season -> UTC ms of the Wednesday that starts Week 1. */
export function buildWeekOneAnchors(ttRows: readonly Loose[]): Record<number, number> {
  const min: Record<number, string> = {};
  for (const r of ttRows ?? []) {
    const s = Number(r.season);
    const w = Number(r.week ?? r.Week);
    const iso = String(r.Date ?? "").slice(0, 10);
    if (!Number.isFinite(s) || w !== 1 || !ISO.test(iso)) continue;
    if (!min[s] || iso < min[s]) min[s] = iso;
  }
  const out: Record<number, number> = {};
  for (const [s, iso] of Object.entries(min)) {
    const d = new Date(`${iso}T00:00:00Z`);
    out[Number(s)] = d.getTime() - ((d.getUTCDay() - 3 + 7) % 7) * DAY;
  }
  return out;
}

/** Week number for one soccer row, or null if it cannot be bucketed. */
export function soccerWeekFor(
  r: { season?: unknown; Date?: unknown; week?: unknown },
  anchors: Record<number, number>
): number | null {
  const anchor = anchors[Number(r.season)];
  const iso = String(r.Date ?? "").slice(0, 10);
  if (anchor != null && ISO.test(iso)) {
    const ms = new Date(`${iso}T00:00:00Z`).getTime();
    return ms < anchor ? 0 : Math.floor((ms - anchor) / (7 * DAY)) + 1;
  }
  const w = Number(r.week);
  return Number.isFinite(w) ? w : null;
}
