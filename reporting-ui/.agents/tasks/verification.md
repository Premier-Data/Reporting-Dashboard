# Verification — Overlap-scoped saved accuracy %

Worktree UI dir: `c:\Users\AndyDin\reporting-dashboard\.worktrees\overlap-scope\reporting-ui`
Iteration: FIRST implementation. (`.agents/tasks/review.json` is present but its
`verdict` is `APPROVED` with an empty `findings` array and its `reviewDoc`
points at an unrelated worktree — `...\.worktrees\ptr-bind-fix\...` — and none of
the files this task defines existed in the tree yet, so there were no findings
to fix; the task was implemented from scratch per `design.md` + `plan.md`.)

## What changed (in scope only)

1. **NEW `lib/comparison/overlap-window.ts`** — the single, shared, PURE
   overlap-window helper. No DOM, no Supabase; type-only import of `Instance`.
   - `deriveOverlapWindow(master, analyst): OverlapWindow | null` — `[min,max]`
     of the `.mid` of whichever side has FEWER instances. Master is pushed first
     and the reduce uses strict `<`, so a tie keeps master — identical to the
     compare page's `[master, analyst].reduce((a,b)=> b.length < a.length ? b : a)`.
     Returns null when both sides empty.
   - `inOverlap(i, w)` — inclusive both ends (`>= start && <= end`), identical to
     the page's `inRange`.
   - `scopeToOverlap(master, analyst)` — filters both sides by `inOverlap`;
     passes inputs through unchanged with `window: null` when underivable.

2. **NEW `lib/comparison/overlap-window.test.ts`** — pure-logic Vitest suite,
   7 tests (design Testing items 1–7). See "Tests" below.

3. **`lib/api/accuracyChecks.ts`** — single derivation + all three recompute
   paths rerouted:
   - Added `gradeOverlapScoped(xmlMaster, xmlAnalyst, tolerance, fileNameMaster)`:
     `instancesFromRaw` both sides → null if master parses empty → canonicalise
     the FULL sets with `canonicaliseTeams(masterRaw, analystRaw, tol, name)`
     (SAME arguments the compare page's `canonical` uses, incl. the master file
     name) → `scopeToOverlap` the already-canonical sets → grade with
     `compareInstances` + `computePlayerAccuracyByScope` over the scoped sets.
     Both downstream calls re-canonicalise but hit `canonicaliseTeams`'
     idempotency guard (inputs are Home/Away-only) and pass through, so the
     stored both/home/away split equals the live Overlap view's labels.
   - `saveAccuracyCheck` — now grades via `gradeOverlapScoped` from the raw
     source, NOT from `input.result.summary`. On a null grade it writes null
     accuracy columns + null `player_accuracy` + `console.warn` (an explicit
     "not graded yet" marker reconciled by backfill) — it does NOT fall back to
     the Range-dependent `input.result`.
   - `updateAccuracyCheck` — grades via `gradeOverlapScoped`; if the grade is
     null AND `input.xmlAnalyst === undefined` (a future partial caller), it
     fetches `xml_analyst, file_name_master, tolerance` for the row and re-grades
     with stored fallbacks so a good row is never blanked. All conditional
     `if (input.X !== undefined) row.Y = ...` metadata writes are preserved
     verbatim; `xml_master: input.xmlMaster` preserved.
   - `propagateMasterCorrection` — per row grades via `gradeOverlapScoped(xmlMaster,
     row.xml_analyst, row.tolerance, fileNameMaster)` and writes the full column
     set (summary + breakdowns + player_accuracy), keeping `xml_master: xmlMaster`.
     Null grade → null columns + warn + continue (does not abort). Supabase
     update error still throws. Removed the now-unused `const master = instancesFromRaw(...)`.
   - `backfillPlayerAccuracy` / `recomputeAllPlayerAccuracy` — per-row body
     rewritten guard-first: `if (xmlErr || !xmlRow) { skipped; continue }` →
     `gradeOverlapScoped(...)` → `if (!graded) { skipped; continue }` → ONE
     `update(...)` writing the full overlap-scoped column set (summary +
     breakdowns + player_accuracy). All three branches (fetch error, null grade,
     update error) `skipped += 1`, call `onProgress`, and continue — none throws.
     List query + `force ? all : .is("player_accuracy", null)` branch unchanged.
     A row is either fully overlap-scoped or untouched (idempotent).
   - Removed the obsolete `computeStoredPlayerAccuracy` wrapper (no callers
     remained after the reroute; leaving it would be dead code / unused).

