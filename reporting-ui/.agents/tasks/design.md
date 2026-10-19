# Player Category Volume (analyst vs master) — Requirements & Design

## Revision note

This is a REVISION (second review cycle). The CURRENT on-disk review
`.agents/tasks/design-review.json` (verdict `CHANGES_REQUESTED`, 0 HIGH /
1 MEDIUM / 3 NIT) and its review doc `.agents/tasks/design-doc-review.md` review
THIS player-category-tally design. Every MEDIUM and NIT finding is addressed
below and reflected inline in the requirements and design. See "Part 3 —
Responses to design review" at the end: Part 3A answers the current review;
Part 3B retains the answers to the prior cycle's review for history.

---

# Part 1 — Requirements

## Summary

On `app/accuracy-compare/page.tsx`, below the existing "Golden Player Accuracy"
cards, add a new section: a per-player, per-category VOLUME tally that compares
the analyst's coded counts against the master's counts, grouped by the existing
FOOTBALL category groups (Passing, Offensive, Defensive, Goalkeeper, Other),
ignoring the specific sub-stat breakdown and ignoring exact-event matching and
timing.

This is deliberately DIFFERENT from the Golden Player Accuracy cards above it.
Those are EXACT-match, event-level accuracy (`computePlayerAccuracy`, exact vs
master per group). The new section is a pure VOLUME reconciliation: for each
player, how many Defensive events (tackles + interceptions + clearances +
blocks) did the analyst code versus how many the master coded — as one number
per side — regardless of which specific defensive stat, and regardless of
whether any individual event matched in time/player.

FOOTBALL only, matching the existing player-accuracy module (AFL is out of
scope for this feature).

## Functional Requirements

FR1. Add a new, visually distinct section below the Golden Player Accuracy
cards on `app/accuracy-compare/page.tsx`, rendered only when `sport === "football"`
and a comparison exists (same gating as the Golden cards).

FR2. Show one row per player. Columns, in this order, are the existing
FOOTBALL_GROUPS categories: Passing, Offensive, Defensive, Goalkeeper, Other.
A leading column identifies the player (jersey number + name, mirroring the
existing "Player stats" table's player cell).

FR3. Each category cell shows BOTH:
  - the analyst count and the master count (rendered as `A / M`, e.g. `6 / 6`), and
  - an accuracy percentage computed with the player-accuracy module's philosophy:
    `pct = (master − |analyst − master|) / master`, floored at 0, capped at 1
    (100%); NULL when `master === 0`, rendered as `—` (never 100%). The cell
    renders the percentage as a WHOLE number (`Math.round(pct * 100)%`); this is
    intentional and need not match the Golden cards' percentage precision — the
    two sections measure different things, so a cosmetic difference (e.g. `67%`
    here vs a decimal there) is acceptable.

FR4. A player-category count = the sum of that group's `parts[].key` values from
`deriveFootball()` for that player on that side. Exactly as the groups define,
e.g. Defensive = `tackles + interceptions + clearances + blocks`; Passing =
`passesExThrough + totalThroughBalls + crosses`; Offensive = `shots + goals`;
Goalkeeper = `gkSaves + gkBlocks + gkCatches + gkClaims + gkPunches +
gkGoalKicks + gkThrows`; Other = `touches + carries + dribbles + throwIns +
cards + fouls + offsides`.

FR5. The row set is the UNION of players appearing on EITHER side (master or
analyst) within scope. A category present on only one side still shows
(e.g. master 3 / analyst 0 ⇒ 0%; analyst-only players show against master 0 ⇒
`—` where master is 0). The ONE carve-out: a player whose combined total across
the FIVE DISPLAYED categories (Passing, Offensive, Defensive, Goalkeeper, Other)
is 0 on BOTH sides is dropped, to suppress rows with nothing to show — see D2.4
step 7 / D3 for the precise, deterministic condition. Every player with ≥1
classified volume in one of the five displayed categories on either side is
retained.

This drop rule is NOT identical to the Player stats table's `relevant()` filter
(`page.tsx` ~line 635), and the design does not claim it is. `relevant()` sums a
DIFFERENT set of derived keys — it counts `ballRecoveries`, `groundDuels`,
`aerials` and `headers` (none of which are a displayed category here) and OMITS
GK stats, `blocks`, `throwIns`, `cards` and `offsides` (all of which ARE part of
a displayed category here, via Goalkeeper / Defensive / Other). Consequence, in
both directions:
  - A player coded ONLY in GK saves, outfield blocks, throw-ins, cards or
    offsides is KEPT here (those feed Goalkeeper / Defensive / Other) but would
    be DROPPED by `relevant()`.
  - A player coded ONLY in ball recoveries, ground/aerial duels or headers is
    DROPPED here (those map to no displayed category) but would be KEPT by
    `relevant()`.
So the new section's row set may legitimately differ from the Player stats
table's. The drop rule is chosen to exactly match what this section can SHOW
(a player with volume only in a non-displayed stat would otherwise be a wall of
`0 / 0` / `—`), which is the honest definition for this reconciliation.

FR6. The section respects the page's ACTIVE team filter (`teamFilter`:
`all` | a canonical team) and the active time range (`inRange` / `effectiveRange`),
computed from the SAME scoped master + analyst `Instance[]` the Golden cards use,
so the two sections always agree on which events are in play.

