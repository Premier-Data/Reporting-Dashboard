# Implementation Note — Supabase egress reduction on `accuracy_checks`

Scope: STRICTLY behavior-preserving. Project away the large `xml_master` /
`xml_analyst` columns from the two dead-code list queries named in the plan,
reusing the existing `AccuracyCheckMeta` type and `ACCURACY_CHECK_META_COLUMNS`
constant. No grading, comparison-engine, UI, DB-schema, or XML-parsing path was
touched.

File changed: `lib/api/accuracyChecks.ts` (only).

## Iteration context

`.agents/tasks/review.json` exists (verdict **APPROVED**, two **non-blocking**
findings). Both findings reference a different worktree (`overlap-scope`) and
unrelated functions (`computeStoredPlayerAccuracy`, `analystWindow`) that do not
exist in this egress change — they are not actionable here and both state "No
action required / cosmetic". No blocking findings to fix. The two primary
target functions were still unprojected (`select("*")`, returning
`AccuracyCheck[]`), so the plan's items 1–3 were implemented.

## Caller-safety evidence (per changed function)

Per the plan's caller-by-caller safety table (egress-plan.md §1 and §2), both
targets are dead code with ZERO call sites. Re-verified in this iteration:

- Grep for `getAllAccuracyChecks|getAccuracyChecksForAnalyst` across the whole
  worktree `.ts/.tsx`: the only hits are the two function definitions, the
  doc-comment mention inside `getAccuracyChecksMeta`, and the stale code comment
  in `summariseByAnalyst`. No invocation anywhere.
- Scoped grep across `app/`, `components/`, `hooks/`: **no matches**.
- No `*.test.ts(x)` imports `accuracyChecks.ts` (grep for
  `accuracyChecks|getAccuracyChecksMeta|summariseByAnalyst|countMasterChecks`
  across worktree test files: no matches).

Conclusion: every caller is vacuously proven not to read `.xml_master` /
`.xml_analyst` (there are no callers). Projecting is caller-safe. The strongest
mechanical proof is the clean `tsc` after narrowing the return type (below): had
any caller consumed the blob fields, narrowing `AccuracyCheck[]` →
`AccuracyCheckMeta[]` would have produced a compile error.

Functions deliberately LEFT UNCHANGED (need the blobs or already safe), matching
the plan: `getAccuracyCheckById`, `getSavedMasterXml`, `getAccuracyChecksXml`,
all XML-parsing paths, and `getAccuracyChecksMeta` /
`getDeletedAccuracyChecksMeta` (already projected). `comp_fixtures`
(`compFixtures.ts`) and `user_accounts` (`auth.ts`) left UNCHANGED — the plan
proved no safe saving (tiny rows / required secret columns).

## Exact projections applied

### 1. `getAccuracyChecksForAnalyst()` (plan item 2)
- `.select("*")` → `.select(ACCURACY_CHECK_META_COLUMNS)`
- return type `Promise<AccuracyCheck[]>` → `Promise<AccuracyCheckMeta[]>`
- final cast `as AccuracyCheck[]` → `as unknown as AccuracyCheckMeta[]`
- filters/ordering unchanged: `deleted_at IS NULL`, `ilike(analyst_name)`,
  `created_at` ascending.
- doc comment updated to note it is blob-free.

### 2. `getAllAccuracyChecks()` (plan item 1)
- paged `.select("*")` → `.select(ACCURACY_CHECK_META_COLUMNS)`
- return type `Promise<AccuracyCheck[]>` → `Promise<AccuracyCheckMeta[]>`
- local `rows: AccuracyCheck[]` → `rows: AccuracyCheckMeta[]`
- push cast `as AccuracyCheck[]` → `as unknown as AccuracyCheckMeta[]`
- paging loop, `deleted_at IS NULL`, and `created_at` descending ordering
  unchanged (mirrors `getAccuracyChecksMeta` exactly).
- doc comment updated to note it is blob-free.

### 3. Stale comment (plan item 3, cosmetic)
- In `summariseByAnalyst`: `// Newest first (getAllAccuracyChecks returns desc)…`
  → `// Newest first (list fetch returns desc), so [0] is latest.` No code
  change.

No caller edits were required (zero callers), so no on-demand XML reload was
needed.

## Verification results

Primary safety net is `tsc` after the return-type narrowing — a clean run proves
no caller read the removed blob fields.

| Command | Tree | Result |
|---------|------|--------|
| `npx tsc --noEmit` | **worktree** (`.worktrees\egress-opt\reporting-ui`) | **CLEAN, exit 0** — no caller breakage from `AccuracyCheck[]`→`AccuracyCheckMeta[]` |
| `npm run build -- --webpack` | **worktree** | succeeds, exit 0 (builds the edited code; Turbopack default avoided due to junction panic) |
| `npx vitest --run` | **worktree** | known junction artifact: "No test suite found" for all 8 files — NOT a real failure |
| `npx vitest --run` | **main** (`reporting-ui`) | **8 files / 84 tests passed, exit 0** |
| `npm run build` | **main** (`reporting-ui`) | succeeds, exit 0 (Turbopack) |

Notes:
- The worktree `node_modules` is a junction into the main tree, which triggers
  the documented vitest "no suite" artifact; verified in the main tree instead.
- No test imports `accuracyChecks.ts`, so the main-tree suite confirms suite
  health; the worktree `tsc` (clean) + worktree webpack build (success) are the
  authoritative checks against the actual edits.
- `tsc` is CLEAN after the type narrowing — the functional-equivalence proof.
