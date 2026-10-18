# Design: Round-Summary board on the Push Activity page

## Overview

The Push Activity page (`reporting-ui/app/push-log/page.tsx`) today renders the
raw TT push log — one row per push the Worker sent, newest first, sortable and
filterable. In peak NTFL season there are 40+ divisions (grades) with 4–6
fixtures each per round, so a single round produces hundreds of log rows and the
operator cannot tell "what is the current scoreline for every fixture in the
round" at a glance.

This feature adds a **summary board above the existing log**: for every division
the Worker knows about, show that division's **most-recent relevant round** with
**all** of its fixtures, each annotated with its **latest pushed score** (or a
muted "not pushed yet" when the push log carries no entry for it).

The crucial constraint that shapes the whole design: **the push log only
contains fixtures that have already been pushed (gone live).** To show *every*
fixture in a round — including upcoming ones that have never been pushed — the
full fixture list must come from the grade **games feed**, not the push log. The
Worker is the only component that already (a) enumerates every registered grade
(`KNOWN_GRADE_IDS` / `DEFAULT_GRADE_IDS`), (b) can fetch each grade's games via
`fetchGradeGames` behind the edge cache, and (c) owns the `PUSH_LOG` KV. So the
**Worker assembles the summary** in a new `GET /api/round-summary` endpoint and
the **frontend just renders it**. This keeps the browser making one cheap call
and puts the fan-out, caching, and join where the data and secrets already live.

A previous attempt derived the summary from the push log alone; it was reverted
because a push-log-only summary can never show a not-yet-pushed fixture. This
design is the grade-feed-backed replacement and must **not** reintroduce any
push-log-derived summary.

## Technology stack (locked)

- **Worker:** TypeScript on Cloudflare Workers, single file
  `playhq-worker/src/index.ts`. No new dependencies. No `wrangler.toml` change —
  caching reuses `caches.default` exactly like the existing grade-games and live
  endpoints. Reuses in-file primitives: `fetchGradeGames`, `competitionLabel`,
  the grade-games `caches.default` cache pattern, `PUSH_LOG` KV + `PUSH_LOG_KEY`,
  `scheduledKickoffMs`, `UUID_RE`, `corsHeaders`, `json`, `UpstreamError`,
  `mapPool`, `DEFAULT_GRADE_IDS`.
- **Frontend:** the page is already a `"use client"` component that fetches
  through a plain browser `fetch` and polls with `useEffect` + `setInterval`
  (the community-library-style client fetching the Next 16 docs describe for
  Client Components — confirmed in `node_modules/next/dist/docs/01-app/
  01-getting-started/06-fetching-data.md` and `.../03-api-reference/01-directives/
  use-client.md`). No Server Component data fetching, `use cache`, or route
  handler is involved, so none of the Next 16 server-caching semantics apply
  here. New fetcher uses `cache: "no-store"` exactly like the existing
  `getPushLog`. New pure helpers live in a small co-located `*.test.ts`-tested
  module; tests run under the existing `vitest` setup (`npm test`).
- **Scope:** Worker = `src/index.ts` only (new endpoint + new pure helpers).
  Frontend = `lib/api/playhq.ts` (new fetcher + types), `app/push-log/page.tsx`
  (new summary section above the unchanged log), and one new pure-helper module
  + its test. The existing log table, its filters, sorting, polling, the
  comparison engine, and all unrelated files stay untouched.

---

## Part 1 — Worker: `GET /api/round-summary`

### 1.1 Route placement and shape

Add the handler in the `fetch` router in `src/index.ts`, matching
`url.pathname === "/api/round-summary"` (an exact-string match is enough — no
params — consistent with the existing `/api/push-log` and `/api/push` checks).
Place it next to the other `/api/...` string-matched routes (e.g. just after the
`/api/push-log` block) and before the final `fixtures/:id/(live|status...)`
regex so it is reached first.

It is a `GET`-only, CORS-wrapped, JSON endpoint:

- Method/OPTIONS/CORS handling is already done at the top of `fetch` (OPTIONS →
  204 with `cors`; non-GET → 405). The handler only runs for GET, and returns
  via the shared `json(body, status, cors)` helper so `Access-Control-Allow-*`
  headers match every other endpoint.
- It **never throws out**: per-grade failures are swallowed (that grade is
  skipped), and the top-level body is whatever succeeded. A total failure still
  returns `200` with `{ rounds: [] }` rather than a 5xx, because an empty board
  is a valid "nothing to show yet" state for the operator and must not surface as
  a red error banner. (The frontend still handles non-200 defensively.)

### 1.2 Response JSON contract (authoritative)

```jsonc
// GET /api/round-summary  →  200
{
  "generatedAt": "2026-10-03T06:12:00.000Z", // ISO; when the board was assembled
  "rounds": [
    {
      "gradeId": "be950883-7630-4df5-81e4-a5bba0f24cb6", // full grade UUID
      "competition": "NTFL Men's Premier",  // competitionLabel(game.url)
      "round": "Round 3",                    // roundObj.name verbatim
      "roundShort": "R3",                    // shortRound(round) — see 1.6
      "roundNum": 3,                          // parsed integer, or null if none
      "fixtures": [
        {
          "id": "a4c47814-bd91-45d5-93e8-227f9c0d72ba", // FULL fixture UUID
          "match": "Waratah vs Nightcliff",  // home vs away, grade suffix stripped
          "scheduled": "2026-10-03T20:00:00", // "<date>T<time>" or null
          "status": "UPCOMING",               // REST status verbatim ("" → "UPCOMING")
          "score": "3.4 (22) - 2.5 (17)",     // latest pushed score string, or null
          "ok": true,                          // latest push accepted? or null
          "ttId": 32656,                       // TT fixtureUid from the push entry, or null
          "lastPushTs": "2026-10-03T20:41:03.004Z" // ISO of the latest push, or null
        }
        // ...all fixtures in this round for this grade
      ]
    }
    // ...one entry per grade that resolved, sorted by competition then roundNum
  ],
  "errors": [ // grades that failed to fetch; non-fatal, for observability
    { "gradeId": "6c2c7212-d1b7-48bb-acee-0fd75ce1984f", "error": "rate_limited" }
  ]
}
```

