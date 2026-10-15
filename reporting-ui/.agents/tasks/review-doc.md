# Project away XML blobs from two dead-code list queries on `accuracy_checks`

Narrows `getAllAccuracyChecks()` and `getAccuracyChecksForAnalyst()` so they
select the explicit `ACCURACY_CHECK_META_COLUMNS` list instead of `select("*")`,
dropping the heavy `xml_master` / `xml_analyst` columns, and changes their return
type from `AccuracyCheck[]` to `AccuracyCheckMeta[]`. The intent is to kill the
latent `select("*")` + blob egress risk so a future caller can never silently
reintroduce it, matching the already-established `getAccuracyChecksMeta` pattern.
Both functions are unreferenced dead code today, so the change produces zero
runtime behavior difference. A third cosmetic edit fixes a stale comment in
`summariseByAnalyst`.

Watch for: nothing blocking. The behavior-preservation argument rests entirely
on both functions having zero call sites (confirmed) and on the `AccuracyCheckMeta`
return-type narrowing being accepted by `tsc` (recorded CLEAN in the worktree).

**Verdict**: APPROVED

## High-level view

The egress win was already captured earlier by `getAccuracyChecksMeta` /
`getDeletedAccuracyChecksMeta`, which every live list/leaderboard view already
calls. This change cleans up the two remaining `select("*")` functions that
nothing calls. Because they are dead code, projecting them away is behavior-
preserving by construction — there is no caller whose data shape could change.

Caller safety is proven, not assumed: a worktree-wide grep for both function
names across `.ts`/`.tsx` returns only their own definitions (plus one doc
comment and one now-fixed stale comment). No barrel re-export or dynamic lookup
exposes them under another name — every `@/lib/api/accuracyChecks` import in the
app is a direct named import that excludes these two.

The mechanical equivalence proof is the type narrowing: `AccuracyCheckMeta` is
`Omit<AccuracyCheck, "xml_master" | "xml_analyst">`, so had any caller read the
blob fields off these functions' results, changing the return type would have
broken compilation. The impl note records `tsc --noEmit` CLEAN in the worktree
tree where the edit lives.

No grading, comparison-engine, UI, DB-schema, or XML-parsing path is touched.
`getAccuracyCheckById`, `getSavedMasterXml`, `getAccuracyChecksXml`, and all
XML-rewriting paths — the functions that legitimately need the blobs — are left
unchanged, as are the `comp_fixtures` and `user_accounts` `select("*")` reads
the plan deliberately skipped.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking action items. Every change is proven caller-safe and
behavior-preserving.

</details>

<details>
<summary>Details</summary>

### Projection matches the plan's caller-safety table exactly

The plan's §1 and §2 tables both record a single row: "(none) — zero call sites —
PROJECT (safe; dead code)". The diff does precisely what those rows authorize and
nothing more. For `getAccuracyChecksForAnalyst`: `.select("*")` →
`.select(ACCURACY_CHECK_META_COLUMNS)`, return type `AccuracyCheck[]` →
`AccuracyCheckMeta[]`, cast `as AccuracyCheck[]` → `as unknown as AccuracyCheckMeta[]`,
with the `deleted_at IS NULL`, `ilike(analyst_name)`, and `created_at` ascending
clauses untouched. For `getAllAccuracyChecks`: the paged `.select("*")` → the meta
column list, local `rows: AccuracyCheck[]` → `AccuracyCheckMeta[]`, push cast
updated, and the paging loop + `created_at` descending ordering preserved. The
narrowed version is now byte-for-byte the same query shape as the pre-existing
`getAccuracyChecksMeta`, which is the exact pattern the plan said to mirror.

The zero-caller claim was independently re-verified for this review: grepping
`getAllAccuracyChecks|getAccuracyChecksForAnalyst` across the worktree's `.ts`/`.tsx`
returns only the two definitions. No file imports either name — the four files
that import from `@/lib/api/accuracyChecks` pull `AccuracyCheckMeta`,
`AccuracyCheck`, `SavedMaster`, `instancesFromRaw`, `getMasterCheckSiblings`, etc.,
but never these two functions. There is no barrel that re-exports them under an
alias. "Every caller proven not to read the blobs" is therefore vacuously true,
and projecting is safe.

### Return-type narrowing is the equivalence proof

`AccuracyCheckMeta = Omit<AccuracyCheck, "xml_master" | "xml_analyst">`. Narrowing
the two functions' return types from `AccuracyCheck[]` to `AccuracyCheckMeta[]`
means any consumer that read `.xml_master` / `.xml_analyst` off their results
would now fail to type-check. The impl note's verification table records
`npx tsc --noEmit` as CLEAN (exit 0) in the worktree
(`.worktrees\egress-opt\reporting-ui`) — the tree the edit actually lives in — so
the compiler confirms no such consumer exists. This is the strongest available
functional-equivalence proof for a dead-code projection and it is anchored in the
correct tree.

The `as unknown as AccuracyCheckMeta[]` double cast is required because the
Supabase client infers a different row type from an explicit column-list string
than from `*`; it is the same cast idiom already used by `getAccuracyChecksMeta`
and `getDeletedAccuracyChecksMeta`, so it introduces no new pattern.

### Nothing outside the two dead functions changed

The only other edit is the `summariseByAnalyst` comment going from "Newest first
(getAllAccuracyChecks returns desc)" to "Newest first (list fetch returns desc)".
No code, ordering, or sort key changed there. The functions that need the blobs —
`getAccuracyCheckById`, `getSavedMasterXml`, `getAccuracyChecksXml`, and every
XML-parsing / rewriting path — are untouched, and so are the `comp_fixtures`
(`compFixtures.ts`) and `user_accounts` (`auth.ts`) `select("*")` reads the plan
explicitly chose to leave alone (tiny rows / required secret columns). No grading
logic, comparison engine, UI behavior, or DB schema is affected by this diff.

### Verification evidence is present and attributed to the right trees

The impl note is not missing; it records which tree each command ran in. The
authoritative checks against the edit — `tsc --noEmit` CLEAN and the webpack
`npm run build` success — both ran in the worktree. The vitest "no suite found"
artifact in the worktree is explained by the `node_modules` junction and
cross-checked by the main-tree run (8 files / 84 tests passed). Since no test
imports `accuracyChecks.ts`, the suite result is corroborating rather than
load-bearing; the worktree `tsc` is the proof that matters, and it is clean.

</details>

<details>
<summary>File map</summary>

- `lib/api/accuracyChecks.ts` — projected `getAllAccuracyChecks` and
  `getAccuracyChecksForAnalyst` to `ACCURACY_CHECK_META_COLUMNS` / `AccuracyCheckMeta[]`;
  updated their doc comments; fixed a stale comment in `summariseByAnalyst`.

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt\reporting-ui diff`

</details>
