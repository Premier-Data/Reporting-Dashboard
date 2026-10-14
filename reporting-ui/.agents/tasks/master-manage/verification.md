# Verification — Manage Saved Masters

Implemented per `design.md` (APPROVED) and `plan.md`. All work done inside the
worktree `c:\Users\AndyDin\reporting-dashboard\.worktrees\master-manage\reporting-ui`.
The main-tree dev server on port 3000 was not touched (no dev server started).

## Review iteration 1 — blocking finding fixed

`review.json` (verdict CHANGES_REQUESTED) raised ONE blocking finding:

> **JSON Replace empty-master guard bypass destroys graded data** — in
> `ManageMastersDialog.handleReplaceFile`, the empty-master guard
> `!looksJson && parseInstances(text).length === 0` only fired for non-JSON
> input. A JSON feed that `instancesFromRaw` resolves to zero instances skipped
> the guard and reached `propagateMasterCorrection`, overwriting `xml_master`
> on every attached check with an empty master and collapsing their accuracy —
> the exact data loss the Replace path exists to prevent.

**Fix applied** (in scope, `app/accuracy-compare/ManageMastersDialog.tsx` only):
imported the already-exported `instancesFromRaw` from `@/lib/api/accuracyChecks`
and split the guard so BOTH branches are covered before any call to
`propagateMasterCorrection`:
- JSON branch (`looksJson`): block when `instancesFromRaw(text).length === 0`
  (the same adapter `propagateMasterCorrection` uses downstream), message
  "That file has no master stats."
- XML branch: unchanged — block when `parseInstances(text).length === 0`,
  message "That file has no &lt;instance&gt; entries." (mirrors the existing
  override handler).

No user-visible behavior change beyond closing the data-loss hole: valid
XML/JSON feeds replace exactly as before; only zero-instance feeds are now
rejected on both paths. No other finding in `review.json`. Re-verified below.

### Re-verification after the fix
- `npx tsc --noEmit` → clean, exit 0.
- `npm run build` → clean, exit 0, all 35 routes generated including
  `/accuracy-compare`.
- `npx vitest --run` (with `NODE_OPTIONS=--preserve-symlinks
  --preserve-symlinks-main`, see env note below) → 7 files, 66 tests, all pass,
  no regressions.

---

Original first-iteration verification follows.

## Files changed (git status — only in-scope files)

```
 M reporting-ui/app/accuracy-compare/page.tsx
 M reporting-ui/lib/api/accuracyChecks.ts
?? reporting-ui/app/accuracy-compare/ManageMastersDialog.tsx
?? reporting-ui/app/accuracy-compare/master-manage-logic.ts
?? reporting-ui/app/accuracy-compare/master-manage-logic.test.ts
?? reporting-ui/.agents/tasks/master-manage/   (task docs + this note)
```

No changes to `lib/comparison/*`, disputes, `getMasterCheckSiblings`,
`propagateMasterCorrection` internals, or the DB schema.

## Next.js constraint honored (AGENTS.md)