Notes on the contract:

- `roundNum` is `number | null`: the parsed integer from the round name, or
  `null` for a round whose name carries no number (finals: "Grand Final",
  "Preliminary Final"). This is a deliberate divergence from the legacy
  frontend `roundNum` helper in `page.tsx`, which returns the sentinel `9999`
  for unparseable names — that sentinel is a sort hack local to the log table
  and is **not** reused here (the board never does arithmetic on `roundNum`;
  the selection math uses an explicit `hasNum` flag — see 1.7/1.9). Keeping the
  JSON honest (`null`, not `9999`) means the frontend never has to special-case
  a magic number.
- `rounds` sort is fully specified (no numeric comparison of `null`):
  1. by `competition` ascending (locale compare);
  2. then numbered rounds (`roundNum !== null`) before null-number rounds;
  3. within numbered rounds, by `roundNum` ascending;
  4. within null-number rounds, by `round` name ascending (locale compare).
  This ordering is a pure comparator so it is deterministic and testable; it
  never evaluates `null < number`.
- `fixtures` within a round are sorted by `scheduled` ascending (nulls last),
  then by `match` as a stable tiebreak, so the board order is deterministic and
  does not jitter between polls.
- When a fixture has never been pushed (or its entry aged out of the 100-entry
  cap), `score`, `ok`, `ttId`, and `lastPushTs` are all `null`. `ttId` may also
  be `null` on a pushed fixture whose entry recorded `ttId: null` (unmapped) —
  so `ttId === null` means "unknown", not "not pushed"; `lastPushTs === null` is
  the single source of truth for "not pushed yet".
- `errors` is always present (possibly empty). The frontend ignores it for
  rendering but it makes a partial board diagnosable from the network tab.

### 1.3 Grade enumeration (reuse the exact existing parse)

Reuse the identical parse used by `liveFixtureIds` / `resolveFullGame`:

```ts
const gradeIds = (env.KNOWN_GRADE_IDS ?? DEFAULT_GRADE_IDS.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean)
  .filter((id) => UUID_RE.test(id));
```

Using the same list guarantees the board covers exactly the grades the push
pipeline and live resolution already know about — no drift.

### 1.4 Fetching each grade's games (reuse the grade-games edge cache)

For each grade, read games the same way `resolveFullGame` does: check
`caches.default` for `new Request(\`https://playhq-cache/grade-games/${gradeId}\`)`
first; on a cache hit parse `body.data`; on a miss call
`fetchGradeGames(gradeId, env)`. This reuses the **exact same cache key** the
`/api/grades/:id/games` handler writes, so when the dashboard's Live Scores tab
has recently loaded a grade, the round-summary endpoint pays zero upstream cost
for it.

Crucially, on a miss the round-summary handler must **also populate that shared
cache**. This is a **deliberate NEW write** — a conscious enhancement, *not* a
reuse of `resolveFullGame` (which only ever reads the cache). The pattern it
actually mirrors is the `/api/grades/:id/games` handler's write, and it must
reproduce that handler's expressions **byte-for-byte** so the two writers produce
interchangeable cache entries under the one shared key:

