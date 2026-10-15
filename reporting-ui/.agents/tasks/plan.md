# Implementation Plan — client-side cache for meta/list Supabase fetches

Follows the approved design (`.agents/tasks/design.md`) and its APPROVED review
(`.agents/tasks/design-review.md`). All paths are in the worktree
`c:\Users\AndyDin\reporting-dashboard\.worktrees\meta-cache\reporting-ui`.
The main tree at `...\reporting-dashboard\reporting-ui` must NOT be touched.

Scope recap (do not exceed it): touch only `lib/api/cache.ts` (new),
`lib/api/cache.test.ts` (new), `lib/api/accuracyChecks.ts`, and
`lib/api/disputes.ts`. Exported function signatures stay IDENTICAL — caching is
added INSIDE the existing functions; only new `invalidate…Cache()` functions are
added to the module exports. Cache the Promise (not the resolved value) and
reset the slot to `null` on failure, mirroring `lib/api/fixtureMap.ts` /
`lib/api/clubConfig.ts`. `getAccuracyChecksForAnalyst`, `getAllAccuracyChecks`,
`getDisputesForCheck`, and all single-row/XML fetches are NOT cached (design §1,
§6). Build/test commands are run from the worktree root with `npm` (scripts:
`"test": "vitest --run"`, `"build": "next build"`, `"lint": "eslint"`; vitest
`include: ["**/*.test.ts","**/*.test.tsx"]`, jsdom env).

The order is dependency-driven: the pure helper and its test land first (item 1,
2), then each module is wired on top of it (items 3–6), then full verification
(item 7). Every item leaves the tree buildable.

---

- [ ] 1. Create the pure, Supabase-free cache helper module.
      Add `createCache<T>(fetcher)` (single-value: populate-once, dedupe
      concurrent callers, reset slot to `null` on reject then rethrow) and
      `createKeyedCache<T>(fetcher, keyFn = s => s)` (one entry per normalized
      key via a `Map<string, Promise<T>>`, `map.delete(key)` on reject,
      `invalidate()` = `map.clear()`), both returning `{ get, invalidate }`.
      Copy the two function bodies VERBATIM from design §5. No imports; no React,
      no `localStorage`/`IndexedDB`, no TTL. `createKeyedCache` is built now even
      though no production code wires it yet (future per-analyst adoption).
      Files: lib/api/cache.ts
      Verify: `npm run build` from the worktree root compiles (the module is
      pure TS and will be covered by tests in the next item).

- [ ] 2. Add the Vitest unit test for the cache helper.
      Co-located `*.test.ts` (matches `lib/comparison/overlap-window.test.ts`).
      Drive each helper with a counting/throwing stub `fetcher` — no network.
      `createCache`: (a) populate once — two sequential `get()`s call fetcher
      exactly once and resolve to the same value; (b) dedupe concurrent — two
      `get()`s before the first resolves call fetcher once and resolve to the
      same instance; (c) `invalidate()` forces a re-fetch (fetcher called twice);
      (d) error does not poison — a fetcher that rejects once then succeeds:
      first `get()` rejects, second re-calls and resolves.
      `createKeyedCache`: (a) key isolation — `get("a")`/`get("b")` call fetcher
      once per distinct key; (b) normalization collapses keys — with
      `keyFn = s => s.trim().toLowerCase()`, `"Jane"`, `" jane "`, `"JANE"` call
      fetcher once; (c) `invalidate()` clears all keys (2 before + 2 after = 4
      calls); (d) error does not poison a key — first fetch rejects, second
      re-calls and resolves. Cover all eight cases from design §5.
      Files: lib/api/cache.test.ts
      Verify: `npm test` — the new `lib/api/cache.test.ts` suite passes along
      with the existing suites.

