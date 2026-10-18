# Design review — Round-Summary board (`/api/round-summary` + Push Activity summary table)

Reviewed document: `.worktrees/round-summary/reporting-ui/.agents/tasks/design.md`
Grounding sources read:
- `playhq-worker/src/index.ts` (worker)
- `reporting-ui/lib/api/playhq.ts` (frontend fetchers/types)
- `reporting-ui/app/push-log/page.tsx` (Push Activity page)
- `reporting-ui/package.json` + existing `lib/comparison/*.test.ts`, `lib/api/cache.test.ts` (test convention)

This is a fresh review of the document on its own merits, with every "the existing
helper does X" claim checked against source.

---

## Verdict summary

The design is strong: the latest-round rule (the correctness-critical piece the task
flags) is precise, three-tiered, and avoids the far-future-round trap; the push-log
join is a clean max-`ts`-per-`playhqId` index on the full UUID; the 100-entry cap is
acknowledged; the response contract is fully pinned and matches the frontend types;
the cost strategy is bounded (`mapPool` limit 6 + two cache layers) with the
subrequest ceiling worked through; the named helpers all exist and are used as
described; the pure helpers are specified with a test matrix; and the reverted
push-log-only summary is explicitly NOT reintroduced.

I found **no HIGH or MEDIUM blocking issues** against the seven gate criteria. The
findings below are all NIT-level accuracy/clarity fixes. Per the mechanical rule
(zero HIGH + zero MEDIUM), the verdict is **APPROVED**.

---

## Findings