```ts
// identical to the /api/grades/:id/games handler
const ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ?? "90") || 90);
const listTtl = Math.min(ttl, 60) || 60;
const bodyText = JSON.stringify({ gradeId, count: data.length, data });
const toCache = new Response(bodyText, {
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=${listTtl}`,
  },
});
ctx.waitUntil(cache.put(new Request(`https://playhq-cache/grade-games/${gradeId}`), toCache));
```

Note the `|| 90` and `|| 60` fallbacks and the `{ gradeId, count, data }` key
order — these match the existing handler exactly so a cache entry written by
either endpoint reads back identically (and debugging stays unconfusing). The
effect: the first grade fetched by the board warms the cache for the Live Scores
tab and vice-versa, instead of each endpoint re-fetching. The write is
best-effort (`ctx.waitUntil`) and never blocks the response. Because this is new
code rather than reuse, the implementation reviewer should expect it and not flag
it as accidental drift from `resolveFullGame`.

Per-grade failure handling: wrap each grade's fetch in `try/catch`. On
`UpstreamError` push `{ gradeId, error: err.message }` to `errors` and `continue`;
on any other throw push `{ gradeId, error: "fetch_failed" }` and `continue`.
One bad grade never aborts the others. The enumerable `error` tokens are exactly:
`rate_limited | forbidden | not_found | upstream_error` (verbatim from the
`UpstreamError` throws in `fetchGradeGames` — 429/403/401/404/502) and
`fetch_failed` (the catch-all for any non-`UpstreamError` throw). The frontend
treats `errors[]` as opaque/observability-only and does not branch on these
tokens.

### 1.5 Cost-bounding for 40+ grades (the critical resilience decision)

A naive `await fetchGradeGames` in a `for` loop over 40 grades, each paginating
up to 50 pages with a 12 s per-request timeout, can blow the Worker CPU/wall
budget. Two viable approaches:

- **(A) Sequential with cache** — simple, but worst-case 40 × (cold fetch) is
  too slow when the cache is cold (e.g. right after a deploy).
- **(B) Bounded concurrency pool** — reuse the existing `mapPool(items, limit,
  fn)` helper (already in the file, already used by `liveFixtureIds`) to fetch
  grades with at most `N` in flight.

**Chosen: (B), `mapPool` with `limit = 6`.** Rationale: `mapPool` is in-file,
dependency-free, already settles every result so one rejection can't abort the
batch, and bounds the simultaneous upstream load so a cold board doesn't fan out
40 paginated fetches at once. `limit = 6` keeps at most 6 grades' pagination
chains active while cutting cold-board latency ~6× versus sequential. Warm boards
mostly hit the edge cache and return near-instantly regardless.

**Concurrency vs total subrequests — the real ceiling:** `limit = 6` bounds
*concurrency*, not the *total* number of subrequests. A fully cold board over 40
grades still issues, in total, `Σ(pages per grade)` subrequests (each
`fetchGradeGames` follows up to 50 pagination pages, though real NTFL grades are
1–2 pages), funnelled 6-at-a-time through the pool. Cloudflare's per-invocation
subrequest limit (50 on the free plan, 1000 on paid) is the hard ceiling, and
40 grades × ~1–2 pages ≈ 40–80 subrequests would **exceed the free-plan 50**
only on a fully cold board at peak scale. This is mitigated in three independent
ways and is acceptable: (1) the shared grade-games edge cache means boards are
almost never fully cold — a grade loaded by the Live Scores tab or a prior board
poll within 60 s is a cache hit costing zero subrequests; (2) the 45 s board
cache means only ~1 assembly per 45 s does any fetching at all; (3) the deploy
target is the paid plan (1000 subrequests), under which even a worst-case cold
40-grade board is comfortably within budget. If a free-plan deployment at 40+
grades is ever required, raise the board cache TTL and/or stagger grade fetches
across invocations — noted, not needed now. The design asserts safety on the
paid-plan budget with warm-cache dominance, not on concurrency alone.

The per-grade function passed to `mapPool` does the cache-read → fetch →
cache-write → build-one-round work and returns either a `RoundSummary` object or
a sentinel error record; the caller collects fulfilled non-null results into
`rounds` and error records into `errors`. Because `mapPool` never rejects, the
assembly can't throw from a single grade.

The push-log KV is read **once** for the whole request (not per grade) — see 1.7.

### 1.6 Competition label and round naming

- **Competition:** `competitionLabel(game.url)` on any game of the grade (they
  all share the grade's comp slug). Reuse verbatim; it already prettifies
  unknown slugs so the board scales to 40+ comps with no new label entries.
- **Round name:** `String((game.round ?? {}).name ?? "")` — the same
  `roundObj.name` the push pipeline records.
- **Round short + number:** extract with pure helpers named **`shortRound(name)`**
  (the same name and exact branch order as the existing `app/push-log/page.tsx`
  helper — reprinted in §1.9) and **`roundNumOf(name)`** (first `\d+` →
  `number | null`, no `9999` sentinel). The Worker computes `roundShort` once per
  division and ships it as a field, so the frontend renders `division.roundShort`
  directly rather than keeping its own summary copy (the legacy log-table
  `shortRound`/`roundNum` in `page.tsx` stay untouched). The abbreviation set is
  R3, GF, PF, SF, QF, EF; the branch order matters (prelim/semi/qualif/elim are
  tested before any generic "final") — see the reprinted body in §1.9.

### 1.7 LATEST ROUND per grade (correctness-critical — precise rule)

**Goal:** pick the round the operator means by "the current round" — the one
being played now or most recently — **not** a far-future round that merely
exists in the season fixture list, and not a long-past round.

PlayHQ's NTFL REST feed is the hard case: a game stays `status: "UPCOMING"` (or
empty) right up until it flips to `FINAL`; it never reports `IN_PROGRESS`. So
status alone cannot identify "the live round". Scheduling date is the reliable
signal, and `scheduledKickoffMs({date, time})` already converts a grade-feed
schedule to an epoch (Darwin offset, Worker-safe).

**Inherited single-offset assumption (flagged):** `scheduledKickoffMs` hardcodes
the NTFL `+09:30` (Australia/Darwin, no DST) offset — the existing helper already
documents this and that a DST-observing grade would need a per-fixture
`schedule.timezone → offset` lookup. The latest-round selection **inherits** this
assumption: for a non-Darwin grade among the 40+, every kickoff epoch could be off
by the offset delta (hours), which in the worst case shifts the tier A/B
"started/imminent" boundary around the `LOOKAHEAD_MS` window. This is acceptable
for now because (a) the registered grades are NTFL/NT-region (Darwin-zoned) and
(b) a few hours' skew only matters within the narrow 6 h lookahead on the exact
morning of a round; it never picks a far-future or far-past round. If a
DST-observing or non-Darwin grade is ever added, the fix is localised to
`scheduledKickoffMs` (per the existing code comment), and the selection rule
needs no change. This is a known, bounded limitation, not a correctness bug for
the current grade set.

**Rule — "the current round is the latest round that has STARTED; only if none
has started yet does the board look ahead to the one about to start, then to the
first upcoming round":**

1. Group the grade's games by round name. For each round compute:
   - `roundNum = roundNumOf(name)` → `number | null` (null for finals/unnumbered);
   - `hasNum = roundNum !== null`;
   - `earliestKickoff` = the minimum of its fixtures' `scheduledKickoffMs`
     values (ignoring `null`s); `null` if the round has no dated fixture.
2. Let `now = Date.now()`. Define a small lookahead `LOOKAHEAD_MS = 6 h` (one
   match-day slot) so that on the morning of a round's first bounce — before any
   kickoff epoch is `<= now` — the board can still roll forward to that round.
3. **Ordering of rounds** (a single pure comparator `compareRounds`, reused for
   both "highest" and "smallest" below): numbered rounds order *before* unnumbered
   ones; two numbered rounds order by `roundNum`; two unnumbered rounds order by
   name (locale compare). "Highest" = last in this order; "smallest" = first.
   This never compares `null` as a number — the `hasNum` flag decides placement —
   which is what resolves the `9999`-vs-`null` hazard from the JSON contract.
4. **Three-tier selection** (first tier that yields a round wins):
   - **Tier A — started:** among rounds whose `earliestKickoff` is non-null and
     `<= now`, pick the **highest** (per step 3). This is the round currently in
     play or most recently played — the operator's "current round".
   - **Tier B — imminent:** if no round has started, among rounds whose
     `earliestKickoff` is non-null and `<= now + LOOKAHEAD_MS`, pick the
     **highest**. This fires only on the morning of a new round before its first
     bounce, rolling the board forward at most 6 h early.
   - **Tier C — first upcoming:** if no round is started or imminent (pre-season,
     or every remaining round is >6 h away), pick the **smallest** round that has
     any dated fixture (`earliestKickoff` non-null). This shows the season/next
     opener rather than nothing.
5. **Undated fallback:** if *every* round is date-less (`earliestKickoff` null
   for all), none of tiers A–C can fire; fall back to the **highest** round by
   step 3 (best-effort for an undated feed). Rounds with a `null`
   `earliestKickoff` are otherwise invisible to tiers A–C (they cannot be
   "started"/"imminent"/"upcoming" without a date).

The key correctness point versus the previous draft: tiers A and B are
**separate**. When two consecutive rounds are both within the 6 h window (a split
weekend where round N's late games and round N+1's early games overlap), tier A
only considers rounds that have *actually* started (`earliestKickoff <= now`), so
it selects N (started) and does **not** silently jump to N+1 (whose earliest
kickoff is still in the future). N+1 is chosen only once tier A finds nothing
started — i.e. genuinely before N+1 begins and after N is fully in the past
relative to the window. This makes the stated goal ("latest round that has
started, else the next to come") and the implementation agree.

**Why this rule over the alternatives:**

- *Highest round with any non-UPCOMING game* fails for NTFL, where nothing is
  non-UPCOMING until FINAL — mid-round (games scheduled, none final yet) it would
  pick last week.
- *Highest round that exists* is exactly the far-future bug the task warns
  against (a full season is in the feed on day one).
- *Date-of-today exact match* breaks when a round spans Fri–Sun or is split
  across weekends, and shows nothing on a bye week.

The three-tier "started → imminent → first upcoming" rule is robust to the NTFL
status quirk, to multi-day rounds, and to pre-season, and degrades sensibly when
dates are missing.

**Edge cases the rule handles explicitly:**

- *Pre-season / all future:* no round started or imminent → tier C → first
  upcoming round.
- *Mid-round, nothing final yet:* the current round's earliest kickoff is
  `<= now` → tier A selects it (not last week's), even though every game still
  reads UPCOMING. This is the core NTFL-quirk regression guard.
- *Between rounds (round N done, N+1 is days away):* N's earliest kickoff is
  `<= now` and N+1's is >6 h away → tier A's highest *started* round is N → board
  shows the just-completed round N with its final scores, which is what an
  operator checking "did everything push?" wants.
- *Split weekend / two rounds overlap the 6 h window:* N has started
  (`earliestKickoff <= now`), N+1 has not → tier A selects N (started); the board
  does **not** jump to the not-yet-started N+1. It rolls to N+1 only once tier A
  finds no started round and tier B sees N+1 within 6 h of its first bounce.
- *Morning of a new round, before its first bounce:* no round has started today
  → tier A empty → tier B selects the highest round within `now + 6 h` (the new
  round), rolling the board forward at most 6 h early.
- *Bye / partial round:* the round still has fixtures with dates, so it
  participates in tiers A–C normally.
- *Undated feed:* tiers A–C all empty → step 5 fallback to highest round by the
  `compareRounds` order.

This selection is implemented as a **pure function**
`selectLatestRound(games, nowMs)` (see 1.9) so it is fully unit-testable without
network.

### 1.8 Fixtures in the chosen round + the push-log join

Once the round is selected, take **all** games whose `round.name` equals the
chosen round's name. For each game build a fixture record:

- `id`: full UUID `String(game.id)`.
- `match`: `${stripGrade(home.name)} vs ${stripGrade(away.name)}` where
  `stripGrade` is the same regex the push pipeline uses
  (`.replace(/\s+(men|women)\s+premier.*$/i, "").trim()`). Home/away come from
  `competitors.find(c => c.isHomeTeam === true/false)`.
- `scheduled`: `game.schedule.date ? \`${date}T${time || "00:00:00"}\` : null`.
- `status`: `String(game.status ?? "")` normalised so `""`/`"NULL"` →
  `"UPCOMING"` (the NTFL feed uses UPCOMING; an empty status means the same
  pre-FINAL state). This is a pure helper `displayStatus(raw)`.

