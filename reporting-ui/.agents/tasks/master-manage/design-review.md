# Design Review — Manage Saved Masters (iteration 2)

Reviewed: `.agents/tasks/master-manage/design.md`
Repo grounded at: `c:\Users\AndyDin\reporting-dashboard\.worktrees\master-manage\reporting-ui`

This is a fresh, standalone read of the design, cross-checked against the actual
source. I verified the schema/behavior of `accuracy_checks` access helpers in
`lib/api/accuracyChecks.ts`, the dropdown and permission gates in
`app/accuracy-compare/page.tsx`, the auth type in `lib/api/auth.ts`, and the
existence of the `dispute-permissions` test pattern the design mirrors.

## Verdict summary

The central HIGH finding from the prior iteration (mutation key vs dropdown
grouping key) is resolved coherently: all operations route through a single
`sameMasterName`/`resolveActiveGroupIds` rule and act by row-id list. The delete
predicate is concrete and schema-grounded, the no-orphan argument is sound given
the soft-delete model, the rename scope and collision policy are exact, Replace
reuses `propagateMasterCorrection` unchanged with `file_name_master` held
constant, and permission gates match the existing admin/super_admin pattern.

I found no HIGH or MEDIUM blocking issues. Remaining items are NITs.

## Verified Assumptions

1. **No `masters` table; a "saved master" is derived.** Confirmed. `getSavedMasters()`
   selects `id, file_name_master, video_url, created_at` with `xml_master IS NOT NULL`
   and `deleted_at IS NULL`, newest-first, then de-dups by `fileName.trim().toLowerCase()`.
   The design's description is exact.
2. **De-dup key is `trim().toLowerCase()`.** Confirmed in `getSavedMasters` (`const key = fileName.trim().toLowerCase()`),
   which is precisely the `sameMasterName` rule the design adopts everywhere.
3. **`SavedMaster.fileName` is the newest row's raw stored string (not normalized).**
   Confirmed — `masters.push({ ..., fileName })` uses the raw `file_name_master`, while
   only `key` is normalized for dedup.
4. **`saveAccuracyCheck` writes `file_name_master` raw (no trim/case-fold).** Confirmed:
   `file_name_master: input.fileNameMaster ?? null`. The design correctly refuses to
   assume stored names are canonicalized.
5. **The only insert path is `saveAccuracyCheck`, requiring a non-empty analyst and a
   full result.** Confirmed. `analyst_name: input.analystName.trim()` and the full
   `result.summary` are always written. There is no placeholder/un-graded master insert,
   so the design's rejection of a "placeholder vs graded" predicate is correct and the
   count-based predicate is the only grounded option.
6. **`propagateMasterCorrection(fileNameMaster, xmlMaster)` keys on exact `.eq("file_name_master", …)`,
   filters `deleted_at IS NULL`, rewrites `xml_master`, re-grades each row against its own
   `xml_analyst`, recomputes `player_accuracy`, returns `{ updated, analysts }`.** Confirmed
   line-by-line. The Replace reuse and its stated exact-match limitation are accurate.
7. **`instancesFromRaw` handles a leading-`{` JSON feed**, so JSON masters re-grade.** Confirmed —
   it routes `{`-prefixed input through `jsonEventsToInstances`. Replace's XML-or-JSON claim holds.
8. **Soft-delete mechanism.** `deleteAccuracyCheck(id, deletedBy?: string | null)` sets
   `deleted_at = new Date().toISOString()` and `deleted_by`. `restoreAccuracyCheck` /
   `getDeletedAccuracyChecksMeta` provide recovery. `deleteMaster`'s claimed mechanism and
   recoverability match exactly. The `deletedBy?: string | null` signature matches the
   design's `user?.username ?? null` call-site (prior Finding 5).
9. **Permission gates.** `canResolveDispute` and `canEditMaster` both use
   `user?.role === "admin" || user?.role === "super_admin"` (page.tsx ~968–994). The design's
   `canManageMasters` mirrors this verbatim. `Role` is `"analyst" | "admin" | "super_admin"`
   and `UserAccount` exposes `role` and `username` (`lib/api/auth.ts`). All confirmed.
10. **Dropdown flow is as described.** `<option value={m.fileName}>` keyed by `m.fileName`,
    `onChange` resolves via `savedMasters.find((m) => m.fileName === e.target.value)` →
    `getSavedMasterXml(sm.checkId)` → `setMaster(...)`. `savedMasters` is seeded in a
    `useEffect` calling `getSavedMasters()`. The design's "unchanged dropdown" and
    "refresh by re-calling getSavedMasters()" claims hold.
