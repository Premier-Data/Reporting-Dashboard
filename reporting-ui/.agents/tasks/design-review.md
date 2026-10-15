# Design review: Merge / move checks between saved masters

Reviewed fresh against the actual sources in the worktree
(`c:\Users\AndyDin\reporting-dashboard\.worktrees\merge-masters\reporting-ui`).
Every claim the design makes about existing code was checked against the real
files, not taken on the design's word.

Verdict: **CHANGES_REQUESTED** (1 MEDIUM, 0 HIGH; plus NITs).

---

## Verified assumptions (checked against source)

1. **`gradeOverlapScoped` is overlap-scoped and module-private.** Confirmed in
   `lib/api/accuracyChecks.ts`: it is `function gradeOverlapScoped(...)` with NO
   `export`, canonicalises the full sets, calls `scopeToOverlap(canon.master,
   canon.analyst)`, then grades the scoped sets. `scopeToOverlap`
   (`lib/comparison/overlap-window.ts`) derives the window via
   `deriveOverlapWindow`. So the design's core claim — the propagate/merge
   re-grade is overlap-scoped and there is no full-game recompute path — is
   TRUE, and co-locating `mergeMasters` in the same module to reuse the private
   grader is correct.

2. **`propagateMasterCorrection` throws on the first per-row update error.**
   Confirmed: `if (upErr) { console.error(...); throw new Error(...) }`. The
   design's justification for inlining a resilient loop (rather than delegating)
   is accurate.

3. **`propagateMasterCorrection`'s column write object.** The 14-column update
   object quoted in the design's Step 4 is byte-for-byte identical to the real
   one in `propagateMasterCorrection` (`accuracy … player_accuracy`,
   `xml_master` set to the master XML). Verified.

4. **`resolveActiveGroupIds` targets the normalized active group by id.**
   Confirmed: `.ilike` loose prefilter + JS `sameMasterName` narrowing,
   `deleted_at IS NULL`, returns ids. The design's "never a bare `.eq`" and
   "soft-deleted source rows are left behind" claims hold.

5. **`renameMaster` forbids the collision `mergeMasters` must allow.** Confirmed:
   it throws `A master named "…" already exists.` when an active row OUTSIDE the
   group matches the target name, and updates by `.in("id", groupIds)`. The
   design's "reuse mechanics, bypass the guard, do NOT call renameMaster"
   framing is correct.

6. **`normalizeMasterName` is trim-only (no case-fold); `sameMasterName` is
   `trim().toLowerCase()`.** Confirmed in BOTH `master-manage-logic.ts` and the
   inlined copies in `accuracyChecks.ts`. This is the lynchpin of the design's
   Step-4 fix (use `resolveActiveGroupIds(destName)`, not a bare `.eq`), and the
   reasoning is sound: a bare `.eq(destName)` would miss case/whitespace variant
   dest rows.

7. **`getSavedMasters` / `getSavedMasterXml` shapes.** Confirmed: `SavedMaster =
   { checkId, fileName, videoUrl }`, de-duped by normalized name, most-recent
   (`created_at desc`) wins, only non-null `xml_master` rows listed.
   `getSavedMasterXml(checkId)` returns the row's `xml_master` or `null` on
   error/missing. Design's Step 2 guard semantics are accurate.

8. **Dialog patterns.** Confirmed `RowState`, `freshRow`, `patchRow`, the mount
   effect that fills `count` via `countActiveGroupSiblings`, and
   `handleReplaceFile`'s message-composition template
   (`` `Replaced. Re-graded ${res.updated}…${res.analysts.join(", ")}` ``). The
   `onChanged` prop union is exactly `rename | delete | replace`; the page
   consumer branches on `change.type` and always calls `refreshSavedMasters()`.
   The design's wiring plan (add a `merge` arm mirroring `delete`) is mechanical
   and consistent.

9. **Admin gating.** Confirmed: dialog takes `isAdmin`, derives
   `masterAffordance(count, isAdmin)`, and `aff.canManage === isAdmin`. The
   feature being gated behind `aff.canManage` matches the existing controls.

10. **`master-manage-logic.ts` currently has no `validMergeDestinations` /
    `canMergeInto`.** Confirmed — they are new, as the design states, and the
    helpers they compose (`sameMasterName`, `isValidMasterName`) exist and
    behave as described.

## Unverified / wrong assumptions

None. Every existing-code claim in the design was verifiable and correct. The
design is unusually well grounded in the actual sources.

---

## Findings

### 1. [MEDIUM] Confirm copy understates the blast radius — the whole destination group is re-graded and re-tagged, not just "the moved checks"

**Where:** §4 "Interaction flow" step 3 (confirm copy), both the `count == null`
and numeric variants.

