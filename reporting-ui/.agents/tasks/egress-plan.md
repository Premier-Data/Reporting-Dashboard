# Egress Reduction Plan — `accuracy_checks` XML blobs

Goal: cut Supabase EGRESS by stopping unnecessary transfer of the two large
columns `xml_master` / `xml_analyst` on `accuracy_checks`. STRICTLY
behavior-preserving: only change a query when it is PROVEN no caller reads the
removed data. Correctness over savings.

Worktree (all paths absolute):
`c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt\reporting-ui`

Project commands (from `package.json`):
- Build: `npm run build` (Next.js 16)
- Typecheck is part of `next build`; standalone: `npx tsc --noEmit`
- Tests: `npm test` (vitest `--run`)
- Lint: `npm run lint`

---

## Key finding (changes the shape of the task)

The egress fix was ALREADY rolled out across the live code path. Every list /
summary / leaderboard view already calls the blob-free projection
`getAccuracyChecksMeta()` (and `getDeletedAccuracyChecksMeta()`), both of which
select `ACCURACY_CHECK_META_COLUMNS` — every column EXCEPT `xml_master` /
`xml_analyst`. The aggregation helpers (`summariseByAnalyst`,
`countMasterChecks`, `teamAccuracy`) all take `AccuracyCheckMeta`.

The two named candidate functions are **dead code**:

- `getAllAccuracyChecks()` — `lib/api/accuracyChecks.ts:1312`, pages `select("*")`
  INCLUDING both blobs.
- `getAccuracyChecksForAnalyst()` — `lib/api/accuracyChecks.ts:1291`, `select("*")`.

Neither is referenced anywhere in `app/`, `lib/`, `components/`, or any
`*.test.ts(x)`. The only textual hit is a stale comment inside
`summariseByAnalyst` ("Newest first (getAllAccuracyChecks returns desc)").

Consequence: projecting these two produces **zero runtime egress savings today**
(nothing calls them, so nothing is transferred). The real egress win was already
captured by the pre-existing `getAccuracyChecksMeta` migration. The remaining
work is to remove the latent `select("*")` + blob risk so a future caller can
never silently reintroduce the egress, and to keep the module consistent with
the established pattern — all while changing no runtime behavior.

---

## Caller-by-caller safety table

Call sites enumerated by grepping each function name across
`.worktrees/egress-opt/reporting-ui\app`, `\lib`, `\components`, plus `*.test.*`.

### 1. `getAllAccuracyChecks()`  (`lib/api/accuracyChecks.ts:1312`)

| Caller | File:line | Reads `.xml_master` / `.xml_analyst`? | Decision |
|--------|-----------|----------------------------------------|----------|
| (none) | — | n/a — zero call sites | PROJECT (safe; dead code) |

Every caller proven "no" (vacuously — there are none). Safe to project.

### 2. `getAccuracyChecksForAnalyst()`  (`lib/api/accuracyChecks.ts:1291`)

| Caller | File:line | Reads XML? | Decision |
|--------|-----------|------------|----------|
| (none) | — | n/a — zero call sites | PROJECT (safe; dead code) |

Every caller proven "no". Safe to project.

### 3. `comp_fixtures` `select("*")`  (`lib/api/compFixtures.ts:125`, `queryCompFixtures`)

| Fact | Detail |
|------|--------|
| Row shape | `CompFixtureRow` = 20 small scalar columns (ids, team names, date/time, score, video_url/name, game_key). NO XML/JSON blob column. |
| Consumers | The `/comp-fixtures` page and master/analyst pickers read many of these columns (home_team, away_team, score, video_url, fixture_date, etc.). |
| Savings | Negligible — rows are tiny; there is no large unused column to drop. |
| Risk | Projecting an explicit column list risks omitting a currently-consumed field and breaking a view, for ~0 egress benefit. |