Read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
(and the design's prior reading of `07-mutating-data.md`). The decision was
already LOCKED by the design: client-side Supabase mutations invoked from event
handlers — NO Server Actions / `"use server"` / route handlers / `revalidatePath`.
`page.tsx` is `"use client"` (line 1); the new `ManageMastersDialog.tsx` is also
`"use client"` because it uses state/effects/event handlers. UI refreshes by
re-calling `getSavedMasters()`.

## Commands run and results

All run from the worktree root.

### `npx tsc --noEmit`
Clean. Exit code 0, no diagnostics.

### `npm run build` (`next build`)
Clean. "Compiled successfully", "Finished TypeScript", all 35 routes generated,
including `/accuracy-compare`. Exit code 0.

### `npx vitest --run`  (unit tests)
7 test files, 66 tests, all passing — including the new suite
`app/accuracy-compare/master-manage-logic.test.ts` (10 tests). No regressions in
the existing suites (dispute-permissions, review-seek, json-adapter,
cross-exact, pitch-zone-stat, pull-to-refresh-math).

> **Environment note (important for the reviewer re-running tests).** This
> worktree's `node_modules` is a Windows **junction** to the main tree
> (`fs.realpathSync` resolves it into `...\reporting-ui\node_modules`). With the
> default Node ESM resolver this realpath-collapses the test module graph into
> the main tree, so vitest's collector cannot match the registered suites and
> every suite (including the pre-existing, unmodified ones) fails with
> **"No test suite found in file …"**. This is purely an environment artifact of
> the junctioned worktree, NOT a code problem — the identical tests pass in the
> main tree. The fix is to run vitest with Node's preserve-symlinks flags so the
> junction paths stay consistent:
>
> ```powershell
> $env:NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main"
> npx vitest --run
> Remove-Item Env:\NODE_OPTIONS
> ```
>
> With this, all 66 tests pass. No config file change was required (verified:
> `NODE_OPTIONS` alone with the stock `vitest.config.ts` is sufficient). A once-
> created temporary `vitest.worktree.config.ts` was removed; no scratch files
> remain.

### `npx eslint` (touched files)
No NEW lint findings introduced. The two new source files
(`ManageMastersDialog.tsx`, `master-manage-logic.ts`) and the test file lint
clean (0 problems). For the two edited files, the lint error COUNT is identical
in the worktree and the main tree — confirming every reported finding is
pre-existing and none sits in the lines I added:
- `lib/api/accuracyChecks.ts`: 5 findings in both trees (pre-existing
  `no-explicit-any` around lines 978–1010, outside my additions).
- `app/accuracy-compare/page.tsx`: 15 findings in both trees (pre-existing
  `react-hooks/preserve-manual-memoization` on existing `useMemo` blocks).

(One real lint error I introduced in the dialog — `set-state-in-effect` from
seeding row state synchronously in an effect — was fixed by making row state
lazily created on read and letting the effect only write counts from its async
callback.)

## API walkthrough (Supabase functions — cannot be exercised headlessly here)

These functions hit Supabase directly from the browser client, so they are
verified by careful review of the queries rather than executed in this
environment. **Live DB behavior must be confirmed by the user in-app.**

Shared helper `resolveActiveGroupIds(fileName)`:
- `select("id, file_name_master").ilike("file_name_master", fileName.trim()).is("deleted_at", null)`
  — correct table (`accuracy_checks`), active-only (`deleted_at IS NULL`), and a
  case-insensitive server prefilter.
- Then filters in JS to rows where `sameMasterName(row.file_name_master, fileName)`
  (trim + lower-case equality), adding whitespace-insensitivity the `.ilike`
  lacks and neutralizing any `_`/`%` ILIKE wildcard over-match. Returns the ids.
  This is the SAME normalized rule `getSavedMasters` uses to de-dup, so the
  dropdown grouping and the mutations' targeting agree.

`countActiveGroupSiblings(fileName)` = `resolveActiveGroupIds(fileName).length`.
Drives the deletable predicate and the advisory UI count over the normalized
group (never an exact-string count).

`renameMaster(oldFileName, newFileName)` — updates **all** siblings:
1. `next = normalizeMasterName(newFileName)` (trim). If empty → throw
   "Master name cannot be empty." BEFORE any DB write.
2. `groupIds = resolveActiveGroupIds(oldFileName)`; empty → `{ updated: 0 }`.
3. Collision guard by id-set membership: unless it's a pure case/whitespace
   self-rename (`sameMasterName(next, oldFileName)`), query active rows
   `.ilike(next)` and throw the collision message iff any matching row's id is
   NOT in `groupIds` (i.e. a DIFFERENT master). No merge.
4. `update({ file_name_master: next }).in("id", groupIds).select("id")` →
   `{ updated: rows.length }`.
   Walkthrough: because the update targets the resolved id list, every active
   sibling in the normalized group (including case/space variants) is renamed;
   after a `getSavedMasters()` refresh no leftover variant resurfaces as a
   separate entry. Soft-deleted rows keep the old name (hidden from all active
   views, so harmless). Guard is best-effort (TOCTOU; no DB unique constraint —
   out of scope), documented in the JSDoc.

`deleteMaster(fileName, deletedBy?)` — only the no-accuracy case, no orphaning:
1. `ids = resolveActiveGroupIds(fileName)`.
2. `ids.length === 0` → `{ deleted: 0 }` (idempotent; already gone).
3. `ids.length > 1` → **throw** "Cannot delete: N accuracy checks are attached
   to this master. Replace it instead." — the authoritative DB-side guard that
   makes it IMPOSSIBLE to delete a master with graded siblings, even on a
   stale/crafted call.
4. exactly 1 → soft-delete that single id:
   `update({ deleted_at: now, deleted_by }).eq("id", ids[0])`.
   Walkthrough: a soft-delete fires only when exactly one active check is in the
   normalized group — that check IS the master, so no other analyst's
   `xml_master`/accuracy is touched. Soft delete (not hard delete) means the one
   removed check remains restorable from the existing "Deleted checks" view
   (`getDeletedAccuracyChecksMeta`/`restoreAccuracyCheck`). No orphan, no data
   loss, no dispute cascade. `deletedBy` typed `string | null` to match
   `deleteAccuracyCheck`; call site passes `user?.username ?? null`.

Replace path (reuses the proven grading flow, unchanged):
- In `ManageMastersDialog`, the Replace handler reads the chosen file, guards an
  empty/unparsable master using the page's established
  `parseInstances(text).length === 0` pattern (only for non-JSON; JSON feeds are
  handled downstream by `instancesFromRaw`), then calls the EXISTING
  `propagateMasterCorrection(fileName, text)` with `file_name_master` UNCHANGED,
  so every attached check is re-graded against its own analyst XML. The returned
  `{ updated, analysts }` is surfaced ("Re-graded N checks …"). No new grading
  logic; XML and JSON feeds both work (per `instancesFromRaw`).

## Permissions

`canManageMasters = user?.role === "admin" || user?.role === "super_admin"`,
mirroring the existing `canEditMaster`/`canResolveDispute` gates. The "Manage"
button and the whole dialog are rendered only when `canManageMasters` is true,
so non-admins see exactly today's dropdown with no new controls. The dialog's
per-row affordances are additionally driven by the pure `masterAffordance`.
Note: the intended authoritative gate is Supabase RLS on `accuracy_checks`,
which lives in the Supabase project (not this repo) and could NOT be verified
here — same situation as the existing admin-gated features.

## Pure-logic unit coverage (`master-manage-logic.test.ts`, 10 tests, green)

- `isMasterDeletable`: 0→false, 1→true, 2→false, 3→false.
- `isValidMasterName`: ""/"   "/"\t \n"→false; "a"/" a "/"Game1.xml"→true.
- `normalizeMasterName`: trims surrounding whitespace, preserves inner case
  (" Game1.XML "→"Game1.XML").
- `sameMasterName`: case- and whitespace-insensitive true cases; different
  name/extension false cases.
- `masterAffordance`: non-admin → all false (counts 0/1/2); admin+1 → canDelete
  true / mustReplaceToRemove false; admin+2 → canDelete false /
  mustReplaceToRemove true; admin+0 → canManage/canRename true, delete & replace
  false.

## What still needs the user to confirm in-app (live Supabase)

Per `plan.md` item 8 (no dev Supabase exercised here), confirm against a live
DB: rename updates every normalized-group sibling with no leftover variant;
empty/whitespace rename rejected (no write); collision onto a different master
rejected, pure case/whitespace self-rename allowed; single-row master
soft-deletes and appears in "Deleted checks" (restorable); a >1-attached master
blocks delete and offers Replace; Replace re-grades all attached checks for both
XML and JSON feeds and keeps `file_name_master`; a stale-count delete that hits
the DB guard surfaces the message and refreshes the row to Replace.
```
