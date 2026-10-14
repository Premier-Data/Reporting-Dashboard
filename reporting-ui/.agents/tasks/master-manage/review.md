# Admin-only manage saved masters (rename / delete / replace)

Adds an admin-gated "Manage saved masters" dialog to the Accuracy Comparison page letting admins rename a saved master's display filename, soft-delete a one-off master, or replace a shared master's file (re-grading every attached check). The feature is deliberately narrow: a pure-logic module plus unit tests, three new data-layer functions in `lib/api/accuracyChecks.ts`, a new `ManageMastersDialog.tsx`, and wiring in `page.tsx`. All mutations resolve a master to its *normalized group* (trim + case-insensitive) and act by row-id list, so the dropdown's grouping and the mutations' targeting always agree. Delete is guarded both in the UI and authoritatively in the data layer so a master with more than one attached check can never be deleted.

Watch for: nothing blocking. The delete safety guard is correct and fail-closed (confirmed); the JSON-replace empty-master data-loss hole flagged in the prior review pass is fixed and present in the code (confirmed); the rename collision guard is best-effort TOCTOU by design and documented (confirmed, accepted per design). One scope note on `git diff main --stat` showing `playhq-worker` is explained below and is NOT a feature change (confirmed).

**Verdict**: APPROVED

## High-level view

Delete safety is the central concern and it holds. `deleteMaster` re-resolves the normalized group inside the mutation and throws when more than one active row is attached, before any write — the UI predicate is only a first-line gate. A soft-delete fires only when exactly one active check is in the group, that check *is* the master, and the removal is recoverable from "Deleted checks". No path can orphan or destroy another analyst's graded accuracy.

Rename updates `file_name_master` across every active sibling in the normalized group via an id-list `update`, with a best-effort collision guard that distinguishes a different master (reject) from a pure case/whitespace self-rename (allow). The TOCTOU window is real, documented in the JSDoc, and accepted per the design (no DB unique constraint, out of scope).

Replace reuses `propagateMasterCorrection` unchanged, keeps `file_name_master` constant, and reports `{updated}`. Because that function has no empty-master guard of its own, the dialog guards zero-instance feeds on both the JSON (`instancesFromRaw`) and XML (`parseInstances`) branches before calling it — the fix for the prior pass's blocking finding.

Permissions mirror the existing `canEditMaster`/`canResolveDispute` pattern (`role === "admin" || "super_admin"`): the Manage button and the whole dialog render only for admins, and the delete DB-side guard backstops the client gate.

Scope is clean: the five in-scope files are the only working-tree changes. The pure predicate and filename helpers are extracted and unit-tested (66 tests green per the verification evidence).

<details>
<summary>Issues (2)</summary>

1. **`git diff main --stat` shows out-of-scope files (informational)** — the stat includes `playhq-worker/src/index.ts` and prior `page.tsx` edits because the branch's merge-base sits behind `main`; `git status` confirms the uncommitted working-tree changes are exactly the five in-scope files. No action needed for this feature; reviewers comparing against `main` should diff the working tree, not the full branch range.
2. **Rename collision guard is best-effort TOCTOU (accepted)** — two admins renaming toward the same name concurrently can still produce a duplicate; surfaced on the next `getSavedMasters()` refresh. Documented in the JSDoc and the design marks a DB unique constraint out of scope. No change required.

</details>

<details>
<summary>Details</summary>

### Delete is fail-closed over the normalized group

`deleteMaster` (confirmed) resolves ids via `resolveActiveGroupIds`, then: `ids.length === 0` → `{deleted: 0}` no-op; `ids.length > 1` → throws `"Cannot delete: N accuracy checks are attached to this master. Replace it instead."` *before any mutation*; exactly one → soft-delete that single id with `deleted_at`/`deleted_by`. This is the authoritative guard — it does not trust the UI's advisory count. The predicate matches the design's `deletable(fileName) ≡ countActiveGroupSiblings === 1` exactly, and the count is over the normalized group (`resolveActiveGroupIds` = `.ilike(trimmed)` prefilter + JS `sameMasterName` filter), identical to the key `getSavedMasters` uses to de-dup (confirmed by reading both). So a `count===1` delete cannot leave a folded-in case/whitespace variant alive, and because it is a soft delete the one removed check stays restorable. No hard delete, no touch to `xml_master`/`xml_analyst`, no dispute cascade. The no-orphan property holds.

The UI delete path (`confirmDelete`) also handles a stale advisory count: if the DB-side `>1` guard throws, it surfaces the thrown message, re-fetches the real count, and the row flips to offering Replace (confirmed) — matching AC #9.

### Rename targets the whole group by id

