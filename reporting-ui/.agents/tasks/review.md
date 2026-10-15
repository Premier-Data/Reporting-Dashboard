# Overlap-scoped saved accuracy % with shared window helper

Every stored accuracy figure on a saved check (`accuracy`, `exact`, `master_total`, the breakdowns, and the whole `player_accuracy` JSON that feeds analyst profiles and leaderboards) is now derived OVERLAP-SCOPED through a single shared pure function, so the saved number matches what the compare page shows in Overlap mode regardless of which Range was on screen at save time. A new `lib/comparison/overlap-window.ts` holds the one definition of the overlap window; all three recompute paths in `lib/api/accuracyChecks.ts` (save/update, `propagateMasterCorrection`, `backfillPlayerAccuracy`/`recomputeAllPlayerAccuracy`) and the compare page's live `analystWindow` route through it. The approach canonicalises the FULL master/analyst sets first (same arguments the live view uses, including the master file name), then filters by the overlap window, so the stored Home/Away split provably matches the live labels, not just the headline. The catch/catches "same stat" requirement needed no code change in this diff — the rule already lives in `baseAction`/the synonym map on `main` and is inherited unchanged.

Watch for: (confirmed) `computeStoredPlayerAccuracy` was fully removed rather than kept as the "thin wrapper" the plan described — this is cleaner, not a defect, since it had no external callers. (possible) The compare page's `analystWindow` null-guard tightened from "at least one file has instances" to "both file objects present"; this only changes a manual-range placeholder in a single-file-loaded state where no comparison is possible, so it is cosmetic and does not touch live-view grading.

**Verdict**: APPROVED

## High-level view

The window math is now one pure module. `deriveOverlapWindow` returns `[min,max]` of the `.mid` values of whichever side has fewer instances, with master pushed first and a strict `<` tie-break so a tie keeps master — reproducing the compare page's prior inline `reduce` exactly. The live page's `analystWindow` and the API's `gradeOverlapScoped` both call it, so there is a single definition of "overlap" and the saved number is provably the same window the Overlap view shows.

The label-correctness argument hinges on ordering: canonicalise the FULL sets (with the master file name) first, THEN scope by `.mid`. Scoping first and canonicalising the subset could resolve Home/Away from window-local team frequencies and flip the split — the earlier (v1) bug this revision fixes. Because the scoped inputs are already Home/Away-only, the downstream `compareInstances` and `computePlayerAccuracyByScope` re-canonicalisations hit `canonicaliseTeams`' idempotency guard and pass through unchanged, so the stored both/home/away split equals the live labels. That guard and the empty-team early-return both exist in the (unchanged) `xml-compare.ts`.

All four write paths call the same `gradeOverlapScoped(xmlMaster, xmlAnalyst, tolerance, fileNameMaster)` and persist an identical column set, so summary and `player_accuracy` can no longer disagree and the three recompute paths are mutually consistent, deterministic, and idempotent. A null grade (unparsable/empty master) is handled uniformly: write null accuracy columns plus a `console.warn`, never a fall-back to the range-dependent `input.result`, so the "always overlap" invariant can't be silently broken; the row is reconciled by a later backfill.

The compare page's live Range selector (`rangeMode`, `effectiveRange`, `inRange`, `canonical`, every live grading memo) is untouched — the only edit repoints the auto-window memo at the shared helper. Core matching in `xml-compare.ts` is not altered; the diff reuses `compareInstances`/`canonicaliseTeams` on filtered inputs only. The pure test suite encodes the synthetic-window and label-parity assertions.

<details>
<summary>Issues (2)</summary>

1. **Plan/impl drift on `computeStoredPlayerAccuracy`** — the plan said reimplement it as a thin wrapper; the implementation removed it entirely. Non-blocking: there were no external callers (it was a module-local function), removal is cleaner, and the verification doc records the decision. No action required.
2. **`analystWindow` single-file null behavior** — the memo now returns null when either `master` or `analyst` is absent, whereas the old code derived a window from whichever single side had instances. Only affects the manual-range input placeholder when exactly one file is loaded (a state with no gradeable comparison). Cosmetic; leave as is unless the placeholder hint matters.

</details>

<details>
<summary>Details</summary>

### One pure window, shared by the live view and all stored paths

`deriveOverlapWindow` pushes `master` as the first candidate and reduces with strict `b.arr.length < a.arr.length`, so a length tie keeps master — identical to the page's old `[master, analyst].reduce((a,b)=> b.instances.length < a.instances.length ? b : a)`. `inOverlap` is inclusive on both ends, matching the old `inRange`. The window reads only `.mid`/`.length` and never `.team`, so applying it before or after `canonicaliseTeams` selects the identical rows. The parity test reproduces the page's prior inline math as an oracle and asserts equality for several fixtures, which is the concrete "saved == what I see in Overlap mode" proof for window selection and bounds.

The compare page edit is the whole of the live-view change: the `analystWindow` memo now calls `deriveOverlapWindow(master.instances, analyst.instances)` and returns `{start, end}`. The dropped `source` field was dead (only `.start`/`.end` are read, in `effectiveRange` and the manual-range placeholders). `effectiveRange` still honours full/manual/auto exactly as before.

### Canonicalise-full-then-scope keeps the stored labels equal to the live labels

`gradeOverlapScoped` canonicalises the full sets with `canonicaliseTeams(masterRaw, analystRaw, tol, name)` — the same argument list the page's `canonical` memo uses, master file name included — then `scopeToOverlap`s the already-canonical sets, then grades. The downstream `compareInstances` and `computePlayerAccuracyByScope` re-canonicalise, but their inputs are already Home/Away-only, so they hit the idempotency guard (`isCanon(master) && isCanon(analyst)`) and pass through, preserving the full-set labels. Both the guard and the `mTeams.length === 0 || aTeams.length === 0` early return are present in the unchanged `xml-compare.ts`, so the two-leg label-preservation the design relies on holds. The item-7 fixture builds a case where team frequency order differs inside the window versus across the full game and asserts the full-then-scope split equals the live full-then-filter split, guarding against regressing to the v1 scope-first ordering.