`venue` is **deliberately not emitted**. The authoritative §1.2 contract and the
§2.1 `RoundSummaryFixture` type both omit it, and the feature goal is "latest
score per fixture per round", for which venue is noise. The fixture builder must
therefore produce **only** the fields in §1.2 (`id`, `match`, `scheduled`,
`status`, `score`, `ok`, `ttId`, `lastPushTs`) — no `venue` key. (If venue is
ever wanted, it would be added to §1.2 and §2.1 together, in a later change.)

**Push-log join rule (correctness-critical):**

Read `PUSH_LOG` KV **once** at the top of the request:
`const raw = await env.PUSH_LOG?.get(PUSH_LOG_KEY); const log = raw ? JSON.parse(raw) : []`
(same store/key `recordPushLog` writes and `/api/push-log` reads). Build a
**latest-per-fixture index** with a pure helper
`indexLatestPushes(entries): Map<string, PushLogEntry>`:

- Key each entry by its `playhqId` (the full UUID the board's fixture `id` also
  uses). Entries with an empty `playhqId` are skipped.
- For a given `playhqId`, keep the entry with the **maximum `ts`** (ISO strings
  compare lexicographically in time order, but the helper parses with
  `Date.parse` and compares numerically to be robust to any format drift; ties
  keep the first seen).

Then for each fixture, `const p = index.get(fixture.id)`:

- `p` present → `score = p.score`, `ok = p.ok`, `ttId = p.ttId ?? null`,
  `lastPushTs = p.ts`.
- `p` absent → `score = null`, `ok = null`, `ttId = null`, `lastPushTs = null`.

