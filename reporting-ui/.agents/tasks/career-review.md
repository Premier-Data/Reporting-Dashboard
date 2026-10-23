# Full PlayHQ player career on /player via worker proxy

Adds a live "full career" view to the existing `/player?id=<uuid>` page. A new worker route `GET /api/player/:id/profile?tenant=<tenant>` proxies PlayHQ's public Discovery GraphQL player-statistics endpoint with browser-like headers plus a lowercase `tenant` header, flattens the deep GraphQL tree into a `CareerProfile` (career totals + every game the API exposes, most-recent first) inside the worker, and the dashboard renders it directly through a thin `getPlayerCareer` fetch. The page keeps its static-export-safe `"use client"` + `<Suspense>` + `?id=` shape and swaps its data source from the Supabase-backed `getPlayerProfile` to the live proxy. The approach matches the existing spectator-proxy pattern (edge cache, `UpstreamError` mapping, shared CORS) rather than inventing new conventions.

Watch for: the live 200 gate is met by recorded evidence, not re-run here (confirmed — Sam Dunstan APPEARANCE=321, GOAL_COUNT=767, BEST_PLAYER=132 recorded in the plan file and commit message). The plan's ">300 games" expectation was empirically corrected to 98 per-game records because PlayHQ's public API only exposes per-game detail for 6 of 28 seasons; totals remain career-wide (confirmed, documented). No blocking concerns.

**Verdict**: APPROVED

## High-level view

The worker route is modelled directly on the existing grade-games route: UUID validation returning a 400 `invalid_player_id` on bad input, a short (300s) edge cache keyed by `player-career/<id>/<tenant>` with the same HIT/MISS + `ctx.waitUntil(cache.put(...))` shape, and the shared `corsHeaders`/`json` helpers so CORS is inherited, not re-implemented. The upstream fetch sends a Chrome UA, `Accept: */*`, `Origin`/`Referer` of playhq.com, and the critical lowercase `tenant` header — the empirically-confirmed set that returns 200 instead of 403 or the "tenant header is missing" GraphQL error.

Flattening lives in one place (the worker), as the plan chose. The flattener is uniformly defensive: every array access is guarded, a private profile (`publicProfileStatistics: null`) degrades to identity-only with empty totals/games rather than throwing, and stat entries read `count` + `details.value` (the live-corrected single-object shape, not the `details[0].value` array the plan originally assumed). Unknown stat types pass through instead of being dropped.

The data layer adds `getPlayerCareer` without touching `getPlayerProfile`. It resolves the worker base URL with the exact `NEXT_PUBLIC_PLAYHQ_WORKER_URL` expression used by the sibling API modules (declared locally, matching their convention), maps 404 to `null`, surfaces the worker's `error` string on other failures, and re-guards the arrays on the client side.

The page renders name, career-totals cards (every total type, with friendly labels for known types and a title-cased fallback for unknown ones), and a one-line-per-game history table whose Match column is `matchName` ("Home vs Away"), never the id. Loading, error, and a dedicated empty state (private/no-data profile) are all handled. The `<Suspense>` boundary, `useSearchParams` `?id=` read, and `router.back()` navigation are preserved, and `auth.ts`'s `/player → live-scores` alias is untouched.

<details>
<summary>Issues (2)</summary>

1. **Games expectation corrected downward** — plan expected >300 per-game rows; live API only exposes per-game detail for 6 of 28 seasons so 98 rows render. Not a bug; documented in the plan and commit. No action.
2. **Live-200 gate not independently re-run** — per instructions, the reviewer relied on recorded evidence (plan file + commit message) rather than re-hitting PlayHQ. Evidence is present and specific (200, 321/767/132). No action.

</details>

<details>
<summary>Details</summary>

### Transport, tenant header, and the 403 gate

`fetchPlayerCareer` POSTs the verbatim `publicProfileStatistics` document to `https://api.playhq.com/graphql` with the Chrome UA, `Accept: */*`, `Accept-Language`, `Origin: https://www.playhq.com`, `Referer: https://www.playhq.com/`, and `tenant: <tenant>` (falling back to `env.PHQ_TENANT`/`"afl"`). This is the header set the plan's live investigation pinned as the one that returns 200 — a naive UA-less fetch is the documented 403 path, and omitting `tenant` yields the "tenant header is missing" resolver error. The recorded evidence (plan file "Verification evidence" section and the commit body) shows HTTP 200 with real totals, so the critical gate is satisfied (confirmed, from recorded evidence). A 12s `AbortSignal.timeout` bounds the upstream call.

Status mapping is explicit and fail-closed: 429→`rate_limited` (with `Retry-After: 120`), 403→`forbidden`, 404→`not_found`, any other non-ok→`upstream_error`/502, a GraphQL `errors[]` payload→`graphql_errors`/502, and a missing `data`→404. The route's `catch` maps `UpstreamError` to `json({error}, status)` and anything unexpected to `unable_to_retrieve_career`/502, so the upstream status is carried through to the client as the plan required (confirmed).

