// Pure, I/O-free helpers for the Round-Summary board. This is the TESTED
// REFERENCE implementation (see roundSummary.test.ts). The Worker
// (playhq-worker/src/index.ts) keeps behaviourally identical INLINE copies of
// these same functions — it can't import this module and the task forbids
// adding a test runner to the Worker, so this suite pins the behaviour and the
// Worker's copies are reviewed against it. Keep the two copies in sync.
//
// Nothing here touches the network, `env`, or `caches`; every function is a
// pure transform so it can be unit-tested directly.

import type { PushLogEntry } from "@/lib/api/playhq";

// Minimal structural shape selectLatestRound / the round grouping read. It is
// satisfied by the frontend's typed PlayHqGame AND by the Worker's loosely
// typed Array<Record<string, unknown>> (cast), so the SAME function body
// type-checks on both sides. See design §1.9.
export type RoundInputGame = {
  round?: { name?: string | null } | null;
  schedule?: { date?: string | null; time?: string | null } | null;
};

// Lookahead for the "imminent" tier — one match-day slot. A round whose first
// fixture is within this window of `now` can be rolled forward to even before
// its first bounce. See design §1.7.
const LOOKAHEAD_MS = 6 * 60 * 60 * 1000;

// NTFL = Australia/Darwin = UTC+09:30, no DST. Byte-identical in behaviour to
// the Worker's exported scheduledKickoffMs (which this module cannot import).
// If a non-Darwin / DST-observing grade is ever added, the fix is localised to
// this offset (per the Worker's existing code comment).
const NTFL_UTC_OFFSET = "+09:30";

// Kickoff epoch (ms) for a grade-feed schedule `{ date, time }` (venue-local),
// or null when the date is missing / unparseable.
export function scheduledKickoffMs(
  schedule: { date?: string | null; time?: string | null } | null | undefined
): number | null {
  const date = schedule?.date;
  if (!date) return null;
  const time = schedule.time || "00:00:00";
  const ms = Date.parse(`${date}T${time}${NTFL_UTC_OFFSET}`);
  return Number.isNaN(ms) ? null : ms;
}

