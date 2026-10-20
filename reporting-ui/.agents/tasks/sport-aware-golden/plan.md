# Implementation Plan — Sport-aware Golden Player Accuracy

All paths are under the worktree UI dir:
`c:\Users\AndyDin\reporting-dashboard\.worktrees\sport-aware-golden\reporting-ui`
Use `git -C <that dir>` for any git. Do NOT touch the sibling main checkout
`c:\Users\AndyDin\reporting-dashboard\reporting-ui`. Do NOT push. Do NOT run
Recompute all.

Project facts (verified):
- MODIFIED Next.js v16 (Turbopack), React 19. `app/accuracy-checks/page.tsx`
  is `"use client"` — this change is pure client React rendering + lib logic,
  no Next routing/server API touched. Per AGENTS.md, if any Next API is used,
  read the matching guide under `node_modules/next/dist/docs/` first; none is
  expected here.
- Test runner: vitest. Run a file with `npx vitest --run <path>`; whole suite
  `npm run test`. Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`. Build:
  `npm run build`.
- Existing comparison test files: afl-player-accuracy.test.ts,
  check-category.test.ts, cross-exact.test.ts, json-adapter.test.ts,
  overlap-window.test.ts, pitch-zone-stat.test.ts,
  player-category-tally.test.ts. There is NO player-accuracy.test.ts or
  xml-compare.test.ts.
- Item 7 (shallow/deep collapse treated as exact) is ALREADY implemented in
  `lib/comparison/xml-compare.ts` (depth-collapse in the canonical key). No
  change needed for it.

## Chosen designs (decided here, grounded in the code)

### Storage union shape + discriminator
`player_accuracy` becomes a discriminated union:
- Football (existing, UNCHANGED on disk): `{ football: boolean; both; home; away }`
  where each scope is `PlayerAccuracy` (overall/passing/offensive/defensive/
  goalkeeper/other). Keep `StoredPlayerAccuracy` exactly as-is.
- AFL (new): `StoredAflPlayerAccuracy = { afl: true; both; home; away }` where
  each scope is `AflPlayerAccuracy` (overall/scoring/defence/possession/
  disposals/other).
- Discriminator: the PRESENCE of the `afl: true` key marks an AFL row; the
  `football` key marks a football row. This is backward compatible — every
  existing stored row already has `football` and no `afl`, so it reads as
  football with zero migration. A legacy NULL stays NULL → renders blank.
  Rationale: adding `afl:true` beside the existing `football` field needs no
  change to any already-written row and gives a cheap, type-narrowing tag. A
  shared `StoredPlayerAccuracyUnion = StoredPlayerAccuracy | StoredAflPlayerAccuracy`
  is exported for the stored type.

### gradeOverlapScoped sport routing
Add a trailing `sport: string | null | undefined` param to `gradeOverlapScoped`.
When `sport === "afl"` it calls the new `computeAflPlayerAccuracyByScope(...)`
and the returned `playerAccuracy` is AFL-shaped; otherwise (football, null,
unknown) it calls `computePlayerAccuracyByScope(...)` exactly as today (safe
default = football). The `result` (ComparisonResult summary/byCategory/byTeam)
is computed the SAME way for both sports — only the player_accuracy shape
changes. The function's return type widens its `playerAccuracy` to the union.

### Four (actually five) call sites pass sport
`gradeOverlapScoped` is called in FIVE places in `lib/api/accuracyChecks.ts`:
1. `saveAccuracyCheck` — pass `input.sport`.
2. `updateAccuracyCheck` — pass `input.sport`. In the defensive recovery branch
   (re-fetch stored row when xmlAnalyst undefined) also SELECT `sport` and pass
   the stored value.
3. `propagateMasterCorrection` — add `sport` to the SELECT and pass per-row
   `row.sport`.
4. `backfillPlayerAccuracy`/`recomputeAllPlayerAccuracy` — add `sport` to the
   id-list SELECT and pass `row.sport`.
5. `mergeMasters` — add `sport` to the destination-group reload SELECT and pass
   per-row `row.sport`. (Task named four; merge is the fifth and MUST be
   routed too or merged AFL checks regress to football shape.)
Each SELECT currently omits `sport`; add the column so the row object carries
it. Default when null/unknown = football (the existing behavior), documented in
the grader.

### Active column set rule (page)
Add `AFL_PLAYER_ACCURACY_COLUMNS` parallel to `PLAYER_ACCURACY_COLUMNS`:
overall/scoring/defence/possession/disposals/other with labels Overall/Scoring/
Defence/Possession/Disposals/Other and shorts OVR/SCO/DEF/POS/DIS/OTH. Keep BOTH
column arrays (and an `OVERALL_ONLY_COLUMNS = [{key:'overall',label:'Overall',
short:'OVR'}]`) co-located with the existing constant near the top of
`page.tsx` so labels never drift. The active set is chosen purely from
`sportFilter`: `football` → football columns; `afl` → AFL columns; `all` →
Overall-only. Define `activeColumns = useMemo(...)` once and thread it to the
memos, the saved table, and BOTH comparison components as a prop.

### Sport-correct per-row reader `groupPctForCheck(check, key)`
Replace `storedGroupPct` usage with a reader that inspects the stored shape:
- `const pa = check.player_accuracy; if (!pa) return null;`
- If `pa` has `afl === true`: it's AFL. Return `groupPct(pa.both?.[key])` only
  when `key` is a valid AFL key (overall/scoring/defence/possession/disposals/
  other); otherwise null (asking "passing" of an AFL check → null).
- Else (football shape, has `football`): return `groupPct(pa.both?.[key])` only
  when `key` is a valid football key; else null (asking "scoring" of a football
  check → null).
- `overall` exists on BOTH shapes. Keep the existing `football` falsy guard for
  football rows (a football row with `football:false` → null, unchanged).
This makes a legacy NULL-sport check (football-shaped stored data, filtered as
"afl" by `sportByCheck`) STILL read football values — but since the AFL column
set asks for scoring/defence/etc., such a legacy row returns null for those and
blank cells render, which is correct (it has no AFL-shaped data until recompute).

## Ordered items

- [ ] 1. Add `computeAflPlayerAccuracyByScope` + `StoredAflPlayerAccuracy` to
      `lib/comparison/afl-player-accuracy.ts`, mirroring football's by-scope.
      Canonicalise teams (import `canonicaliseTeams`, `compareInstances`, `Instance`,
      `PlayerAccuracyScope` from xml-compare / player-accuracy), scope each of
      both/home/away, run `computeAflPlayerAccuracy` per scope. Shape
      `{ afl: true; both; home; away }`. The `afl` flag is literal `true`.
      Export `StoredAflPlayerAccuracy`.
      Files: `lib/comparison/afl-player-accuracy.ts`
      Verify: `npx vitest --run lib/comparison/afl-player-accuracy.test.ts` passes
      (after item 2 adds its tests); `npx tsc --noEmit` clean.

- [ ] 2. Extend `lib/comparison/afl-player-accuracy.test.ts`:
      `computeAflPlayerAccuracyByScope` returns `{ afl:true, both, home, away }`
      with an `AflPlayerAccuracy` per scope, and its `both` scope equals
      `computeAflPlayerAccuracy` over the same both-scoped comparison rows.
      Reuse the existing `inst`/`row`/`exactRows` helpers; build minimal
      Instance[] master/analyst arrays with Home/Away teams.
      Files: `lib/comparison/afl-player-accuracy.test.ts`
      Verify: `npx vitest --run lib/comparison/afl-player-accuracy.test.ts` — all
      pass (existing 16 + new).

- [ ] 3. Make `gradeOverlapScoped` sport-aware in `lib/api/accuracyChecks.ts`:
      add trailing `sport` param, widen return `playerAccuracy` to
      `StoredPlayerAccuracy | StoredAflPlayerAccuracy`, route to
      `computeAflPlayerAccuracyByScope` when `sport==='afl'` else
      `computePlayerAccuracyByScope`. Import `computeAflPlayerAccuracyByScope`
      + `StoredAflPlayerAccuracy`. Update the five call sites to pass sport and
      add `sport` to the SELECT in propagate/backfill/merge and the
      updateAccuracyCheck recovery SELECT (see "call sites" above). Document the
      null→football default in the grader doc comment.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npx tsc --noEmit` clean; `npm run test` green.