4. **`app/accuracy-compare/page.tsx`** — the `analystWindow` useMemo now calls
   `deriveOverlapWindow(master.instances, analyst.instances)` and returns
   `{ start, end }` (the `source` field was dropped — a grep confirmed only
   `.start`/`.end` are read, in `effectiveRange` and the manual-range
   placeholders). Added `import { deriveOverlapWindow } from "@/lib/comparison/overlap-window"`.
   `rangeMode`, `effectiveRange`, `inRange`, `canonical`, the Range selector UI
   and every live grading memo are UNTOUCHED — the live-view Range behavior is
   unchanged (requirement 5). This is a pure React `useMemo` refactor reusing an
   already-imported helper; it uses no new Next.js API.

5. **catch/catches (requirement 6)** — NO code change needed. `baseAction` in
   `lib/comparison/xml-compare.ts` already canonicalises `\bcatches\b → catch`,
   and the overlap-scoped stored path flows through `compareInstances` →
   `sameBaseAction`, inheriting it. Already covered by `cross-exact.test.ts`
   ("scores master Catch as EXACT vs analyst Catches (and vice versa)") alongside
   no-regression cases (short vs long passes stay non-exact; unrelated-stat
   pairing unchanged).

## Commands run and results

### `npx tsc --noEmit` (worktree) — CLEAN
```
> npx tsc --noEmit
tsc exit=0
```
Type-checks the ENTIRE project, including `app/accuracy-compare/page.tsx`,
`lib/api/accuracyChecks.ts`, the new helper and the new test. (One tsc error was
found and fixed during development: the item-7 fixture passed a possibly-null
`playerNumber` into the `inst` helper; fixed with `?? 0`.)

### `npx vitest --run lib/comparison/overlap-window.test.ts` (worktree) — KNOWN ARTIFACT
```
FAIL  lib/comparison/overlap-window.test.ts
Error: No test suite found in file .../lib/comparison/overlap-window.test.ts
Test Files  1 failed (1) / Tests  no tests
```
This is the KNOWN WORKTREE ARTIFACT, NOT a real failure. Running the full suite
in the worktree reports "No test suite found" for ALL EIGHT test files
(`dispute-permissions.test.ts`, `master-manage-logic.test.ts`,
`review-seek.test.ts`, `cross-exact.test.ts`, `json-adapter.test.ts`,
`overlap-window.test.ts`, `pitch-zone-stat.test.ts`, `pull-to-refresh-math.test.ts`),
including pre-existing ones that are known-good. The cause: the worktree's
`node_modules` is a **junction** to the main tree
(`Target: c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules`),
which confuses Vitest's test discovery in a worktree.

**Proof the test suite is genuinely valid and passes** — I copied the helper +
test into the MAIN tree (real `node_modules`) and ran them there, then removed
the copies:
```
> npx vitest --run lib/comparison/overlap-window.test.ts   (in main tree)
Test Files  1 passed (1)
     Tests  7 passed (7)
```
All 7 tests pass. (The two temporary copies were deleted from the main tree
afterward; `git status` on the main tree shows no residual change.)