FR7. Rows are grouped/sorted by team then jersey number, reusing the key shape,
display string and sort comparator of the existing Player stats table
(`playerTable`) — players appearing only on the analyst side sort last,
consistent with that table's `analystOnly` behaviour. This is parity of the
KEY/DISPLAY/SORT MECHANICS only — NOT a claim that the two tables list the same
players. The new section sources from the SAME scoped `canonical.*` instances as
the Golden cards (NOT from `result.rows`, which is what `playerTable` uses), and
its drop rule differs from `relevant()` (see FR5), so the two row SETS may
differ. The key/display/sort reproduction guarantees that whenever a player
appears in both tables it is keyed, labelled and ordered identically. See D2.3
and D5 for the exact relationship.

FR8. The tally and the metric are extracted as PURE functions in a new module
`lib/comparison/player-category-tally.ts`, unit-testable without React/DOM,
reusing `player-accuracy.ts` exports. `page.tsx` only calls them with
already-scoped instances and renders.

## Non-Functional Requirements

NFR1. No behaviour change to `player-accuracy.ts` — it is imported only. Reuse
`initFootballCounts`, `bumpFootball`, `deriveFootball`, and `FOOTBALL_GROUPS`;
do not duplicate stat-classification logic.

NFR2. Only two files change: the new `lib/comparison/player-category-tally.ts`
(+ its test file) and `app/accuracy-compare/page.tsx`. Do not touch the Golden
computation, the comparison engine (`xml-compare.ts`), the DB, or any unrelated
file.

NFR3. No new Next.js API surface. `page.tsx` is already a client component; the
feature is client React (a `useMemo` + JSX table) plus a pure compute module.
The only Next.js imports on the page (`next/navigation`, `next/link`) are
pre-existing and unchanged, so AGENTS.md's "read the Next.js docs before using a
Next.js API" rule has nothing new to apply here. Confirmed by inspecting the
page's imports.

## Acceptance Criteria

AC1. `categoryAccuracy(6, 6)` ⇒ `{ a: 6, m: 6, pct: 1 }`.
AC2. `categoryAccuracy(4, 6)` ⇒ `{ a: 4, m: 6, pct: 2/3 }` (≈0.6667, renders "67%").
AC3. `categoryAccuracy(0, 3)` ⇒ `{ a: 0, m: 3, pct: 0 }`.
AC4. `categoryAccuracy(0, 0)` ⇒ `{ a: 0, m: 0, pct: null }` (renders `—`).
AC5. `categoryAccuracy(9, 6)` ⇒ `pct: 0.5` (over-count: `(6 − |9 − 6|)/6 = 0.5`).
AC6. `categoryAccuracy(20, 6)` ⇒ `pct: 0` (floored, not negative).
AC7. The tally for a player with master labels
   `["Interceptions","Clearances","Blocks","Tackles Successful"]` and analyst
   labels `["Interceptions","Clearances"]` yields Defensive `{ a: 2, m: 4,
   pct: 0.5 }`, and that same player's Passing is `{ a: 0, m: 0, pct: null }`
   when neither side has passing stats.
AC8. A player present only on the master side appears in the output with the
   analyst counts all 0; a player present only on the analyst side appears with
   master counts all 0.
AC8a. A player whose ONLY coded stats are goalkeeper stats (e.g. `["Save",
   "Save", "Catch"]`) — or only outfield `Blocks` — appears in the tally (it has
   Goalkeeper / Defensive volume), even though such a player would be dropped by
   the Player stats table's `relevant()` filter. The row set is defined by the
   five-category drop rule, not by `relevant()`.
AC8b. A player whose ONLY coded stats are ball recoveries, ground/aerial duels
   or headers (e.g. `["Ball Recovery","Aerial Win"]`) is DROPPED from the tally
   (those stats map to no displayed category, so both sides total 0 across the
   five categories), even though such a player WOULD appear in a
   `relevant()`-filtered Player stats table. This is the intended divergence.
AC9. Rows are sorted `analystOnly`-last, then by `team` (guarded
   `a.team !== b.team` short-circuit before `localeCompare`), then by
   `number ?? 999` — byte-for-byte the `playerTable` comparator (D2.4 step 8).
AC10. With `teamFilter` set to a single team, only that team's players appear,
   and the counts match a hand-tally of that team's scoped instances.
AC11. Changing the time range changes the counts consistently with the Golden
   cards (both read from the same scoped instance sets).
