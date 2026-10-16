# Supabase Log Ingestion — Findings Report

_Read-only investigation. No code was changed. All paths are under `c:\Users\AndyDin\reporting-dashboard\reporting-ui\` unless noted._

## Summary answer (read this first)

- **Everything that touches Supabase runs in the browser.** The app is a Next.js **static export** (`next.config.js` → `output: "export"`, `package.json` deploy script `gh-pages -d out`). There are **no** server components doing DB work, **no** `app/api` route handlers, **no** server actions (`'use server'` returns zero matches in source), **no** `getServerSideProps`, and **no** Supabase **Edge Functions** (`supabase/functions` does not exist; the only thing in `supabase/` is one `.sql` file). The Supabase client in `lib/supabase.ts` is created with the **anon key only** — there is no `service_role` key anywhere in source.
- **Consequence for logs:** the app's own `console.error` / `console.warn` / `console.log` calls go to the **browser console only**. They do **NOT** feed Supabase log ingestion. So "reduce our logging" is not the lever — chasing `console.*` statements will not move the quota.
- **What actually drives Supabase log ingestion here is REQUEST VOLUME.** Every PostgREST (REST) call the browser makes is one API-gateway log line, and the two biggest multipliers are (a) **1000-row paginated loops** that fire 2+ requests per full-table read, and (b) **per-navigation / per-mount refetches** (especially the sidebar unread-count query that runs on every page change). **Supabase Realtime** channels (messages + single-check subscription) are a secondary, smaller contributor to Realtime logs.
- **The high-frequency pollers (2–5s `setInterval`) do NOT hit Supabase.** Live Scores, Push Log, Operations, Recommendations, Fixtures and Comp-Fixtures polling all target the external .NET API (`downloads.premierdata-technology.com`) or the **Cloudflare Worker** (PlayHQ) — not Supabase. Do not "fix" those to reduce Supabase logs; they would reduce egress/load on *other* services, not Supabase ingestion.
- **The second workspace `PDAutoDownload` does NOT use Supabase** (grep for `supabase`/`SUPABASE` across its `.ts/.tsx/.cs/.json` returns nothing). It talks to the same .NET API, not the Supabase project. It is **not** a contributor and can be set aside.

---

## Evidence

### 1. Server vs client execution — it's all client-side

| Check | Result | Evidence |
|---|---|---|
| Static export (no server runtime) | ✅ confirmed | `next.config.js`: `output: "export"`; `package.json` → `"deploy": "gh-pages -d out"` |
| `'use server'` / server actions | none | grep over `app,lib,components,src/**/*.{ts,tsx}` → no matches |
| `app/api` route handlers | none | `file_search` for `reporting-ui/app/api` → no files |
| `getServerSideProps` / `getStaticProps` | none | grep → no matches |
| `service_role` key | none | grep → no matches; `lib/supabase.ts` uses `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Supabase Edge Functions | none | `supabase/functions` does not exist; `supabase/` contains only `fixture_report_overrides.sql` |

