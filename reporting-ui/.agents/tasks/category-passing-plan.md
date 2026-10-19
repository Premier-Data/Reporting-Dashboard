# Implementation Plan — Player category volume: passing match + Other tooltip folding

Worktree (absolute): `c:\Users\AndyDin\reporting-dashboard\.worktrees\passing-golden-match\reporting-ui`
Git: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\passing-golden-match`

## Repo rule note (Next.js v16, modified)
AGENTS.md requires reading the relevant guide under `node_modules/next/dist/docs/` before writing Next-specific code. This change touches NO Next API surface: it edits a pure TS module (`lib/comparison/player-category-tally.ts`), its vitest tests, and the body/JSX of an existing client component (`app/accuracy-compare/page.tsx`) — no routing, no server components, no `next/*` imports added. So no Next guide read is strictly required, but the implementer must not introduce any new `next/*` usage; if that becomes necessary, read the matching doc first.

## Design decisions (made here, grounded in the code read)

- **Decision 1 — Option A (compute passing accuracy in the page, override the cell).**
  `computePlayerCategoryTally` takes only `Instance[]` and intentionally never calls `compareInstances` (see its doc comment: "volume reconciliation needs no pairing"). Passing the comparison rows into the pure module (Option B) would force it to either import `compareInstances` or accept pre-paired rows, breaking its clean "counts in → cells out" contract and its node-only tests that build plain `Instance[]`. Option A keeps the pure module focused on volume for the four unchanged columns, and lets the page — which ALREADY builds `compareInstances(...).rows` for `playerAccuracy` (page.tsx ~line 2120) with the IDENTICAL `inScope` predicate — compute per-player + team-wide passing exact-match and override just the passing cell. This keeps scope agreement automatic (same rows, same predicate) and the module testable.

- **Decision 2 — Reuse `buildGroup` + `FOOTBALL_GROUPS.passing` from `player-accuracy.ts`, do not re-derive the looser pass rule.** `buildGroup` encapsulates `LOOSE_PASS_PART_KEYS` and produces an `AccuracyGroup { master, exact, pct, parts: {label,master,exact}[] }`. The team-wide passing figure is `buildGroup(FOOTBALL_GROUPS.passing, allScopedRows)` (equals the Golden passing card). For per-player, filter the scoped rows by the SAME `"team|number"` key the tally uses, then `buildGroup` per player. Both require exporting `buildGroup` and `FOOTBALL_GROUPS` from `player-accuracy.ts` (currently `FOOTBALL_GROUPS` is exported; `buildGroup` is module-private — it must be exported).

- **Decision 3 — Carry an optional exact-match shape on `CategoryCell`, render a distinct passing tooltip.** The other four columns keep `CategoryCell.parts: CategoryPart[] {label,a,m}` and the existing "Analyst / Master" tooltip untouched. The passing cell carries an additional optional field describing exact-vs-master so `CategoryTallyCell` can render a distinct "Exact / Master" tooltip for passing only. This avoids a confusing mixed format and leaves the pure metric for the other columns unchanged. The cell's VALUE for passing becomes `exact/master` (rounded %), with `a` = exact and `m` = master so the existing `{cell.a} / {cell.m}` display reads "exact / master" and the mismatch colour still works.

### Concrete shape for the passing override
Add to the pure module (`player-category-tally.ts`):

```ts
// Optional exact-match breakdown carried ONLY by the passing cell after the
// page overrides it. When present, CategoryTallyCell renders an "Exact /
// Master" tooltip instead of the volume "Analyst / Master" one.
export type ExactPart = { label: string; exact: number; master: number };

export type CategoryCell = {
  a: number;
  m: number;
  pct: number | null;
  parts: CategoryPart[];
  exactParts?: ExactPart[]; // present only on an exact-match (passing) cell
};
```

`categoryAccuracy` keeps its signature (`parts` default `[]`); `exactParts` is simply omitted by it (stays `undefined`), so all existing volume cells and tests are unaffected. The page builds the passing override cell directly as a `CategoryCell` literal: `{ a: g.exact, m: g.master, pct: g.pct, parts: [], exactParts: g.parts.map(p => ({label:p.label, exact:p.exact, master:p.master})) }` where `g = buildGroup(FOOTBALL_GROUPS.passing, rowsForPlayer)`.

### Scope / key agreement (must hold exactly)
- Page passing useMemo reuses the SAME `inScope = (i) => inRange(i) && (teamFilter === "all" || i.team === teamFilter)` and the SAME `compareInstances(..., tolerance)` call already used by `playerAccuracy` (page.tsx ~2117-2126). Build it from one shared `cmp.rows` (reuse the existing `playerAccuracy` compare or add a sibling useMemo with identical deps).
- Per-player row grouping key = `` `${(row.master ?? row.analyst).team.toLowerCase()}|${(row.master ?? row.analyst).playerNumber ?? "?"}` ``, matching the tally's `ensure` key. Group rows by this key, run `buildGroup` per group. For the denominator the master side defines rows (buildGroup ignores rows with no `r.master`), so key off `r.master` when present else `r.analyst`.
- Team totals passing = `buildGroup(FOOTBALL_GROUPS.passing, cmp.rows)` over all scoped rows (NOT a fold of per-player cells) — this equals the Golden passing card team-wide figure.

---

## Ordered plan

- [ ] 1. Export `buildGroup` and keep `FOOTBALL_GROUPS` exported from `player-accuracy.ts`.
      Change `function buildGroup(` to `export function buildGroup(`. No logic change. `FOOTBALL_GROUPS`, `AccuracyGroup`, `AccuracyPart`, `AccuracyGroupDef` are already exported/needed; confirm `AccuracyGroupDef` is exported (it is `export type`).
      Files: `lib/comparison/player-accuracy.ts`
      Verify: `npx tsc --noEmit` — no errors; `npx vitest --run lib/comparison/player-accuracy.test.ts` (if present) still green.

- [ ] 2. Add `ExactPart` type and the optional `exactParts?: ExactPart[]` field to `CategoryCell` in the pure module. Do NOT change `categoryAccuracy`'s behaviour (it leaves `exactParts` undefined). Add an exported helper `passingCellFromGroup(group: AccuracyGroup): CategoryCell` that maps an `AccuracyGroup` to a `CategoryCell` (`a=exact, m=master, pct, parts: [], exactParts: group.parts.map(...)`), so the mapping is pure and unit-testable and not duplicated in the page.
      Files: `lib/comparison/player-category-tally.ts`
      Verify: `npx tsc --noEmit` — no errors.

- [ ] 3. In `page.tsx`, add the per-player + team-wide passing accuracy map. Reuse the existing scoped `cmp.rows` from the `playerAccuracy` useMemo (page.tsx ~2117): either read it from a shared memo or add a `playerPassingByKey` useMemo with IDENTICAL deps/predicate that: builds `cmp` once, computes `teamPassing = buildGroup(FOOTBALL_GROUPS.passing, cmp.rows)`, groups `cmp.rows` by `"team|number"` key, and stores `Map<string, AccuracyGroup>` of per-player passing. Import `buildGroup`, `FOOTBALL_GROUPS` from `@/lib/comparison/player-accuracy` and `passingCellFromGroup`, `type ExactPart` from `@/lib/comparison/player-category-tally`.
      Files: `app/accuracy-compare/page.tsx` (import block ~88-97; new memo near ~2135)
      Verify: `npx tsc --noEmit` — no errors.

- [ ] 4. Override the passing cell in the table render. In the per-player `<tbody>` map, when `ck === "passing"` pass `cell={passingCellFromGroup(playerPassingByKey.get(row.key) ?? emptyGroup)}` (empty group ⇒ master 0 ⇒ pct null ⇒ "—", consistent with no-data). For the other four `ck`, pass `row.cells[ck]` unchanged. In the `<tfoot>` Team totals, when `ck === "passing"` render `passingCellFromGroup(teamPassing)`; other four stay the existing `categoryAccuracy(aTot, mTot, parts)` fold.
      Files: `app/accuracy-compare/page.tsx` (~3068 per-player cells; ~3079-3112 tfoot)
      Verify: `npx tsc --noEmit`; then step 8 build.

- [ ] 5. Update `CategoryTallyCell` to render the passing exact-match tooltip when `cell.exactParts` is present, else keep the existing volume tooltip verbatim. When `exactParts` present: header `"Exact / Master"`, each line `` `${p.label}: ${p.exact} / ${p.master}` `` (filter to parts where `exact !== 0 || master !== 0`, fall back to all when none). The cell body still shows `{cell.a} / {cell.m}` (= exact / master) and `pctText`; mismatch colouring unchanged. Other columns: untouched code path.
      Files: `app/accuracy-compare/page.tsx` (`function CategoryTallyCell` ~745-776)
      Verify: `npx tsc --noEmit`; then step 8 build.

- [ ] 6. Fold Touches + Carries + Dribbles into ONE tooltip line for the "Other" column, WITHOUT changing the Other cell value. Do this in the pure module so both per-player and team-totals inherit it: after building `parts` for the `other` category in `computePlayerCategoryTally`, post-process the parts array to replace the three entries (`Touches`, `Carries`, `Dribbles` — identify by the group part order: keys `touches`, `carries`, `dribbles`) with a single combined `{ label: "Touches / Carries / Dribbles", a: sum, m: sum }`, keeping `Throw ins`, `Cards`, `Fouls`, `Offside` as separate lines in order. The category TOTAL `aTot`/`mTot` is computed from `categoryTotal(...)` BEFORE this fold, so the cell value/% is unchanged; only `cell.parts` grouping changes. Add a small pure helper `foldOtherParts(parts: CategoryPart[]): CategoryPart[]` keyed off the first three `FOOTBALL_GROUPS.other.parts` so the team-totals fold (which sums parts by index in the page) stays consistent — since every player row now has the folded 5-entry parts shape, the page's index-wise `<tfoot>` fold produces the same combined line automatically. Confirm the page tfoot fold still works with the new parts length (5 instead of 7) — it folds by index so it adapts; no page change needed for Other.
      Files: `lib/comparison/player-category-tally.ts` (`computePlayerCategoryTally`, Other branch)
      Verify: `npx vitest --run lib/comparison/player-category-tally.test.ts` — new Other-fold test (step 7) passes; existing volume tests stay green (Other cell `a`/`m`/`pct` unchanged).

- [ ] 7. Update/extend `player-category-tally.test.ts`.
      Add:
      - `passingCellFromGroup` maps an `AccuracyGroup {master, exact, pct, parts}` to a `CategoryCell` with `a=exact, m=master, pct` equal, `parts: []`, and `exactParts` mirroring the group parts (label/exact/master).
      - `foldOtherParts` / the Other branch: given a player with Touches+Carries+Dribbles plus Throw ins/Cards, the Other cell `parts` has ONE combined "Touches / Carries / Dribbles" line summing the three, plus separate Throw ins/Cards lines; and the Other cell `a`/`m`/`pct` are UNCHANGED vs the pre-fold totals (assert exact numbers).
      Keep all existing AC1–AC9 volume tests green (they assert `a`/`m`/`pct`, which the passing override and Other fold do not touch in the pure tally output — passing override happens in the page, not in `computePlayerCategoryTally`).
      Files: `lib/comparison/player-category-tally.test.ts`
      Verify: `npx vitest --run lib/comparison/player-category-tally.test.ts` — all tests (old + new) pass.

- [ ] 8. Full verification.
      Files: none (verification only).
      Verify, in order, from the worktree `reporting-ui` dir:
      1. `npx vitest --run lib/comparison/player-category-tally.test.ts` — all pass.
      2. `npx tsc --noEmit` — no type errors.
      3. `npm run build` — Next build succeeds. NEVER start a dev server.

## Gaps / assumptions
- Assumed per-player passing groups should be keyed off `r.master` team/number when present, else `r.analyst` — matching the tally's `ensure` key and so analyst-only players still align. If a paired `wrong_stat` row has differing master/analyst players, the master side wins (consistent with buildGroup's master-defined denominator).
- Assumed an empty/missing per-player passing group renders as "—" (master 0 ⇒ pct null), consistent with the existing no-data convention; the player row still shows because the OTHER four volume cells keep the row in scope via the existing drop rule.
- `emptyGroup` in step 4 = `{ master: 0, exact: 0, pct: null, parts: FOOTBALL_GROUPS.passing.parts.map(p => ({label:p.label, master:0, exact:0})) }` or simply reuse `buildGroup(FOOTBALL_GROUPS.passing, [])`.
