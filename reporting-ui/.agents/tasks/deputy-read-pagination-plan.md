# Implementation Plan — deputy-read pagination fix

Fixes the confirmed row-limit bug: `deputy-read` reads `deputy.timesheets` and
`deputy.rosters` with `.limit(20000)`, but PostgREST's server-side
`db-max-rows` (1000) clamps every response to 1000 rows, so the function
silently returns only the most recent 1000 rows and every date-range
aggregation undercounts. The fix is in-function pagination over `.range()`;
no schema, config, page, or sync changes.

## Design decisions (grounded in the three files read)
- **Pure helper + async loop split.** `shape.ts` is deliberately framework-free
  (no Deno/Supabase imports) so it can be unit-tested from Node under vitest via
  `lib/deputy/deputyRead.test.ts`. The page-stop predicate is pure logic → it
  goes in `shape.ts` as `needsAnotherPage(...)` with tests. The async
  `.range()` accumulation loop depends on the supabase client → it stays in
  `index.ts`. This mirrors the existing `attachNames`/`resolveNames` split.
- **Predicate shape.** `needsAnotherPage(lastPageCount, pageSize, accumulated, maxRows): boolean`.
  Returns `true` only when the last page was full (`lastPageCount === pageSize`,
  i.e. more rows likely remain) AND we are still under the safety ceiling
  (`accumulated < maxRows`). A short/empty last page or hitting `maxRows` stops
  the loop. This keeps the "is there another page?" decision testable without a
  live DB.
