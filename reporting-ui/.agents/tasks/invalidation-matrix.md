# Invalidation matrix — as implemented

Cache short names (the four module-level single-value caches added by this
change):

- **M** = `getAccuracyChecksMeta` (active-checks meta list) — cache in
  `lib/api/accuracyChecks.ts`, cleared via `invalidateAccuracyChecksMetaCache()`.
- **D** = `getDeletedAccuracyChecksMeta` (soft-deleted meta list) — cache in
  `accuracyChecks.ts`, cleared via `invalidateDeletedAccuracyChecksMetaCache()`.
- **GD** = `getAllDisputes` (global dispute list) — cache in
  `lib/api/disputes.ts`, cleared via `invalidateAllDisputesCache()`.
- **OC** = `getOpenDisputeCounts` (open-dispute counts) — cache in `disputes.ts`,
  cleared via `invalidateOpenDisputeCountsCache()`.

Not cached (per design): `getAccuracyChecksForAnalyst` (dead code / keyed cache
dropped), `getAllAccuracyChecks` (dead code), `getDisputesForCheck`,
`getAccuracyCheckById`, `getSavedMasters`, `getSavedMasterXml`,
`getAccuracyChecksXml`, `getMasterCheckSiblings`, `countActiveGroupSiblings`,
`diagnoseMasterConsistency`. `createKeyedCache` is implemented + unit-tested but
wired to no production fetch (future per-analyst adoption).

## `accuracy_checks` mutations → caches cleared (as wired)

| Mutation | Write | M | D | GD | OC | Placement of the `invalidate…` call(s) |
|---|---|---|---|---|---|---|
| `saveAccuracyCheck` | INSERT active row | ✅ | — | — | — | After the insert `if (error) throw`. |
| `updateAccuracyCheck` | UPDATE one active row | ✅ | — | — | — | After the update `if (error) throw`. |
| `propagateMasterCorrection` | UPDATE many rows (loop THROWS on `upErr`) | ✅ | — | — | — | `finally` wrapping the loop — fires on both the success return and a mid-loop throw after committed rows. |
| `renameMaster` | UPDATE `file_name_master` on group | ✅ | — | — | — | After the update `if (error) throw`. |
| `deleteMaster` | soft-delete one row | ✅ | ✅ | ✅ | ✅ | After the update `if (error) throw`; the 4 clears together. |
| `mergeMasters` | UPDATE source rows name+XML (Step 3), re-grade dest group (Step 4) | ✅ | — | — | — | Immediately after Step 3's `if (error) throw` (one clear covers the moved rows AND Step-4 re-grades; a Step-4 `loadErr` throw cannot leave M stale). |
| `fixStaleMasterTotals` | UPDATE `master_total` (resilient loop, `continue` on error) | ✅ | — | — | — | Unconditionally on the normal return after the loop. |
| `backfillPlayerAccuracy` | UPDATE summary cols (resilient loop, always returns) | ✅ | — | — | — | Unconditionally on the normal `return { updated, skipped }` (NOT gated on `updated`). |
| `recomputeAllPlayerAccuracy` | wrapper → `backfillPlayerAccuracy(force)` | ✅ | — | — | — | Inherited from `backfillPlayerAccuracy` (no separate clear). |
| `deleteAccuracyCheck` | soft-delete one row | ✅ | ✅ | ✅ | ✅ | After the update `if (error) throw`; cross-table GD/OC via `accuracy_checks!inner(deleted_at)`. |
| `restoreAccuracyCheck` | restore (clear `deleted_at`) | ✅ | ✅ | ✅ | ✅ | After the update `if (error) throw`; cross-table. |
| `purgeAccuracyCheck` | hard DELETE (CASCADE) | ✅ | ✅ | ✅ | ✅ | After the delete `if (error) throw`; CASCADE removes child disputes → GD/OC. |

## `accuracy_disputes` mutations → caches cleared (as wired)

| Mutation | Write | M | D | GD | OC | Placement |
|---|---|---|---|---|---|---|
| `createDispute` — update/restore branch | UPDATE existing (reason/category and/or clear `deleted_at`) | — | — | ✅ | ✅ | After the update `if (error) throw`. |
| `createDispute` — empty-patch early return | NO WRITE | — | — | — | — | No invalidation (nothing committed). |
| `createDispute` — insert branch | INSERT new open dispute | — | — | ✅ | ✅ | After the insert `if (error) throw`. |
| `resolveDispute` | UPDATE status | — | — | ✅ | ✅ | After the update `if (error) throw`. |
| `deleteDispute` | soft-delete | — | — | ✅ | ✅ | After the update `if (error) throw`. |
| `restoreDispute` | restore | — | — | ✅ | ✅ | After the update `if (error) throw`. |

## Per-fetch caller walkthrough (behavior preservation)

- **M (`getAccuracyChecksMeta`)** — consumed by `app/accuracy-checks/page.tsx`
  (and leaderboards via `summariseByAnalyst` / `countMasterChecks`). The public
  function now returns `metaCached.get()`; the body is the SAME paging loop,
  moved verbatim into `fetchAccuracyChecksMeta`. On a cache hit the caller gets
  the same array instance it would have fetched; it only `map`/`filter`s and
  sorts into NEW arrays (never mutates in place), so the shared-reference
  invariant holds. Every mutation that changes an active row's meta columns or
  its active-ness clears M (see table), so the next read after any such mutation
  re-fetches fresh data. Behavior = pre-change, minus the redundant re-page on
  an unchanged revisit.
- **D (`getDeletedAccuracyChecksMeta`)** — consumed by the "Deleted checks"
  review. Same wrapping (single select moved into `fetchDeletedAccuracyChecksMeta`).
  Cleared by exactly the mutations that change a row's deleted-ness
  (`deleteMaster`, `deleteAccuracyCheck`, `restoreAccuracyCheck`,
  `purgeAccuracyCheck`), so the deleted view is never stale after one of those.
- **GD (`getAllDisputes`)** — consumed by `app/disputes/page.tsx` (assigns to
  state, `map`/`filter`s; `disputeKeySet` builds a new Set). Body moved verbatim
  into `fetchAllDisputes` (paging + `accuracy_checks!inner(deleted_at)` inner
  join preserved). Cleared by all dispute writes AND the four check mutations
  that change which disputes the inner join returns.
- **OC (`getOpenDisputeCounts`)** — backs history open-dispute badges. Body moved
  verbatim into `fetchOpenDisputeCounts` (paging + inner-join filters
  preserved). Cleared alongside GD everywhere GD is cleared (same staleness
  surface: open-status and parent-check deleted-ness).

All four fetches keep their exact exported signatures (`(): Promise<…>`), and the
error path mirrors `clubConfig`/`fixtureMap`: `createCache`'s `.catch` resets the
slot to `null` so a failed fetch rejects the current callers and the next call
retries — a transient Supabase error never poisons the cache.