`renameMaster` (confirmed) computes `next = normalizeMasterName(newFileName)`, rejects an empty-after-trim name pre-DB (no write), resolves `groupIds` from the old name, returns `{updated: 0}` on an empty group, and updates `file_name_master = next` via `.in("id", groupIds)` — so every active sibling in the normalized group (including case/whitespace variants) regroups under the new name with no stray variant left behind (AC #3). Soft-deleted rows are intentionally untouched.

The collision check is defined by id-set membership: it queries active rows `.ilike(next)` and rejects only when a matching row's id is *not* in `groupIds` (a genuinely different master), while skipping the query entirely for a pure case/whitespace self-rename where `sameMasterName(next, oldFileName)` is already true (confirmed). This is exactly the design's AC #5 behavior — reject a merge onto a different master, allow a self-rename. The guard is best-effort against concurrent writers; the JSDoc states the TOCTOU limitation and that a DB unique constraint is out of scope.

### Replace reuses the proven grading path and guards empty masters

The Replace handler calls `propagateMasterCorrection(m.fileName, text)` unchanged, keeping `file_name_master` constant (confirmed), and reports `Re-graded N check(s)` from the returned `{updated, analysts}`. I confirmed `propagateMasterCorrection` matches by `.eq("file_name_master", ...)`, re-grades each row against its own `xml_analyst`, and has **no empty-master guard of its own** — so without a call-site guard an empty feed would overwrite `xml_master` across every attached check and collapse their accuracy. The dialog guards both input shapes before calling it:

```
looksJson = /\.json$/i.test(f.name) || text.trimStart().startsWith("{")
  looksJson:  instancesFromRaw(text).length === 0  → block "That file has no master stats."
  else (XML): parseInstances(text).length === 0    → block "That file has no <instance> entries."
```

`instancesFromRaw` is the same adapter `propagateMasterCorrection` uses downstream, so the JSON branch guards against exactly what would reach the grading path. This closes the prior pass's blocking finding (the earlier code only guarded the non-JSON branch). The exact-match limitation of `propagateMasterCorrection` on an un-renamed case/whitespace group is a pre-existing property the design explicitly keeps out of scope; this feature does not worsen it.

### Permissions mirror the existing pattern

`canManageMasters = role === "admin" || "super_admin"` (confirmed), declared next to `canEditMaster`. The Manage button renders only when `canManageMasters`, and the whole `<ManageMastersDialog>` is wrapped in `canManageMasters && manageMastersOpen` so non-admins see today's dropdown unchanged (AC #1). Inside the dialog, per-row affordances are driven by the pure `masterAffordance(count, isAdmin)`, and the delete DB-side guard backstops the client gate. The intended authoritative gate (Supabase RLS) lives outside this repo and is unverifiable here — the same honest caveat the design and the existing admin-gated features carry.

### Scope and the `git diff main --stat` artifact

The uncommitted working tree (per `git status`) is exactly: modified `app/accuracy-compare/page.tsx` and `lib/api/accuracyChecks.ts`; untracked `ManageMastersDialog.tsx`, `master-manage-logic.ts`, `master-manage-logic.test.ts` (plus the `.agents/tasks` docs). No change to `lib/comparison/*`, disputes, `getMasterCheckSiblings`, `propagateMasterCorrection` internals, or the DB schema (AC #11).

`git diff main --stat` additionally shows `playhq-worker/src/index.ts` and larger `page.tsx` deltas because the branch merge-base (`2dd013e`) is behind `main` — those are committed Live-Scores history on the branch, not this feature's work. Confirmed via `git status` + `git log`. Informational only.

### Tests

The pure contract is extracted into `master-manage-logic.ts` and unit-tested in `master-manage-logic.test.ts` (confirmed): `isMasterDeletable` (0/1/2/3), `isValidMasterName` (empty/whitespace/real), `normalizeMasterName` (trims, preserves inner case), `sameMasterName` (case- and whitespace-insensitive true cases, different-name/extension false cases), and the full `masterAffordance` matrix across admin∈{true,false} × count∈{0,1,2}. The data layer inlines character-identical copies of the three helpers with a comment pointing at the logic module as the single contract (avoids a `lib/`→`app/` import), so the tested definitions and the runtime definitions stay in lockstep.

Not tested (by design — needs a live Supabase, cannot be unit-mocked): `resolveActiveGroupIds`/`renameMaster`/`deleteMaster`/replace DB effects. The verification note records these as a manual checklist. The build (`next build`), `tsc --noEmit`, and `vitest --run` (66 tests, with the documented worktree junction `--preserve-symlinks` caveat) are all clean per `verification.md`; I spot-confirmed every import the new code depends on resolves (`instancesFromRaw`, `propagateMasterCorrection`, `SavedMaster` from accuracyChecks; `parseInstances` from xml-compare) and did not re-run the suites.

</details>

<details>
<summary>File map</summary>

- `app/accuracy-compare/master-manage-logic.ts` — new pure module: `isMasterDeletable`, `isValidMasterName`, `normalizeMasterName`, `sameMasterName`, `masterAffordance`.
- `app/accuracy-compare/master-manage-logic.test.ts` — new unit tests for all five pure functions.
- `app/accuracy-compare/ManageMastersDialog.tsx` — new admin-only client dialog: rename/delete/replace per row, empty-master guard on both JSON and XML branches, stale-count handling.
- `lib/api/accuracyChecks.ts` — new `resolveActiveGroupIds` (internal), `countActiveGroupSiblings`, `renameMaster`, `deleteMaster`; inlined copies of the three equality/validation helpers.
- `app/accuracy-compare/page.tsx` — `canManageMasters` gate, `refreshSavedMasters`, Manage button, dialog wiring with in-view master reflection on rename/replace/delete.

Full feature diff: `git diff -- app/accuracy-compare/page.tsx lib/api/accuracyChecks.ts` plus the three untracked files above (`git status`).

</details>
