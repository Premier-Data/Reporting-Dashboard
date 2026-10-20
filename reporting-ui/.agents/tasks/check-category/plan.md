# Implementation Plan — Check "category" feature

App: MODIFIED Next.js v16 (Turbopack). Worktree app root (ALL paths below are
inside this unless stated):
`c:\Users\AndyDin\reporting-dashboard\.worktrees\check-category\reporting-ui`

## Context discovered during exploration (read this first)

- **Build/test deps are NOT installed in the worktree.** `node_modules/` does
  not exist in the worktree and both are gitignored (`/node_modules`, `.env*`
  in `reporting-ui/.gitignore`), so copying them in can never be committed. The
  Next docs live at `node_modules/next/dist/docs/` which therefore does not
  exist yet — install/copy node_modules before trying to read them.
- **Next API surface:** this feature is entirely React client-component state
  (both pages are existing `"use client"` components) plus Supabase reads/writes
  through the existing `lib/api/accuracyChecks.ts` data layer. It introduces NO
  new Next-specific API (no new route handlers, no server components, no
  `next/*` imports). Per repo AGENTS.md ("this is NOT the Next.js you know"),
  if any Next API is reached for, READ the matching guide under
  `node_modules/next/dist/docs/` first — but none is expected here. Call this
  out; do not add Next APIs.
- **Totals + PlayerAccuracy at save time:** `ComparisonResult.summary` has
  `masterTotal` and `analystTotal` (numbers) — see
  `lib/comparison/xml-compare.ts` (summary shape ~lines 97-110, assigned
  ~1416-1430). `StoredPlayerAccuracy` (from
  `lib/comparison/player-accuracy.ts`) has `.both` / `.home` / `.away`, each a
  `PlayerAccuracy` whose five groups are `passing`, `offensive`, `defensive`,
  `goalkeeper`, `other` plus `overall`; each group has a `.master` number. The
  five "Golden Player Accuracy GROUPS" in the spec = Passing, Offensive,
  Defensive, Goalkeeper, Other (NOT overall).
- **Save derivation is overlap-scoped.** `saveAccuracyCheck`
  (`lib/api/accuracyChecks.ts`) ignores the page's filter-scoped `result` and
  re-grades via the module-private `gradeOverlapScoped` (canonicalise FULL sets
  -> `scopeToOverlap` -> `compareInstances` + `computePlayerAccuracyByScope`).
  `scopeToOverlap` IS exported from `lib/comparison/overlap-window.ts`. So the
  auto-suggest shown in the save UI must be computed the SAME overlap-scoped
  way to match what actually gets stored (see item 4).
- **Compare page already has an unrelated `categoryFilter`** state — that is a
  STAT-category (instance.category) filter, nothing to do with check category.
  Do NOT reuse or collide with it; name all new identifiers with a `check`
  prefix (e.g. `suggestedCheckCategory`, `checkCategory`,
  `savedCategoryFilter`).
- **History page already has the "Check #" column** (`SortHead col="checkNo"`,
  renders `#{c.id}`) — a prior task did that. Do NOT re-add it.
- **History page data flow:** `load()` calls `getAccuracyChecksMeta()` ->
  `setAllChecks(scoped)`; `checks` (sport filter) -> `analystChecks` ->
  `sortedSavedChecks` memo (applies week filter + sort). Inline edits must
  update `allChecks` via `setAllChecks` so the row reflects immediately without
  a reload.
- **Week filter UI** lives in `savedChecksCard` (~lines 1195-1209): a `<label>
  Week</label>` + `<select value={savedWeekFilter} ...>` inside a
  `<div className="flex items-center gap-2">`. The new category filter goes
  INSIDE that same flex div, right next to it.
- **Test convention:** vitest, `*.test.ts` colocated with source; jsdom default
  env; pure/node tests add a top `// @vitest-environment node` line (see
  `lib/comparison/player-category-tally.test.ts`). Run with `npm run test`
  (`vitest --run`) or scope with `npx vitest run <path>`.

## Shared decisions (made here; one or two lines each)