- [ ] 4. Update the stored TYPE: change `AccuracyCheck.player_accuracy` to
      `StoredPlayerAccuracy | StoredAflPlayerAccuracy | null`. `AccuracyCheckMeta`
      is `Omit<AccuracyCheck,...>` so it inherits automatically.
      `ACCURACY_CHECK_META_COLUMNS` already lists `player_accuracy` and `sport`
      (no column change). Import `StoredAflPlayerAccuracy`.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npx tsc --noEmit` clean.

- [ ] 5. Add a routing-decision unit test (gradeOverlapScoped is module-private
      and XML-parse heavy, so test the DECISION in isolation): a small test that
      feeds the same scoped rows to both by-scope computers and asserts the AFL
      result has `afl:true` + scoring/defence/possession/disposals/other groups
      and the football result has `football` + passing/.../goalkeeper. Place in
      `lib/comparison/afl-player-accuracy.test.ts` (or a new
      `lib/comparison/stored-accuracy-shape.test.ts`).
      Files: `lib/comparison/afl-player-accuracy.test.ts` (or new file)
      Verify: `npx vitest --run <that file>` passes.

- [ ] 6. In `app/accuracy-checks/page.tsx` add `AFL_PLAYER_ACCURACY_COLUMNS`,
      `OVERALL_ONLY_COLUMNS`, a union key type, and the sport-correct
      `groupPctForCheck(check, key)` reader (see designs). Keep `storedGroupPct`
      only if still used by the trend chart, OR repoint the trend chart to
      `groupPctForCheck`. Add an `activeColumns` memo keyed off `sportFilter`.
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npx tsc --noEmit` clean.