// First integer in a round name, or null when there is none ("Grand Final").
// NOT the legacy page.tsx `9999` sentinel — see design §1.2.
export function roundNumOf(name: string | null | undefined): number | null {
  const m = String(name ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Short, readable round label. Branch order matches app/push-log/page.tsx
// EXACTLY: prelim/semi/qualif/elim are tested before any generic "final" so a
// "Preliminary Final" is not mis-tagged "GF".
export function shortRound(round: string | undefined): string {
  const n = (round ?? "").trim();
  if (!n) return "";
  const m = n.match(/round\s*(\d+)/i);
  if (m) return `R${m[1]}`;
  if (/grand\s*final/i.test(n)) return "GF";
  if (/prelim/i.test(n)) return "PF";
  if (/semi/i.test(n)) return "SF";
  if (/qualif/i.test(n)) return "QF";
  if (/elim/i.test(n)) return "EF";
  return n;
}

// Normalise a REST status for display: "" / "NULL" mean the pre-FINAL state the
// NTFL feed calls UPCOMING; anything else is passed through (trimmed/upper).
export function displayStatus(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (s === "" || s.toUpperCase() === "NULL") return "UPCOMING";
  return s.toUpperCase();
}

// Strip the grade suffix from a team name — same regex the push pipeline uses
// ( `.replace(/\s+(men|women)\s+premier.*$/i, "").trim()` ). The `(n ?? "?")`
// fallback matches the push pipeline exactly.
export function stripGradeName(name: string | null | undefined): string {
  return (name ?? "?").replace(/\s+(men|women)\s+premier.*$/i, "").trim();
}

// Presentational class-mapper for a status chip. FINAL → emerald;
// IN_PROGRESS/LIVE → amber/pulse (a DEFENSIVE fallthrough that never fires for
// the NTFL grade feed, which only emits UPCOMING/FINAL — kept + tested so the
// helper is correct if ever fed a live status); everything else → slate.
export function statusChip(status: string): string {
  const s = String(status ?? "").toUpperCase();
  if (s === "FINAL") return "bg-emerald-500/15 text-emerald-300";
  if (s === "IN_PROGRESS" || s === "LIVE")
    return "animate-pulse bg-amber-500/15 text-amber-300";
  return "bg-slate-500/15 text-slate-300";
}

// Ordering of rounds (design §1.7 step 3): numbered rounds order BEFORE
// unnumbered ones; two numbered by roundNum; two unnumbered by name (locale
// compare). Never compares null as a number — the hasNum flag decides
// placement. "Highest" = last in this order; "smallest" = first.
export type RoundKey = { roundName: string; roundNum: number | null };

export function compareRounds(a: RoundKey, b: RoundKey): number {
  const aHas = a.roundNum !== null;
  const bHas = b.roundNum !== null;
  if (aHas && bHas) return (a.roundNum as number) - (b.roundNum as number);
  if (aHas && !bHas) return -1; // numbered before unnumbered
  if (!aHas && bHas) return 1;
  return a.roundName.localeCompare(b.roundName); // two unnumbered: by name
}

type RoundAgg = {
  roundName: string;
  roundNum: number | null;
  hasNum: boolean;
  earliestKickoff: number | null;
};

// Group games by round name and compute, per round, its number and the
// earliest (min) kickoff epoch among its dated fixtures.
function aggregateRounds(games: RoundInputGame[]): RoundAgg[] {
  const byName = new Map<string, RoundAgg>();
  for (const game of games) {
    const roundName = game.round?.name ?? "";
    let agg = byName.get(roundName);
    if (!agg) {
      const roundNum = roundNumOf(roundName);
      agg = {
        roundName,
        roundNum,
        hasNum: roundNum !== null,
        earliestKickoff: null,
      };
      byName.set(roundName, agg);
    }
    const ms = scheduledKickoffMs(game.schedule);
    if (ms !== null && (agg.earliestKickoff === null || ms < agg.earliestKickoff)) {
      agg.earliestKickoff = ms;
    }
  }
  return Array.from(byName.values());
}

// Pick the highest round (per compareRounds) from a candidate list.
function highest(rounds: RoundAgg[]): RoundAgg | null {
  let best: RoundAgg | null = null;
  for (const r of rounds) {
    if (best === null || compareRounds(r, best) > 0) best = r;
  }
  return best;
}

// Pick the smallest round (per compareRounds) from a candidate list.
function smallest(rounds: RoundAgg[]): RoundAgg | null {
  let best: RoundAgg | null = null;
  for (const r of rounds) {
    if (best === null || compareRounds(r, best) < 0) best = r;
  }
  return best;
}

// THE latest-round rule (design §1.7). Three tiers — started → imminent →
// first-upcoming — then an undated fallback. Returns the chosen round's name +
// number, or null when there are no games.
export function selectLatestRound(
  games: RoundInputGame[],
  nowMs: number
): RoundKey | null {
  const rounds = aggregateRounds(games);
  if (rounds.length === 0) return null;

  const dated = rounds.filter((r) => r.earliestKickoff !== null);

  // Tier A — started: highest round whose earliest kickoff <= now.
  const started = dated.filter((r) => (r.earliestKickoff as number) <= nowMs);
  const tierA = highest(started);
  if (tierA) return { roundName: tierA.roundName, roundNum: tierA.roundNum };

  // Tier B — imminent: highest round whose earliest kickoff <= now + lookahead.
  const imminent = dated.filter(
    (r) => (r.earliestKickoff as number) <= nowMs + LOOKAHEAD_MS
  );
  const tierB = highest(imminent);
  if (tierB) return { roundName: tierB.roundName, roundNum: tierB.roundNum };

  // Tier C — first upcoming: smallest round that has any dated fixture.
  const tierC = smallest(dated);
  if (tierC) return { roundName: tierC.roundName, roundNum: tierC.roundNum };

  // Undated fallback: every round is date-less → highest by compareRounds.
  const fallback = highest(rounds);
  return fallback
    ? { roundName: fallback.roundName, roundNum: fallback.roundNum }
    : null;
}

// Build a latest-push-per-fixture index from the push log (design §1.8). Keys
// each entry by its full-UUID playhqId (empty ids skipped), keeping the entry
// with the maximum numeric ts (Date.parse); ties keep the first seen.
export function indexLatestPushes(
  entries: PushLogEntry[]
): Map<string, PushLogEntry> {
  const index = new Map<string, PushLogEntry>();
  for (const entry of entries) {
    const id = String(entry?.playhqId ?? "");
    if (!id) continue;
    const prev = index.get(id);
    if (!prev) {
      index.set(id, entry);
      continue;
    }
    const tsNew = Date.parse(entry.ts);
    const tsPrev = Date.parse(prev.ts);
    const nNew = Number.isNaN(tsNew) ? -Infinity : tsNew;
    const nPrev = Number.isNaN(tsPrev) ? -Infinity : tsPrev;
    if (nNew > nPrev) index.set(id, entry);
  }
  return index;
}