### Four paths, one derivation, consistent writes

```
                      gradeOverlapScoped(xmlMaster, xmlAnalyst, tol, name)
                                      |
         canonicaliseTeams(FULL) -> scopeToOverlap -> deriveOverlapWindow
                                      |
             compareInstances + computePlayerAccuracyByScope (scoped)
                                      |
      summary + category/team breakdown + player_accuracy  (one column set)
         ^save        ^update        ^propagate(per row)      ^backfill(per row)
```

Save grades from the raw source rather than `input.result.summary`, so the stored value no longer reflects the on-screen Range. Update calls the same helper and, only when a future caller omits `xmlAnalyst` entirely (`=== undefined`) AND the grade is null, re-fetches the stored `xml_analyst`/`file_name_master`/`tolerance` to avoid blanking a previously-good row; the sole current caller (`handleUpdateCheck`) always passes the analyst XML, so this branch is defensive. All conditional `if (input.X !== undefined) row.Y = ...` metadata writes are preserved verbatim, as is `xml_master: input.xmlMaster`. Propagate grades each sibling against the corrected master through the same helper and persists `xml_master: xmlMaster`, so a master correction can no longer silently rewrite siblings back to full-game scope. Backfill grades each row from stored XML and writes the full column set in one update, so a row is either fully overlap-scoped or untouched — never a mix of overlap `player_accuracy` with stale full-game summary. Because the function is pure in `(xml, tolerance, fileName)`, re-running backfill yields identical values (idempotent), and `recomputeAllPlayerAccuracy` is just `backfill(force=true)`.

### Failure modes: fail to null, never fail to full-game

A null grade is reachable only when the source is unparsable or the master parses empty. Every path treats null the same way: write null accuracy columns, `console.warn`, and (for the bulk paths) skip-and-continue — none falls back to the range-dependent `input.result`, which is what preserves the "always overlap" invariant. Backfill keeps the preserved per-row fetch guard first (`if (xmlErr || !xmlRow) { skipped; continue }`), so a per-row fetch error is counted and skipped rather than aborting the whole run; the three skip branches (fetch error, null grade, update error) all increment `skipped`, call `onProgress`, and continue, and only the Supabase update error path retains the existing contract. Propagate likewise warns-and-continues on a null row while still throwing on a Supabase update error.

### Scope discipline and the removed helper

Core matching is untouched: `xml-compare.ts` and `player-accuracy.ts` show no diff against `main`, and the API layer reuses `compareInstances`/`canonicaliseTeams`/`computePlayerAccuracyByScope` on filtered inputs only. The now-unused `const master = instancesFromRaw(xmlMaster)` in propagate was removed, keeping `instancesFromRaw` otherwise referenced. `computeStoredPlayerAccuracy` was removed entirely (zero remaining references in the worktree) rather than kept as the plan's "thin wrapper"; since it was never exported this is a clean simplification, and the verification doc records it.

### catch/catches already in the base

The diff makes no change to `xml-compare.ts`. `git show main:...xml-compare.ts` confirms `.replace(/\bcatches\b/g, "catch")` in `baseAction` and the `catch`/`catches`/`claims`/`saves` cross-synonym map are already on `main`, so the overlap-scoped stored path inherits the "treat catch and catches as the same exact stat" behaviour through `compareInstances` → `sameBaseAction` with no API-layer change. `cross-exact.test.ts` (unchanged) already asserts master `Catch` vs analyst `Catches` and the reverse score exact, alongside no-regression cases (short vs long passes stay non-exact), so there is no risk of this normalisation merging unrelated stats.

### Verification evidence

`tsc --noEmit` is clean (exit 0) over the whole project per the verification doc. The vitest "No test suite found" symptom is the documented worktree artifact: the worktree's `node_modules` is a junction pointing outside the Turbopack root, which breaks both vitest discovery (all eight test files report it, including known-good pre-existing ones) and the Turbopack build in the worktree. The coder reproduced a clean `npm run build` and 7/7 passing `overlap-window.test.ts` by copying the files into the main tree (real `node_modules`) and then restored it, leaving no residual change. Given tsc is clean and the artifact signature is as documented, that symptom is not a real failure, so no spot-check run was warranted.

</details>

<details>
<summary>File map</summary>

- `lib/comparison/overlap-window.ts` (new) — pure shared window helper: `deriveOverlapWindow`, `inOverlap`, `scopeToOverlap`; no DOM/Supabase.
- `lib/comparison/overlap-window.test.ts` (new) — 7 pure-logic tests: window selection/tie-break, inclusive bounds, empty-side, page-parity oracle, synthetic `[1200,1800]` grading effect, full-then-scope label parity.
- `lib/api/accuracyChecks.ts` — adds `gradeOverlapScoped`; reroutes save/update/propagate/backfill through it; removes `computeStoredPlayerAccuracy` and the unused propagate master parse.
- `app/accuracy-compare/page.tsx` — `analystWindow` memo repointed at `deriveOverlapWindow`; `source` field dropped; no other live-view change.
- `lib/comparison/xml-compare.ts`, `player-accuracy.ts`, `cross-exact.test.ts` — unchanged vs `main` (catch/catches already present on base).

Full diff: `git diff main` in `c:\Users\AndyDin\reporting-dashboard\.worktrees\overlap-scope` (plus the two untracked new files under `reporting-ui/lib/comparison/`).

</details>
