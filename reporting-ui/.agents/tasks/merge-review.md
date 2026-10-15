# Merge / move checks between saved masters

Adds an admin-only "Move checks…" action to the accuracy-compare Manage dialog that moves every active check attached to one saved master (source) onto another (destination), then re-grades the whole destination group overlap-scoped against the destination master's XML. The data layer gets `mergeMasters` co-located in `accuracyChecks.ts` so it can reuse the module-private `gradeOverlapScoped`; the UI gets two pure helpers (`validMergeDestinations`, `canMergeInto`) with unit tests, a per-row picker/confirm/execute flow, and a mechanical `merge` arm on the page's `onChanged`. The design was approved in substance and the implementation folds in all three design-review findings.

Watch for: nothing blocking. The ordered mutation sequence, id-targeted writes, resilient re-grade loop, and all three findings are faithfully implemented and verified by reading (confirmed). The bulk DB run is an admin in-app action and cannot be exercised here; it was judged by careful reading of the query sequence plus the coder's reasoned walkthrough, not re-run (confirmed by design, out of scope to run).

**Verdict**: APPROVED

## High-level view

The grader is not re-implemented. `mergeMasters` lives in `accuracyChecks.ts` and calls the same module-private `gradeOverlapScoped` used by save/update/propagate/backfill, and its re-grade column object is byte-for-byte the one in `propagateMasterCorrection`. The only intentional divergence is the error policy: propagate throws on the first bad row, the merge loop collects and skips, which is exactly why it inlines the loop rather than delegating.

The mutation order is the safety contract and it matches the design: self-merge guard and empty-source no-op first; destination-XML-null and empty-destination-group guards before any write; then a single update that sets `file_name_master` and `xml_master` together on the source ids; then a resilient re-grade of the whole destination group. There is no window where a moved row carries the destination name with source XML.

Group targeting is by normalized id-list throughout (`resolveActiveGroupIds` → `.in("id", …)`), never a bare `.eq`, so case/whitespace-variant destination rows are included and the `regraded` count is honest. Soft-deleted source rows are left behind. Same-analyst duplicates are preserved because the move is by id with no `analyst_name` dedup. The intentional-collision decision is documented in the function's doc comment so a future reader does not "fix" it by re-adding `renameMaster`'s guard.

All three design-review findings are folded in: the confirm copy (both variants) now states the full blast radius, the Move button guard short-circuits on null before calling `canMergeInto`, and `MergeMastersResult.failed` drives a shortfall caveat on the success message while "Source removed." stays accurate.

Scope is respected: only `accuracyChecks.ts`, `master-manage-logic.ts` (+ its test), `ManageMastersDialog.tsx`, and the mechanical `page.tsx` merge arm changed. No engine, overlap-window, disputes, or schema edits.

<details>
<summary>Issues (0 blocking)</summary>

No blocking findings. Two non-blocking observations are recorded in the details below (shortfall-caveat semantics and the non-null-XML guard limitation), both of which the design already acknowledges and neither of which should gate shipping.

</details>

<details>
<summary>Details</summary>

## Grader reuse and the resilient re-grade loop

`mergeMasters` is defined in `lib/api/accuracyChecks.ts` (line ~718) and calls the module-private `function gradeOverlapScoped(...)` (line 148) directly — no new grader, no export of the private one. I compared the re-grade update object in the merge loop (accuracyChecks.ts ~846–867) against `propagateMasterCorrection`'s object (lines 447–462): all 14 columns match in the same order (`accuracy … avg_time_drift`, `category_breakdown`, `team_breakdown`, `xml_master`, `player_accuracy`), with `xml_master` set to the destination XML in the merge path. The two paths cannot drift on the write (confirmed).

The one deliberate difference is the failure policy. `propagateMasterCorrection` does `if (upErr) { … throw }` (line 464-ish), aborting on the first bad row. The merge loop instead logs, increments `failed`, and `continue`s (accuracyChecks.ts ~869–876), so one locked/bad row after the Step-3 move does not strand the rest. This is the stated reason for inlining rather than delegating, and it is implemented as described (confirmed).