The join is on the **full UUID** on both sides (the push entry's `playhqId` and
the grade-feed game's `id`), which is exact and unambiguous — no short-id
prefix matching needed here.

**100-entry-cap caveat (must be flagged):** `PUSH_LOG` is a ring buffer capped
at `PUSH_LOG_MAX = 100` (see `recordPushLog`). In peak season a single round
across 40 grades × 4–6 fixtures is 160–240 pushes, and each fixture is re-pushed
every live cycle, so the 100 newest entries can easily cover **less than one
full round**. Consequences the design accepts and surfaces:

- A fixture pushed earlier in the round whose entries have all aged out shows
  `"not pushed yet"` even though it *was* pushed. This is a **known limitation**,
  not a bug: the board reflects "what the log still remembers". It is acceptable
  because the log naturally refills with the newest cycle's pushes, and the most
  recently active fixtures (the ones an operator is watching) are exactly the
  ones retained.
- The board therefore must not be read as an authoritative "has this ever been
  pushed" ledger; it is "latest remembered score per fixture". The frontend
  copy ("not pushed yet") and a short footnote make this explicit.
- *Out of scope for this change* (flagged for the backlog): raising
  `PUSH_LOG_MAX` or moving to per-fixture KV keys would make the board complete
  across a full peak round. Not done here because it changes the push-log
  storage contract and the existing `/api/push-log` reader, which this task
  scopes out. Noted so the reviewer/operator knows the single lever that removes
  the caveat.

### 1.9 Pure helpers to extract (Worker) + their unit tests

All selection/join logic is pulled into **exported pure functions** (no I/O, no
`env`, no `caches`) so they can be unit-tested directly.

**Where the tests live:** the frontend module `lib/round-summary/roundSummary.ts`
(+ `.test.ts`) is the **tested reference implementation**, run under the
frontend's already-wired `vitest` (`npm test`). The Worker keeps its own inline
copies of the same pure helpers in `src/index.ts` (tiny, pure) because the task
forbids adding a test runner / new config to the Worker. Both copies are pure and
must be **behaviourally identical**; the frontend test suite pins the behaviour,
and the implementation reviewer compares the Worker's inline copies against it.

**Avoiding Worker/Next drift (addresses the two-copies risk):** the helpers read
a **minimal structural input type**, not the strict `PlayHqGame`, so the exact
same function body type-checks against *both* the frontend's typed
`PlayHqGame[]` and the Worker's loosely-typed `Array<Record<string, unknown>>`
(what `fetchGradeGames` returns and the cache's `body.data` carries, cast). The
input type and the exact field accessors are pinned below so the two copies are
line-for-line identical:

```ts
// Minimal shape selectLatestRound reads — satisfied by PlayHqGame AND by the
// Worker's cast Record<string, unknown> games.
type RoundInputGame = {
  round?: { name?: string | null } | null;
  schedule?: { date?: string | null; time?: string | null } | null;
};

// Exact accessors used inside the helper (identical in both copies):
//   const name = game.round?.name ?? "";
//   const ms   = scheduledKickoffMs(game.schedule);   // the exported helper
// scheduledKickoffMs already accepts { date?, time? } | null | undefined, so no
// cast or reshaping is needed on either side.
```

The helpers are:

1. `selectLatestRound(games: RoundInputGame[], nowMs: number)` →
   `{ roundName: string; roundNum: number | null } | null` (the 1.7 rule).
   Reads `game.round?.name ?? ""` and `scheduledKickoffMs(game.schedule)`; builds
   per-round `{ roundNum, hasNum, earliestKickoff }`; applies the three-tier
   selection via the shared `compareRounds` comparator. **Unit tests (required):**
   - all-future season (nothing started/imminent) → tier C first upcoming round.
   - mid-round, every game UPCOMING, earliest kickoff `<= now` → that round via
     tier A, not the prior one (the NTFL quirk — the core regression guard).
   - between rounds, next round >6 h away → tier A returns the just-finished
     (started) round, not the future one.
   - morning of a new round, nothing started but next round `<= now + 6 h` →
     tier B rolls to the new round.
   - split weekend: round N started (`<= now`) AND round N+1 within 6 h but not
     started → tier A selects **N**, not N+1 (the Finding-2 guard).
   - round names without numbers (finals: "Grand Final") → `roundNum: null`,
     ordered after numbered rounds by the comparator; selected correctly when
     they are the started/highest round.
   - all fixtures date-less → step 5 fallback to highest round by `compareRounds`.
   - empty games array → `null`.
2. `compareRounds(a, b)` → number (the pure ordering from 1.7 step 3 / the §1.2
   sort). **Unit tests:** numbered-before-unnumbered; numbered by `roundNum`;
   two unnumbered by name; symmetry (sign flips on swap).
3. `indexLatestPushes(entries)` → `Map<playhqId, PushLogEntry>` (the 1.8 join).
   **Unit tests (required):**
   - multiple entries for one `playhqId` → max-`ts` wins.
   - entries for several fixtures → each keyed correctly.
   - empty/absent `playhqId` entries skipped.
   - empty input → empty map.
   - out-of-order timestamps → still picks the latest.
4. Supporting pure helpers, also tested: `roundNumOf(name)`, `shortRound(name)`
   (the **same name** as the existing frontend log-table helper — see naming note
   below), `displayStatus(raw)`, `stripGradeName(name)`, `statusChip(status)`.

**Naming (one name across the boundary):** the round-abbreviation helper is
called `shortRound` everywhere — it reuses the exact name and logic already in
`app/push-log/page.tsx` (not a new `roundShort`). The board does not need a
second frontend copy for rendering: the Worker precomputes `roundShort` as a
field on each division (via its inline `shortRound`), and the frontend renders
`division.roundShort` directly. The `shortRound` in the shared helper module
exists only so the Worker's inline copy has a tested reference; the legacy
`shortRound` in `page.tsx` (used by the log table) is left **untouched**. The
Worker's inline `shortRound` must reproduce the existing `page.tsx` branch order
**exactly** (prelim/semi/qualif/elim are matched before any generic "final" so a
"Preliminary Final" is not mis-tagged "GF"):

```ts
function shortRound(round: string | undefined): string {
  const n = (round ?? "").trim();
  if (!n) return "";
  const m = n.match(/round\s*(\d+)/i);
  if (m) return `R${m[1]}`;
  if (/grand\s*final/i.test(n)) return "GF";
  if (/prelim/i.test(n)) return "PF";
  if (/semi/i.test(n)) return "SF";
  if (/qualif/i.test(n)) return "QF";
  if (/elim/i.test(n)) return "EF";
  return n;
}
```

`roundNumOf(name)` is the number extractor used by the selection math: it returns
`number | null` (the first `\d+` parsed, else `null`) — **not** the frontend log
table's `9999` sentinel (see the §1.2 note). It is a new, separately-tested
helper; the legacy `roundNum` in `page.tsx` is left untouched.

### 1.10 Edge cache for the endpoint response

Cache the assembled board at the edge with a short TTL so a roomful of operators
polling every 5 s collapses to one assembly per window:

- Key: `new Request("https://playhq-cache/round-summary")`.
- TTL: **45 s** (within the task's 30–60 s band). Rationale: the frontend polls
  on the existing 5 s cadence; 45 s means at most ~1 cold assembly per 9 polls
  while still reflecting a new push well inside a minute. Independent of the
  per-grade grade-games cache (≤60 s), so a board rebuild still benefits from
  warm grade caches.
- Read-through pattern identical to the existing endpoints: on hit, return the
  cached text with `X-Cache: HIT` + `cors`; on miss, assemble, then
  `ctx.waitUntil(cache.put(key, new Response(bodyText, {headers: {"Cache-Control":
  "public, max-age=45"}})))` and return with `X-Cache: MISS`. The push-log KV
  read happens during assembly (miss path) only, so a cache hit costs zero KV
  reads too. Proof: `indexLatestPushes` runs during assembly and its result is
  serialised **into** the cached board text (each fixture's
  `score`/`ok`/`ttId`/`lastPushTs` is already baked in). A hit returns that
  stored text verbatim — it never re-reads `PUSH_LOG` or re-runs the join; the
  only cost on a hit is the single `caches.default.match`.

Cache-key summary (all `caches.default`, no `wrangler.toml` change):

| Purpose | Key | TTL |
|---|---|---|
| Per-grade games (shared with `/api/grades/:id/games`) | `https://playhq-cache/grade-games/{gradeId}` | `min(CACHE_TTL,60)` s |
| Assembled board | `https://playhq-cache/round-summary` | 45 s |

### 1.11 Error handling & CORS summary (per operation)

| Operation | Failure | Recoverable? | Caller receives | Logged? |
|---|---|---|---|---|
| Parse grade ids | malformed id | yes | id filtered out by `UUID_RE` | no |
| Per-grade games fetch | `UpstreamError` (429/403/404/502) | yes (skip grade) | grade omitted; `errors[]` entry | no (surfaced in body) |
| Per-grade games fetch | other throw | yes (skip grade) | grade omitted; `errors[]` entry `fetch_failed` | no |
| Grade-games cache write | KV/cache put fails | yes | ignored (`waitUntil`, best-effort) | no |
| Push-log KV read | get/JSON fails | yes | treated as empty log → all fixtures "not pushed yet" | `console.log` once |
| Round selection | no started/imminent round | yes | tier C (first upcoming) / step 5 undated fallback per 1.7 | no |
| Whole request | unexpected throw before assembly | yes | `200 { rounds: [], errors: [{gradeId:"*", error}] }` via outer try/catch | `console.log` |
| Response | — | — | `json(body, 200, cors)` | — |

CORS uses the shared `corsHeaders(env, origin)` on every return path (hit, miss,
empty, error) so the browser is never blocked. No new env vars; no 5xx is ever
emitted by this endpoint by design (empty board instead), which keeps the
frontend's error banner reserved for genuine network/transport failures.

### 1.12 Validation of inputs

The endpoint takes **no** query params or body, so there is no external input to
validate beyond the already-validated grade-id list (type: UUID via `UUID_RE`,
limit: the configured grade list length, behavior on failure: filtered out). The
push-log KV content is treated as untrusted: each entry is read defensively
(`String(...)`, `?? null`, numeric `Date.parse` compare) so a malformed stored
entry degrades that one fixture to "not pushed yet" rather than throwing.

---

## Part 2 — Frontend

### 2.1 Fetcher + types in `lib/api/playhq.ts`

Add the new response types and a fetcher mirroring the existing `getPushLog`
exactly (same `WORKER_BASE`, same `cache: "no-store"`, same abort-signal and
error style):

```ts
export type RoundSummaryFixture = {
  id: string;
  match: string;
  scheduled: string | null;
  status: GameStatus;
  score: string | null;
  ok: boolean | null;
  ttId: number | null;
  lastPushTs: string | null;
};

export type RoundSummaryDivision = {
  gradeId: string;
  competition: string;
  round: string;
  roundShort: string;
  roundNum: number | null;
  fixtures: RoundSummaryFixture[];
};

export type RoundSummary = {
  generatedAt: string;
  rounds: RoundSummaryDivision[];
  errors: { gradeId: string; error: string }[];
};

/** The round-summary board (all divisions, latest round, latest score), via the Worker. */
export async function getRoundSummary(signal?: AbortSignal): Promise<RoundSummary> {
  const res = await fetch(`${WORKER_BASE}/api/round-summary`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`Failed loading round summary (HTTP ${res.status})`);
  const body = (await res.json()) as Partial<RoundSummary>;
  return {
    generatedAt: body.generatedAt ?? "",
    rounds: Array.isArray(body.rounds) ? body.rounds : [],
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}
```

The fetcher is defensive (coerces missing arrays) so a partial body never throws
in the component.

### 2.2 Render structure in `app/push-log/page.tsx`

The existing log table, its filters, sort state, polling, and layout stay
**exactly as they are**, below. Add a **summary section above** them, and fetch
both the push log (unchanged) and the new board on the **same existing poll**:

- Add state `const [summary, setSummary] = useState<RoundSummary | null>(null)`.
- In the existing `load` callback, after `getPushLog`, also call
  `getRoundSummary(ctrl.signal)` and `setSummary(...)`. Run the two fetches in
  parallel with `Promise.allSettled` so a round-summary failure never blanks the
  log (and vice-versa); on the summary's rejection leave the previous board in
  place (or `null` on first load). Reuse the same `POLL_MS` (5 s) interval and
  the same `live`/pause toggle and `abortRef` — **no new poll loop**. This
  respects the Worker's 45 s cache (most polls are HITs).

Summary layout — placed between the header/filters block and the `{/* Body */}`
log block:

```
<section> "Round summary" heading + muted caption
  for each division in summary.rounds (already sorted by the Worker):
    <div> card/block per division:
      header row: competition name + roundShort badge (e.g. "NTFL Men's Premier · R3")
      compact table, one row per fixture:
        | Match (shortMatch) | Status chip | Score (mono, sky) or muted "not pushed yet" | last push time (clock) |
</section>
```

Concretely:

- **Grouping:** one bordered block per `division`, each with a sticky-ish header
  showing `competition` and a round badge (`roundShort`). For 40+ divisions the
  blocks stack vertically; each block's inner table is small (4–6 rows), so the
  page stays scannable — the operator scrolls divisions, not hundreds of log
  rows.
- **Per fixture row** reuses the existing helpers verbatim:
  - `shortMatch(f.match)` for the match label.
  - status chip: a small helper `statusChip(f.status)` mapping FINAL → emerald,
    UPCOMING → slate, others → slate, with an IN_PROGRESS/LIVE → amber/pulse
    branch that is a **defensive fallthrough only**. Important caveat: this board
    is built entirely from the grade REST feed, which for NTFL **never reports
    IN_PROGRESS** — a game stays `UPCOMING` (or `""` → normalised to `UPCOMING`)
    until it flips straight to `FINAL`. So in practice the board emits only
    `UPCOMING` and `FINAL`, and the amber/pulse branch will **not** fire for this
    data source. A fixture that is actually being played shows as `UPCOMING`
    here; "live-ness" is surfaced on the Live Scores tab (which probes the
    spectator feed), not on this summary board. The IN_PROGRESS/LIVE branch is
    kept purely as a defensive mapping (and is unit-tested in isolation) so the
    helper is correct if ever fed a live status, but the operator should not
    expect a pulsing chip mid-game on this page. The footnote (below) does not
    need to mention this; it is a developer-facing note so no one wires an
    expectation to a dead branch.
  - score: when `f.lastPushTs` is non-null show `f.score` in the same
    `font-mono text-sky-300` style the log uses; when `null` show a muted
    `"not pushed yet"` (`text-slate-500 italic`).
  - `ok === false` → render the score with a red tint + a small warning glyph so
    a rejected push is visible at a glance; `ok === true`/`null` → normal.
  - last push: `clock(f.lastPushTs)` when present, else `—`. (`clock` already
    guards `NaN`.)
- **Empty states:** if `summary` is `null` on first load, show nothing (the log's
  own loader covers the page). If `summary.rounds` is empty, show a single muted
  line "No divisions to summarise yet." The summary section never shows the red
  error banner — a summary fetch failure just leaves the last good board (the log
  below still owns the page's error surface).
- **Visual style:** reuse the existing palette/classes (`border-white/10`,
  `bg-white/5`, `text-slate-*`, `tabular-nums`, the same chip styles as the log's
  status cell) so the summary looks native to the page. No new dependencies, no
  layout change to the log.

A short footnote under the summary states the cap caveat in operator terms:
"Shows the latest score still held in the push log (last 100 pushes). A fixture
pushed earlier that has scrolled out of the log reads 'not pushed yet'."

### 2.3 Frontend pure-helper module + tests

New module `lib/round-summary/roundSummary.ts` holding the tested reference
implementations of the correctness-critical rules (the Worker mirrors these):

- `selectLatestRound(games, nowMs)`, `compareRounds(a, b)`, and
  `indexLatestPushes(entries)` — the exact rules from 1.7 and 1.8. Pure; typed
  via the minimal structural `RoundInputGame` input (pinned in §1.9) so the same
  body also satisfies the Worker's cast `Record<string, unknown>[]`. The typed
  `PlayHqGame` / `PushLogEntry` shapes exported from `lib/api/playhq.ts` both
  satisfy their respective inputs.
- `roundNumOf` (`→ number | null`), `shortRound` (one name, matching the legacy
  log-table helper's branch order — the summary renders `division.roundShort`
  from the Worker, so this frontend copy exists only as the Worker's tested
  reference), `displayStatus`, `stripGradeName`, and the presentational
  `statusChip(status)` class-mapper.

Co-located `lib/round-summary/roundSummary.test.ts` (vitest, matching the
existing `lib/comparison/*.test.ts` convention) covering every case listed in
1.9 plus `statusChip` mappings (including the IN_PROGRESS/LIVE defensive branch
tested in isolation — see Finding 4) and `displayStatus("")/("NULL") ===
"UPCOMING"`.

**Testability summary:** the two correctness-critical behaviors (latest-round
selection, latest-push-per-fixture join) are pure functions with full unit
coverage and no network. The endpoint wiring (cache read/write, `mapPool`
fan-out, CORS) is integration-level and verified manually via `wrangler dev`
against the real feeds; it contains no branching logic beyond the pure helpers it
calls, by design. The React rendering is presentational over the typed board; the
only logic in it (which cell style, empty/muted states) delegates to the tested
`statusChip`/null checks. A design where the hard logic sits in pure helpers and
the I/O layer is thin is exactly what keeps this testable.

---

## Out of scope / explicitly unchanged

- The existing push-log table, its columns, sorting, filters, search, `POLL_MS`,
  pause/LIVE toggle, and error banner — untouched.
- The comparison engine and any file outside the three frontend files + one new
  helper module, and `src/index.ts` on the Worker.
- `wrangler.toml` (no change — `caches.default` only).
- Raising `PUSH_LOG_MAX` or per-fixture push storage (backlogged; the single
  lever that would remove the 100-entry caveat — see 1.8).
- No commit/push/deploy; no new dependencies anywhere.

## Responses to design review (`design-review.json` / `design-review.md`)

This revision resolves every finding in the round-summary design review
(verdict `CHANGES_REQUESTED`: 2 HIGH, 4 MEDIUM, 5 NIT). Each response below cites
the section(s) changed.

- **1 [HIGH] `roundNum` `null` vs `9999` sentinel & sort.** ADDRESSED. §1.2 now
  declares `roundNum: number | null` explicitly, states the deliberate divergence
  from the legacy `9999` sentinel (which is *not* reused), and gives a fully
  specified four-key `rounds` sort that never compares `null` numerically. §1.7
  step 3 and §1.9 introduce an explicit `hasNum` flag and a pure `compareRounds`
  comparator (numbered-before-unnumbered; numbered by number; unnumbered by name)
  used for both selection and the JSON sort. The selection math no longer does
  arithmetic on `roundNum`.

- **2 [HIGH] 6 h lookahead could pick a not-yet-started future round.**
  ADDRESSED. §1.7 is rewritten as a **three-tier precedence**: tier A = highest
  round whose earliest kickoff `<= now` (started); tier B = highest round `<= now
  + LOOKAHEAD_MS` (imminent) only if none started; tier C = first upcoming only
  if none started/imminent; plus the undated fallback. The split-weekend case now
  selects the started round N, never the not-yet-started N+1. The edge-case list
  and §1.9 test matrix were updated to match, including the explicit "split
  weekend: tier A selects N, not N+1" regression test.

- **3 [MEDIUM] `venue` ambiguity.** ADDRESSED (option a — drop). §1.8 now states
  `venue` is deliberately not emitted; the fixture builder produces only the §1.2
  fields. §1.2 and §2.1 already omit it, so all three agree.

- **4 [MEDIUM] dead IN_PROGRESS/LIVE chip branch.** ADDRESSED (option a). §2.2 and
  §2.3 now state the IN_PROGRESS/LIVE mapping is a defensive fallthrough that does
  not fire for the grade feed (which only emits UPCOMING/FINAL for NTFL), that a
  played fixture shows as UPCOMING here (live-ness lives on the Live Scores tab),
  and that the branch is kept and unit-tested in isolation.

- **5 [MEDIUM] `selectLatestRound` input shape underspecified.** ADDRESSED. §1.9
  pins a minimal structural `RoundInputGame` type satisfied by both the typed
  `PlayHqGame[]` and the Worker's cast `Record<string, unknown>[]`, and names the
  exact accessors (`game.round?.name ?? ""`, `scheduledKickoffMs(game.schedule)`)
  so the two copies are line-for-line identical.

- **6 [MEDIUM] grade-games cache write is new behaviour; reproduce exact write.**
  ADDRESSED. §1.4 now labels it a deliberate NEW write (not a reuse of
  `resolveFullGame`) and reproduces the exact expressions from
  `/api/grades/:id/games`: `ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ??
  "90") || 90)`, `listTtl = Math.min(ttl, 60) || 60`, body
  `{ gradeId, count: data.length, data }`, and the `Cache-Control` header.

- **7 [NIT] `roundShort`/`shortRound` naming mismatch.** ADDRESSED. The helper is
  `shortRound` everywhere; the Worker precomputes `roundShort` as a field and the
  frontend renders `division.roundShort` directly. The legacy log-table
  `shortRound` is left untouched. §1.6, §1.9, §2.2, §2.3 updated.

- **8 [NIT] dangling "OR" in §1.9.** ADDRESSED. §1.9 now states the chosen
  approach directly (frontend vitest module is the tested reference; Worker keeps
  inline copies) with no undecided alternative.

- **9 [NIT] reprint `shortRound` branch order.** ADDRESSED. §1.9 reprints the
  exact branch order from `page.tsx` (prelim/semi/qualif/elim matched before any
  generic "final"), and §1.6 points to it.

- **10 [NIT] prove "zero KV reads on hit".** ADDRESSED. §1.10 adds the one-line
  proof: the join result is baked into the cached board text, so a hit returns
  stored text without re-reading `PUSH_LOG` or re-running `indexLatestPushes`.

- **11 [NIT] enumerate `errors[]` tokens.** ADDRESSED. §1.4 enumerates the tokens:
  `rate_limited | forbidden | not_found | upstream_error | fetch_failed`, and
  notes the frontend treats `errors[]` as opaque.

Non-blocking "Unverified" notes also addressed:

- **Darwin single-offset assumption** (review Unverified #3): §1.7 now flags that
  the selection rule inherits `scheduledKickoffMs`'s hardcoded `+09:30` offset,
  why it is acceptable for the current NT-region grade set, and that the fix (if a
  non-Darwin grade is added) is localised to `scheduledKickoffMs`.
- **Total-subrequest ceiling vs concurrency** (review Unverified #4): §1.5 now
  distinguishes the `limit = 6` concurrency bound from the total-subrequest
  ceiling, works the ~40–80 worst-case cold arithmetic against Cloudflare's
  50/1000 limits, and states the three mitigations (shared grade cache, 45 s board
  cache, paid-plan budget).

## Notes on prior stale artifacts

An earlier authoring of this `design.md` closed with a note claiming the review
in this folder was for an unrelated `meta-cache` feature. That is no longer true:
the `design-review.json` here (`reviewDoc` →
`.worktrees\round-summary\...\design-review.md`) is a genuine review of THIS
round-summary design, and the section above records the responses to each of its
findings.