**Problem.** The confirm text tells the admin: *"This re-grades the moved checks
against `<dest>`."* But the normative Step 4 (and its side-effect note) re-grade
the ENTIRE destination group and overwrite `xml_master` on every destination row
with `destXml` — including the destination's pre-existing checks. The design
explicitly and intentionally does this ("single source of truth" consolidation),
and even notes that if a destination row previously held a *different*
`xml_master` (e.g. a prior partial replace) it is silently overwritten and
re-graded. For a destructive, bulk, admin-gated operation, the confirm dialog is
the one place the operator consents to the blast radius — and it currently
describes a strictly smaller operation than what runs. In the common
identical-duplicate case this is invisible, but the design itself admits the
non-identical case exists, and that is exactly the case where an operator would
want to know their existing destination scores are about to be recomputed.

**Concrete fix.** Make the confirm copy state the real scope. For the numeric
variant:

> **Move all checks for `<source>` into `<dest>`**
> Move N check(s) for "`<source>`" into "`<dest>`". "`<source>`" will be
> removed, and **all checks under "`<dest>`" will be re-graded against the
> "`<dest>`" master**. This can't be undone from here.

(and the analogous `count == null` variant). This also makes the success copy's
two distinct numbers — `moved` (N) vs `regraded` (whole group) — intelligible,
since the confirm now primes the admin that more rows re-grade than move.

---

### 2. [NIT] `canMergeInto` is specified against the typed source name, but §4 passes `mergeDest` which can be `null`

**Where:** §3 `canMergeInto(sourceFileName: string, destFileName: string)` vs §4
step 3 "`disabled unless canMergeInto(m.fileName, mergeDest)`", where
`RowState.mergeDest` is typed `string | null`.

**Problem.** `canMergeInto` takes `destFileName: string`, but the UI holds
`mergeDest: string | null`. Passing a `null` into a `string` param either fails
typecheck or, if coerced, `isValidMasterName(null as any)` throws on
`.trim()`. The design never says how the Move button behaves while
`mergeDest === null` (before a destination is picked) beyond "disabled unless
canMergeInto".

**Concrete fix.** Specify the button guard explicitly:
`disabled={row.busy || !row.mergeDest || !canMergeInto(m.fileName, row.mergeDest)}`,
so `canMergeInto` is only ever called with a non-null string. No signature
change needed.

---

### 3. [NIT] Success copy claims "Source removed." unconditionally, but a per-row failure path can leave the source emptied yet report a partial re-grade

**Where:** §4 step 3 success copy:
`` `Moved ${res.moved} … re-graded ${res.regraded} … Source removed.` ``

**Problem.** `mergeMasters` moves the source rows in Step 3 (so the source IS
emptied) and then collects per-row re-grade failures in Step 4 without throwing.
If some destination-group rows fail to re-grade, `res.regraded < group size`,
yet the copy still says "Source removed." with no hint that some rows did not
re-grade. The source genuinely is removed, so "Source removed" is not wrong, but
the operator gets no signal that a subset silently failed and awaits a
backfill/retry.

**Concrete fix.** When `res.regraded` is less than the destination group size,
append a note, e.g. append `" Some checks could not be re-graded and will
reconcile on the next backfill."` The design would need `mergeMasters` to also
return the attempted-group total (or a `failed` count) so the UI can detect the
shortfall — a small addition to `MergeMastersResult`
(`failed: number` or `attempted: number`). Minimal and keeps the operator
honestly informed.

---

## Focus-question coverage

- **Overlap-scoped re-grade reuses the same path, no full-game recompute:**
  CONFIRMED by source (finding set, Verified #1). ✔
- **Mutation ordering race-conscious (name + XML in one update, then re-grade):**
  Step 3 sets `file_name_master` AND `xml_master` in a single `.update`, Step 4
  re-grades. The forbidden "dest name but source XML" window cannot occur. ✔
- **Targets by ACTIVE id-list via `resolveActiveGroupIds`, allows the collision
  renameMaster forbids:** Steps 1, 2, 4 all use `resolveActiveGroupIds`; §2
  states no collision guard, deliberately. ✔
- **source===destination / empty source / missing destination XML guarded:**
  Step 0 self-merge throw, Step 1 empty-source no-op, Step 2 null-XML +
  empty-dest throws, all pre-write. ✔
- **Same-analyst checks preserved (not deduped):** §2 and Edge Cases confirm
  move-by-id, no `analyst_name` inspection. ✔
- **Admin-gated, explicit confirm, idempotent, resilient:** gating via
  `aff.canManage`; confirm step present (but see Finding 1 on its wording);
  idempotent empty-source re-run; Step 4 collects/skips per-row failures. ✔
- **Scope respected (no schema change, no engine/overlap/disputes edits):** §5
  no schema change; only `accuracyChecks.ts`, `master-manage-logic.ts`
  (+ test), `ManageMastersDialog.tsx`, and the additive `page.tsx` `onChanged`
  arm (called out, mechanical). No comparison-engine or overlap-window edits. ✔

The design is sound and faithfully grounded in the real code. The one blocking
item is a user-facing honesty gap in the confirm dialog for a destructive bulk
operation (Finding 1); the two NITs tighten the UI contract and the failure
reporting.
