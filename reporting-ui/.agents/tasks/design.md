# Design: client-side cache for blob-free meta/list fetches (Supabase egress)

## Overview

Supabase egress is over the Free-plan cap. Profiling identified the remaining
driver as REPEAT full-table fetches of the blob-free "meta/list" queries that
fire every time a user revisits Accuracy History / leaderboards / analyst
history / deleted-checks / dispute lists. Each of those views re-pages the whole
`accuracy_checks` (or `accuracy_disputes`) table over the wire on every mount,
even when nothing changed since the last visit.

This design adds a **module-level, in-memory, promise-deduped cache** in front of
exactly those list fetches, mirroring the proven in-repo pattern in
`lib/api/clubConfig.ts` and `lib/api/fixtureMap.ts` (a module-scoped
`let cache: Promise<T> | null`, an `ensure…Cache()` that populates once and
reuses, and an `invalidate…Cache()` called from every write — with the fetch's
`.catch` resetting the cache to `null` so a failed fetch never poisons it).
Revisiting a cached view then reuses the already-fetched array instead of
re-paging the table.

The non-negotiable acceptance criterion is **behavior-preserving correctness**:
the data shown must stay correct, so every mutation that changes an underlying
row MUST invalidate the caches that could now be stale. The design treats a
smaller, provably-correct cache as strictly better than a broad one that risks
staleness. Where a mutation's invalidation can't be cleanly wired, the design
does NOT cache the fetch it would make stale (none of the in-scope fetches hit
that case — see the invalidation matrix).

Only two files change for the mechanism-plus-wiring, plus one optional small
pure helper module and its test:

- `lib/api/accuracyChecks.ts` — cache `getAccuracyChecksMeta()` and
  `getDeletedAccuracyChecksMeta()`; add `invalidate…` calls to every check-row
  mutation. **`getAccuracyChecksForAnalyst(name)` is NOT cached** in this task:
  a worktree-wide grep (`**/*.{ts,tsx}`) finds the function declared here and
  referenced nowhere else, so it is dead code today — caching it would reduce
  zero present egress while wiring a keyed-map invalidation into ~8 mutation
  sites for a fetch nothing reads. Per the task's "a smaller, provably-correct
  cache is better" stance, we drop it from scope (see §1 "Keyed cache (dropped)"
  and the revision note at the end). The keyed-cache primitive is still
  specified and unit-tested in §5 so a future analyst-history view can adopt it
  in one line without re-deriving the mechanism.
- `lib/api/disputes.ts` — cache `getAllDisputes()` and
  `getOpenDisputeCounts()`; add `invalidate…` calls to every dispute-row
  mutation; AND invalidate the dispute caches from the two check-row mutations
  that can change a dispute's visibility (soft-delete / restore of a check — see
  the matrix for why).
- `lib/api/cache.ts` (NEW, optional-but-recommended) — a tiny PURE, generic
  `createCache(fn)` / `createKeyedCache(fn)` helper so the mechanism is
  unit-testable without Supabase. See §5.
- `lib/api/cache.test.ts` (NEW) — Vitest unit tests for the pure helper.

No UI component, comparison engine, grading path, DB schema, or on-demand/XML
fetch changes. Exported function signatures are IDENTICAL — caching is added
INSIDE the existing functions (via the helper, or an inline module-level cache),
and new `invalidate…` functions are exported for the mutations to call.

### Technology stack (locked)

- TypeScript, same module style as the existing `lib/api/*` data layer.
- Supabase JS client (`@/lib/supabase`) for all data access — unchanged.
- Module-level in-memory cache (a `let` binding at module scope), exactly as
  `clubConfig.ts` / `fixtureMap.ts` already do. NO external cache library, NO
  React Query, NO `localStorage`/`IndexedDB`, NO TTL (see correctness Q2).
- Vitest (`npm test` → `vitest --run`) for the pure-helper unit test, co-located
  as `lib/api/cache.test.ts` (matches the repo's co-located `*.test.ts`
  convention, e.g. `lib/comparison/overlap-window.test.ts`).

### No new Next.js API (AGENTS.md confirmation)

Per the AGENTS.md rule, before using any Next.js API I confirmed what this task
needs. This change is **purely a client-side data-layer concern**: it adds
module-scoped variables and plain functions inside existing `lib/api/*` modules
that already run in the browser via the Supabase client. It introduces **no**
Next.js API surface — no Server Components, Server Actions, Route Handlers,
`fetch` cache options, `unstable_cache`, `revalidate*`, middleware, or
`next/*` imports. The caches are ordinary JS module state. Therefore no guide
under `node_modules/next/dist/docs/` governs this change, and none is required
to implement it. (The directory exists and was located; nothing in it applies.)

---

## Background: the exact fetches, read from source

All line references are to the worktree sources as they stand.

### `lib/api/accuracyChecks.ts`

- **`getAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]>`** — pages the whole
  active table (`deleted_at IS NULL`, `pageSize=1000`, `created_at desc`),
  selecting `ACCURACY_CHECK_META_COLUMNS` (blob-free: no `xml_master`/
  `xml_analyst`). Backs Accuracy History + leaderboards. **Biggest driver.**
- **`getDeletedAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]>`** — single
  select of soft-deleted rows (`deleted_at IS NOT NULL`, `deleted_at desc`),
  same blob-free columns. Backs the "Deleted checks" review.