### 1 [NIT] `errors[]` token enumeration is incomplete vs the actual throws
§1.4 claims the `errors[].error` tokens are "exactly … `rate_limited | forbidden |
not_found | upstream_error` (verbatim from the `UpstreamError` throws in
`fetchGradeGames`)". Verified against `fetchGradeGames` (worker lines ~1004–1037):
it also throws `new UpstreamError("api_key_not_configured", 500)` when
`env.PHQ_API_KEY` is unset. If the key is ever missing, **every** grade fails with
`api_key_not_configured`, which is not in the enumerated set. (`graphql_errors`
belongs to `fetchGame`, not `fetchGradeGames`, so the design is right to omit it.)
Impact is cosmetic: the design also says the frontend treats `errors[]` as opaque
and never branches on the token, so rendering is unaffected — but the "verbatim"
enumeration is inaccurate.
**Fix:** add `api_key_not_configured` to the enumerated list in §1.4 (and the §1.11
table row), or soften the wording to "includes but is not limited to", e.g.
`rate_limited | forbidden | not_found | upstream_error | api_key_not_configured`
(from `UpstreamError`) plus `fetch_failed` (catch-all).

### 2 [NIT] `stripGrade` vs `stripGradeName` — one helper, two names
§1.8 names the team-name helper `stripGrade` (and matches the push pipeline's
in-file `stripGrade` regex, worker lines 1141–1142, verified identical:
`.replace(/\s+(men|women)\s+premier.*$/i, "").trim()`). §1.9 lists the pure helper
to extract as `stripGradeName`. The implementer could reasonably produce two
differently-named helpers.
**Fix:** pick one name across §1.8 and §1.9 (suggest `stripGradeName` for the
exported pure helper, and have §1.8 reference it by that name). Also note the real
push-pipeline helper defaults a null to `"?"` (`(n ?? "?")`); either reproduce that
fallback or state it is intentionally dropped since the grade-feed competitor name
is expected non-null.

### 3 [NIT] "same regex the push pipeline uses" — clarify the name source, not just the regex
§1.8 builds `match` from the grade-feed game's `competitors.find(c => c.isHomeTeam
=== true/false).name`. Verified this is the correct pattern (worker `toFixtureLite`
lines 1256–1257 use exactly `comps.find((c) => c.isHomeTeam === true/false)` on a
grade-feed game, and `teamOf` reads `c.name`). The push pipeline's `stripGrade`
operates on `live.home.name`, which resolves from the same grade-feed competitor
names — so the reuse is sound. This is just worth stating explicitly so a reader
does not worry the two name sources differ.
**Fix:** one sentence in §1.8: "the grade-feed `competitors[].name` is the same
field the push pipeline ultimately strips, so the suffix pattern matches."

---

## Gate-criteria assessment (the seven required checks)

1. **Latest-round selection rule — precise, defensible, no far-future pick.** PASS.
   §1.7 is a three-tier rule (A started `earliestKickoff <= now` → highest; B
   imminent `<= now + 6h` → highest, only if none started; C first upcoming with a
   date; plus undated fallback to highest by `compareRounds`). It never picks a
   far-future round (tier C takes the *smallest* dated upcoming, not the highest
   that merely exists), correctly handles the NTFL "nothing is non-UPCOMING until
   FINAL" quirk via date-based tiers, and the split-weekend case selects started N
   over not-yet-started N+1. The ordering is a pure `compareRounds` that never
   compares `null` as a number (uses the `hasNum` flag). Defensible and testable.

2. **Push-log latest-per-fixture join + 100-cap caveat.** PASS. §1.8 keys by the
   full `playhqId` UUID, keeps max-`ts` (numeric `Date.parse` compare), skips empty
   ids. Verified `PushLogEntry` carries `playhqId`, `ts`, `score`, `ok`, `ttId`
   (worker lines 888–901) and that the board fixture `id` is the full UUID, so the
   join is exact. The `PUSH_LOG_MAX = 100` ring buffer is confirmed (worker lines
   902–903, `recordPushLog` `.slice(0, PUSH_LOG_MAX)`), and §1.8 flags that one peak
   round (160–240 pushes) exceeds the cap, surfaces it as "latest remembered score",
   and backlogs the single lever (`PUSH_LOG_MAX`) rather than silently assuming
   completeness.

3. **Response JSON contract matches what the frontend renders.** PASS. §1.2 fields
   (`generatedAt`, `rounds[]{gradeId,competition,round,roundShort,roundNum,fixtures[]}`,
   `fixtures[]{id,match,scheduled,status,score,ok,ttId,lastPushTs}`, `errors[]`)
   exactly match the §2.1 `RoundSummary` / `RoundSummaryDivision` /
   `RoundSummaryFixture` types, which the §2.2 renderer consumes. `roundNum` is
   `number | null` on both sides; `venue` is omitted on both sides (§1.8 states it
   deliberately). `getRoundSummary` coerces missing arrays defensively.

4. **Bounded cost for 40+ grades.** PASS. §1.5 uses the existing `mapPool(items,
   limit, fn)` with `limit = 6` — verified `mapPool` settles every result and never
   rejects (worker lines 1039–1061), so one bad grade cannot abort the batch.
   Per-grade failures are caught and pushed to `errors[]`, then `continue`. Two
   cache layers (shared per-grade `grade-games/{id}` ≤60s + a 45s board cache) mean
   boards are almost never fully cold, and the design works the worst-case
   ~40–80-subrequest arithmetic against Cloudflare's 50/1000 ceilings and names the
   paid-plan target. No unbounded fan-out; `fetchGradeGames` already caps at 50
   pages with a 12s per-request timeout. The whole endpoint is wrapped so it returns
   `200 {rounds:[]}` rather than 5xx.

5. **Reuse of named existing helpers.** PASS. Every helper the design names was
   found and matches: `fetchGradeGames`, `competitionLabel`, the
   `https://playhq-cache/grade-games/{id}` cache key + write expressions (§1.4's
   `ttl`/`listTtl`/`{gradeId,count,data}` body verified byte-equivalent to the
   `/api/grades/:id/games` handler, worker lines ~1575–1589 — the only difference is
   the local variable name `games` vs the design's `data`, behaviourally identical),
   `PUSH_LOG`/`PUSH_LOG_KEY`, `scheduledKickoffMs` (exported, `+09:30` offset),
   `UUID_RE`, `corsHeaders`/`json`, `UpstreamError`, `mapPool`, `DEFAULT_GRADE_IDS`,
   the top-of-`fetch` OPTIONS→204 / non-GET→405 handling, and the grade-id parse
   from `resolveFullGame`. The §1.4 grade-games cache **write** is correctly labelled
   a deliberate NEW write (mirroring the games handler, not `resolveFullGame` which
   only reads) so a reviewer will not flag it as drift.

6. **Pure unit-testable helpers + latest-round tests.** PASS. §1.9 extracts
   `selectLatestRound`, `compareRounds`, `indexLatestPushes`, `roundNumOf`,
   `shortRound`, `displayStatus`, `stripGradeName`, `statusChip` as pure functions
   over a minimal structural `RoundInputGame` input (so Worker and Next copies are
   line-for-line identical), with a concrete test matrix including the NTFL-quirk
   mid-round guard, the split-weekend "select N not N+1" guard, finals (`roundNum
   null`), undated fallback, and empty input. vitest is wired (`npm test` →
   `vitest --run`) and the cited `lib/comparison/*.test.ts` colocated convention
   exists.

7. **Reverted push-log-only summary NOT reintroduced.** PASS. The Overview and the
   "Responses to design review" + "Notes on prior stale artifacts" sections
   explicitly state the summary is grade-feed-backed (to show not-yet-pushed
   fixtures) and that no push-log-derived summary is reintroduced. The architecture
   (Worker assembles from `fetchGradeGames`, push log only annotates) enforces this.

