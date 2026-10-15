# Design review — client-side meta/list caching (Supabase egress)

Reviewed: `.agents/tasks/design.md` (the revision that answers the prior
review in its §7).
Reviewer stance: fresh read, no prior context assumed. The dominant correctness
risk is CACHE STALENESS — a mutation that writes `accuracy_checks` or
`accuracy_disputes` but has no matching invalidation would silently serve stale
data. I re-derived the invalidation matrix directly from source rather than
trusting the design.

## Verdict

APPROVED — zero HIGH, zero MEDIUM findings. Three NITs below do not block.

The invalidation matrix is **complete and correct against source**. Every write
site in both files is enumerated and wired to the caches it can make stale,
including the subtle cross-table coupling (`accuracy_checks.deleted_at` filters
`getAllDisputes` / `getOpenDisputeCounts`). The placement rule (invalidate after
a committed write and before any later step that can throw, using `finally`
where needed) correctly closes the committed-write-then-throw hole for
`mergeMasters`, `propagateMasterCorrection`, and `backfillPlayerAccuracy`.

## Independent write-site enumeration (the staleness check)

I grepped `\.(insert|update|delete)\(` in both files and classified every hit.

### `accuracy_checks` — 12 write sites, all covered

| Line | Function | Write | Caches design clears | Correct? |
|---|---|---|---|---|
| 242 | `saveAccuracyCheck` | INSERT active row | M | ✅ new active row; not deleted; no disputes |
| 369 | `updateAccuracyCheck` | UPDATE one row | M | ✅ meta/analyst change only |
| 447 | `propagateMasterCorrection` | UPDATE many (loop THROWS per row) | M (via `finally`) | ✅ mid-loop throw still clears |
| 654 | `renameMaster` | UPDATE `file_name_master` | M | ✅ meta column |
| 690 | `deleteMaster` | soft-delete one row | M, D, GD, OC | ✅ cross-table (hides its disputes) |
| 794 | `mergeMasters` Step 3 | UPDATE source ids name+XML | M (right after guard) | ✅ before Step-4 throw |
| 852 | `mergeMasters` Step 4 | UPDATE re-grade (resilient) | M (covered by Step-3 clear) | ✅ one clear suffices |
| 1152 | `fixStaleMasterTotals` | UPDATE `master_total` | M | ✅ leaderboard column |
| 1517 | `backfillPlayerAccuracy` | UPDATE many (resilient) | M (unconditional return) | ✅ not gated on `updated` |
| 1570 | `deleteAccuracyCheck` | soft-delete | M, D, GD, OC | ✅ cross-table |
| 1589 | `restoreAccuracyCheck` | restore | M, D, GD, OC | ✅ cross-table |
| 1605 | `purgeAccuracyCheck` | hard DELETE (CASCADE) | M, D, GD, OC | ✅ CASCADE drops disputes |

`recomputeAllPlayerAccuracy` is a thin wrapper over `backfillPlayerAccuracy`
(confirmed at source) so wiring inside backfill covers it — no separate site.

### `accuracy_disputes` — 5 write sites, all covered

| Line | Function | Write | Caches cleared | Correct? |
|---|---|---|---|---|
| 108 | `createDispute` (update/restore branch) | UPDATE patch | GD, OC | ✅ reason/category/restore |
| 122 | `createDispute` (insert branch) | INSERT open | GD, OC | ✅ new open dispute |
| 249 | `resolveDispute` | UPDATE status | GD, OC | ✅ leaves open set |
| 271 | `deleteDispute` | soft-delete | GD, OC | ✅ both filter deleted_at |
| 287 | `restoreDispute` | restore | GD, OC | ✅ re-enters GD/OC |

The `createDispute` empty-patch early return performs no write and correctly
gets no invalidation. The three-branch split is spelled out in the matrix and in
completeness item 5.

### Reads correctly left uncached / uninvalidated