## Ordered mutation sequence

The sequence matches the design's failure-ordering guarantee exactly (confirmed by reading accuracyChecks.ts ~760–845):

```
Step 0  normalize destName once; throw if sameMasterName(source, dest)   [pre-DB]
Step 1  sourceIds = resolveActiveGroupIds(source); empty -> no-op return  [pre-write]
Step 2  destXml = getSavedMasterXml(destCheckId); throw if null
        destCheckIds = resolveActiveGroupIds(dest); throw if empty        [pre-write]
Step 3  ONE update: file_name_master = destName AND xml_master = destXml
        .in("id", sourceIds).select("id")  -> moved
Step 4  destGroupIds = resolveActiveGroupIds(destName)
        load .in("id", destGroupIds).is("deleted_at", null)
        per-row gradeOverlapScoped + update .eq("id", row.id)  [resilient]
```

Both the null-destination-XML guard and the empty-destination-group guard sit before any write, so a missing/empty destination aborts with zero mutations. Step 3 writes name and XML in a single statement, so the forbidden "destination name but source XML" state is unreachable — if the process dies between Step 3 and Step 4 the moved rows already hold the destination XML and only the summary columns are briefly stale, reconciled by a re-run or backfill. Step 4 reloads via `resolveActiveGroupIds(destName)` then `.in("id", destGroupIds)`, not a bare `.eq("file_name_master", destName)`; since `normalizeMasterName` is trim-only while grouping folds case, the id-list is what makes "the whole destination group" literally true and `regraded` accurate. The moved rows are included because Step 3 set them to `destName` (confirmed).

The return shape is `{ moved, regraded, failed, analysts }` as required. `deleted_at` is respected (source soft-deletes excluded by `resolveActiveGroupIds` and left behind; destination load adds an explicit `.is("deleted_at", null)`). Same-analyst duplicates are preserved — the move is purely id-targeted and nothing inspects `analyst_name` for dedup; `analysts` is a `Set` used only for the success message. The intentional-collision decision is documented in a prominent doc-comment block ("INTENTIONAL COLLISION … do NOT 'fix' this by adding renameMaster's guard"), satisfying the design's §2 requirement (confirmed).

## Finding 1 — confirm copy states the full blast radius

Both confirm variants in `ManageMastersDialog.tsx` (the `row.count == null` and numeric branches) now read: *"… `<source>` will be removed, and all checks under `<dest>` will be re-graded against the `<dest>` master. This can't be undone from here."* This replaces the design's original "re-grades the moved checks" wording that understated the operation. The copy now honestly primes the admin that the whole destination group re-grades, making the success message's distinct `moved` vs `regraded` numbers intelligible. Finding 1 is genuinely folded in (confirmed).

## Finding 2 — Move button guarded against null dest

Both buttons that can trigger progression use the short-circuit guard. The confirm-step Move button: `disabled={row.busy || !row.mergeDest || !canMergeInto(m.fileName, row.mergeDest)}`. The pre-confirm "Move checks…" button uses the same `!row.mergeDest` short-circuit (and passes `row.mergeDest ?? ""` defensively, which is dead-safe because the `!row.mergeDest` term already blocks the null case). `confirmMerge` additionally re-guards with `if (!destName || !canMergeInto(...)) return;`. `canMergeInto` is never reached with null. Finding 2 is folded in (confirmed).

## Finding 3 — shortfall caveat without lying about source removal

`MergeMastersResult` carries `failed: number` (accuracyChecks.ts ~706), incremented in the resilient loop's `upErr` branch. The success message computes `regradedTotal = res.regraded + res.failed` and appends *" Some checks could not be re-graded and will reconcile on the next backfill."* only when `res.regraded < regradedTotal`, while "Source removed." is always included because the Step-3 move genuinely emptied the source. Since the loop increments exactly one of `regraded`/`failed` per loaded row, `regraded + failed` equals the loaded group size, so the shortfall test is exact (not an under/over-count). Finding 3 is folded in (confirmed).