---

## Verified assumptions (checked against source)

- `scheduledKickoffMs({date,time})` is **exported**, returns `number | null`, and
  hardcodes `NTFL_UTC_OFFSET = "+09:30"` with a code comment that a DST grade needs
  a per-fixture offset lookup — exactly as §1.7 states (worker lines 988–1000).
- `mapPool<T,R>(items, limit, fn)` settles every result into
  `PromiseSettledResult<R>[]` and never rejects (worker lines 1039–1061). §1.5's
  "never rejects / can't abort the batch" claim is accurate.
- `PUSH_LOG_KEY = "recent"`, `PUSH_LOG_MAX = 100`, `recordPushLog` prepends and
  `.slice(0, 100)` (ring buffer, newest first) — §1.8 cap caveat is correct
  (worker lines 902–938).
- `PushLogEntry` has `playhqId: string`, `ttId: number | null`, `score`, `ok`, `ts`
  (worker lines 888–901). The join key and the nullable fields in §1.2 are right.
- `/api/push-log` returns `{ count, entries }`; `getPushLog` reads `body.entries`
  (worker line 1571; `playhq.ts`). The board reads KV directly via `PUSH_LOG.get`,
  consistent with the design.
- The `/api/grades/:id/games` cache write uses
  `JSON.stringify({ gradeId, count: games.length, data: games })`, `listTtl =
  Math.min(ttl, 60) || 60`, and `ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ??
  "90") || 90)` with `Cache-Control: public, max-age=${listTtl}` — §1.4's
  "byte-for-byte" reproduction is accurate (`ttl` is in scope at the route;
  only the var name `games`/`data` differs). (worker lines 1494, 1575–1597)
- Top of `fetch`: `OPTIONS → 204 headers: cors`; `method !== "GET" → 405`; CORS via
  `corsHeaders(env, origin)`. §1.1 is correct (worker lines 1483–1489).
- `competitionLabel(url)`, `UUID_RE`, `DEFAULT_GRADE_IDS`, `json`, `UpstreamError`,
  and the `resolveFullGame` grade-id parse all exist as described.
- `competitors.find(c => c.isHomeTeam === true/false)` is the real home/away pattern
  on grade-feed games (`toFixtureLite`, worker lines 1256–1257).
- `stripGrade` regex `/\s+(men|women)\s+premier.*$/i` is exactly the push pipeline's
  (worker lines 1141–1142).
- `shortRound` branch order in §1.9 matches `page.tsx` verbatim (prelim/semi/
  qualif/elim before any generic final), `roundNum` returns the `9999` sentinel
  (page.tsx lines 30–45), and `clock` guards `NaN` (page.tsx lines 46–50).
- Frontend reuse: `POLL_MS = 5_000`, `load` useCallback with `abortRef`,
  `setInterval(load, POLL_MS)` gated on `live`, `shortMatch`, `clock` all present in
  `page.tsx` — §2.2's "same existing poll, no new loop" is feasible as written.
- vitest `^3.2.7` wired (`"test": "vitest --run"`); `lib/comparison/*.test.ts` and
  `lib/api/cache.test.ts` colocated tests exist — §1.9/§2.3 test plan is grounded.

## Unverified / wrong assumptions

- **Wrong (minor):** §1.4's `errors[]` token set is described as the complete
  verbatim set of `fetchGradeGames` throws but omits `api_key_not_configured`
  (500, thrown when `PHQ_API_KEY` is unset). See Finding 1. Not blocking because the
  frontend treats `errors[]` as opaque.
- **Unverified (acceptable):** the PlayHQ grade-feed `game.round.name` values
  ("Round 3", "Grand Final", etc.) and that finals rounds truly carry no digit are
  taken from live-feed experience, not from a fixture snapshot in-repo. The design
  handles the unnumbered case via `roundNum: null` + `compareRounds`, so a surprise
  name degrades gracefully rather than crashing. No change required.
- **Unverified (acceptable, flagged by design):** the single-offset `+09:30`
  assumption for all 40+ grades. §1.7 already flags this, bounds the impact to a few
  hours' skew within the 6h window for a hypothetical non-Darwin grade, and localises
  the future fix to `scheduledKickoffMs`. Acceptable for the current NT-region grade
  set.
- **Unverified (acceptable):** the free-vs-paid Cloudflare subrequest ceiling (50 /
  1000) and that the deploy target is the paid plan. §1.5 states this as the
  operating assumption with two cache mitigations; not checkable from the repo, but
  the design degrades (raise board TTL / stagger) if false.