- **Single source for the union + labels + option list:** add to
  `lib/api/accuracyChecks.ts` (the data layer every surface already imports):
  `export type CheckCategory = 'full_game' | 'specific_stats' | 'golden_accuracy'`,
  `export const CHECK_CATEGORY_LABELS: Record<CheckCategory, string>`
  (`full_game`→"Full game", `specific_stats`→"Specific stats",
  `golden_accuracy`→"Golden Accuracy"), and
  `export const CHECK_CATEGORY_OPTIONS: readonly CheckCategory[]`
  (order: full_game, specific_stats, golden_accuracy). Reused by the save
  dropdown, inline edit, and filter so the three lists cannot drift. Chosen over
  a new module to avoid an extra file and match how `AccuracyCheck`/labels
  already live here.
- **Auto-suggest helper placement:** a NEW pure module
  `lib/comparison/check-category.ts` exporting `suggestCheckCategory(...)`, kept
  dependency-light (imports only the `CheckCategory` type and
  `PlayerAccuracy`/`FOOTBALL_GROUPS` types) so it is trivially unit-testable in
  a node env. It must NOT import React or the data layer. Chosen in
  `lib/comparison/` because that is where the pure comparison helpers + their
  vitest files already live.
- **NULL handling:** legacy rows have `category: null`. Display as "—"
  (Uncategorised) in the inline edit control; a specific-category filter
  excludes NULL rows; "All" includes them. The save dropdown always has a
  concrete value (defaults to the suggestion), so new rows are never NULL.
- **Inline-edit gating:** the saved-checks table has NO per-row role gate today
  (delete button is always rendered). Per the task, do NOT add role gating for
  the category edit either.

---

# Implementation Plan

- [ ] 1. Add the shared `CheckCategory` type, labels map, and option list to the
      data layer, and thread `category` through the row/interfaces + meta
      projection.
      In `lib/api/accuracyChecks.ts`:
      (a) add `export type CheckCategory` + `export const CHECK_CATEGORY_LABELS`
      + `export const CHECK_CATEGORY_OPTIONS` (see Shared decisions) near the top
      type declarations;
      (b) add `category: CheckCategory | null` to the `AccuracyCheck` interface
      (~line 83, next to `sport`);
      (c) add `category?: CheckCategory | null` to `SaveAccuracyCheckInput`;
      (d) in `saveAccuracyCheck`'s `row` object add
      `category: input.category ?? null`;
      (e) add `category` to the `ACCURACY_CHECK_META_COLUMNS` projection string
      (the `AccuracyCheckMeta` type is `Omit<AccuracyCheck,"xml_master"|"xml_analyst">`
      so it inherits `category` automatically — no separate type edit needed, but
      confirm it does).
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npx vitest run` still passes (no behaviour change yet) and
      `npx tsc --noEmit` reports no new type errors. (node_modules must be present
      — see item 8.)

- [ ] 2. Add a focused data-layer updater for the inline edit.
      In `lib/api/accuracyChecks.ts` add
      `export async function setAccuracyCheckCategory(id: number, category: CheckCategory | null): Promise<void>`
      that PATCHes ONLY the `category` column
      (`supabase.from("accuracy_checks").update({ category }).eq("id", id)`),
      throws on error (match the error-handling style of `renameMaster`), and
      calls `invalidateAccuracyChecksMetaCache()` on success (category is now a
      meta column shown in the list). Do NOT extend `updateAccuracyCheck` (it
      re-grades and rewrites many columns; a category change must not touch
      accuracy).
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npx tsc --noEmit` clean; `npx vitest run` passes.

- [ ] 3. Create the pure auto-suggest helper.
      New file `lib/comparison/check-category.ts` exporting
      `suggestCheckCategory(args: { masterTotal: number; analystTotal: number; playerAccuracy: PlayerAccuracy }): CheckCategory`.
      Priority order EXACTLY:
      (1) Golden FIRST — if `analystTotal > 0 && masterTotal / analystTotal < 0.60`
          → `'golden_accuracy'`. If `analystTotal === 0`, skip this rule (fall
          through — no divide-by-zero, not golden).
      (2) Count groups among the FIVE
          (`passing, offensive, defensive, goalkeeper, other`) whose `.master > 0`
          on the passed `PlayerAccuracy`. `>= 3` → `'full_game'`; `1` or `2` →
          `'specific_stats'`; `0` → `'full_game'` (sensible default).
      Import the `CheckCategory` type from `@/lib/api/accuracyChecks` (type-only)
      and `PlayerAccuracy` from `@/lib/comparison/player-accuracy`. No other
      imports; no side effects.
      Files: `lib/comparison/check-category.ts`
      Verify: `npx tsc --noEmit` clean (covered by tests in item 4).