### Flattening in one place, defensively

`flattenCareer` is the single flattening location (the plan's chosen design — the data layer is a thin typed fetch). It walks `seasonStatistics → statistics → teamStatistics → gradeStatistics → gameStatistics`, and every level guards with `Array.isArray` / null-coalesced object reads via the `strOf` helper, so absent or null nodes produce nulls rather than throwing. A private profile short-circuits to `{ id, firstName, lastName, totals: [], games: [] }` with identity still taken from `publicProfile` (confirmed). `matchName` is `"<home> vs <away>"` with fallback to `team` then game id then `"Unknown match"`, and games sort most-recent-first with undated games pushed last via a stable comparator (confirmed).

The one divergence from the plan text is deliberate and correct: the plan wrote `details[0].value`, but live probing found `details` is a single object. `flattenStats` reads `details?.value` and `count`, skipping entries with no type string. This correction is documented in the plan's evidence section (confirmed).

### API surface and caching

The route matches `^/api/player/([^/]+)/profile$`, decodes the segment, and rejects non-UUIDs with 400 `invalid_player_id` using the pre-existing `UUID_RE` (confirmed — `UUID_RE` is defined in the base file, reused here). `tenant` is read from the query string with `env.PHQ_TENANT`/`"afl"` fallback. The edge cache key `https://playhq-cache/player-career/<id>/<tenant>` and the 300s `Cache-Control` with `X-Cache: HIT/MISS` mirror the grade-games route exactly, and CORS is inherited via the shared `cors` object rather than re-declared (confirmed). Read-only, token-free, consistent with the other public proxy routes.

### Data layer without regressing getPlayerProfile

`getPlayerCareer` declares a local `WORKER_BASE` using the identical `process.env.NEXT_PUBLIC_PLAYHQ_WORKER_URL?.replace(/\/$/, "") || "<workers.dev default>"` expression as `playhq.ts`/`competitors.ts` (not hardcoded, matches the sibling convention). It `encodeURIComponent`s the tenant, maps 404→`null`, extracts the worker's `error` message on other non-ok responses, and defensively re-wraps `totals`/`games` as arrays on return. `getPlayerProfile` and its types are untouched in the diff (confirmed — the diff only adds below the existing export).

### Page: totals, per-game history, and preserved patterns

The page swaps `getPlayerProfile` for `getPlayerCareer` and renders career totals as `StatCard`s over `profile.totals`, labelling `APPEARANCE`/`GOAL_COUNT`/`BEST_PLAYER` and title-casing unknown types so new stats surface instead of being dropped (confirmed). The history table is one line per game with Match (`matchName`, never the id), Round, Date, Grade/Competition, Venue, G, and Best columns; the container was widened `max-w-5xl → max-w-7xl` to fit the extra columns and keeps the `overflow-x-auto` wrapper. Loading, the amber error banner, and a dedicated empty state ("No public career data … the profile may be private") when both totals and games are empty are all present (confirmed). `"use client"`, the `<Suspense>` wrapper around the `useSearchParams` consumer, and `router.back()` are retained, so the static-export shape is intact — no SSR, server routes, or un-parameterized dynamic routes are introduced (confirmed).

### Permission alias and scope

`reporting-ui/lib/api/auth.ts` is not in the diff; `PAGE_KEY_ALIASES["/player"] = "live-scores"` remains, so the guard still admits `/player` for Live Scores roles (confirmed). The diff touches exactly the four intended files plus the plan doc — no unrelated changes bundled in (confirmed).

### Verification evidence (not re-run, per instructions)

The plan file's "Verification evidence" section and the commit body record: live HTTP 200 for Sam Dunstan with APPEARANCE=321 / GOAL_COUNT=767 / BEST_PLAYER=132 and a sample flattened game; worker `tsc --noEmit` exit 0; dashboard `tsc --noEmit` exit 0; `npm run build` static export success producing `out/player.html`. The ">300 games" assertion was relaxed to ">0" with a documented reason (public API exposes per-game detail for only 6 of 28 seasons). Evidence is present and specific, so no suite was re-run and no spot-check was warranted (confirmed).

</details>

<details>
<summary>File map</summary>

- `playhq-worker/src/index.ts` — new career query constant, `fetchPlayerCareer` fetch helper, `flattenCareer`/`flattenStats`/`strOf` flatteners, and the `/api/player/:id/profile` route.
- `reporting-ui/lib/api/players.ts` — new `CareerStat`/`CareerGame`/`CareerProfile` types and `getPlayerCareer`; `getPlayerProfile` untouched.
- `reporting-ui/app/player/page.tsx` — data source swapped to `getPlayerCareer`; totals cards, one-line-per-game history table, empty state; Suspense/`?id=`/`router.back()` preserved.
- `reporting-ui/.agents/tasks/player-career-plan.md` — plan + recorded verification evidence.

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\player-career diff main...feature/player-career`

</details>
