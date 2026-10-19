# Verification — Player category volume: passing match + Other tooltip fold

Worktree: `c:\Users\AndyDin\reporting-dashboard\.worktrees\passing-golden-match\reporting-ui`
Branch: `feat/category-passing-golden-match`

## What changed (three changes)

1. **Passing column matches the Golden passing card.** The Passing cell (per-player
   rows AND Team totals) is now the EXACT-match accuracy `exact/master` from the
   shared `buildGroup(FOOTBALL_GROUPS.passing, rows)` (with the looser same-player
   pass rule baked into `buildGroup`), NOT the volume reconciliation used by the
   other four columns. Offensive / Defensive / Goalkeeper / Other are unchanged.
   - `lib/comparison/player-accuracy.ts`: exported `buildGroup` (was module-private).
   - `lib/comparison/player-category-tally.ts`: added `ExactPart`, the optional
     `exactParts?: ExactPart[]` field on `CategoryCell`, and the pure helper
     `passingCellFromGroup(group: AccuracyGroup): CategoryCell`
     (`a=exact, m=master, pct=exact/master, parts:[], exactParts: group.parts`).
   - `app/accuracy-compare/page.tsx`: new `playerPassing` useMemo reusing the SAME
     scoped instances + IDENTICAL `inScope` predicate + the SAME `compareInstances`
     call as `playerAccuracy`. It computes `team = buildGroup(FOOTBALL_GROUPS.passing,
     cmp.rows)` (team-wide) and a per-player `Map<"team|number", AccuracyGroup>`.
     The table overrides the passing cell per row and in the tfoot with
     `passingCellFromGroup(...)`; empty/missing group ⇒ `buildGroup(..., [])` ⇒
     master 0 ⇒ pct null ⇒ renders "—".
   - `CategoryTallyCell` renders an "Exact / Master" tooltip when `exactParts` is
     present (lines like "Player Passes: exact / master"), else the existing
     "Analyst / Master" volume tooltip verbatim.

2. **"Other" tooltip folds Touches + Carries + Dribbles into ONE line.** Added the
   pure helper `foldOtherParts(parts)` in `player-category-tally.ts`, applied in
   `computePlayerCategoryTally` ONLY for the `other` category, AFTER the cell total
   `aTot`/`mTot` is summed from the unfolded counts — so the Other cell VALUE and %
   are unchanged; only the tooltip grouping changes. Throw ins / Cards / Fouls /
   Offside stay as separate lines in order. Because every player row now carries the
   folded 5-line Other parts shape, the page's index-wise tfoot fold produces the
   same combined Team-totals line automatically (no page change needed for Other).

3. **Offensive / Defensive / Goalkeeper columns unchanged** (volume + existing
   "Analyst / Master" tooltip). Both the previous player table and this
   category-volume table coexist.

## Commands run and results

All from `c:\Users\AndyDin\reporting-dashboard\.worktrees\passing-golden-match\reporting-ui`.

Note: the worktree had no `node_modules`, so `npm install` was run first (653
packages). The worktree also had no `.env*` (those are gitignored); the local
`.env` / `.env.local` were copied from the sibling main checkout
`c:\Users\AndyDin\reporting-dashboard\reporting-ui` SOLELY so `next build` could
statically prerender the Supabase-backed pages. They are gitignored and NOT
committed.

1. `node_modules/.bin/vitest run lib/comparison/player-category-tally.test.ts`
   → **17 passed (17)**. All existing AC1–AC9 volume tests stay green; new tests
   cover `passingCellFromGroup`, `foldOtherParts`, and the Other-fold in
   `computePlayerCategoryTally` (asserting the folded 5-line tooltip AND that the
   Other cell `a`/`m`/`pct` are unchanged).

2. `node_modules/.bin/tsc --noEmit` → **clean** (exit 0, no output).

3. `npm run build` → **succeeds**. Compiled, TypeScript passed, 37 static pages
   generated including `/accuracy-compare` and `/fixture-review`.
   (A first build attempt failed ONLY because the worktree lacked `.env` —
   "supabaseUrl is required" during prerender of `/fixture-review`, a page this
   change does not touch. After copying the local env it built clean. No dev
   server was started.)

## Logic check (passing cell == Golden passing %)

**Team totals.** The tfoot passing cell is
`passingCellFromGroup(playerPassing.team)` where
`playerPassing.team = buildGroup(FOOTBALL_GROUPS.passing, cmp.rows)` and `cmp` is
`compareInstances(canonical.master.filter(inScope), canonical.analyst.filter(inScope),
tolerance)` — the SAME call, SAME `inScope`, SAME rows the Golden
`playerAccuracy` useMemo passes to `computePlayerAccuracy`, whose `passing` is
`buildGroup(FOOTBALL_GROUPS.passing, cmp.rows)`. Same function, same inputs ⇒
identical `{master, exact, pct}`. `passingCellFromGroup` sets `a=exact, m=master,
pct=exact/master`, so the Team-totals passing cell equals the Golden team-wide
passing figure by construction.

Worked example. Say over all scoped rows the passing group has master=10,
exact=7 (looser pass rule applied inside `buildGroup`). Golden passing card shows
7/10 = 70%. Team totals passing cell = `passingCellFromGroup({master:10, exact:7,
pct:0.7, ...})` → displays `7 / 10`, 70%. Equal. ✓

**Per player.** `playerPassing.byKey` partitions the SAME `cmp.rows` by
`"team|number"` (lowercased team + `playerNumber ?? "?"` of the master side, else
analyst side) — the IDENTICAL key the tally's `ensure` uses — then runs
`buildGroup(FOOTBALL_GROUPS.passing, rowsForThatPlayer)`. `buildGroup` counts only
rows whose master side belongs to the passing group, so a player's group is exactly
their master passing events and the exact matches among them: that player's Golden
passing %. The row's passing cell = `passingCellFromGroup(byKey.get(row.key))`.

Worked example. Player Home #10 has, in scope, 4 master passes of which the analyst
exactly/loosely matched 3, plus 1 master cross matched 0. `buildGroup` passing →
master=5, exact=3, pct=0.6. The Golden passing breakdown for that player is the
same 3/5 = 60%. Per-player passing cell displays `3 / 5`, 60%. Equal. ✓

Since the per-player groups partition the same rows `buildGroup` sees team-wide and
`buildGroup`'s denominator is additive over rows, the per-player passing cells'
master/exact sum to the Team-totals passing master/exact (the % is recomputed
team-wide, not averaged) — consistent with the Golden card.

## Repo rule (Next.js v16, modified)

This change adds no `next/*` API surface (pure TS module + its vitest + the body/JSX
of an existing client component). Per the plan's note, no Next guide read was
required; none was added.