- [ ] 4. Unit-test the pure helper.
      New file `lib/comparison/check-category.test.ts` with top line
      `// @vitest-environment node`. Build a small `PlayerAccuracy` factory
      (set each group's `.master`; other fields can be minimal casts since the
      helper only reads `.master`). Cases:
      (i) golden by ratio: masterTotal=50, analystTotal=100 (0.5 < 0.6) →
          `golden_accuracy`, even when 4 groups have master events (proves ratio
          rule takes PRIORITY over group count);
      (ii) analystTotal=0 guard: masterTotal=0, analystTotal=0, 3 groups with
           master → NOT golden → `full_game`;
      (iii) 3 groups with master>0, ratio ≥0.6 → `full_game`;
      (iv) 2 groups → `specific_stats`;
      (v) 1 group → `specific_stats`;
      (vi) 0 groups (and ratio not triggering) → `full_game`.
      Files: `lib/comparison/check-category.test.ts`
      Verify: `npx vitest run lib/comparison/check-category.test.ts` — all cases
      pass.

- [ ] 5. Compute the overlap-scoped auto-suggest on the Accuracy Comparison page
      and wire the save dropdown.
      In `app/accuracy-compare/page.tsx`:
      (a) import `suggestCheckCategory`, `CHECK_CATEGORY_OPTIONS`,
          `CHECK_CATEGORY_LABELS`, type `CheckCategory`, plus `scopeToOverlap`
          (from `@/lib/comparison/overlap-window`) and
          `computePlayerAccuracyByScope` (already imported? check — add if not);
      (b) add a memo `checkCategorySuggestion` that mirrors the save path's
          overlap-scoped grade so the suggestion equals what gets stored:
          from `canonical` (already present), run
          `scopeToOverlap(canonical.master, canonical.analyst)`, then
          `compareInstances(scoped.master, scoped.analyst, tolerance, master?.name)`
          for `summary.masterTotal`/`analystTotal`, and
          `computePlayerAccuracyByScope(scoped.master, scoped.analyst, tolerance, master?.name).both`
          for the `PlayerAccuracy`; feed both into `suggestCheckCategory`.
          Returns `null` when `!canonical`.
      (c) add state `const [checkCategory, setCheckCategory] = useState<CheckCategory>('full_game')`
          and an effect that resets it to `checkCategorySuggestion` whenever the
          suggestion changes AND the user has not manually overridden it (track a
          `categoryEdited` boolean ref/state, mirroring the existing
          `labelEdited` pattern around line 1845);
      (d) in the "Save this check" bar (the flex container around lines
          2920-2990, next to the match-label input / Save button), add a labelled
          `<select>` styled like the existing week/sport selects
          (`rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm`),
          options from `CHECK_CATEGORY_OPTIONS` using `CHECK_CATEGORY_LABELS`,
          value `checkCategory`, onChange sets `categoryEdited=true` +
          `setCheckCategory(...)`;
      (e) in `handleSaveCheck` (~line 2367) pass `category: checkCategory` into
          the `saveAccuracyCheck({...})` call.
      Do NOT collide with the existing `categoryFilter` state.
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` succeeds (Turbopack production build) with
      node_modules present; manually confirm no TS errors via `npx tsc --noEmit`.

- [ ] 6. Add the inline category editor to the Saved checks table.
      In `app/accuracy-checks/page.tsx`:
      (a) import `setAccuracyCheckCategory`, `CHECK_CATEGORY_OPTIONS`,
          `CHECK_CATEGORY_LABELS`, type `CheckCategory`;
      (b) add a new `<th>` ("Category", `col="category"`, left-aligned, width
          ~`w-32`) in the table header, placed right after the "Master by"
          column header (~line 1266) — keep `SortHead` so it is sortable like the
          others; note the `expandedCheck` row `colSpan` values (`selectedAnalyst
          ? 12 : 13`) must each increase by 1 to account for the new column;
      (c) add a matching `<td>` per row (after the "Master by" cell ~line 1339)
          containing a small `<select>` (styled like the week filter select,
          compact) whose value is `c.category ?? ''`, with an `—` /
          "Uncategorised" option for the empty/NULL case plus the three
          `CHECK_CATEGORY_OPTIONS`. The `<select>` and its wrapping `<td>` must
          call `e.stopPropagation()` on click (the `<tr>` has an `onClick` that
          opens the check) so editing doesn't navigate;
      (d) onChange handler: compute the new value
          (`'' | CheckCategory` → `CheckCategory | null`), call
          `setAccuracyCheckCategory(c.id, next)`, and on success update local
          state via `setAllChecks(prev => prev.map(x => x.id === c.id ? { ...x, category: next } : x))`
          so the row reflects immediately without `load()`; on error `alert(...)`
          like `handleDelete`;
      (e) in the `sortedSavedChecks` `val()` switch add
          `case "category": return (c.category ? CHECK_CATEGORY_LABELS[c.category] : "").toLowerCase();`
          so the new column sorts (nulls sink via existing null handling).
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npm run build` succeeds; `npx tsc --noEmit` clean.

