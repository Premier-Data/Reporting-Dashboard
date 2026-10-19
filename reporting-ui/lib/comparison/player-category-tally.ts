// Player Category Volume (analyst vs master) — a pure VOLUME reconciliation
// per player, per FOOTBALL category group (Passing / Offensive / Defensive /
// Goalkeeper / Other).
//
// This is deliberately DIFFERENT from the Golden Player Accuracy cards
// (`computePlayerAccuracy`), which are EXACT-match, event-level accuracy. Here
// we ask only: for each player, how many events did the analyst code in each
// category versus how many the master coded — as one number per side —
// regardless of which specific sub-stat, and regardless of whether any event
// matched in time/player. The metric is an absolute-difference percentage
// (same philosophy as `player-accuracy.ts`) applied at the category level.
//
// FOOTBALL only, mirroring `player-accuracy.ts` (AFL is out of scope).
//
// Reuse-only: classification (`bumpFootball`), derivation (`deriveFootball`),
// category membership (`FOOTBALL_GROUPS`) and the zeroed counts
// (`initFootballCounts`) are imported from `player-accuracy.ts` and never
// re-implemented, so the two sections can never drift on which stat belongs to
// which category.

import {
  initFootballCounts,
  bumpFootball,
  deriveFootball,
  FOOTBALL_GROUPS,
  type FootballCounts,
} from "./player-accuracy";
import type { Instance } from "./xml-compare";

// Display order = the existing FOOTBALL_GROUPS order.
export const CATEGORY_KEYS = [
  "passing",
  "offensive",
  "defensive",
  "goalkeeper",
  "other",
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

// Labels read straight from the group defs so they never drift from
// `player-accuracy.ts`.
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  passing: FOOTBALL_GROUPS.passing.label,
  offensive: FOOTBALL_GROUPS.offensive.label,
  defensive: FOOTBALL_GROUPS.defensive.label,
  goalkeeper: FOOTBALL_GROUPS.goalkeeper.label,
  other: FOOTBALL_GROUPS.other.label,
};

export type CategoryCell = {
  a: number; // analyst count
  m: number; // master count
  pct: number | null; // (m - |a - m|) / m, floored 0, capped 1; null when m===0
};

/**
 * The pure metric: absolute-difference accuracy of an analyst count `a`
 * against a master count `m`, at the category-volume level.
 *
 *   pct = (m - |a - m|) / m, floored at 0 and capped at 1 (100%).
 *
 * `m === 0 ⇒ pct: null` (no master events = no data to compare; a 0/0 is NOT
 * 100%, it's "no data" — the same rule the Golden module uses, rendered `—`).
 *
 * Note on the cap: `Math.min(1, …)` is UNREACHABLE for non-negative counts —
 * `(m − |a − m|)/m > 1` would require a negative `a`, which counts never
 * produce. It is retained only so the `[0,1]` contract holds for any numeric
 * input. `Math.max(0, …)` is the load-bearing clamp (it floors over-counts
 * to 0).
 */
export function categoryAccuracy(a: number, m: number): CategoryCell {
  if (m === 0) return { a, m, pct: null };
  const raw = (m - Math.abs(a - m)) / m;
  const pct = Math.max(0, Math.min(1, raw));
  return { a, m, pct };
}

// Sum one group's derived part keys into a single number.
function categoryTotal(derived: FootballCounts, key: CategoryKey): number {
  const group = FOOTBALL_GROUPS[key];
  return group.parts.reduce((sum, p) => sum + (derived[p.key] ?? 0), 0);
}

export type PlayerCategoryRow = {
  key: string; // "team|number" (lowercased team, number ?? "?")
  team: string; // canonical team (original case as first seen)
  number: number | null; // jersey number, or null
  display: string; // `${team} - #${number ?? "?"}`
  analystOnly: boolean; // appears only on the analyst side within scope
  cells: Record<CategoryKey, CategoryCell>;
};