`getDisputesForCheck`, `getAccuracyCheckById`, `getSavedMasterXml`,
`getSavedMasters`, `getMasterCheckSiblings`, `countActiveGroupSiblings`,
`resolveActiveGroupIds`, `diagnoseMasterConsistency`, `getAccuracyChecksXml`,
`getAllAccuracyChecks` — all read-only or single-row / XML-blob fetches, out of
the task's list. Confirmed none performs a write.

## Findings

### 1. NIT — `getDisputesForCheck` staleness is not surfaced to the two cached dispute views
**Where:** Background ("`getDisputesForCheck` … NOT cached") and §2.
**Problem:** This is correctly NOT cached, so no staleness bug exists. But note
for the implementer: the `accuracy-checks` page calls `getDisputesForCheck` for
the expanded panel AND `getOpenDisputeCounts` (OC, cached) for badges. After a
mutation these two can momentarily disagree on screen because only OC is cached.
This is behavior-preserving (OC's invalidation already fires on every dispute
write) and not a correctness regression; just worth a one-line note so a future
reader does not mistake the panel/badge timing for a cache bug.
**Fix (doc-only):** add a sentence to the `getDisputesForCheck` skip rationale:
"its per-check panel is always a fresh fetch, so panel and (cached) badge counts
reconcile on the next OC invalidation — no extra wiring needed."

### 2. NIT — `mergeMasters` "one clear suffices" depends on no read between Step 3 and return
**Where:** §2 Wiring mechanics, `mergeMasters` bullet.
**Problem:** The claim that clearing M once after Step 3 covers the Step-4
re-grades is correct ONLY because nothing reads M between Step 3 and the
function returning. That is true today (Step 4 is a tight server loop with no
`getAccuracyChecksMeta` call), but the reasoning is load-bearing and currently
only implied.
**Fix (doc-only):** state the invariant explicitly: "No `get…Meta()` runs
between Step 3 and return, so a single post-Step-3 clear is sufficient; if a
future edit adds a meta read inside Step 4, re-clear after the loop."

### 3. NIT — `fixStaleMasterTotals` placement wording vs. its actual control flow
**Where:** §2 Wiring mechanics, single-write bullet (parenthetical on
`fixStaleMasterTotals`).
**Problem:** The function loops over ids and `continue`s on per-row error (never
throws out of the loop), so "place the invalidate immediately AFTER that write's
`if (error) throw` guard" does not literally apply — there is no throwing guard;
each row's update error is swallowed with `continue`. The design's parenthetical
does acknowledge "a single clear after the loop is fine," which is the correct
instruction, but the lead-in rule and the exception read as mildly contradictory.
**Fix (doc-only):** move `fixStaleMasterTotals` out of the "single-write,
clear-after-throw-guard" bullet and group it with the resilient-loop shapes:
"clear M once on the normal return, unconditionally — like `backfillPlayerAccuracy`."

## Verified assumptions (checked against source)

1. **Write-site enumeration is exhaustive.** Grepped both files; all 12
   `accuracy_checks` and 5 `accuracy_disputes` write sites map onto a matrix
   row. No un-enumerated write exists.
2. **Cross-table coupling is real and fully wired.** `getAllDisputes` and
   `getOpenDisputeCounts` both use `accuracy_checks!inner(deleted_at)` +
   `.is("accuracy_checks.deleted_at", null)`, so a check's soft-delete / restore
   / purge changes their result without writing a dispute row. The four check
   mutations that change deleted-ness (`deleteMaster`, `deleteAccuracyCheck`,
   `restoreAccuracyCheck`, `purgeAccuracyCheck`) are exactly the four the design
   clears GD+OC on. Correct and complete.
3. **`purgeAccuracyCheck` CASCADE.** Hard `.delete()` on `accuracy_checks`; the
   design relies on ON DELETE CASCADE removing child disputes, matching the
   `purgeAccuracyCheck` doc comment in source. GD/OC clear is required and present.