- **PAGE = 1000** (matches PostgREST's cap, so a full page signals "more may
  remain"); **MAX_ROWS = 20000** stays as the memory/runaway ceiling.
- **Order stability.** Each ranged request must re-apply the SAME `.order(...)`
  as today (`roster_date` desc for rosters, `timesheet_date` desc for
  timesheets) so paging is stable across requests. Note: ordering by date alone
  is not a strict total order (ties possible), but this preserves existing
  behavior exactly as required by the task; we do not add tiebreakers.
- **Joins run once, after pagination.** `resolveNames`/`attachNames` run on the
  full accumulated row set once (not per page), exactly as the current code
  runs them once on the single response.
- **Error path unchanged.** A query error on ANY page returns
  `{ error: "query_failed" }` with status 500 and logs, identical to now. The
  loop returns early on the first page error.

## Items

- [ ] 1. Add the pure `needsAnotherPage` helper to `shape.ts`.
      Signature: `needsAnotherPage(lastPageCount: number, pageSize: number, accumulated: number, maxRows: number): boolean`.
      Returns `true` iff `lastPageCount === pageSize && accumulated < maxRows`;
      otherwise `false`. Add a short JSDoc explaining it drives the deputy-read
      pagination loop. Keep the file free of Deno/Supabase imports.
      Files: `supabase/functions/deputy-read/shape.ts`
      Verify: `npm test` still passes (no behavior change yet; existing tests
      unaffected).

- [ ] 2. Add unit tests for `needsAnotherPage` to `lib/deputy/deputyRead.test.ts`.
      Import `needsAnotherPage` from `../../supabase/functions/deputy-read/shape`
      (add to the existing import block). Add a `describe("needsAnotherPage")`
      covering: full page under ceiling → `true` (e.g. `(1000, 1000, 1000, 20000)`);
      short last page → `false` (e.g. `(342, 1000, 1342, 20000)`); empty last page
      → `false` (`(0, 1000, 1000, 20000)`); ceiling reached even on a full page →
      `false` (e.g. `(1000, 1000, 20000, 20000)`); first full page with more to
      come → `true` (`(1000, 1000, 1000, 20000)` already covered — also assert a
      mid-loop case like `(1000, 1000, 5000, 20000)` → `true`).
      Files: `lib/deputy/deputyRead.test.ts`
      Verify: `npm test` — the new `needsAnotherPage` tests pass and all existing
      tests still pass.

- [ ] 3. Add a generic page-accumulation loop in `index.ts` and route both reads through it.
      Add `const PAGE = 1000;` near `MAX_ROWS`. Import `needsAnotherPage` from
      `./shape.ts` (add to the existing import block). Introduce a private async
      helper in `index.ts`, e.g.
      `async function fetchAllPages(buildQuery: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<{ rows: Json[]; error: unknown }>`
      that loops: for `offset = 0; ; offset += PAGE` run `buildQuery(offset, offset + PAGE - 1)`,
      on error return `{ rows: accumulated, error }` immediately, else push
      `data ?? []` onto the accumulator and call
      `needsAnotherPage(pageCount, PAGE, accumulated.length, MAX_ROWS)` to decide
      whether to continue; stop when it returns false. (`buildQuery` receives the
      per-page `.range(from, to)` bounds and applies `.range` itself.) Keep this
      helper in `index.ts` because it closes over the supabase query builder.
      Files: `supabase/functions/deputy-read/index.ts`
      Verify: the function still compiles under Deno conventions; `index.ts` stays
      in the tsconfig `exclude` list (do NOT remove it). Build check for the repo:
      `npm test` (unit tests) passes. (This item is wired up by items 4–5; it may
      be introduced together with them in one edit since `index.ts` must stay
      buildable — see note below.)

- [ ] 4. Rewrite `readRosters` to paginate via `fetchAllPages`.
      Replace the single `.limit(MAX_ROWS)` query with a `buildQuery(from, to)`
      that reproduces the EXACT existing query on every page: same
      `.schema("deputy").from("rosters").select(<same column list>)`,
      `.order("roster_date", { ascending: false })`, and `.range(from, to)`
      (instead of `.limit`). On `error` return `json({ error: "query_failed" }, 500)`
      with the existing `console.error`. On success call
      `resolveNames(supabase, rows)` ONCE on the full accumulated set and return
      `json({ rows }, 200)`.
      Files: `supabase/functions/deputy-read/index.ts`
      Verify: same as item 3 — `npm test` passes; `index.ts` remains excluded from
      typecheck. Manually confirm the `.select` column list and `.order` are byte-
      identical to the original.

- [ ] 5. Rewrite `readTimesheets` to paginate via `fetchAllPages`.
      Same transformation as item 4, preserving the approved-only filter on every
      page: `.eq("time_approved", true).or("discarded.is.null,discarded.eq.false")`,
      the same `.select(<same column list>)`,
      `.order("timesheet_date", { ascending: false })`, and `.range(from, to)`
      replacing `.limit`. Error path and the single post-pagination
      `resolveNames` call identical to item 4.
      Files: `supabase/functions/deputy-read/index.ts`
      Verify: `npm test` passes; `index.ts` stays tsconfig-excluded. Confirm the
      filter chain, `.select`, and `.order` match the original exactly.

- [ ] 6. Final review of unchanged surfaces and full test run.
      Re-read `index.ts` and confirm these are UNCHANGED: CORS block, the
      `OPTIONS`/`method_not_allowed` handling, `SUPABASE_URL`/
      `SUPABASE_SERVICE_ROLE_KEY` → `server_misconfigured` check, `?dataset=`
      routing to rosters/timesheets with `unknown_dataset` otherwise, the
      `{ rows }` success shape, and all `console.error` logs. Confirm `MAX_ROWS`
      is still 20000 and `PAGE` is 1000. Confirm only the three allowed files
      changed.
      Files: (review only) `supabase/functions/deputy-read/index.ts`,
      `supabase/functions/deputy-read/shape.ts`, `lib/deputy/deputyRead.test.ts`
      Verify: `npm test` — entire suite green. `git status` shows only those three
      files modified.

## Verification note (implementation run)

Implemented as planned (first iteration — no review JSON present):
- `shape.ts`: added the pure `needsAnotherPage(lastPageCount, pageSize, accumulated, maxRows)` helper (returns `lastPageCount === pageSize && accumulated < maxRows`). No Deno/Supabase imports added.
- `index.ts`: added `const PAGE = 1000` and an async `fetchAllPages(buildQuery)` loop that pages `.range(offset, offset + PAGE - 1)`, accumulates, returns on the first page error, and consults `needsAnotherPage` to stop. `readRosters` and `readTimesheets` now route through it, swapping `.limit(MAX_ROWS)` for per-page `.range(from, to)` while preserving byte-identical `.select(...)`, the timesheets `.eq("time_approved", true).or("discarded.is.null,discarded.eq.false")` filter, and `.order(...)` on every page. `resolveNames` runs ONCE on the full accumulated set. CORS/auth/env/dataset-routing/error paths unchanged. `MAX_ROWS` still 20000. `index.ts` remains tsconfig-excluded.
- `deputyRead.test.ts`: added a `describe("needsAnotherPage")` block with 5 cases — full page under ceiling → true, mid-loop full page → true, short last page → false, empty last page → false, ceiling reached on a full page → false. All existing tests kept.

Commands run from `reporting-ui/` and their results:
- `npm test` → PASS. 18 test files, 250 tests passed. `lib/deputy/deputyRead.test.ts` reports 16 tests (11 existing + 5 new `needsAnotherPage`).
- `npm run build` → PASS. "Compiled successfully", "Finished TypeScript" (no type errors), all 43 routes generated. `shape.ts` participates in the typecheck and passes; `index.ts` stays excluded.
- `npx eslint supabase/functions/deputy-read/shape.ts lib/deputy/deputyRead.test.ts` → clean (exit 0, no output). The repo's ~256 pre-existing unrelated lint errors were left untouched.
- `git status --short` → only the three allowed files are modified: `supabase/functions/deputy-read/index.ts`, `supabase/functions/deputy-read/shape.ts`, `lib/deputy/deputyRead.test.ts` (other listed `.agents/tasks/*` entries are pre-existing workflow artifacts, not touched here).

No dev server left running.

## Notes / assumptions
- Items 3–5 all edit `index.ts`. To keep the file buildable at each boundary,
  the implementer may land items 3+4+5 as a single coherent `index.ts` edit
  (the helper plus both call sites) rather than an intermediate state where
  `fetchAllPages` exists but is unused. The ordering above reflects dependency,
  not a mandate to leave the file half-wired.
- `shape.ts` must remain importable from Node (no Deno/Supabase imports) so the
  vitest suite keeps working — the new helper is plain arithmetic/boolean logic,
  so this holds.
- `index.ts` must remain in the tsconfig `exclude` array; do not add it to the
  Next typecheck.
- The project's only automated check available here is `npm test` (vitest). The
  Edge Function itself is not exercised by vitest (it imports Deno/jsr); its
  runtime behavior is validated indirectly through the pure `needsAnotherPage`
  tests plus manual byte-for-byte comparison of the preserved query shape. Live
  verification against Supabase (expecting ~8,600 approved timesheets instead of
  1000) is a deploy-time check outside this test harness.