- [ ] 7. Add the category filter next to the week filter and wire it into the
      existing memo.
      In `app/accuracy-checks/page.tsx`:
      (a) add state `const [savedCategoryFilter, setSavedCategoryFilter] = useState<CheckCategory | 'all'>('all')`;
      (b) in `savedChecksCard`, INSIDE the same
          `<div className="flex items-center gap-2">` that holds the Week
          `<label>`+`<select>` (~lines 1195-1209), add a second labelled
          `<select>` ("Category") immediately after the week select, same styling,
          options: `All` (value `all`) + `CHECK_CATEGORY_OPTIONS` via
          `CHECK_CATEGORY_LABELS`, default `all`;
      (c) extend the `sortedSavedChecks` memo (~lines 555-602): after the
          `savedWeekFilter` scoping, apply the category narrowing — when
          `savedCategoryFilter !== 'all'`, keep only rows with
          `c.category === savedCategoryFilter` (NULL rows excluded); `all` keeps
          everything (NULL included). Add `savedCategoryFilter` to the memo's
          dependency array.
      Files: `app/accuracy-checks/page.tsx`
      Verify: `npm run build` succeeds; manually reason that selecting a specific
      category hides NULL + other-category rows and "All" restores them.

- [ ] 8. Build/test environment bring-up and full verification (do this BEFORE
      relying on any build/test command above; it is listed last only because it
      frames how to verify items 1-7).
      The worktree has no `node_modules` and no `.env*`. Both are gitignored, so
      copying is commit-safe. From
      `c:\Users\AndyDin\reporting-dashboard\.worktrees\check-category\reporting-ui`:
      (a) obtain dependencies — either `npm ci`/`npm install` in the worktree, OR
          (faster) copy `node_modules` from the main checkout
          `c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules`;
      (b) copy `.env` and `.env.local` from
          `c:\Users\AndyDin\reporting-dashboard\reporting-ui` into the worktree
          `reporting-ui` for the build only;
      (c) run the FULL verification:
          `npm run test` (vitest), then `npm run build` (Next v16 Turbopack
          production build), then `npm run lint`;
      (d) AFTER verification, REMOVE the copied `.env` and `.env.local` from the
          worktree so they are never committed (they are gitignored anyway —
          belt and braces). Leaving/removing `node_modules` is fine since it is
          gitignored; prefer leaving it so later steps can re-verify.
      Files: none committed (env files are temporary; node_modules gitignored).
      Verify: `npm run test` all green (incl. the new
      `check-category.test.ts`), `npm run build` completes with no errors, and
      `git status` in the worktree shows ONLY the intended source changes (no
      `.env*`, no `node_modules`).

## Notes / assumptions

- The DB `category` column already exists (nullable text). No DDL, no migration,
  no ALTER is performed anywhere in this plan.
- CSV export is intentionally NOT extended with category (task says focus on
  filter + inline edit; adding it is optional and only "if trivially
  consistent"). Left out to keep scope tight; can be added later by appending to
  the header/row arrays that already map `PLAYER_ACCURACY_COLUMNS`.
- No new dependencies are added.
- Sort order in the table for the new Category column reuses the existing
  null-sinking comparator; a NULL category sorts to the bottom like other nulls.