- **`getAccuracyChecksForAnalyst(analystName): Promise<AccuracyCheckMeta[]>`** —
  blob-free, `ilike("analyst_name", analystName.trim())`, `deleted_at IS NULL`,
  `created_at asc`. It is **PARAMETERIZED** and would be a keyed cache IF it
  were called — but a worktree-wide grep (re-run for this revision) shows it has
  **zero callers**: the only hits are its own definition and doc-comment
  mentions. It is dead code and is **NOT cached** in this task. Caching an
  uncalled fetch reduces no egress and cannot show stale data, but it WOULD add
  an `invalidateAccuracyChecksForAnalystCache()` call to every check mutation
  for no benefit, so it is dropped (the earlier design's "Backs analyst history
  → keyed cache" framing was wrong — the fetch backs nothing today). The keyed
  primitive remains documented/tested in §5 for a future caller.
- `getAllAccuracyChecks()` — dead code per the task; **NOT cached.**
- Single-row / on-demand / XML fetches — `getAccuracyCheckById`,
  `getSavedMasterXml`, `getAccuracyChecksXml`, `getSavedMasters`,
  `getMasterCheckSiblings`, `countActiveGroupSiblings`,
  `diagnoseMasterConsistency` — **NOT cached** (single-row, XML blobs, or
  admin-only diagnostics; out of the task's list).

### `lib/api/disputes.ts`

- **`getAllDisputes(): Promise<Dispute[]>`** — pages ALL disputes
  (`pageSize=1000`), excluding soft-deleted disputes AND disputes on
  soft-deleted checks (via `accuracy_checks!inner(deleted_at)` + two `.is(…,
  null)` filters). Backs the global Disputes page.
- **`getOpenDisputeCounts(): Promise<Record<number, number>>`** — pages all
  `status='open'`, non-deleted disputes on non-deleted checks; tallies per
  `check_id`. Backs the history open-dispute badges.
- `getDisputesForCheck(checkId)` — single-check, on-demand; **NOT cached** (not
  in the task's list; small and per-check — caching it adds a second keyed map
  for little egress benefit and more invalidation surface). Documented as a
  deliberate skip.

**Cross-table dependency to note now (drives the matrix):** both
`getAllDisputes()` and `getOpenDisputeCounts()` are filtered by the parent
check's `deleted_at` (`accuracy_checks!inner(deleted_at)`). So **soft-deleting
or restoring an accuracy check changes which disputes these two fetches return**,
even though no dispute row changed. That cross-table coupling is handled
explicitly in the invalidation matrix (check soft-delete/restore invalidate the
dispute caches too).

---

## 1. Cache mechanism (mirrors clubConfig / fixtureMap)

### Single-value caches (the array fetches)

For `getAccuracyChecksMeta`, `getDeletedAccuracyChecksMeta`, `getAllDisputes`,
and `getOpenDisputeCounts`, use the exact `clubConfig`/`fixtureMap` shape: a
module-scoped promise that is populated once and reused, resetting itself to
`null` on failure so a rejected fetch never poisons the cache.

Reference pattern being mirrored (`fixtureMap.ts`):

```ts
let cache: Promise<Map<string, number | null>> | null = null;
export function ensureFixtureMapCache() {
  if (!cache) {
    cache = loadMap().catch((e) => { cache = null; throw e; });
  }
  return cache;
}
export function invalidateFixtureMapCache(): void { cache = null; }
```

Applied here (illustrative, for `getAccuracyChecksMeta`). The PUBLIC signature
is unchanged; the existing body becomes an inner `fetch…` and the public
function returns the cached promise:

```ts
// module scope
let metaCache: Promise<AccuracyCheckMeta[]> | null = null;

async function fetchAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
  // ← the CURRENT getAccuracyChecksMeta body verbatim (the paging loop).
}

export function getAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
  if (!metaCache) {
    metaCache = fetchAccuracyChecksMeta().catch((e) => {
      metaCache = null; // don't poison the cache — next call retries
      throw e;
    });
  }
  return metaCache;
}

export function invalidateAccuracyChecksMetaCache(): void {
  metaCache = null;
}
```

Caching the **Promise** (not the resolved array) dedupes concurrent callers: two
views mounting at once share one in-flight request. On resolve, every caller
awaits the same array.

> **Shared-reference note (applies to every list cache).** Callers receive the
> SAME array instance on cache hits. The existing consumers of these fetches
> treat the result as read-only (map/filter/sort into new arrays — e.g.
> `summariseByAnalyst`, `countMasterChecks`, `disputeKeySet` all build new
> structures and never mutate the input). This is behavior-preserving as long as
> no caller mutates the returned array in place. The design does not change any
> caller; this invariant is documented so a future caller does not introduce an
> in-place sort/splice on a cached array. (If that risk is deemed material, the
> cache can hand back a shallow copy `arr.slice()` on read; NOT done by default
> because the existing callers are all non-mutating and the copy adds per-hit
> cost. Stated as the known, bounded trade-off.)
>
> **Enforcement decision (Finding #5).** Verified against the two live consumers:
> `app/accuracy-checks/page.tsx` and `app/disputes/page.tsx` assign the fetched
> array into React state and `map`/`filter` it (plus `summariseByAnalyst` /
> `countMasterChecks` / `disputeKeySet`, which all build NEW structures); none
> sorts or splices the result in place. The invariant therefore holds today and
> is left protected by this documented contract rather than a defensive copy —
> adding `.slice()` at every cache boundary would cost an array copy on each
> hit for a risk no current caller realizes. **Rule for future callers:** if a
> caller ever needs to sort/splice a cached result in place, it MUST copy first
> (`[...result]` / `result.slice()`); do not mutate the shared instance. If that
> ever becomes a real hazard, the single-line fix is to return `result.slice()`
> from the cache getter. No correctness change is needed now.

Each of the four single-value fetches gets its own `let …Cache` and matching
`invalidate…Cache()`:

- `invalidateAccuracyChecksMetaCache()`
- `invalidateDeletedAccuracyChecksMetaCache()`
- `invalidateAllDisputesCache()`
- `invalidateOpenDisputeCountsCache()`

### Keyed cache (the per-analyst fetch) — DROPPED from this task

`getAccuracyChecksForAnalyst(analystName)` is parameterized and would be the one
keyed cache in this task — a `Map<string, Promise<AccuracyCheckMeta[]>>` keyed
by the normalized analyst name. **It is not implemented here because the fetch
has zero callers** (dead code — see Background and Finding #1). Caching it would
reduce no present egress and, more importantly, would wire
`invalidateAccuracyChecksForAnalystCache()` into every check mutation
(`save`, `update`, `propagate`, `merge`, `rename`, `delete`, `restore`, `purge`,
`fixStaleMasterTotals`, `backfill`) — ~10 call sites — to keep a map nothing
reads consistent. That is pure scope for no benefit, so the design does NOT add
it. This also removes column **A** from every row of the invalidation matrix in
§2 (the matrix below reflects that).

The keyed-cache *primitive* (`createKeyedCache`) is still specified and
unit-tested in §5, so if a future analyst-history view is built it can be cached
in one line:

```ts
// FUTURE (not wired now — getAccuracyChecksForAnalyst is uncalled today):
const analystCached = createKeyedCache(
  fetchAccuracyChecksForAnalyst,
  (name) => name.trim().toLowerCase(), // matches ilike(analyst_name, trim())
);
```

**When adopted, the key MUST be `name.trim().toLowerCase()`** to match the
query's folding: the fetch does `.ilike("analyst_name", analystName.trim())`,
which is case-insensitive and trim-insensitive, so `"Jane"`, `" jane "`, and
`"JANE"` resolve to one row-set and must share one entry. One subtlety for the
future implementer: `ilike` also treats `%` and `_` in the argument as SQL
wildcards (the same loose-prefilter caveat the module documents for
`resolveActiveGroupIds`). This does NOT break the cache: **the key is exactly
the normalized query argument, so each key maps 1:1 onto whatever row-set the
query returns for that argument, regardless of ILIKE wildcard behavior** — the
cache can never be more stale than the query is loose, and no extra
normalization is required. When adopted, invalidation would clear the WHOLE map
(`map.clear()`) from every check mutation rather than per-key, because most
check mutations touch rows for multiple analysts not cheaply known at the call
site; whole-map clear is provably correct and the map is tiny.

---

## 2. THE INVALIDATION MATRIX (exhaustive)

Method: grepped both files for every `supabase.from("accuracy_checks")` and
`supabase.from("accuracy_disputes")` call and classified each as a READ or a
WRITE (`.insert` / `.update` / `.delete`). Every WRITE is listed below with the
caches it must clear. Completeness is argued after the table.

### Caches (short names)

- **M** = accuracy-checks meta (`getAccuracyChecksMeta`)
- **D** = deleted-checks meta (`getDeletedAccuracyChecksMeta`)
- **GD** = all disputes (`getAllDisputes`)
- **OC** = open dispute counts (`getOpenDisputeCounts`)

> There is **no column A**: the per-analyst keyed cache is dropped (its fetch is
> dead code — see §1). No mutation needs to clear it because nothing populates
> it. If the keyed cache is adopted later, add column A and clear it (whole-map)
> on every check mutation that today clears M.

### `accuracy_checks` mutations → caches cleared

| Mutation (fn) | Write it performs | M | D | GD | OC | Why |
|---|---|---|---|---|---|---|
| `saveAccuracyCheck` | INSERT active row | ✅ | — | — | — | New active check appears in meta. Not deleted (D), creates no disputes (GD/OC). |
| `updateAccuracyCheck` | UPDATE summary/analyst/label of one active row | ✅ | — | — | — | Changes meta figures and possibly `analyst_name`; M reflects it. Dispute rows unchanged; deleted-ness unchanged. |
| `propagateMasterCorrection` | UPDATE many active rows (re-grade) | ✅ | — | — | — | Mass summary change across analysts → clear M. No delete; disputes untouched. |
| `mergeMasters` | UPDATE source rows' name+XML (Step 3), then re-grade whole dest group (Step 4) | ✅ | — | — | — | Mass name + summary change → M. Invalidate right after Step 3's write guard (see Wiring). Soft-deleted rows untouched; no dispute change. |
| `renameMaster` | UPDATE `file_name_master` on active group | ✅ | — | — | — | `file_name_master` is a meta column shown in lists → M. |
| `deleteMaster` | **soft-delete** one active row (sets `deleted_at`) | ✅ | ✅ | ✅ | ✅ | Row leaves active (M) and enters deleted (D). Its disputes drop out of GD/OC because those are `accuracy_checks!inner(deleted_at IS NULL)` filtered — cross-table. |
| `deleteAccuracyCheck` | **soft-delete** one row | ✅ | ✅ | ✅ | ✅ | Same as above: leaves active, enters deleted, hides its disputes from GD/OC. |
| `restoreAccuracyCheck` | **restore** (clears `deleted_at`) | ✅ | ✅ | ✅ | ✅ | Row re-enters active (M), leaves deleted (D); its disputes re-appear in GD/OC. Cross-table. |
| `purgeAccuracyCheck` | hard DELETE (CASCADE deletes its disputes) | ✅ | ✅ | ✅ | ✅ | Row removed from deleted view (D) — purge is called only on already-deleted rows, so M rarely changes, but clearing it is harmless and keeps the rule uniform. CASCADE removes dispute rows → GD/OC. |
| `fixStaleMasterTotals` | UPDATE `master_total` on rows | ✅ | — | — | — | `master_total` is a meta/leaderboard column → M. Deleted-ness and disputes unchanged. |
| `backfillPlayerAccuracy` | UPDATE summary cols on many active rows | ✅ | — | — | — | Mass summary change (incl. accuracy/master_total used by leaderboards) → M. Admin-triggered. **Clear unconditionally on normal return** (never gate on the `updated` count — see Wiring). No delete; no dispute change. |
| `recomputeAllPlayerAccuracy` | thin wrapper → `backfillPlayerAccuracy(force)` | ✅ | — | — | — | Same as backfill. Only needs the wiring once (inside backfill) — see note. |

### `accuracy_disputes` mutations → caches cleared

| Mutation (fn) | Write it performs | M | D | GD | OC | Why |
|---|---|---|---|---|---|---|
| `createDispute` — insert branch | INSERT new open dispute | — | — | ✅ | ✅ | A new open dispute changes the global list and the open-count badges. Check rows untouched (M/D). |
| `createDispute` — update/restore branch | UPDATE existing (reason/category and/or clear `deleted_at` to restore) | — | — | ✅ | ✅ | Re-flagging may restore a soft-deleted dispute (re-adds to GD, and to OC if open) and/or change its reason/category shown in GD. |
| `createDispute` — empty-patch early return | **NO WRITE** (`patch` empty → `return existingDispute`) | — | — | — | — | Performs no mutation; **gets no invalidation** (clearing here would be needless). |
| `resolveDispute` | UPDATE `status` → confirmed/denied | — | — | ✅ | ✅ | Leaves the OPEN set (OC) and its status changes in GD. |
| `deleteDispute` | **soft-delete** (sets `deleted_at`) | — | — | ✅ | ✅ | Drops out of both GD and OC (both filter `deleted_at IS NULL`). |
| `restoreDispute` | **restore** (clears `deleted_at`) | — | — | ✅ | ✅ | Re-enters GD and (if open) OC. |

### Completeness justification

1. **Enumeration is by write-site, not by name.** Every `.insert`/`.update`/
   `.delete` against the two tables in both files is in one of the two tables
   above. The reads (`select` with no write) — `getDisputesForCheck`,
   `getAllDisputes`, `getOpenDisputeCounts`, `getAccuracyCheck*`,
   `getSavedMaster*`, `getMasterCheckSiblings`, `countActiveGroupSiblings`,
   `resolveActiveGroupIds`, `diagnoseMasterConsistency` (read-only, explicitly
   documented as touching no data), `getAccuracyChecksXml`,
   `getAllAccuracyChecks` — perform no writes and need no invalidation.
2. **`recomputeAllPlayerAccuracy` is a wrapper** over `backfillPlayerAccuracy`,
   so wiring the invalidation INSIDE `backfillPlayerAccuracy` covers both. The
   invalidation is placed once, on the normal return path, UNCONDITIONALLY — it
   is NOT gated on `updated > 0`. (A mid-loop clear is unnecessary: nothing reads
   the cache during the synchronous admin backfill. Clearing even on a
   zero-update run is harmless — the next read simply re-fetches unchanged data —
   and keeping it unconditional removes any chance of a committed row-update
   slipping through without a clear.)
3. **Cross-table rows (the subtle completeness point).** `getAllDisputes` and
   `getOpenDisputeCounts` join `accuracy_checks!inner(deleted_at)` and filter
   `accuracy_checks.deleted_at IS NULL`. Therefore a check's soft-delete,
   restore, master-level delete, or purge changes which disputes those two
   fetches return WITHOUT writing any dispute row. The four check mutations that
   change a check's deleted-ness or remove it (`deleteAccuracyCheck`,
   `deleteMaster`, `restoreAccuracyCheck`, `purgeAccuracyCheck`) therefore clear
   **GD and OC in addition to the check cache (M, and D where relevant)**. This is the one place where
   "check mutations invalidate check caches, dispute mutations invalidate
   dispute caches" is deliberately widened, and it is required for correctness.
   Conversely, check mutations that do NOT change deleted-ness
   (`saveAccuracyCheck`, `updateAccuracyCheck`, `propagateMasterCorrection`,
   `mergeMasters`, `renameMaster`, `fixStaleMasterTotals`, backfill) do NOT
   touch GD/OC: the set of disputes and their open-status is unchanged by a
   re-grade or rename, so clearing the dispute caches there would be needless
   over-invalidation (correct but wasteful) — omitted deliberately, with this
   reasoning.
4. **Dispute mutations never change check caches.** None of
   `createDispute`/`resolveDispute`/`deleteDispute`/`restoreDispute` writes an
   `accuracy_checks` row, and neither M nor D derives from dispute data (the
   badges are overlaid by the UI from OC, which IS invalidated). So dispute
   mutations clear only GD/OC. Verified: no check-cache field is a function of
   dispute rows.

5. **`createDispute` has two write branches and one no-write branch.** The
   function first looks up an existing dispute for the instance/side.
   (a) If one exists and the computed `patch` is non-empty, it UPDATEs
   (reason/category and/or `deleted_at = null` to restore) → invalidate GD+OC.
   (b) If one exists but `patch` is empty, it `return`s the existing row with
   **no write** → **no invalidation** (there is nothing to make stale; adding a
   clear here would be needless churn). (c) If none exists, it INSERTs a new open
   dispute → invalidate GD+OC. So both write branches clear GD+OC and only the
   empty-patch early return is exempt, matching the "invalidate after a committed
   write" rule exactly.

### Wiring mechanics

- `accuracyChecks.ts` mutations call the local `invalidate…` functions directly
  (same module).
- For the cross-table clears, `accuracyChecks.ts` must clear the dispute caches
  that live in `disputes.ts`. Import them:
  `import { invalidateAllDisputesCache, invalidateOpenDisputeCountsCache } from "@/lib/api/disputes";`.
  (`disputes.ts` does not import from `accuracyChecks.ts` for invalidation, so
  there is no import cycle: the dependency is one-directional,
  accuracyChecks → disputes. `disputes.ts` already imports only `@/lib/supabase`.
  Verified no cycle is introduced.)
**The placement rule (precise):** *fire the invalidation after any committed
write on that code path, BEFORE any later step that can throw.* "After the write"
is not enough on its own — a multi-step mutation can commit an early write and
then throw in a later step, and if the clear sits only at the end it is skipped
and leaves a stale cache. The three mutation shapes:

- **Single-write mutations** (`saveAccuracyCheck`, `updateAccuracyCheck`,
  `renameMaster`, `deleteMaster`, `deleteAccuracyCheck`, `restoreAccuracyCheck`,
  `purgeAccuracyCheck`, `fixStaleMasterTotals`, and all four dispute mutations):
  place the `invalidate…` call(s) immediately AFTER that write's
  `if (error) throw` guard. A failed write throws before the clear, so a still-
  valid cache is never cleared on failure. (`fixStaleMasterTotals` loops but each
  iteration is an independent single write; a single clear after the loop is
  fine because no earlier committed write is followed by a throw — a per-row
  error is `continue`d, not thrown. For robustness the clear still runs on the
  normal return regardless of how many rows were fixed.)

- **`mergeMasters` (two writes, Step 3 throws / Step 4 is resilient-but-loads).**
  Step 3 is a single `.update({file_name_master, xml_master})` on the source ids
  that THROWS on error; Step 4 reloads the destination group (its `loadErr` path
  THROWS) then re-grades row by row (per-row errors swallowed). **Invalidate M
  immediately after Step 3's `if (error) throw` guard** — i.e. the moment the
  source rows are committed under the destination name/XML. This is mandatory:
  if the clear were placed only at the end, a run where Step 3 commits but
  Step 4's reload throws would return via exception with M stale (the moved rows
  already carry a new name/summary-to-be). Clearing right after Step 3 covers
  both the moved rows AND the subsequent Step-4 re-grades (one clear suffices;
  re-clearing after Step 4 is unnecessary because nothing reads M between Step 3
  and the function returning). `mergeMasters` does not touch deleted-ness or
  dispute rows, so only M is cleared.

- **`backfillPlayerAccuracy` (resilient loop, always returns normally).** It
  never throws out of the loop (per-row fetch/update errors are counted and
  `continue`d), so it always reaches its normal `return`. **Invalidate M on that
  normal return, unconditionally** — do NOT gate on `updated > 0`. Any committed
  row update makes M stale; a run that updated nothing clearing M is harmless
  (next read re-fetches unchanged data). Placing it on the unconditional return
  guarantees no committed update escapes without a clear. `recomputeAllPlayerAccuracy`
  inherits this because it is a thin wrapper over `backfillPlayerAccuracy`.

- **`propagateMasterCorrection` (loop that THROWS on any per-row error).** Here a
  per-row `upErr` throws, so the loop can commit several rows and then throw mid-
  way. A clear placed only after the loop would be skipped on that throw, leaving
  M stale for the rows already updated. Two correct options: (a) clear M once
  immediately BEFORE the loop returns on success AND in a `catch`/`finally` so a
  mid-loop throw still clears, or (b) wrap the loop so the clear runs on both
  paths. **Chosen: wrap the clear in a `try { …loop… } finally { invalidate M }`**
  (or clear in both the success return and before re-throwing). The `finally`
  form is simplest and provably correct: whether the loop completes or throws
  after committing some rows, M is cleared exactly once. (This is the same
  "committed-write-then-later-throw" hazard as `mergeMasters`, handled the same
  way — any path that may have committed an `accuracy_checks` write must clear M
  before control leaves the function.)

Summary rule for the implementer: **for every mutation, identify each point at
which an `accuracy_checks` (or `accuracy_disputes`) write is committed; ensure
the matching `invalidate…` call(s) run on every control-flow path that reaches
or passes such a commit — including exception paths — using a `finally` where a
later step can throw after an earlier commit.**

---

## 3. Correctness questions (resolved)

**Q1 — Hard reload / pull-to-refresh re-fetches everything.** The caches are
module-scoped `let`/`Map` bindings — ordinary JavaScript module state in the
loaded document. A browser **hard reload** (or a PWA pull-to-refresh that
reloads the document) tears down and re-evaluates every module, so `metaCache`
etc. are re-initialized to `null`/empty and the next call re-fetches from
Supabase. The cache therefore can NEVER block a deliberate full refresh; it only
affects in-session client-side revisits (navigating back to a view without a
document reload), which is exactly the egress we want to eliminate. This matches
the existing `clubConfig`/`fixtureMap` caches, which rely on the same reload
semantics. **Verified against the repo's pull-to-refresh implementation:**
`components/pwa/usePullToRefresh.ts` triggers a refresh by calling
`window.location.reload()` (a full document reload), which discards the JS
context and re-initializes all module caches to empty — so a deliberate
pull-to-refresh always re-fetches and the cache can never block it. (I confirmed
the caches hold no persistence layer —
no `localStorage`/`IndexedDB`/service-worker cache is involved, so there is no
cross-reload survival to reason about.)

**Q2 — Cross-tab / cross-user staleness; TTL?** A module cache is per
JS-context (per tab). User A's mutation invalidates only A's tab; another admin's
already-open tab keeps its cache until that tab reloads or performs its own
mutation. **Decision: accept this, no TTL** — identical to the existing
`clubConfig`/`fixtureMap` caches, which have no TTL and the same cross-tab
behavior, and which the app already ships with. Adding a TTL would reintroduce
periodic full-table fetches (the exact egress we are cutting) for a staleness
window that the existing caches already tolerate app-wide. There is no concrete
correctness requirement for sub-reload cross-tab freshness here (these are
admin/analyst review views, not real-time dashboards; the data changes on
deliberate admin actions, and the acting tab is always fresh). If a future
requirement demands cross-tab freshness, the right tool is the Supabase Realtime
subscription the repo already uses (`subscribeToAccuracyCheck`) to call the
`invalidate…` functions on remote changes — NOT a polling TTL. Documented as the
future path; not built now (out of scope, and would add egress).

**Q3 — A failed fetch must not poison the cache.** Mirrored exactly from
`ensureClubConfigCache`'s `.catch`: the single-value caches assign
`cache = fetch().catch(e => { cache = null; throw e; })`, so a rejected fetch
resets the slot to `null` and still rejects the awaiting callers; the next call
retries. The keyed primitive (`createKeyedCache`, specified for future use)
does the same with `map.delete(key)` in its `.catch`. Net effect: a transient
Supabase error yields a normal rejection to
the current callers and a clean retry on the next call — never a permanently
cached rejected promise.

**Q4 — Extract a pure, unit-testable helper?** **Yes — recommended, and this is
the unit-test target.** The Supabase coupling makes the cached FETCH functions
impractical to unit-test directly (they'd need a mocked PostgREST client), but
the cache *mechanism* (populate-once, dedupe-concurrent, reset-on-error,
keyed-by-normalized-key, invalidate) is pure control flow independent of
Supabase. Extracting it into `lib/api/cache.ts` as `createCache(fn)` /
`createKeyedCache(fn, keyFn)` lets us unit-test the mechanism against a trivial
counting/throwing stub `fn`, which is where the real risk lives (does a reject
reset the slot? do concurrent callers share one call? does invalidate force a
re-call? does the keyed version isolate keys?). The two data modules then wrap
their existing fetch bodies with the helper. If, for any reason, the helper is
judged to add indirection the team dislikes, the inline per-module pattern (§1)
is the equally-correct fallback and the fetch bodies can be smoke-tested only
via integration — but the pure helper is preferred precisely because it makes
the one risky part testable. See §5 for the helper contract and tests.

---

## 4. Edge cases

- **Empty results** cache normally (an empty array is a valid cached value); the
  next read reuses `[]` until an invalidation. Correct: an empty table stays
  empty until a mutation.
- **Concurrent first callers** share one in-flight promise (promise-dedupe), so
  two views mounting together make ONE request, not two.
- **Mutation while a fetch is in flight:** `invalidate()` sets the slot to
  `null`; the in-flight promise still resolves for its current awaiters (with
  possibly pre-mutation data), but the NEXT call — including the component's
  post-mutation refetch — sees `null` and starts a fresh fetch. Since UIs
  refetch AFTER awaiting their mutation (the mutation resolves, then the view
  reloads its list), the post-mutation read always gets fresh data. This matches
  the existing caches' semantics.
- **Resilient / multi-step mutations** (`mergeMasters`, `backfillPlayerAccuracy`,
  `propagateMasterCorrection`): the invalidation is placed per the precise
  placement rule in §2 "Wiring mechanics" — after a committed write and before
  any later step that can throw (immediately after `mergeMasters` Step 3; on the
  unconditional normal return of `backfillPlayerAccuracy`; in a `finally` around
  `propagateMasterCorrection`'s throwing loop). Any changed row makes M stale,
  and a wholly-failed run clearing M merely forces a harmless re-fetch of
  unchanged data. This is the finding-#2 fix: a committed early write followed by
  a later throw can never skip the clear.
- **Purge of an already-deleted check:** clearing M is a no-op in practice
  (the row wasn't in the active meta cache) but keeps the rule uniform and is
  harmless; D/GD/OC do change (the row leaves the deleted view and its disputes
  are CASCADE-removed).

---

## 5. Shared helper contract + testing

### `lib/api/cache.ts` (new, pure, no Supabase import)

```ts
/** Single-value cache: populate once, dedupe concurrent callers, reset on error. */
export function createCache<T>(fetcher: () => Promise<T>): {
  get: () => Promise<T>;
  invalidate: () => void;
} {
  let cache: Promise<T> | null = null;
  return {
    get() {
      if (!cache) {
        cache = fetcher().catch((e) => {
          cache = null; // never poison the cache
          throw e;
        });
      }
      return cache;
    },
    invalidate() {
      cache = null;
    },
  };
}

/** Keyed cache: one entry per normalized key; invalidate clears the whole map. */
export function createKeyedCache<T>(
  fetcher: (arg: string) => Promise<T>,
  keyFn: (arg: string) => string = (s) => s
): {
  get: (arg: string) => Promise<T>;
  invalidate: () => void;
} {
  const map = new Map<string, Promise<T>>();
  return {
    get(arg) {
      const key = keyFn(arg);
      let p = map.get(key);
      if (!p) {
        p = fetcher(arg).catch((e) => {
          map.delete(key);
          throw e;
        });
        map.set(key, p);
      }
      return p;
    },
    invalidate() {
      map.clear();
    },
  };
}
```

Usage in `accuracyChecks.ts` keeps the exported signatures identical:

```ts
const metaCached = createCache(fetchAccuracyChecksMeta);
export function getAccuracyChecksMeta() { return metaCached.get(); }
export function invalidateAccuracyChecksMetaCache() { metaCached.invalidate(); }

// NOT wired in this task — getAccuracyChecksForAnalyst is dead code today
// (see §1 "Keyed cache (dropped)"). The createKeyedCache helper below is
// specified + unit-tested so a FUTURE analyst-history view can adopt it:
//
//   const analystCached = createKeyedCache(
//     fetchAccuracyChecksForAnalyst,
//     (name) => name.trim().toLowerCase(),
//   );
//   export function getAccuracyChecksForAnalyst(name: string) {
//     return analystCached.get(name);
//   }
//   export function invalidateAccuracyChecksForAnalystCache() {
//     analystCached.invalidate(); // whole-map clear, wired into every check mutation
//   }
```

(The `let`-based inline form in §1 is the identical fallback if the team prefers
no helper; the helper is recommended because it is the testable unit. `createKeyedCache`
is still built and tested now even though no production code wires it yet — it is
a few pure lines and keeps the future adoption to one call site.)

### Unit tests — `lib/api/cache.test.ts` (Vitest)

Pure, no network, no Supabase. Drive each helper with a stub `fetcher` that
counts calls and can be made to reject.

`createCache`:
- **populate once:** two sequential `get()`s with a counting fetcher → fetcher
  called exactly once; both resolve to the same value.
- **dedupe concurrent:** two `get()`s called before the first resolves →
  fetcher called once; both awaits resolve to the same value/instance.
- **invalidate forces re-fetch:** `get()`, `invalidate()`, `get()` → fetcher
  called twice.
- **error does not poison:** a fetcher that rejects once then succeeds →
  first `get()` rejects, second `get()` re-calls and resolves (proves the slot
  reset to `null` on error).

`createKeyedCache`:
- **key isolation:** `get("a")` and `get("b")` → fetcher called once per
  distinct key.
- **normalization collapses keys:** with `keyFn = trim().toLowerCase()`,
  `get("Jane")`, `get(" jane ")`, `get("JANE")` → fetcher called once; all share
  one entry.
- **invalidate clears all keys:** populate "a" and "b", `invalidate()`, re-get
  both → fetcher called twice more (2 before + 2 after = 4 total).
- **error does not poison a key:** a key whose first fetch rejects then succeeds
  → first rejects, second re-calls and resolves.

### Why not unit-test the data modules directly

The cached fetch bodies are thin wrappers over the Supabase client; testing them
would mean mocking PostgREST query-builder chains, which is brittle and tests the
mock more than the code. The behavior worth protecting — the cache state
machine — is fully exercised by the pure-helper tests above. The data modules'
correctness reduces to "wrap the right fetch with a cache" and "call the right
`invalidate…` after each write", which are verified by **code review against the
invalidation matrix** (§2) and by the existing app flows (integration-level:
mutate in a view, confirm the list reflects it on the post-mutation refetch).
This split — unit-test the pure mechanism, review-verify the wiring — is the
honest testability boundary given the Supabase coupling, as Q4 requires.

### Verification plan

- `npm run lint` and `npm test` (Vitest) must pass; the new `cache.test.ts` runs
  under the existing `vitest --run` script (no config change — the repo uses
  Vitest defaults with co-located `*.test.ts`).
- `npx tsc --noEmit` (or `npm run build`) to confirm the unchanged public
  signatures still typecheck across all callers and that the one-directional
  `accuracyChecks → disputes` import adds no cycle.
- **Cross-table wiring grep (Finding #6).** Grep the four check mutations that
  must clear the dispute caches — `deleteAccuracyCheck`, `deleteMaster`,
  `restoreAccuracyCheck`, `purgeAccuracyCheck` — and confirm each one both
  imports and CALLS `invalidateAllDisputesCache` and
  `invalidateOpenDisputeCountsCache` (in addition to its M/D clears). Also
  confirm the import line `import { invalidateAllDisputesCache,
  invalidateOpenDisputeCountsCache } from "@/lib/api/disputes";` is present in
  `accuracyChecks.ts` and that `disputes.ts` still imports only `@/lib/supabase`
  (no cycle). `tsc` catches a broken import, but this grep confirms the call
  sites exist, not just the import.
- **Placement grep (Finding #2).** Confirm `mergeMasters` clears M immediately
  after its Step-3 `if (error) throw`; `backfillPlayerAccuracy` clears M on its
  unconditional normal return (not gated on `updated`); and
  `propagateMasterCorrection` clears M on both the success and throw paths
  (`finally`).
- Manual smoke (optional, documented): open Accuracy History (populates M),
  perform each mutation class once, confirm the list reflects the change on
  revisit (proves the matrix wiring), and confirm a hard reload re-fetches.

---

## 6. Scope / constraints recap

- Touch only `lib/api/accuracyChecks.ts`, `lib/api/disputes.ts`, new
  `lib/api/cache.ts` + `lib/api/cache.test.ts`.
- No UI component, comparison engine, grading, DB schema, or on-demand/XML fetch
  changes. Exported signatures identical.
- Behavior-preserving is the acceptance criterion: the invalidation matrix (§2)
  is the correctness contract; every in-scope fetch has a cleanly wired
  invalidation for every mutation that can make it stale, so no fetch is cached
  without complete invalidation. Nothing had to be skipped-for-safety under this
  analysis.
- **Cached in this task: four single-value caches** — `getAccuracyChecksMeta`
  (M), `getDeletedAccuracyChecksMeta` (D), `getAllDisputes` (GD),
  `getOpenDisputeCounts` (OC). The parameterized `getAccuracyChecksForAnalyst`
  keyed cache is **deliberately dropped** because the fetch is dead code today
  (zero callers); the keyed primitive is specified + tested for future adoption.
  This narrows the cache surface to exactly the live egress drivers, honoring
  "a smaller, provably-correct cache is better than a broad one."

---

## 7. Responses to design-review findings

This is the revision addressing `.agents/tasks/design-review.md` /
`design-review.json` (verdict: CHANGES_REQUESTED — 2 MEDIUM, 4 NIT). Each
finding is addressed below; none was backlogged or ignored.

- **Finding #1 (MEDIUM) — `getAccuracyChecksForAnalyst` has zero callers.**
  ADDRESSED by taking the review's recommended option (a): **dropped the
  per-analyst keyed cache from this task.** Re-ran the worktree grep and
  confirmed the only hits are the function's own definition and doc-comment
  mentions — it is dead code. The Background and §1 now state it is uncalled and
  not cached; column **A** was removed from every row of the §2 matrix; and no
  `invalidateAccuracyChecksForAnalystCache()` wiring is added to any mutation.
  The keyed-cache primitive (`createKeyedCache`) and its tests are retained in §5
  so a future analyst-history view adopts it in one line (with the correct
  `trim().toLowerCase()` key and whole-map invalidation), but nothing production
  wires it now. This strictly shrinks scope and removes ~10 no-benefit call-site
  edits.

- **Finding #2 (MEDIUM) — invalidation placement under-specified for the merge
  two-step and the resilient loops.** ADDRESSED in §2 "Wiring mechanics" with a
  precise placement rule: *fire the invalidation after any committed write on
  that path, before any later step that can throw.* Concretely: `mergeMasters`
  invalidates M immediately after Step 3's `if (error) throw` (so a Step-4 load
  throw cannot leave M stale); `backfillPlayerAccuracy` invalidates M on its
  unconditional normal return (never gated on `updated > 0`); and
  `propagateMasterCorrection` (whose per-row loop THROWS) clears M in a `finally`
  so a mid-loop throw after committing rows still clears. §4 and the matrix rows
  were updated to match, and §5 verification adds a placement grep.

- **Finding #3 (NIT) — `createDispute` dual nature collapsed into one matrix
  row.** ADDRESSED: the §2 dispute table now has three explicit rows for
  `createDispute` — insert branch (GD+OC), update/restore branch (GD+OC), and
  the empty-patch early return (NO write → NO invalidation). Completeness
  justification item 5 spells out the three branches.

- **Finding #4 (NIT) — keyed-cache key relies on ILIKE semantics worth
  stating.** ADDRESSED in §1 "Keyed cache (dropped)": added the sentence that
  the key equals the normalized query argument, so each key maps 1:1 to its
  query result regardless of ILIKE `%`/`_` wildcard behavior, requiring no extra
  normalization. (Documented on the future primitive since the cache itself is
  dropped.)

- **Finding #5 (NIT) — shared-array-reference invariant documented but not
  enforced.** ADDRESSED (kept as-is per the review's "acceptable as-is"): the §1
  shared-reference note now records the verification of the two live callers
  (both non-mutating), states the explicit rule for future callers to copy
  before in-place sort/splice, and names the one-line `result.slice()` fallback
  if it ever becomes a real hazard. No defensive copy is added today.

- **Finding #6 (NIT) — verification should assert the cross-module invalidation
  import + call sites.** ADDRESSED: §5 verification plan adds an explicit grep
  step confirming all four cross-table mutations (`deleteAccuracyCheck`,
  `deleteMaster`, `restoreAccuracyCheck`, `purgeAccuracyCheck`) both import and
  call `invalidateAllDisputesCache` + `invalidateOpenDisputeCountsCache`, plus
  the no-cycle confirmation.
```