AC12. `npm run build` (or the project's type-check/lint) passes; the new unit
   test file passes.

## Out of Scope

- AFL (the module and section are FOOTBALL-only).
- Any change to the exact-match Golden Player Accuracy computation or cards.
- Any change to the comparison engine, DB schema, stored `player_accuracy`, or
  persistence.
- Event-level / timing-aware matching in the new section (it is pure volume).
- CSV export of the new section (not requested; keep scope tight).
- Team-colour theming beyond what is trivially reusable (see design D6).

---

# Part 2 — Technical Design

## Overview

The feature adds a pure compute module and one rendered table. The module
`lib/comparison/player-category-tally.ts` exposes (a) a pure metric function
`categoryAccuracy` and (b) a pure aggregator `computePlayerCategoryTally` that
takes already-scoped master + analyst `Instance[]` and returns one row per
player with per-category `{ a, m, pct }` values. `page.tsx` adds a `useMemo`
that builds these inputs from the EXACT same scoped sets the Golden cards use,
then renders a table below the Golden cards.

Stack is locked: TypeScript, React (client component, hooks), Tailwind CSS for
styling, reusing `lib/comparison/player-accuracy.ts` and types from
`lib/comparison/xml-compare.ts`. Tests use the repo's existing test runner
(see D9 — detect from config and match it). No new runtime dependencies.

## D1. Scoped instance sourcing (the integration point)

The Golden cards compute from this scope (verified in `page.tsx` ~line 2071,
the `playerAccuracy` useMemo):

```ts
const inScope = (i: Instance) =>
  inRange(i) && (teamFilter === "all" || i.team === teamFilter);
// canonical.master.filter(inScope), canonical.analyst.filter(inScope)
```

where:
- `canonical = canonicaliseTeams(master.instances, analyst.instances, tolerance, master.name)`
  (page ~line 1819) — teams relabelled to canonical `Home`/`Away`, so
  `teamFilter` holds a canonical team string (or `"all"`), and `i.team` is the
  canonical team.
- `inRange(i) => i.mid >= effectiveRange.start && i.mid <= effectiveRange.end`
  (page ~line 1811).

The new `useMemo` MUST build its two inputs with the IDENTICAL `inScope`
predicate against `canonical.master` and `canonical.analyst`, so the volume
tally and the Golden cards see exactly the same instances. Crucially, the new
section passes the SCOPED `Instance[]` directly to the pure aggregator — it does
NOT run `compareInstances` (volume reconciliation needs no pairing). This is the
key structural difference from the Golden path and is what makes it "ignore
exact-event matching".

Gating: like the Golden `useMemo`, return `null` when `!canonical ||
sport !== "football"`, and render the section only when the memo is non-null and
has at least one row.

Dependency array mirrors the Golden memo: `[canonical, sport, tolerance,
effectiveRange, teamFilter]` (with the existing `eslint-disable
react-hooks/exhaustive-deps` line, since `inRange`/`inScope` are closures — same
pattern already in the file).

## D2. New module `lib/comparison/player-category-tally.ts`

### Imports (reuse only; no behaviour change)

```ts
import {
  initFootballCounts,
  bumpFootball,
  deriveFootball,
  FOOTBALL_GROUPS,
  type FootballCounts,
} from "./player-accuracy";
import type { Instance } from "./xml-compare";
```

### Category key list

```ts
// Display order = the existing FOOTBALL_GROUPS order.
export const CATEGORY_KEYS = [
  "passing",
  "offensive",
  "defensive",
  "goalkeeper",
  "other",
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];
```

A small helper exposes the label for each, read straight from the group def so
the labels never drift from `player-accuracy.ts`:

```ts
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  passing: FOOTBALL_GROUPS.passing.label,
  offensive: FOOTBALL_GROUPS.offensive.label,
  defensive: FOOTBALL_GROUPS.defensive.label,
  goalkeeper: FOOTBALL_GROUPS.goalkeeper.label,
  other: FOOTBALL_GROUPS.other.label,
};
```

### D2.1 The pure metric `categoryAccuracy`

```ts
export type CategoryCell = {
  a: number;        // analyst count
  m: number;        // master count
  pct: number | null; // (m - |a - m|) / m, floored 0, capped 1; null when m===0
};

export function categoryAccuracy(a: number, m: number): CategoryCell {
  if (m === 0) return { a, m, pct: null };
  const raw = (m - Math.abs(a - m)) / m;
  const pct = Math.max(0, Math.min(1, raw));
  return { a, m, pct };
}
```

This is the SAME philosophy as the `player-accuracy.ts` module docstring
(absolute-difference against the master total, floored/capped), applied at the
category-volume level. `m === 0 ⇒ null` matches the "0/0 is not 100%, it's no
data" rule used throughout the Golden module (`pct: number | null`, rendered as
`—`).

Note on the cap: the `Math.min(1, …)` is UNREACHABLE for non-negative counts —
`(m − |a − m|)/m > 1` would require a negative `a`, which counts never produce.
It is retained purely so the `[0,1]` contract holds for any numeric input. The
`Math.max(0, …)` is the load-bearing clamp (it floors over-counts to 0 — AC6).

### D2.2 Per-player, per-category category totals (one side)

Compute each player's five category totals for a single side from that side's
scoped instances:

```ts
// Sum a group's deriveFootball part keys into one number.
function categoryTotal(derived: FootballCounts, key: CategoryKey): number {
  const group = FOOTBALL_GROUPS[key];
  return group.parts.reduce((sum, p) => sum + (derived[p.key] ?? 0), 0);
}
```

The per-player counts are built by running `bumpFootball` over each of a
player's stat labels into a fresh `FootballCounts`, then `deriveFootball`, then
summing each group's part keys via `categoryTotal`. This reuses the exact
classification + derivation logic the Golden cards and the Player stats table
use — no re-implementation.

### D2.3 Player keying (mirror the existing Player stats table)

The existing `playerTable` (page ~line 2163) keys players as:

```ts
const key = `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}`;
```

and displays them as `` `${team} - #${number ?? "?"}` ``, sorting master-first
then by `team` (localeCompare) then by `number ?? 999`. The new module uses the
SAME key shape and the SAME display/sort so the two tables list players in the
same shape and order.