`lib/supabase.ts` in full:
```ts
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

A single anon client, imported by the `lib/api/*` modules, which are in turn imported by `'use client'` pages. There is no second (server) client. **Therefore the data layer only ever runs in the browser, and its `console.*` output never reaches Supabase.**

> Side note (not a log-ingestion issue, but worth flagging): because it's the anon key and earlier notes say **RLS is off**, every table is world-readable/writable by anyone with the public anon key. That is a security exposure independent of logging. Out of scope for this report, but it should be on the backlog.

### 2. Which `lib/api` modules actually hit Supabase

Modules importing `@/lib/supabase` (these generate PostgREST log lines):

- `lib/api/accuracyChecks.ts`
- `lib/api/disputes.ts`
- `lib/api/auth.ts` (login reads, `role_permissions`)
- `lib/api/messages.ts` (+ **Realtime**)
- `lib/api/clubConfig.ts`
- `lib/api/compFixtures.ts`
- `lib/api/fixtureMap.ts`
- `lib/api/fixtureOverrides.ts`
- `lib/api/awsCostCategories.ts`
- `lib/api/analysts.ts` (partly — also calls the .NET API)

Modules that do **NOT** hit Supabase (they `fetch` the external .NET API or the Cloudflare Worker — **irrelevant to Supabase ingestion**):

- `lib/api/operations.ts`, `downloadJobs.ts`, `autodownload.ts`, `fixtures.ts`, `reviewFixtures.ts`, `computers.ts`, `assignFixture.ts`, `config.ts` → `downloads.premierdata-technology.com` (`API_URL`)
- `lib/api/playhq.ts` → Cloudflare Worker (`WORKER_BASE`, `playhq-scores.*.workers.dev`)
- `lib/api/comps.ts`, `jadeCompMap.ts`, `lmsProvision.ts`, `fixtureReports.ts` → other external hosts

### 3. High-frequency `setInterval` pollers — none hit Supabase

| Page | Interval | Calls | Target |
|---|---|---|---|
| `app/operations/page.tsx` | 5s (`REFRESH_INTERVAL`) + 1s clock | `getOperations` | **.NET API** `/api/operations` |
| `app/recommendations/page.tsx` | 2s + 5s | `getDownloadJobs`, `getAutoDownloadFixtures` | **.NET API** `/api/downloadjobs`, `/api/fixtures` |
| `app/fixtures/page.tsx` | 5s | `refreshFixtures` | **.NET API** `/api/fixtures` |
| `app/comp-fixtures/page.tsx` | 5s | `pullApiStatus` | **.NET API** (live status overlay) |
| `app/live-scores/page.tsx` | `LIVE_POLL_MS`, only while a match is live | PlayHQ score/live fetches | **Cloudflare Worker** |
| `app/push-log/page.tsx` | `POLL_MS` | `getPushLog` | **Cloudflare Worker** `/api/push-log` |

All six also wire a SignalR hub (`lib/signalr.ts` → `downloads.premierdata-technology.com/operationsHub`). **None of this is Supabase.** Reducing these intervals would lighten the .NET API / Worker, not the Supabase quota.

### 4. The real Supabase volume drivers

#### 4a. 1000-row paginated loops (each full read = 2+ REST requests)

All of these page with `pageSize = 1000` and loop until `data.length < pageSize`. Note the loop issues **one extra empty request** whenever the row count is an exact multiple of 1000 (e.g. exactly 1000 active checks ⇒ 2 requests, the 2nd returning 0 rows):

- `lib/api/accuracyChecks.ts` → `fetchAccuracyChecksMeta` (backs `getAccuracyChecksMeta`), `getAllAccuracyChecks` — full `accuracy_checks` scan, projected to meta columns (XML blobs excluded, good)
- `lib/api/disputes.ts` → `fetchAllDisputes` (backs `getAllDisputes`), `fetchOpenDisputeCounts` (backs `getOpenDisputeCounts`) — full `accuracy_disputes` scans with an inner join on `accuracy_checks`
- `lib/api/compFixtures.ts` → **six** separate paged loops over `comp_fixtures`, `teams`, `comp_sources` (`queryCompFixtures`, distinct-season/competition, team maps, excluded-competition cleanup, source status)
- `lib/api/analysts.ts` → deputy-shifts roster paged loop
- `lib/data/loadDeputyRoster.ts` → paged `.range()` roster load

The comment in `disputes.ts` confirms the design intent is to defeat PostgREST's ~1000-row cap. That is correct for completeness, but it means a table in the low thousands of rows costs 2–4 gateway log lines **per full read**, and these full reads happen on page mount.

#### 4b. Per-navigation / per-mount refetches (the quiet multiplier)

- **`components/layout/Sidebar.tsx`** — the unread-message badge `useEffect` depends on **`[user, pathname]`**, so it calls `getUnreadCount(uid)` (a Supabase read) **on every route change**, and re-opens a Realtime subscription (`subscribeToAllMessages`) each time too. The sidebar is on every authenticated page, so this is likely the single most frequent Supabase REST call in normal use.
- `app/accuracy-checks/page.tsx` and `app/disputes/page.tsx` each fire `getAccuracyChecksMeta()` + `getOpenDisputeCounts()` / `getAllDisputes()` on mount (via `Promise.all`), i.e. several paged scans per visit.

#### 4c. Supabase Realtime subscriptions (feed Realtime logs, smaller)

- `lib/api/messages.ts` → `subscribeToConversation` and `subscribeToAllMessages` (`postgres_changes`). Each consumer opens a **uniquely-named channel** on purpose (comment explains the sidebar badge + `ChatWidget` would otherwise collide). So on a typical page you have: sidebar badge channel + chat widget channel, re-created on navigation (see 4b).
- `lib/api/accuracyChecks.ts` → `subscribeToAccuracyCheck` (single-row `accuracy_checks` channel) when a check view is open.

These require Realtime to be enabled on the tables and generate Realtime log lines on connect/subscribe churn.

#### 4d. What already helps

`lib/api/cache.ts` provides `createCache` (populate-once, dedupe-concurrent, reset-on-error) and `createKeyedCache`. It is wired into:
- `accuracyChecks.ts`: `metaCached` / `deletedMetaCached` back `getAccuracyChecksMeta` / `getDeletedAccuracyChecksMeta`, with explicit invalidation on every mutation.
- `disputes.ts`: `allDisputesCached` / `openCountsCached` back `getAllDisputes` / `getOpenDisputeCounts`.

So **within a session**, repeat reads of the checks-meta and disputes lists are deduped — a real reduction already in place. The cache does **not** survive a full page reload or help the per-navigation sidebar query (which is a different call: `getUnreadCount`).

---

## Config levers (reported, not changed)

| Lever | Where | Effect on log ingestion |
|---|---|---|
| Reduce request **volume** (pagination, dedupe, polling, per-nav refetch) | **App-side** (this repo) | **Directly** reduces API-gateway log lines. The main lever you control. |
| `log_statement`, `log_min_duration_statement`, Postgres log level | **Supabase dashboard** (Database settings) | Affects Postgres log verbosity. On the **Free plan**, control is limited. |
| Log **retention** window | **Supabase dashboard** | Affects stored volume, limited on Free. |
| API-gateway logging (every REST/Storage/Auth call logged) | **Supabase-side**, not configurable on Free | Can't be turned down; only way to reduce is **fewer requests**. |
| Realtime logging | Supabase-side | Reduce by opening fewer / fewer-churning channels. |
| Plan upgrade (higher ingestion quota) | **Plan** | Raises the ceiling; doesn't reduce usage. |

Because the API-gateway logs one line per request and that can't be dialed down on Free, **the only functionality-preserving way to move the needle is to cut request count.**

---

## Recommendations (prioritized; all preserve functionality)

Ranked by expected impact on **log ingestion** (request count). Each notes whether it also affects egress.

1. **Collapse the sidebar per-navigation refetch.** `components/layout/Sidebar.tsx` re-runs `getUnreadCount` and re-subscribes on every `pathname` change. Change the effect dependency from `[user, pathname]` to `[user]` and rely on the existing Realtime subscription (plus an on-read refresh) to update the badge. This removes one Supabase REST call **per navigation** app-wide — likely the biggest single win. _(Ingestion: large. Egress: small.)_

2. **Collapse the 1000-row pagination loops where a single range covers the table.** For `accuracy_checks` and `accuracy_disputes`, if the live row counts are under the PostgREST max-rows limit, a single `.range(0, N-1)` (or raising the project's max-rows) reads the table in **one** request instead of 2+. At minimum, **avoid the extra empty trailing request** by breaking when `data.length < pageSize` *before* issuing the next page (already done) and seeding the first page size from a cheap `head: true` count when near a 1000 boundary. _(Ingestion: medium–large depending on table sizes. Egress: neutral.)_
   - Verify current row counts first (Supabase dashboard or a one-off `count`) to confirm they fit; if a table genuinely exceeds the cap, keep paging but widen `pageSize` to the server max to minimize page count.

3. **Dedupe the remaining hot reads behind `lib/api/cache.ts`.** The checks-meta and disputes lists are already cached. Extend the same `createCache` pattern to `getUnreadCount`, `getRolePermissions` (already effectively once-per-session via `AuthContext`, confirm it isn't refetched per mount), and the `compFixtures.ts` reference-data loops (`teams`, distinct seasons/competitions) which are effectively static within a session. _(Ingestion: medium. Egress: medium.)_

4. **Trim Realtime channel churn.** Because the sidebar + chat widget each open a unique channel and the sidebar re-subscribes per navigation (see #1), fixing #1 already reduces Realtime connect/subscribe log churn. Additionally, mount the message subscriptions **once at a stable layout level** rather than inside components that remount on navigation. _(Ingestion: small–medium on Realtime logs.)_

5. **Confirm Realtime is actually needed where enabled.** `subscribeToAccuracyCheck` and the message channels require Realtime enabled on those tables. If live single-check updates are a nice-to-have, consider gating them so Realtime connections only open on the specific view that needs them (the single-check one already does). _(Ingestion: small.)_

### Explicitly NOT recommended for log ingestion
- **Do not** reduce the 2–5s `setInterval` pollers (Operations / Recommendations / Fixtures / Comp-Fixtures / Live Scores / Push Log) to cut Supabase logs — they hit the **.NET API / Cloudflare Worker**, not Supabase. (Lowering them would reduce load on *those* services only.)
- **Do not** spend effort removing `console.*` statements to cut Supabase logs — this is a **static-export, client-only** app, so those logs are browser-only and never reach Supabase.
- **Do not** investigate `PDAutoDownload` for this — it doesn't use the Supabase project.

### Egress vs ingestion note
Recommendations 1–4 reduce the **number of requests**, which is what drives **log ingestion**. They also incidentally reduce **egress** (bytes returned) — most for the paginated full-table reads (#2, #3), least for the tiny unread-count call (#1, which is big for ingestion but trivial for egress). If egress is a separate concern, the paginated meta/disputes scans and the `xml_master`/`xml_analyst` blob reads (already excluded from meta via `ACCURACY_CHECK_META_COLUMNS`) are where the bytes are.

---

## Caveats / what I could not verify

- **Exact request frequencies and table row counts** were not measured against the live project. The ranking above is reasoned from code paths (loop structure, effect dependencies, mount points), not from Supabase's log/usage dashboard. Confirm the top offenders against the dashboard's "Log Explorer" / API usage before/after any change.
- Whether Realtime is actually **enabled** on `accuracy_checks` / `messages` in the Supabase dashboard isn't visible from the repo (the code degrades gracefully if not). If it's disabled, items #4/#5 contribute nothing today.
- The RLS-off + anon-key exposure noted in §1 is a **security** finding surfaced in passing; it is outside this report's log-ingestion scope.