### `npm run build` (`next build`, worktree) — BLOCKED BY THE SAME JUNCTION (not a code error)
```
FATAL: An unexpected Turbopack error occurred.
Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid,
  it points out of the filesystem root
  ... Execution of find_package failed ...
```
Next.js 16 builds with Turbopack only (`--no-turbopack` is rejected: "unknown
option"). `next.config.js` pins `turbopack.root = __dirname` (the worktree), and
the worktree's `node_modules` junction targets the main tree OUTSIDE that root,
so Turbopack panics while resolving the `next` package itself — i.e. BEFORE any
app/lib code is compiled. Reproducible with zero code changes; purely
environmental (the worktree + junction + Turbopack combination).

**Proof the code builds clean under the real Next.js 16** — I temporarily copied
the 4 changed files into the MAIN tree, added `distDir: ".next-verify"` to its
`next.config.js` (so the running dev server's `.next` on port 3000 was NOT
touched), and ran `npm run build`:
```
> npm run build   (main tree, distDir .next-verify)
├ ○ /accuracy-compare
...  (all routes prerendered)
○  (Static)  prerendered as static content
Exit Code: 0
```
Build succeeded, including the `/accuracy-compare` route that contains the edited
page. Afterward I restored the main tree's `accuracyChecks.ts`, `page.tsx` and
`next.config.js` from backups, deleted the copied `overlap-window.ts` and the
`.next-verify` output. `git status` on the main tree shows NO residual change
from this verification. The main-tree dev server on port 3000 was never stopped
or disturbed.

### `npx eslint ...` (worktree) — NO NEW ERRORS INTRODUCED
Linting the 4 touched files reports 16 errors, but EVERY one is PRE-EXISTING in
code I did not change:
- `app/accuracy-compare/page.tsx`: React-compiler / `react-hooks` errors at
  lines 1318, 1520, 1735, 1886, and memoization errors at 1888/1896/1947/1991/
  2114/2184/2194/2201 — all in untouched memos/effects (e.g. the `[result]`
  memos), not in the `analystWindow` memo I edited (~line 1760).
- `lib/api/accuracyChecks.ts`: 4 `@typescript-eslint/no-explicit-any` errors at
  1047/1048/1056/1079 — inside `getSavedMasters` / `getSavedMasterXml`, untouched.

Confirmed pre-existing by running the SAME eslint on the MAIN tree (without my
changes): identical set of errors, only shifted by the exact line offset my new
code adds (e.g. accuracyChecks.ts `any` at 978/979/987/1010 in main → 1047/1048/
1056/1079 in worktree). The new `overlap-window.ts` and `overlap-window.test.ts`
produce no lint errors.

## Reasoned walkthrough — save / propagate / backfill derive the SAME window and write consistent values

All three paths call ONE function, `gradeOverlapScoped`, which is the only place
the window and the grade are computed:

1. **Same window.** `gradeOverlapScoped` derives the window exclusively through
   `scopeToOverlap` → `deriveOverlapWindow`, which is the SAME pure function the
   compare page's `analystWindow` now calls (item 4 above). `deriveOverlapWindow`
   depends only on each side's `.mid` values and `.length`, with master-first
   ordering + strict `<` tie-break. The window is independent of team
   canonicalisation (it never reads `.team`), so applying it before or after
   `canonicaliseTeams` selects the identical rows. Therefore save, update,
   propagate and backfill — all of which pass the SAME (master XML, analyst XML,
   tolerance, master file name) into `gradeOverlapScoped` — derive the identical
   `[start,end]`, and that window equals what the live Overlap view shows for the
   same two files. The parity unit test (item 5) reproduces the page's prior
   inline math and asserts equality with `deriveOverlapWindow`.

2. **Same labels.** Each path canonicalises the FULL sets first with
   `canonicaliseTeams(masterRaw, analystRaw, tol, name)` — the exact argument
   list the page uses for its `canonical`. Scoping then filters the
   already-canonical rows. The downstream `compareInstances` and
   `computePlayerAccuracyByScope` re-canonicalise, but their inputs are already
   Home/Away-only so they hit the idempotency guard and pass through unchanged.
   Hence the stored `both`/`home`/`away` split uses the full-set labels — the
   same labels the live Overlap view shows — not a subset-derived relabeling.
   Item-7 test asserts the full-then-scope split equals the live-path split on a
   fixture where team frequency order differs inside vs across the window.

3. **Consistent values.** Within `gradeOverlapScoped` the summary
   (`accuracy/exact/master_total/...`), the `category_breakdown`/`team_breakdown`
   and the `player_accuracy` all come from the SAME scoped, same-labelled
   instances (`compareInstances` and `computePlayerAccuracyByScope` over
   `scoped.master`/`scoped.analyst`). So the Ex/Mas pair and the OVR/PASS/OFF/
   DEF/GK/OTH columns can no longer disagree with each other, and all are
   overlap-scoped. Every write path persists exactly these fields (save/update/
   propagate/backfill use the identical column list), so a row is either fully
   overlap-scoped or (on a null grade) explicitly null and reconciled later —
   never a mix of overlap player_accuracy with full-game summary.

4. **Idempotent / deterministic backfill.** `backfillPlayerAccuracy` re-grades a
   row purely from its stored XML through the same deterministic function and
   writes the full column set; re-running yields identical values.
   `recomputeAllPlayerAccuracy` is `backfillPlayerAccuracy(onProgress, true)` —
   the admin-triggered, force-all historical re-scope (requirement 4).

## MUST be run by the user as admin (cannot run here)

The historical DB bulk re-scope — **`recomputeAllPlayerAccuracy` (force=true)**,
triggered in-app from the Accuracy History page by an admin — MUST be run by the
user. It cannot run from this environment because it needs the browser
`DOMParser` (grading is client-side) and an authenticated Supabase session.

## Stakeholder-visible knock-on

Once stored values change (new/updated/propagated checks immediately, and all
historical checks after the admin runs the backfill), EVERY analyst's historical
average and leaderboard position shifts materially: overlap scope reads HIGHER
than full-game (the analyst is now scored only on the section they actually
coded, not penalised for the rest of the match they never touched). Until the
admin runs the backfill, Accuracy History will MIX overlap-scoped new rows with
full-game old rows; this is expected and converges once backfill completes
(idempotent). The `masterTotalMismatches` sibling banner may also fire more often
under overlap scope — advisory only, not changed here.