Non-blocking observation: `regradedTotal` is derived from the result counts rather than an independently returned attempted-group total. That is fine here — the two are identical by construction — but it means the caveat is driven by the same loop that could fail; if a future change made the loop skip rows without counting them in either bucket, the caveat would silently under-report. Not a concern for this diff (the loop counts every loaded row), noted only so the invariant is explicit (possible, documented).

## Non-null-XML guard limitation (acknowledged, not a regression)

Step 2 guards only `destXml == null`, not unparsable XML. A non-null-but-unparsable destination master passes the guard, the source still moves, and every re-grade returns null-accuracy markers across the group. This matches how `propagateMasterCorrection`/backfill behave today and is reconciled by a later backfill; the design calls it out explicitly. Flagged here only because the diff touches the trust boundary of a destructive bulk operation; it is not a new gap introduced by this change (likely, matches existing behavior).

## Pure helpers and their tests

`validMergeDestinations` and `canMergeInto` are added to `master-manage-logic.ts` as the design specifies, composing the existing `sameMasterName` / `isValidMasterName`. The test file adds real coverage: `validMergeDestinations` exact-name exclusion, case/whitespace-variant exclusion, order preservation, empty input, and sole-master-is-source → empty; `canMergeInto` true/false for distinct, equal, trim/case-fold-equal, and empty/whitespace names. These are genuine assertions against behavior, not placeholders (confirmed by reading the diff).

## Scope

Changed source files are exactly `lib/api/accuracyChecks.ts`, `app/accuracy-compare/master-manage-logic.ts` (+ `.test.ts`), `app/accuracy-compare/ManageMastersDialog.tsx`, and `app/accuracy-compare/page.tsx`. The page change is the mechanical `merge` arm mirroring the `delete` branch (drops the in-view master when it was the source, then refreshes). No comparison-engine, overlap-window, disputes, or schema edits. The remaining diff entries are the `.agents/tasks` design/review docs (confirmed via `git diff main --stat`).

## Verification evidence

The coder recorded runs in `merge-verification.md`: `tsc --noEmit` exit 0 in both worktree and main tree; the pure-logic suite "19 passed" and the comparison suite "25 passed" via the main-tree vitest binary with `--root` pointed at the worktree; `next build --webpack` exit 0 in the worktree. The note documents the known worktree artifact credibly — `node_modules` is a junction into the main tree, which makes bare `npx vitest` report "No test suite found" (reproduced against an unmodified existing test to prove it is the junction, not the new code) and makes default Turbopack `next build` panic on the filesystem-root check, with the documented `--webpack` opt-out used as the workaround. The evidence is present and internally consistent, so per the step instructions I did not re-run any suite; the bulk DB move+re-grade is an admin in-app action and was judged by reading the query sequence (confirmed).

<details>
<summary>File map</summary>

- `lib/api/accuracyChecks.ts` — new `MergeMastersResult` (with `failed`) and `mergeMasters(source, dest, destCheckId)`; co-located to reuse the private `gradeOverlapScoped`.
- `app/accuracy-compare/master-manage-logic.ts` — pure `validMergeDestinations` and `canMergeInto`.
- `app/accuracy-compare/master-manage-logic.test.ts` — unit tests for both helpers.
- `app/accuracy-compare/ManageMastersDialog.tsx` — per-row merge picker/confirm/execute UI with Finding-1 copy, Finding-2 guard, Finding-3 caveat; `merge` arm on `onChanged`.
- `app/accuracy-compare/page.tsx` — mechanical `onChanged` `merge` arm mirroring `delete`.
- `.agents/tasks/design.md`, `design-review.md`, `design-review.json` — approved design + review (docs, not code).

Full diff: `git diff main` from `c:\Users\AndyDin\reporting-dashboard\.worktrees\merge-masters`.

</details>

</details>