Important distinction — the two tables source from DIFFERENT instance pipelines:
`playerTable` is built from `result.rows` (page ~line 2185), where `result =
compareInstances(canonical.*.filter(inRange), …, tolerance, master?.name)` — a
SECOND `canonicaliseTeams` pass *with* the master file name. The new section is
built directly from `canonical.master` / `canonical.analyst` filtered by
`inScope` (D1), bypassing `compareInstances`, because its priority is scope
agreement with the Golden accuracy cards (which read from the same
`canonical.*`). So the two are NOT "identical by construction"; they agree in
practice because `canonicaliseTeams` is idempotent (re-canonicalising an already
canonical set is a no-op) and `compareInstances` preserves each instance's
`team` / `playerNumber`. We deliberately do NOT switch the new section to
`result.rows` — that would couple it to the Golden cards' second-canon pipeline
and weaken the stated scope-agreement priority. A code comment in the new module
records this relationship so a future change to one table's source is a
conscious decision.

A second shape difference (also intentional): `playerTable`'s `inScope` folds in
`teamFilter` ONLY (its `result.rows` source is already range-filtered), whereas
the new section's `inScope` folds BOTH `inRange` and `teamFilter` over the raw
`canonical.*` — equivalent in the players it admits, but the new section owns its
range filter rather than inheriting it.

Null jersey number — the three-part invariant (stated once; all three mirror
`playerTable`, decision: bucket-as-unknown, NOT skip):
  - KEY bucket: `playerNumber ?? "?"` in the `"team|number"` map key.
  - SORT weight: `number ?? 999` in the comparator (so null-number players sort
    after all numbered players within a team).
  - DISPLAY: `#?` — i.e. `` `${team} - #${number ?? "?"}` ``.
Implement all three together; keying `"?"` but sorting on raw `undefined`, or
displaying a blank, would diverge from the existing table.

### D2.4 The aggregator `computePlayerCategoryTally`

```ts
export type PlayerCategoryRow = {
  key: string;             // "team|number" (lowercased team, number ?? "?")
  team: string;            // canonical team (original case as first seen)
  number: number | null;   // jersey number, or null
  display: string;          // `${team} - #${number ?? "?"}`
  analystOnly: boolean;     // appears only on analyst side within scope
  cells: Record<CategoryKey, CategoryCell>;
};

export function computePlayerCategoryTally(
  masterInstances: Instance[],
  analystInstances: Instance[],
): PlayerCategoryRow[]
```

Algorithm:
1. `const acc = new Map<string, { team; number; master: FootballCounts;
   analyst: FootballCounts; inMaster: boolean; inAnalyst: boolean }>()`.
2. An `ensure(i: Instance)` helper creates/returns the entry for
   `` `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}` ``, seeding `master`
   and `analyst` with `initFootballCounts()` and remembering `team` (original
   case, as first seen) + `number` from the first instance seen.

   Casing note: the MAP KEY lowercases `team` while the stored `team` (used for
   display and for the `localeCompare` sort in step 8) keeps the first-seen
   case. This matches `playerTable` exactly. It is safe ONLY because
   `canonicaliseTeams` has already normalised teams to canonical `Home`/`Away`
   upstream, so every instance for a team carries the same case and the
   lowercased key never collides across genuinely different teams. A future
   caller that passed NON-canonical instances (mixed-case team labels) could see
   two casings of one team collapse to a single key while the sort runs on the
   first-seen case — such a caller must canonicalise first.
3. For each master instance: `ensure(i); entry.inMaster = true;
   bumpFootball(entry.master, i.stat.toLowerCase())`.
4. For each analyst instance: same into `entry.analyst`, set `inAnalyst = true`.
   (Union of players across both sides is automatic — FR5.)
5. For each entry: `dm = deriveFootball(entry.master)`,
   `da = deriveFootball(entry.analyst)`; for each `CategoryKey`,
   `cells[key] = categoryAccuracy(categoryTotal(da, key),
   categoryTotal(dm, key))`.
6. `analystOnly = inAnalyst && !inMaster` (mirrors the existing table).
7. Drop rule (the ONLY deviation from FR5's union): drop a row iff, after
   `deriveFootball`, the sum of the FIVE DISPLAYED `CategoryKey` totals
   (Passing + Offensive + Defensive + Goalkeeper + Other) is 0 on BOTH sides.
   This keeps exactly the rows that have something to display and drops rows
   that would be an all-`0 / 0` / `—` wall; it is deterministic and
   unit-testable. Any player with ≥1 displayed-category volume on either side is
   kept.

   This drop rule is intentionally NOT the Player stats table's `relevant()`
   filter and is NOT imported from it. `relevant()` (page ~line 635) sums a
   different derived-key set — it includes `ballRecoveries` / `groundDuels` /
   `aerials` / `headers` (not displayed categories here) and omits `blocks` / GK
   stats / `throwIns` / `cards` / `offsides` (which ARE displayed categories
   here). So the two admit different player sets in both directions (see FR5,
   AC8a/AC8b). We use the five-displayed-category sum because it matches what
   this section can actually show; `relevant()` would both drop players who have
   displayable GK/blocks/Other volume and keep players who would render as all
   `—`.
8. Sort — reproduce `playerTable`'s guarded form exactly:
   ```ts
   rows.sort((a, b) => {
     if (a.analystOnly !== b.analystOnly) return a.analystOnly ? 1 : -1;
     if (a.team !== b.team) return a.team.localeCompare(b.team);
     return (a.number ?? 999) - (b.number ?? 999);
   });
   ```
   i.e. `analystOnly` last, then the `a.team !== b.team` short-circuit before
   `localeCompare`, then `(number ?? 999)` — byte-for-byte the `playerTable`
   comparator.
9. Return the rows.

Note the stat labels are lowercased before `bumpFootball`, matching every other
caller (`bumpFootball` expects a lowercased label — see `player-accuracy.ts`
and the page's `sportConfig.bump(..., stat.toLowerCase())`).

### D2.5 Optional per-player overall total — DECISION: SKIP

An overall per-player volume across core categories was offered as optional.
Decision: SKIP it for this iteration. Rationale: the five category cells already
convey the reconciliation; an "overall" raises the question of which philosophy
to use (sum-of-category pcts vs a fresh absolute-difference over summed volumes),
which is a design choice better deferred than guessed. Keeping scope tight also
honours the two-file constraint and the "don't over-engineer" guidance. The
table footer (D6) gives per-category team totals, which covers the "how big is
the gap overall" question at the column level.

## D3. Edge cases

- **master === 0 for a category** → `pct: null`, cell renders `A / 0` with `—`
  for the percentage (never 100%). Covers analyst-only players and
  categories absent on the master side.
- **analyst === 0, master > 0** → `pct: 0` (AC3) — a real miss, shown as `0%`.
- **Both sides 0 for a category** (common: most players have no goalkeeper
  stats) → `pct: null`, `0 / 0`, `—`. The cell is rendered but muted (D6) so a
  row isn't a wall of `0 / 0`.
- **Null jersey number** → bucketed as `#?` (D2.3), matching the existing table.
- **Non-football stat labels** that `bumpFootball` doesn't classify contribute
  0 to every displayed category; such a player could have all-null cells. Because
  the section is gated on `sport === "football"`, this is only reachable for
  stray labels and is harmless. The aggregator applies the deterministic drop
  rule (D2.4 step 7): drop a row iff, after `deriveFootball`, the sum of the five
  DISPLAYED `CategoryKey` totals is 0 on BOTH sides. This is the ONLY deviation
  from FR5's union and exists solely to drop rows that would be an all-`—` wall;
  it is unconditional and unit-testable, and keeps the union (FR5) intact for
  every player with displayable volume on either side. It is NOT the existing
  table's `relevant()` filter and is not imported from it — the two admit
  different player sets (see FR5 / D2.4 step 7 / AC8a / AC8b).