Decision: **LEAVE UNCHANGED** (matches the task's "SKIP if rows are small"). The
other `comp_fixtures` reads (`compFixtures.ts:200,432,664,762`) already select
only the columns they need; no change.

### 4. `user_accounts` `select("*")`  (`lib/api/auth.ts:262`, `login`)

| Fact | Detail |
|------|--------|
| Row shape | Small account row; the two "largest" columns (`password_hash`, `salt`) are REQUIRED here to verify the password. |
| Fetch size | Single row (`.limit(1).maybeSingle()`). |
| Savings | None — no large unused column; `select("*")` here deliberately includes the secrets it must read. |

Decision: **LEAVE UNCHANGED**. (`listUsers` at `auth.ts:293` already projects a
safe column list.)

---

## Functions to LEAVE UNCHANGED and why (on-demand XML paths)

These legitimately need the blobs; do NOT touch them:

- `getAccuracyCheckById()` (`:1273`, `select("*")`) — opens one saved check;
  `app/accuracy-compare/page.tsx` and `app/disputes/page.tsx` read
  `check.xml_master` / `check.xml_analyst` to re-populate the compare view.
- `getSavedMasterXml()` (`:~1250`) — single-row XML fetch for the "reuse master"
  dropdown and inside `mergeMasters`.
- `getAccuracyChecksXml()` (`:~1450`) — batched single-row on-demand XML for
  scope player-accuracy and master-timeline download in
  `app/accuracy-checks/page.tsx`.
- All XML-parsing paths: `saveAccuracyCheck`, `updateAccuracyCheck`,
  `propagateMasterCorrection`, `mergeMasters`, `backfillPlayerAccuracy`,
  `recomputeAllPlayerAccuracy`, `diagnoseMasterConsistency`,
  `fixStaleMasterTotals`, `gradeOverlapScoped`, `instancesFromRaw`. These read
  or rewrite XML by design — out of scope.
- `getAccuracyChecksMeta()` / `getDeletedAccuracyChecksMeta()` — already
  projected; the correct pattern — no change.

Do NOT change grading logic, the comparison engine, UI behavior, or the DB
schema. Do NOT alter any XML-parsing path.

---

## Implementation plan (ordered, each item leaves the tree buildable)

- [ ] 1. Project `getAllAccuracyChecks()` to drop the XML blobs and return
      meta rows.
      In `lib/api/accuracyChecks.ts` change its `select("*")` (line ~1320) to
      `select(ACCURACY_CHECK_META_COLUMNS)`, change the return type to
      `Promise<AccuracyCheckMeta[]>`, the local `rows` type to
      `AccuracyCheckMeta[]`, and the cast to `as unknown as AccuracyCheckMeta[]`
      (mirror `getAccuracyChecksMeta` exactly — same paging loop, same
      `ACCURACY_CHECK_META_COLUMNS`, same `deleted_at IS NULL` + `created_at`
      desc ordering). Update its doc comment to note it is blob-free like
      `getAccuracyChecksMeta`. This is behavior-preserving because the function
      has no callers; the only observable effect is that any FUTURE caller gets
      meta rows and cannot pull blobs.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npx tsc --noEmit` reports no new errors; `npm run build`
      succeeds; `npm test` passes (no test references this function).

- [ ] 2. Project `getAccuracyChecksForAnalyst()` the same way.
      Change its `select("*")` (line ~1296) to
      `select(ACCURACY_CHECK_META_COLUMNS)`, return type to
      `Promise<AccuracyCheckMeta[]>`, and the final cast to
      `as unknown as AccuracyCheckMeta[]`; keep the existing
      `deleted_at IS NULL` + `ilike(analyst_name)` + `created_at` ascending
      filters/ordering unchanged. Update the doc comment to note it is
      blob-free. Behavior-preserving for the same reason as item 1 (zero
      callers).
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npx tsc --noEmit` clean; `npm run build` succeeds; `npm test`
      passes.

- [ ] 3. (Optional, cosmetic) Fix the stale comment in `summariseByAnalyst`
      (line ~1701) that references `getAllAccuracyChecks` so it no longer names
      a function that no list view uses — e.g. "Newest first (list fetch returns
      desc), so [0] is latest." Pure comment edit; no code change.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npm run build` succeeds; `npm test` passes.

### Alternative to items 1–2 (note for the implementer, do not do both)

Because both functions are unreferenced dead code, an equally valid and even
smaller-footprint option is to DELETE `getAllAccuracyChecks` and
`getAccuracyChecksForAnalyst` outright (they export nothing anyone imports).
Deletion removes the latent `select("*")` entirely. Chosen recommendation is to
PROJECT (items 1–2) rather than delete, because: it is the lowest-risk edit
(keeps the exported API surface intact in case anything resolves them
dynamically or is added later), and it keeps the module uniform with the
established `*Meta` pattern. If the reviewer prefers a leaner module, deleting
is also safe given the zero-caller proof above. Either way, nothing else needs
to change — do not pick both.

---

## Verification summary (project's real commands)

1. `cd c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt\reporting-ui`
2. `npx tsc --noEmit` — no new type errors from the changed return types.
3. `npm run build` — Next.js build succeeds.
4. `npm test` — vitest suite passes (confirms no test depended on the old
   `select("*")` return including blobs; none reference these functions).
5. `npm run lint` — no new lint errors.

Grep is NOT used as verification; it was used only for the caller audit above.

## Assumptions / gaps

- Assumed no dynamic/string-based resolution of these two function names (none
  found in `app`/`lib`/`components` or docs beyond the stale comment and
  ARCHITECTURE.md prose). If a future consumer is added, projecting (not
  deleting) keeps it safe by construction.
- No DB schema or RLS change is implied; the projection only narrows the
  selected column list on existing queries.