- [ ] 7. Saved-checks table: drive thead (line ~1344), body cells (~1429), the
      `sortedSavedChecks` `val` switch group cases (~590), and CSV export
      header+cells (~698/~711) off `activeColumns` and `groupPctForCheck`
      instead of `PLAYER_ACCURACY_COLUMNS`/`storedGroupPct`. Keep the Overall
      highlight (first column styling). History summary Stat cards (~1680) +
      `overallAverages`/`averageGroups` also use `activeColumns` +
      `groupPctForCheck`.
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npx tsc --noEmit` clean; `npm run build` succeeds.

- [ ] 8. `analystComparison` + `locationComparison` memos: iterate
      `activeColumns` and read via `groupPctForCheck`; build the per-row
      `groups` record keyed to the active keys (replace the hardcoded
      `{overall,passing,...}` literals with a record built from the active
      column keys). Pass `activeColumns` into `AnalystComparisonTable` and
      `LocationComparisonTable` as a prop and use it for thead, body cells,
      sort `val`, and each component's CSV export (replace the local
      `PLAYER_ACCURACY_COLUMNS`/`groupCols` references). Update the
      `sortedComparison` val + the location analyst-row sort to read from the
      active keys. Keep Overall highlight.
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npx tsc --noEmit` clean; `npm run build` succeeds.

- [ ] 9. "By master fixture" table + `fixtureGroupAccuracy` + `sortFixtureRows`:
      make it sport-correct too. `fixtureGroupAccuracy` currently reads
      `stored.football`/`stored[scope]` and returns a football `PlayerAccuracy`;
      generalise it to return the active-shape scope object (football OR AFL)
      and drive the fixture thead/body/tfoot (~1968/~2008) + sort off
      `activeColumns`. For filter=all use Overall-only. Keep the XML fallback
      path (football compute) for legacy NULL rows — those only ever render
      Overall/football and are acceptable as the backward-compat path.
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npx tsc --noEmit` clean; `npm run build` succeeds.

- [ ] 10. Trend chart group selector (~3216) + `trendGroup` state (~516): drive
      its button list off `activeColumns`; if the active set changes and the
      current `trendGroup` key is no longer present, reset it to `overall`.
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npx tsc --noEmit` clean.

- [ ] 11. Full verification pass: `npm run test` all green (existing + new),
      `npx tsc --noEmit` clean, `npm run lint` clean, `npm run build` succeeds.
      Manually sanity-check: football filter shows Passing/Offensive/Defensive/
      Goalkeeper/Other + Overall; afl filter shows Scoring/Defence/Possession/
      Disposals/Other + Overall; all filter shows Overall only.
      Files: none
      Verify: all four commands succeed.

## Backward-compatibility guarantees
- Existing football rows `{football, both, home, away}` are untouched on disk;
  `groupPctForCheck` detects absence of `afl` → reads them as football. Under
  the football filter they render identically to today.
- Legacy NULL `player_accuracy` → `groupPctForCheck` returns null → blank "—"
  cells in every table, same as today.
- A null/unknown `sport` keeps football grading (safe default), so nothing that
  is not explicitly `sport==='afl'` changes shape.
- Existing AFL checks keep their current (football-shaped) stored value until an
  admin runs Recompute all; under the AFL filter their sport-specific columns
  render blank until then, which is expected (we do NOT run recompute here).
- No DB column change (player_accuracy + sport already exist); no new deps.