- **`teamFilter` is a canonical team** (`Home`/`Away`), so filtering by
  `i.team === teamFilter` is correct against `canonical.*` (D1); no extra
  canonicalisation is done in the module (the page already canonicalised once —
  re-canonicalising a subset is exactly the bug `canonicaliseTeams`' idempotency
  guard warns about, so the module never calls it).

## D4. Input validation (external inputs to the pure functions)

The module's inputs are in-process `Instance[]` already produced and scoped by
the page, not user-facing I/O, so validation is light and total (never throws):

- `categoryAccuracy(a, m)`: `a`, `m` are required numbers ≥ 0 by construction
  (counts). Behaviour: `m === 0 ⇒ { a, m, pct: null }`; otherwise compute and
  clamp to `[0, 1]`. Negative or non-integer inputs are not expected; the
  clamp makes any out-of-range result safe rather than throwing. No logging.
- `computePlayerCategoryTally(master, analyst)`: each array may be empty
  (⇒ `[]`, a no-op render). An `Instance` with an empty `team` string keys as
  `"|<number>"` and displays `` ` - #<n>` `` — this matches how the existing
  table treats a blank team (it does not special-case it), so parity is kept.
  `i.stat` is always a non-empty trimmed string (guaranteed by `parseInstances`,
  which drops empty-stat instances), so `.toLowerCase()` is safe. No throws, no
  logging — a pure function.

There are no fallible I/O operations in this feature (no fetch, no DB, no file
read), so there is no error-handling table of recoverable/fatal failures: the
compute path is total. The only "failure" mode is "no data in scope", which
renders as an absent/empty section, consistent with the Golden cards.

## D5. Invariant ownership

- **Scope agreement** (the new section and Golden cards see the same instances):
  owned by `page.tsx` — it builds both from the same `canonical.*` + identical
  `inScope`. The module is scope-agnostic; it trusts the arrays it is handed.
  This is the right layer because only the page knows the active filters.
- **Metric definition** (`(m−|a−m|)/m`, floored/capped, null at 0): owned by the
  module (`categoryAccuracy`), the single source of truth, unit-tested.
- **Stat classification & category membership**: owned by `player-accuracy.ts`
  (`bumpFootball` / `deriveFootball` / `FOOTBALL_GROUPS`), reused unchanged. The
  module must NOT re-derive which stat belongs to which category.
- **Player identity/order** (NOT row membership): the module reproduces the
  existing table's key shape, display string and sort comparator. This is parity
  of MECHANICS by REPRODUCTION — it guarantees that a player appearing in both
  tables is keyed, labelled and ordered identically. It is explicitly NOT a
  claim that the two tables contain the same players: `playerTable` sources from
  `result.rows` and filters with `relevant()`, while this section sources from
  `canonical.*` and filters with the five-displayed-category drop rule (FR5,
  D2.4 step 7), so the row SETS may differ in both directions (AC8a/AC8b). The
  key/display/sort invariant is maintained via a code comment on both sides so a
  future change to one table's key/sort is a conscious decision to mirror in the
  other. The scope priority is deliberately agreement-with-the-Golden-cards
  (same `canonical.*`), NOT lockstep-with-`playerTable`.

