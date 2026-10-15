# Merge / move checks — implementation verification

Feature: admin-only "Move all checks for &lt;source&gt; into &lt;dest&gt;" (merge
saved masters) in the accuracy-compare Manage dialog. First iteration (no
`merge-review.json` present). Implemented exactly per `design.md` and folded in
the 3 remaining `design-review.md` findings.

## Files changed (scope respected)

- `lib/api/accuracyChecks.ts` — new `MergeMastersResult` interface (incl.
  `failed`, Finding 3) and `mergeMasters(sourceFileName, destFileName,
  destCheckId)`. Co-located to reuse module-private `gradeOverlapScoped`.
- `app/accuracy-compare/master-manage-logic.ts` — pure `validMergeDestinations`
  and `canMergeInto`.
- `app/accuracy-compare/master-manage-logic.test.ts` — unit tests for both.
- `app/accuracy-compare/ManageMastersDialog.tsx` — per-row merge UI (picker,
  honest Finding-1 confirm copy, Finding-2 button guard, Finding-3 shortfall
  caveat), `merge` arm on the `onChanged` union, success message using
  `res.analysts`.
- `app/accuracy-compare/page.tsx` — mechanical `onChanged` `merge` arm mirroring
  the `delete` branch (drops the in-view master if it was the source).

No DB schema change. Comparison engine, overlap-window, disputes untouched.

## Design-review findings folded in

- **Finding 1 (MEDIUM):** both confirm variants (numeric and `count==null`) now
  state the full blast radius — "&lt;source&gt; will be removed, and all checks
  under &lt;dest&gt; will be re-graded against the &lt;dest&gt; master. This
  can't be undone from here."
- **Finding 2 (NIT):** Move button guarded with
  `disabled={row.busy || !row.mergeDest || !canMergeInto(m.fileName, row.mergeDest)}`
  so `canMergeInto` is never called with null.
- **Finding 3 (NIT):** `MergeMastersResult.failed` added; the success message
  appends " Some checks could not be re-graded and will reconcile on the next
  backfill." when `regraded < regraded + failed`. "Source removed." kept.

## Verification runs

Known worktree artifact: the worktree's `node_modules` is a JUNCTION into the
main tree, which makes (a) `npx vitest` report "No test suite found" and (b)
`next build` (Turbopack, the Next 16 default) panic with "Symlink
[project]/node_modules is invalid, it points out of the filesystem root". This
is the documented Turbopack "Filesystem Root" limitation (bundled doc
`node_modules/next/dist/docs/01-app/03-api-reference/08-turbopack.md`), not a
real failure. Workarounds used below.

### Type-check — PASS

- `npx tsc --noEmit` in the WORKTREE
  (`c:\Users\AndyDin\reporting-dashboard\.worktrees\merge-masters\reporting-ui`):
  exit 0.
- `npx tsc --noEmit` in the MAIN tree
  (`c:\Users\AndyDin\reporting-dashboard\reporting-ui`): exit 0 (baseline).

### Unit tests — PASS

- Direct `npx vitest run` in the worktree hit the junction artifact ("No test
  suite found") — confirmed it also hits an unmodified existing test
  (`dispute-permissions.test.ts`), proving it is the junction, not my code.
- Workaround: ran the MAIN-tree vitest binary with `--root` pointed at the
  worktree:
  `npx vitest run --root "...\.worktrees\merge-masters\reporting-ui" app/accuracy-compare/master-manage-logic.test.ts`
  → **19 passed** (incl. the new `validMergeDestinations` / `canMergeInto`
  cases).
- Comparison suite the same way (`--root` worktree, `lib/comparison`) →
  **4 files, 25 tests passed.**

### Build — PASS

- WORKTREE `npm run build` (Turbopack) panicked on the junction (expected
  artifact).
- MAIN tree `npm run build` (Turbopack): exit 0 (baseline, unchanged sources).
- WORKTREE `npx next build --webpack` (documented Turbopack opt-out that avoids
  the filesystem-root check): **exit 0**, compiled `/accuracy-compare` and all
  routes. This builds my actual changed worktree sources.

## Bulk DB move + re-grade — reasoned walkthrough (real run is an admin in-app action)

The move+re-grade cannot run here (no DB). Verified by review of the query
sequence in `mergeMasters`:

1. **Step 0** normalizes `destName` once (`normalizeMasterName`, trim-only) and
   throws on `sameMasterName(source, dest)` (self-merge guard; mirrors
   `canMergeInto`).
2. **Step 1** `resolveActiveGroupIds(source)` → `sourceIds`; empty → no-op
   `{ moved:0, regraded:0, failed:0, analysts:[] }` (idempotent re-run).
3. **Step 2** `getSavedMasterXml(destCheckId)` → throw if null; then
   `resolveActiveGroupIds(dest)` → throw if empty. Both BEFORE any write.
4. **Step 3** a SINGLE `.update({ file_name_master: destName, xml_master:
   destXml }).in("id", sourceIds)` — id-targeted (never a bare `.eq`), name +
   XML together so a moved row never carries dest NAME with source XML.
   `moved = movedRows.length`. `deleted_at` respected (soft-deleted source rows
   were excluded by `resolveActiveGroupIds` and stay behind).
5. **Step 4** reloads the WHOLE dest group via `resolveActiveGroupIds(destName)`
   then `.in("id", destGroupIds).is("deleted_at", null)` — NOT a bare `.eq`, so
   case/whitespace-variant dest rows are included and `regraded` is accurate.
   The moved rows are included (Step 3 set them to `destName`). Each row is
   re-graded with `gradeOverlapScoped(destXml, row.xml_analyst, row.tolerance,
   destName)` — the SAME overlap-scoped grader used by
   save/update/propagate/backfill — writing the 14-column object copied VERBATIM
   from `propagateMasterCorrection` (incl. `xml_master: destXml`,
   `player_accuracy`, summary, breakdowns). The loop is RESILIENT: a per-row
   update error is logged, counted in `failed`, and skipped (never thrown), so a
   single bad row doesn't abort the rest.
6. Returns `{ moved, regraded, failed, analysts }`.

Result walkthrough: a moved check ends up under the destination name, its
`xml_master` is the destination XML, and its summary/player_accuracy are
recomputed overlap-scoped against the destination master. Same-analyst
duplicates are preserved — the merge moves by id and re-grades by group, never
inspecting `analyst_name` for dedup. The collision `renameMaster` forbids is
intentionally allowed (documented in the function's doc comment).