/**
 * Per-player, per-category VOLUME tally over already-scoped master + analyst
 * instances. One row per player (the union of players across BOTH sides);
 * each row carries a `{ a, m, pct }` cell per category.
 *
 * Relationship to the Accuracy page's "Player stats" table (`playerTable`):
 * this function REPRODUCES that table's KEY shape (`"team|number"`,
 * lowercased team, `number ?? "?"`), DISPLAY string (`` `${team} - #${n ??
 * "?"}` ``) and SORT comparator (analystOnly-last → team localeCompare →
 * `number ?? 999`), so whenever a player appears in both tables it is keyed,
 * labelled and ordered identically. It is NOT a claim that the two tables list
 * the same players: `playerTable` sources from `result.rows` (a second
 * `canonicaliseTeams` pass) and filters with `relevant()`, while this section
 * is handed the SAME scoped `canonical.*` instances the Golden cards use and
 * filters with the five-displayed-category drop rule below — so the row SETS
 * may legitimately differ in both directions. The scope priority is agreement
 * with the Golden cards (same instances), NOT lockstep with `playerTable`.
 *
 * This function does NOT call `canonicaliseTeams` — the page already
 * canonicalised once; re-canonicalising a subset is the very bug
 * `canonicaliseTeams` guards against.
 */
export function computePlayerCategoryTally(
  masterInstances: Instance[],
  analystInstances: Instance[]
): PlayerCategoryRow[] {
  type Entry = {
    team: string;
    number: number | null;
    master: FootballCounts;
    analyst: FootballCounts;
    inMaster: boolean;
    inAnalyst: boolean;
  };
  const acc = new Map<string, Entry>();

  // Create/return the entry for an instance. The MAP KEY lowercases `team`
  // while the stored `team` (used for display and the localeCompare sort)
  // keeps the first-seen case — matching `playerTable` exactly. This is safe
  // only because `canonicaliseTeams` has already normalised teams to canonical
  // case-uniform `Home`/`Away` upstream, so the lowercased key never collides
  // across genuinely different teams. A future caller passing NON-canonical
  // (mixed-case) instances must canonicalise first.
  const ensure = (i: Instance): Entry => {
    const key = `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}`;
    let e = acc.get(key);
    if (!e) {
      e = {
        team: i.team,
        number: i.playerNumber,
        master: initFootballCounts(),
        analyst: initFootballCounts(),
        inMaster: false,
        inAnalyst: false,
      };
      acc.set(key, e);
    }
    return e;
  };

  for (const i of masterInstances) {
    const e = ensure(i);
    e.inMaster = true;
    bumpFootball(e.master, i.stat.toLowerCase());
  }
  for (const i of analystInstances) {
    const e = ensure(i);
    e.inAnalyst = true;
    bumpFootball(e.analyst, i.stat.toLowerCase());
  }

  const rows: PlayerCategoryRow[] = [];
  for (const [key, e] of acc) {
    const dm = deriveFootball(e.master);
    const da = deriveFootball(e.analyst);

    const cells = {} as Record<CategoryKey, CategoryCell>;
    let masterSum = 0;
    let analystSum = 0;
    for (const ck of CATEGORY_KEYS) {
      const mTot = categoryTotal(dm, ck);
      const aTot = categoryTotal(da, ck);
      masterSum += mTot;
      analystSum += aTot;
      cells[ck] = categoryAccuracy(aTot, mTot);
    }

    // Drop rule (the ONLY deviation from the union): drop a row iff the sum of
    // all five DISPLAYED category totals is 0 on BOTH sides — i.e. it would be
    // an all-`0 / 0` / `—` wall. This is deterministic and unit-testable. It
    // is intentionally NOT `playerTable`'s `relevant()` filter (which sums a
    // different key set): a player coded ONLY in GK / blocks / throw-ins /
    // cards / offsides is KEPT here (they feed a displayed category) though
    // `relevant()` would drop them; a player coded ONLY in ball recoveries /
    // ground-or-aerial duels / headers is DROPPED here (they map to no
    // displayed category) though `relevant()` would keep them.
    if (masterSum === 0 && analystSum === 0) continue;

    rows.push({
      key,
      team: e.team,
      number: e.number,
      display: `${e.team} - #${e.number ?? "?"}`,
      analystOnly: e.inAnalyst && !e.inMaster,
      cells,
    });
  }

  // Sort — byte-for-byte the `playerTable` comparator: analystOnly last, then
  // the `a.team !== b.team` short-circuit before localeCompare, then
  // `(number ?? 999)`.
  rows.sort((a, b) => {
    if (a.analystOnly !== b.analystOnly) return a.analystOnly ? 1 : -1;
    if (a.team !== b.team) return a.team.localeCompare(b.team);
    return (a.number ?? 999) - (b.number ?? 999);
  });

  return rows;
}