## D6. Rendering in `page.tsx`

Add the section JSX immediately after the Golden Player Accuracy cards block
(the `{playerAccuracy && ( … )}` block — it opens at render ~line 2922 and
closes with `)}` at ~line 2946, right before the "Category breakdown" grid;
place the new block directly after that closing `)}`), still inside the same
results container so it shares layout. Use the structural anchor (directly after
the Golden block's closing `)}`, before the Category-breakdown grid) rather than
the approximate line number to locate the insertion point.

- **Heading**: a distinct title so users don't confuse it with the exact-match
  cards — `"Player category volume (analyst vs master)"` with a one-line
  sub-caption like "Counts per category, ignoring which exact stat or whether
  events matched — analyst / master and an accuracy %." Use the same small
  uppercase label styling the Golden block uses
  (`text-xs font-semibold uppercase tracking-wider text-slate-500`).
- **Table**: reuse the look of the existing "Player stats" table (D ref
  page ~line 3131): outer `rounded-2xl border border-slate-200 bg-white
  shadow-sm`, sticky header row with
  `bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500`,
  a sticky left "Player" column (`sticky left-0`), `max-h-[520px] overflow-auto`
  scroll container, and `border-b border-slate-100` rows with
  `hover:bg-slate-50/60`. One header cell per category using `CATEGORY_LABELS`
  in `CATEGORY_KEYS` order.
- **Player cell**: render `row.display` (e.g. `Home - #10`) exactly like the
  existing table's player cell (verified page ~line 3195): the row is
  `group border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60` with
  `bg-red-50/60` added when `analystOnly`; the sticky player `<td>` is
  `sticky left-0 z-10 whitespace-nowrap px-4 py-2 font-medium text-slate-800`
  with `bg-red-50` (analystOnly) / `bg-white` backgrounds and
  `group-hover:bg-slate-50`; the `analyst only` badge is
  `ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700`.
  Reuse these classes verbatim. Team-colour number badge: the existing Player
  stats table does NOT
  use a coloured number badge (it renders the plain `` `${team} - #${number}` ``
  string), so there is nothing to "reuse" cheaply; per the brief ("team colours
  for the number badge if easy; do not over-engineer") the DECISION is to match
  the existing plain player cell and NOT introduce a new colour system. This
  keeps the two tables visually consistent and respects the two-file / no-new-
  system constraint.
- **Category cell**: a small two-line (or inline) cell showing
  `{a} / {m}` on top and the percentage below, e.g.:

  ```tsx
  function CategoryTallyCell({ cell }: { cell: CategoryCell }) {
    const muted = cell.m === 0 && cell.a === 0;
    const pctText = cell.pct == null ? "—" : `${Math.round(cell.pct * 100)}%`;
    const mismatch = cell.pct != null && cell.a !== cell.m;
    return (
      <td className={`border-l border-slate-100 px-3 py-2 text-center ${muted ? "text-slate-300" : ""}`}>
        <div className={`tabular-nums ${mismatch ? "text-amber-700 font-semibold" : "text-slate-700"}`}>
          {cell.a} / {cell.m}
        </div>
        <div className="text-[11px] text-slate-400 tabular-nums">{pctText}</div>
      </td>
    );
  }
  ```

  The `%` uses `Math.round(pct * 100)` so AC2 (`2/3`) renders `67%`. `—` for
  `pct == null` (AC4). Amber emphasis on a count mismatch mirrors the existing
  table's `mismatch` cue (`PlayerCells` uses a mismatch highlight), keeping the
  visual language consistent without importing `PlayerCells` (its `A/M` layout
  differs enough that a tiny local cell is clearer than overloading it).
- **Footer (optional, cheap, included)**: a `tfoot` "Team totals" row summing
  each category's `a` and `m` across visible rows and running those two sums
  through `categoryAccuracy`. The existing Player stats table's footer was
  verified (page ~line 3230): `tfoot` is `sticky bottom-0 z-10`, its totals row
  is `border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900` with a
  sticky `Team totals` label cell (`sticky left-0 z-20 whitespace-nowrap
  bg-slate-100 px-4 py-2.5 text-left`). The new footer reuses these exact
  classes. This is the column-level "overall" that replaces the skipped
  per-player overall (D2.5).
- **Team filter**: the section reads the SAME `teamFilter` state; no new toggle
  is added (the existing `TeamToggle` above the Player stats table already drives
  `teamFilter`, and the memo depends on it). Showing a small scope chip
  (`teamFilter === "all" ? "Both teams" : teamDisplay(teamFilter)`) matches the
  other sections and is cheap to add.

Display-name note: `teamDisplay(canonTeam)` maps the canonical `Home`/`Away` to
the real club name for display. The player cell currently shows the canonical
`row.team`; to match the existing Player stats table EXACTLY (which also shows
the canonical team in `p.key`), the new table likewise shows `row.team`. (The
existing table does not run its player label through `teamDisplay`, so neither
does this one — parity over prettiness.)

## D7. Files changed

1. **NEW** `lib/comparison/player-category-tally.ts` — pure module (D2).
2. **NEW** `lib/comparison/player-category-tally.test.ts` — unit tests (D9).
3. **EDIT** `app/accuracy-compare/page.tsx`:
   - add import of `computePlayerCategoryTally`, `categoryAccuracy` (for the
     footer), `CATEGORY_KEYS`, `CATEGORY_LABELS`, and the `CategoryCell` type
     from `@/lib/comparison/player-category-tally`;
   - add the `playerCategoryTally` `useMemo` (D1);
   - add the `CategoryTallyCell` helper component (D6) near the other local cell
     components;
   - add the section JSX after the Golden cards block (D6).

No other files are touched. `player-accuracy.ts` and `xml-compare.ts` are
import-only.

## D8. Testability

- **Unit (no React/DOM)**: `categoryAccuracy` (AC1–AC6) and
  `computePlayerCategoryTally` (AC7–AC9). The aggregator is pure and takes plain
  `Instance[]`, so tests build small instance fixtures inline (minimal objects
  satisfying the `Instance` type — `id`, `start`, `end`, `mid`, `team`,
  `playerNumber`, `playerRaw`, `stat`, `category`, `code`). No DOMParser needed
  because tests construct `Instance[]` directly rather than parsing XML. This is
  the main reason the brief insists the logic live in a pure module.
- **Null-data assertions are STRICT**: for AC4 (`categoryAccuracy(0, 0)`) and
  AC7 (a player's empty Passing), the test asserts `pct === null` (strict
  identity), NOT a falsy check, so a future refactor that returned `pct: 0`
  cannot slip through.
- **Integration (manual / optional component test)**: scope agreement with the
  Golden cards (AC10–AC11) and rendering (AC12) are verified in the running app
  and by the type-check/build; they depend on page state (`teamFilter`,
  `effectiveRange`) that is awkward to unit test. The design keeps ALL logic
  worth asserting in the pure module so the untested surface is only wiring +
  JSX.

A design that forced the metric or tally to read React state or parse XML would
be hard to test; isolating them in the pure module is exactly what makes AC1–AC9
cheap to assert.

## D9. Test runner

The runner is Vitest — unambiguously configured: `package.json` has
`"test": "vitest --run"` and `vitest@^3` in devDependencies, `vitest.config.ts`
sets `environment: "jsdom"` and `include: ["**/*.test.ts", "**/*.test.tsx"]`,
and `lib/round-summary/roundSummary.test.ts` already exists as a style
reference. No runner setup is needed. The test file is
`lib/comparison/player-category-tally.test.ts`, written with Vitest
(`describe` / `it` / `expect`), matching the existing test's style. It needs no
jsdom (the pure functions don't touch the DOM), but the configured jsdom
environment does no harm.

## D10. Verification plan

1. Type-check / lint: run the project's build or `tsc --noEmit` + ESLint.
2. Run the new unit test file; confirm AC1–AC9.
3. `npm run build` to confirm the page compiles (AC12).
4. Manual smoke in dev: load a football check, confirm the new section renders
   below the Golden cards, toggle Both/Home/Away and the time range, and confirm
   counts track the Player stats table (same players, same scope) while the
   percentages follow the `(m−|a−m|)/m` rule.
5. Clean up any scratch files.

---

# Part 3 — Responses to design review

## Part 3A — Responses to the CURRENT review

Review: the on-disk `.agents/tasks/design-review.json`
(`CHANGES_REQUESTED`; 0 HIGH, 1 MEDIUM, 3 NIT) and
`.agents/tasks/design-doc-review.md`. Every finding is ADDRESSED (none
backlogged, none ignored). Changes align with the original requirements: the
two-file scope, reuse of `player-accuracy.ts`, and the
scope-agreement-with-the-Golden-cards priority are all preserved. The drop rule
itself (the five-displayed-category sum) is UNCHANGED — only the framing around
it and the related ACs were corrected.

### Finding 1 [MEDIUM] — "mirrors `playerTable`/`relevant()`" row-set claim is wrong — ADDRESSED
I verified `relevant()` in source (`page.tsx` ~line 635): it sums
`touches, totalPasses, throughSucc, throughUnsucc, carries, crosses, shots,
goals, tackles, interceptions, clearances, ballRecoveries, dribblesSucc,
dribblesUnsucc, groundDuelsWon, groundDuelsLost, aerialWon, aerialLost, headers,
fouls` — a different set from the five displayed categories. Adopted the
reviewer's PREFERRED fix: kept the five-category drop rule as the deterministic
definition and REMOVED the "mirrors `relevant()` / mirrors the spirit of
`playerTable`" framing from FR5, FR7, D2.4 step 7, D3 and D5. Each now states
explicitly that the row set is NOT identical to `relevant()` and lists the
divergent stats in both directions (GK/blocks/throwIns/cards/offsides kept here
but dropped by `relevant()`; ballRecoveries/groundDuels/aerials/headers dropped
here but kept by `relevant()`). Added AC8a (a GK-only or blocks-only player
appears in the tally) and AC8b (a ball-recovery-only player does not). FR7/D5
now scope the `playerTable` parity to KEY/DISPLAY/SORT mechanics only, not row
membership. Did NOT switch to importing `relevant()` (the reviewer's
not-recommended alternative), since that would show GK-only players as all-zero
displayed rows — worse UX.

### Finding 2 [NIT] — team casing split (lowercased key vs first-seen-case sort) undocumented — ADDRESSED
D2.4 step 2 now notes the map key lowercases `team` while the stored `team`
(display + `localeCompare` sort) keeps first-seen case, matching `playerTable`,
and that this is safe only because `canonicaliseTeams` normalises teams to
canonical case-uniform `Home`/`Away` upstream — with an explicit warning to a
future non-canonical caller.

### Finding 3 [NIT] — Golden-block render anchor line number off — ADDRESSED
Verified the Golden `{playerAccuracy && (` opens ~line 2922 and closes `)}`
~line 2946 (right before the "Category breakdown" grid). D6 now cites ~2922/2946
and instructs using the STRUCTURAL anchor (after the Golden block's closing `)}`,
before the Category-breakdown grid) rather than the line number.

### Finding 4 [NIT] — null-number contract scattered — ADDRESSED
D2.3 now states the three-part null-number invariant ONCE: key bucket `?`, sort
weight `999`, display `#?` — all three mirror `playerTable` — with a note to
implement all three together.

## Part 3B — Responses to the PRIOR review cycle (retained for history)

Review: the prior `.agents/tasks/design-review.json` (`CHANGES_REQUESTED`;
0 HIGH, 2 MEDIUM, 5 NIT) and `.agents/tasks/design-doc-review.md`. Every MEDIUM
and NIT was ADDRESSED (none backlogged, none ignored). Changes align with the
original requirements: the two-file scope, reuse of `player-accuracy.ts`, and
scope-agreement-with-the-Golden-cards priority are all preserved.

### Finding 1 [MEDIUM] — Parity-with-`playerTable` claim rests on a different pipeline — ADDRESSED
Softened every "identical / lockstep" claim to "mirrors the key shape, display
string and sort order". FR7, D2.3 and D5 now state explicitly that the new
section sources from `canonical.*` (same set as the Golden cards, NOT from
`result.rows`), that `playerTable` sources from `result.rows` (a second
`canonicaliseTeams` pass with the master file name), and that the two agree
because `canonicaliseTeams` is idempotent and `compareInstances` preserves
`team`/`playerNumber` — parity by reproduction, not shared pipeline. D2.3 also
documents the second shape difference (new `inScope` folds `inRange`+`teamFilter`
over raw `canonical.*`; `playerTable`'s folds `teamFilter` only over
already-range-filtered `result.rows`). Did NOT switch to `result.rows`, per the
reviewer's recommendation, to keep the stated scope-agreement priority.

### Finding 2 [MEDIUM] — "Drop all-zero rows" rule underspecified / can contradict FR5 — ADDRESSED
The rule is now stated once, deterministically, and tied to the classifier:
"Drop a row iff, after `deriveFootball`, the sum of all five `CategoryKey`
totals is 0 on BOTH sides." The "MAY" is removed (D2.4 step 7, D3). FR5 now
carries a sentence referencing this single carve-out, so the two sections no
longer conflict. It is called out as unit-testable.

### Finding 3 [NIT] — `team` sort stated differently than `playerTable` — ADDRESSED
D2.4 step 8 now reproduces the guarded comparator verbatim
(`if (a.team !== b.team) return a.team.localeCompare(b.team)` before the number
compare), and AC9 restates the sort as "byte-for-byte the `playerTable`
comparator".

### Finding 4 [NIT] — Assert `pct === null` strictly in tests — ADDRESSED
D8 gains an explicit bullet: AC4 and AC7 assert `pct === null` (strict identity),
not a falsy check.

### Finding 5 [NIT] — Document the one input that needs the `Math.min(1,…)` cap — ADDRESSED
D2.1's cap note reworded: the cap is "unreachable for non-negative counts;
retained so the `[0,1]` contract holds for any numeric input", and
`Math.max(0,…)` is named the load-bearing clamp.

### Finding 6 [NIT] — Percentage rounding precision vs Golden cards not stated — ADDRESSED
FR3 now states whole-percent rounding (`Math.round(pct*100)%`) is intentional and
need not match the Golden cards' precision.

### Finding 7 [NIT] — D9 runner-detection branch is dead; state Vitest outright — ADDRESSED
D9 rewritten to state Vitest flatly (configured `test` script, `vitest@^3`,
`vitest.config.ts` with jsdom, existing `lib/round-summary/roundSummary.test.ts`
reference). The "if no runner" branch is removed.

### Reviewer "Unverified" items — now verified
- **Footer styling classes**: verified in source (page ~line 3230). The Player
  stats table's `tfoot` is `sticky bottom-0 z-10`; its totals row is
  `border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900`. D6 now
  cites the exact classes (plus the verified row/player-cell/badge classes at
  page ~line 3195: row `hover:bg-slate-50/60` + `bg-red-50/60`, player `<td>`
  `font-medium text-slate-800` with `bg-red-50`/`bg-white`, badge
  `bg-red-100 … text-red-700`).
- **Golden cards' exact `%` formatting**: not quoted; addressed by FR6's explicit
  statement that whole-percent rounding is intentional and may differ cosmetically
  (Finding 6).
- **Stale `design-review.json`**: the earlier note was wrong — the on-disk review
  IS for this feature. The opening "Revision note" now reflects that.