11. **`dispute-permissions.ts` + `dispute-permissions.test.ts` exist**, so the
    pure-logic-module + vitest pattern the design mirrors is real.
12. **The new functions/components are net-new.** `renameMaster`, `deleteMaster`,
    `countActiveGroupSiblings`, `resolveActiveGroupIds`, `master-manage-logic`, and
    `ManageMastersDialog` appear only in design.md, so no naming collision with existing code.
13. **`getMasterCheckSiblings` returns `{ count, analysts }` (count = row count) via exact `.eq`.**
    Confirmed. The design correctly leaves it unchanged and sources the authoritative count from
    the new normalized `countActiveGroupSiblings` instead.

## Unverified / Could-Not-Verify Assumptions

1. **Supabase RLS on `accuracy_checks`.** The design explicitly states RLS is the intended
   authoritative gate but lives in the Supabase project, not this repo, so it cannot be verified
   here. This is correctly disclosed as an assumption, not a claim. If RLS is permissive, the
   client-side role check is the only gate — the same posture as the existing
   `canEditMaster`/`canResolveDispute` features, so this feature does not regress security.
   No action required; flagged for the implementer's awareness.
2. **PostgREST `.ilike(value)` without wildcards is case-insensitive but not
   whitespace-insensitive.** This is a reasonable, documented PostgREST behavior assumption. The
   design does not depend on it for correctness — the JS `sameMasterName` filter is the source of
   truth after the prefilter — so even if the assumption were wrong, the final id set stays correct
   (see NIT 1). Not independently verified against the live DB.

## Findings

1. **NIT — `.ilike` prefilter does not escape `%`/`_`, which are common in filenames.**
   In `resolveActiveGroupIds` (design "steps" §) and `deleteMaster`/`renameMaster`, the server
   prefilter is `.ilike("file_name_master", fileName.trim())`. In `ILIKE`, `_` matches any single
   character and `%` matches any run — and `_` appears constantly in real filenames
   (e.g. `game_1.xml`). So `.ilike("game_1.xml")` also matches `game-1.xml`, `gameX1.xml`, etc.
   This does **not** cause a correctness bug because the subsequent JS `sameMasterName` filter does
   exact `trim().toLowerCase()` equality and discards the over-matches — the prefilter can only
   over-fetch, never under-fetch. The only cost is pulling a few extra candidate rows.
   Concrete fix (optional, defensive): either state in the design that the `.ilike` is a
   deliberately loose prefilter whose over-matches are discarded by `sameMasterName` (make the
   "no wildcards" wording precise — the *input* has no wildcards, but `_`/`%` in the value are still
   treated as wildcards by `ILIKE`), or escape them, or use `.eq`-per-candidate. Recommended wording:
   "`.ilike` may over-match on `_`/`%` in a filename; the JS `sameMasterName` filter narrows to exact
   normalized equality, so the resolved id set is always correct." No functional change required.

2. **NIT — dropdown `key`/`value` collision when two raw names normalize equal is possible in theory
   but prevented by dedup; worth an explicit note.** The dropdown renders `<option key={m.fileName}
   value={m.fileName}>`. If two distinct raw strings normalized to the same key, React would warn on
   duplicate keys — but `getSavedMasters` dedups by the normalized key before returning, so only one
   survives. After a `renameMaster` the group collapses to one stored string, so no duplicate arises.
   This is correct as designed; the NIT is only that the design could state that the dropdown's
   `value={m.fileName}` (raw string) is what the Replace handler forwards to
   `propagateMasterCorrection`, and that this is intentionally the exact-string subset (already
   acknowledged as the known pre-existing limitation in the Replace section). No change required.

3. **NIT — Replace empty-master guard is specified at "the call site" but not pinned to a function.**
   The error table says "no DB write if instances empty-guard added at call site" and Input Validation
   says "if `instancesFromRaw(newXml)` yields an empty master, the call site blocks propagation."
   `propagateMasterCorrection` itself does not guard an empty master (confirmed — it will run
   `compareInstances([], …)` and happily rewrite every sibling's `xml_master` to the empty feed),
   so the guard genuinely must live in the Replace handler. The design is correct to place it there,
   but "the call site" is slightly loose. Concrete fix: name it — "the Replace handler in
   `app/accuracy-compare/page.tsx` checks `instancesFromRaw(newXml).length > 0` before calling
   `propagateMasterCorrection`, mirroring that `propagateMasterCorrection` has no empty-master guard
   of its own." This prevents an implementer from assuming the data layer guards it.

## Blocking count

HIGH: 0
MEDIUM: 0
NIT: 3

Zero HIGH/MEDIUM → **APPROVED**. The three NITs are non-blocking clarifications; all are about
making already-correct behavior explicit, not about fixing broken behavior.