- [ ] 3. Wire the two meta caches into `accuracyChecks.ts` and add their
      invalidators. Rename the current bodies of `getAccuracyChecksMeta` and
      `getDeletedAccuracyChecksMeta` to inner `fetchAccuracyChecksMeta()` /
      `fetchDeletedAccuracyChecksMeta()` (verbatim — keep the paging loop and the
      single select respectively). Add module-scope
      `const metaCached = createCache(fetchAccuracyChecksMeta)` and
      `const deletedMetaCached = createCache(fetchDeletedAccuracyChecksMeta)`
      (import `createCache` from `@/lib/api/cache`). Re-implement the two public
      functions to `return metaCached.get()` / `deletedMetaCached.get()` with
      their ORIGINAL exported signatures (`(): Promise<AccuracyCheckMeta[]>`).
      Export `invalidateAccuracyChecksMetaCache()` and
      `invalidateDeletedAccuracyChecksMetaCache()` that call the matching
      `.invalidate()`. Do NOT cache `getAccuracyChecksForAnalyst` or
      `getAllAccuracyChecks`.
      Files: lib/api/accuracyChecks.ts
      Verify: `npm run build` compiles (public signatures unchanged, so all
      callers still typecheck).

- [ ] 4. Wire the two dispute caches into `disputes.ts` and add their
      invalidators. Rename the bodies of `getAllDisputes` and
      `getOpenDisputeCounts` to inner `fetchAllDisputes()` /
      `fetchOpenDisputeCounts()` (verbatim — keep the paging loops and the
      `accuracy_checks!inner(deleted_at)` filters). Add module-scope
      `const allDisputesCached = createCache(fetchAllDisputes)` and
      `const openCountsCached = createCache(fetchOpenDisputeCounts)` (import
      `createCache` from `@/lib/api/cache`). Re-implement the public functions to
      `return allDisputesCached.get()` / `openCountsCached.get()` with their
      ORIGINAL signatures (`(): Promise<Dispute[]>` and
      `(): Promise<Record<number, number>>`). Export
      `invalidateAllDisputesCache()` and `invalidateOpenDisputeCountsCache()`.
      `disputes.ts` keeps importing only `@/lib/supabase` plus the new
      `@/lib/api/cache` — it must NOT import from `accuracyChecks.ts` (one-way
      dependency, no cycle). Do NOT cache `getDisputesForCheck`.
      Files: lib/api/disputes.ts
      Verify: `npm run build` compiles.

- [ ] 5. Add invalidation calls to every `accuracy_disputes` mutation in
      `disputes.ts`, per the design §2 dispute matrix. In every case fire BOTH
      `invalidateAllDisputesCache()` and `invalidateOpenDisputeCountsCache()`
      immediately AFTER the write's `if (error) throw` guard (so a failed write
      never clears a still-valid cache):
      - `createDispute` — insert branch: after the INSERT's error guard.
      - `createDispute` — update/restore branch: after the UPDATE's error guard.
      - `createDispute` — empty-patch early return (`Object.keys(patch).length
        === 0` → `return existingDispute`): NO invalidation (no write).
      - `resolveDispute`: after its UPDATE error guard.
      - `deleteDispute`: after its UPDATE (soft-delete) error guard.
      - `restoreDispute`: after its UPDATE (restore) error guard.
      These are the 5 write sites from the review table (lines ~108, 122, 249,
      271, 287) plus the deliberate no-write branch. No check caches are touched
      here (dispute mutations never change M/D).
      Files: lib/api/disputes.ts
      Verify: `npm run build` compiles; `npm test` still passes.