4. **`createDispute` has exactly three branches** (restore/patch UPDATE, INSERT,
   empty-patch no-write return) — matches the matrix's three rows precisely.
5. **`recomputeAllPlayerAccuracy` is a wrapper** over `backfillPlayerAccuracy`
   (`return backfillPlayerAccuracy(onProgress, true)`), so one clear inside
   backfill covers both — verified.
6. **`propagateMasterCorrection` THROWS mid-loop** (`if (upErr) throw`), so the
   `finally`-based clear is genuinely required to avoid a committed-rows-then-throw
   stale cache. `mergeMasters` Step 4 is resilient (`continue`), confirming the
   asymmetric handling the design describes.
7. **Per-analyst fetch keying is moot but correctly specified for the future.**
   `getAccuracyChecksForAnalyst` uses `.ilike("analyst_name", analystName.trim())`;
   the proposed future key `name.trim().toLowerCase()` matches that folding. The
   fetch has ZERO callers (grep: only its own definition and doc mentions), so
   dropping it from scope is correct and removes needless invalidation wiring.
8. **Single-row / XML / blob fetches are NOT cached.** `getAccuracyCheckById`,
   `getSavedMasterXml`, `getAccuracyChecksXml`, `getSavedMasters` confirmed out
   of scope in source and design.
9. **Failed fetch does not poison.** The `createCache`/inline pattern assigns
   `cache = fetch().catch(e => { cache = null; throw e; })`, resetting to `null`
   and rethrowing — matches `clubConfig`/`fixtureMap`. Keyed variant does
   `map.delete(key)`. Correct no-poison behavior.
10. **Pull-to-refresh / hard reload re-fetches.** `components/pwa/usePullToRefresh.ts`
    calls `window.location.reload()` on trigger, tearing down module state so all
    caches re-init to null/empty. The cache can never block a deliberate refresh.
    Verified in source.
11. **Exported signatures unchanged.** The pattern wraps existing bodies as inner
    `fetch…` and keeps the public function returning the cached promise; the four
    cached getters keep their exact return types. New exports are only the
    `invalidate…` functions. No caller signature changes.
12. **Shared-array-reference invariant holds for current callers.** Grepped
    `app/accuracy-checks/page.tsx` and `app/disputes/page.tsx`: every `.sort()`
    runs on a copy (`[...checks].sort`, `[...scoped].sort`, `[...rows].sort`) or
    a freshly built array (`result`, `Array.from(...)`, mapped arrays). No
    in-place sort/splice on a cached fetch result. The documented "copy before
    mutating" rule for future callers is adequate.
13. **Vitest + co-located test convention exists.** `package.json` has
    `"test": "vitest --run"` and `vitest@^3.2.7`; `lib/comparison/overlap-window.test.ts`
    confirms the co-located `*.test.ts` convention the new `cache.test.ts` follows.
14. **No import cycle.** `disputes.ts` imports only `@/lib/supabase`; the new
    `accuracyChecks → disputes` invalidation import is one-directional. Confirmed.

## Unverified / wrong assumptions

1. **Cross-tab staleness is accepted by design, not eliminated.** §3 Q2 decides
   NO TTL and documents that another admin's already-open tab keeps stale caches
   until it reloads or mutates — identical to the shipping `clubConfig`/`fixtureMap`
   caches. This is an explicit, justified decision matching the existing pattern,
   not a gap. Flagged here only so the acceptance owner is aware it is a conscious
   trade-off (the Realtime `subscribeToAccuracyCheck` path is named as the future
   fix if sub-reload cross-tab freshness is ever required).
2. **"Mutation-then-refetch always shows fresh data" assumes the UI refetches
   after awaiting the mutation.** §4 relies on consumers calling the list fetch
   AFTER the mutation resolves. The two live pages do follow this (e.g.
   `resolveDispute` then `getOpenDisputeCounts`), so the assumption holds today;
   it is a convention future callers must keep, not a property the cache enforces.
   Not a current defect.