- [ ] 6. Add invalidation calls to every `accuracy_checks` mutation in
      `accuracyChecks.ts`, per the design §2 check matrix, including the
      cross-table dispute clears. First add the one-directional import
      `import { invalidateAllDisputesCache, invalidateOpenDisputeCountsCache }
      from "@/lib/api/disputes";` (and use the local meta invalidators from
      item 3). Then wire each mutation to the EXACT caches below (M = meta,
      D = deleted meta, GD = all disputes, OC = open counts), following the
      placement rule — fire after each committed write and before any later step
      that can throw, using `finally`/unconditional-return where a later step can
      throw after an earlier commit:
      - `saveAccuracyCheck` (INSERT): clear M after the insert error guard.
      - `updateAccuracyCheck` (UPDATE one row): clear M after the update error
        guard.
      - `propagateMasterCorrection` (per-row loop that THROWS on `upErr`): wrap
        the loop in `try { … } finally { invalidateAccuracyChecksMetaCache(); }`
        so a mid-loop throw after committing rows still clears M. (Only M.)
      - `renameMaster` (UPDATE `file_name_master`): clear M after the update
        error guard. (Only M.)
      - `deleteMaster` (soft-delete one row): after the update error guard clear
        M, D, GD, OC (cross-table — the row's disputes drop out of GD/OC).
      - `mergeMasters`: clear M immediately after Step 3's
        `.update({file_name_master, xml_master})` `if (error) throw` guard (NOT
        at function end — a Step-4 `loadErr` throw must not leave M stale). One
        clear suffices because nothing reads M between Step 3 and return. (Only
        M; merge touches no deleted-ness or disputes.)
      - `fixStaleMasterTotals` (resilient loop, `continue` on per-row error,
        never throws out): clear M once on the normal return, unconditionally
        (like backfill — review NIT #3). (Only M.)
      - `backfillPlayerAccuracy` (resilient loop, always returns normally): clear
        M on the unconditional normal `return { updated, skipped }` — do NOT gate
        on `updated > 0`. This also covers `recomputeAllPlayerAccuracy` (thin
        wrapper), so add NO separate clear there. (Only M.)
      - `deleteAccuracyCheck` (soft-delete): after the update error guard clear
        M, D, GD, OC (cross-table).
      - `restoreAccuracyCheck` (restore): after the update error guard clear
        M, D, GD, OC (cross-table).
      - `purgeAccuracyCheck` (hard DELETE, CASCADE): after the delete error guard
        clear M, D, GD, OC (CASCADE removes child disputes).
      This covers all 12 check write sites from the review table. The four
      cross-table mutations (`deleteMaster`, `deleteAccuracyCheck`,
      `restoreAccuracyCheck`, `purgeAccuracyCheck`) are exactly the ones that
      clear GD+OC in addition to the check caches.
      Files: lib/api/accuracyChecks.ts
      Verify: `npm run build` compiles with no import cycle (tsc would flag a
      broken/cyclic import); `npm test` still passes.

- [ ] 7. Full verification pass and matrix spot-checks.
      Run the project's real commands and the design §5 placement/cross-module
      checks:
      - `npm run build` (Next.js build / tsc) from the worktree root — succeeds,
        confirming unchanged public signatures typecheck across all callers and
        the `accuracyChecks → disputes` import adds no cycle.
      - `npm test` — all suites pass, including the new `lib/api/cache.test.ts`.
      - `npm run lint` — no new lint errors in the four touched files.
      - Cross-table wiring check (review Finding #6): confirm `deleteMaster`,
        `deleteAccuracyCheck`, `restoreAccuracyCheck`, and `purgeAccuracyCheck`
        each CALL both `invalidateAllDisputesCache` and
        `invalidateOpenDisputeCountsCache` (not just that the import line exists),
        and that `disputes.ts` imports only `@/lib/supabase` and `@/lib/api/cache`.
      - Placement check (review Finding #2): confirm `mergeMasters` clears M
        right after Step 3's `if (error) throw`; `backfillPlayerAccuracy` clears
        M on its unconditional return; `propagateMasterCorrection` clears M in a
        `finally`.
      Files: none (verification only)
      Verify: `npm run build`, `npm test`, and `npm run lint` all succeed and the
      two spot-checks above hold.

---

## Notes / assumptions

- Design §4 shared-array-reference invariant: callers get the same array
  instance on cache hits. The two live consumers (`app/accuracy-checks/page.tsx`,
  `app/disputes/page.tsx`) only `map`/`filter`/sort-on-copy, so no defensive
  `.slice()` is added (matches design, review Finding #5). Do not introduce an
  in-place sort/splice on a cached result in these modules.
- No Next.js API surface is added — these are plain JS module caches in the
  existing `lib/api/*` data layer (design "No new Next.js API" section), so the
  AGENTS.md Next.js-docs rule imposes no additional reading for this change.
- The `createKeyedCache` helper is implemented and tested but intentionally NOT
  wired to any production fetch (`getAccuracyChecksForAnalyst` is dead code —
  design §1 "Keyed cache (dropped)"); no mutation gets a per-analyst invalidator.
