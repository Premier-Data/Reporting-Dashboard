# Round-summary board: `/api/round-summary` + Push Activity summary table

A new Worker endpoint assembles a per-division "latest round, every fixture, latest pushed score" board, and the Push Activity page renders it above the untouched raw log. The board is grade-feed-backed (not push-log-derived), so it can show fixtures that have never been pushed, which is the whole point the earlier reverted attempt couldn't satisfy. The selection of "which round is current" is a pure three-tier rule (started → imminent → first-upcoming, undated fallback), extracted to a tested reference module with a byte-identical inline copy in the Worker. Cost over 40+ grades is bounded by two cache layers plus a `mapPool` concurrency cap of 6, and the endpoint never emits a 5xx.

Watch for: the 100-entry push-log ring buffer means a fixture pushed earlier in a peak-season round can read "not pushed yet" even though it was pushed — **confirmed**, and explicitly surfaced in the UI footnote and design as an accepted limitation. The Darwin single-offset assumption in `scheduledKickoffMs` is inherited by the selection rule — **confirmed**, bounded and acceptable for the current NT-region grade set.

**Verdict**: APPROVED

## High-level view

The latest-round rule is implemented exactly as the design specifies and is the correctness heart of the feature. Tiers A and B are kept separate so a split weekend selects the round that has actually started rather than jumping to the not-yet-started next round, and the comparator never compares `null` as a number. The "far-future round" bug the task warns about is avoided because tier A only considers rounds whose earliest kickoff is at or before now, and tier C picks the *smallest* upcoming round, never the highest existing one. All eight required cases are unit-tested.

The push-log join builds a latest-per-`playhqId` index once per request by maximum timestamp, joins on the full fixture UUID, and renders fixtures with no entry as "not pushed yet". `lastPushTs === null` is the single source of truth for "not pushed", correctly distinct from an unmapped `ttId`.

Resilience over 40+ grades rests on three independent levers: a shared `grade-games/{id}` edge cache (≤60s, warmed by both this endpoint and the Live Scores tab), a 45s board-level edge cache that collapses a roomful of pollers into one assembly, and a `mapPool` cap of 6 bounding concurrent upstream fan-out. Per-grade failures become error records and never abort the batch; any unexpected top-level throw still returns `200` with an empty board.

The response contract matches what the frontend renders field-for-field. The frontend groups by division (the Worker pre-sorts by competition then round), shows every fixture, reuses the existing `shortMatch`/`clock` helpers and palette, and leaves the log table, its filters, sorting, and polling byte-unchanged. Scope held: no push-log-derived summary, no new dependencies, no `wrangler.toml` change, changes confined to the four allowed files plus the new tested helper module.

<details>
<summary>Issues (2)</summary>

1. **Push-log 100-entry cap** — in peak season (160–240 pushes/round) a fixture pushed earlier can age out and read "not pushed yet". Non-blocking, accepted, and surfaced in the UI footnote; the only fix (raise `PUSH_LOG_MAX` or per-fixture KV) is correctly scoped out.
2. **Darwin single-offset assumption** — `scheduledKickoffMs` hardcodes `+09:30`, inherited by the selection rule; a future non-Darwin grade could skew the tier A/B boundary by hours. Non-blocking for the current NT-region grades; fix is localised to the helper if ever needed.

</details>

<details>
<summary>Details</summary>

### Latest-round selection is the design, verbatim

`selectLatestRound` groups games by round name, computes per-round `{ roundNum, hasNum, earliestKickoff }`, and applies the three tiers in order: highest *started* round (`earliestKickoff <= now`), else highest *imminent* round (`<= now + 6h`), else smallest *dated* round, else highest round overall as an undated fallback. The Worker inline copy is byte-identical to the frontend reference module — I diffed both bodies and the only differences are the private helper names (`highestRound`/`smallestRound` vs `highest`/`smallest`, `ROUND_LOOKAHEAD_MS` vs `LOOKAHEAD_MS`), which don't affect behaviour.

The split-weekend guard is the subtle part and it's correct (**confirmed**): tier A filters to `earliestKickoff <= now` before taking the highest, so when round N has started and N+1 is within the 6h window but hasn't started, tier A yields N and never reaches tier B. The `compareRounds` comparator decides numbered-vs-unnumbered placement via the `hasNum` flag and never evaluates `null < number`, which is what retires the `9999`-sentinel hazard the legacy log-table helper carries.

The far-future bug is structurally impossible here: tier A's upper bound is `now`, and the only tier that can look forward (C) takes the *smallest* dated round, so a full season sitting in the feed on day one resolves to Round 1, not the grand final.

The required cases are all tested in `roundSummary.test.ts`: all-future→tier C, mid-round-all-UPCOMING→tier A (the NTFL quirk guard), between-rounds→tier A started round, morning-of-round→tier B, split-weekend→N not N+1, finals→`roundNum: null` ordered after numbered, all-date-less→highest fallback, and empty→`null`. The verification note records 29 tests passing in the main tree (the worktree run hit the documented junction artifact, not a real failure), and the full suite at 121 passing with no regressions.

### Push-log join and the 100-entry cap

`indexLatestPushes` keys entries by full-UUID `playhqId`, skips empty ids, and keeps the maximum `Date.parse(ts)` with NaN guarded to `-Infinity` and ties keeping the first seen. The KV is read once at the top of the miss path and the index built once, not per grade. Each fixture joins on its full UUID: present → `score/ok/ttId/lastPushTs` from the entry; absent → all `null`. `ttId ?? null` is kept distinct from `lastPushTs`, so an unmapped-but-pushed fixture is not mistaken for unpushed.

The 100-entry ring-buffer cap means a peak-season round (160–240 pushes) can exceed what the log retains, so an earlier-pushed fixture may render "not pushed yet" (**confirmed** against `PUSH_LOG_MAX = 100`). This is acknowledged in the design, the verification note, and the UI footnote, and the single lever to remove it is correctly scoped out because it changes the push-log storage contract. Acceptable as flagged.

### 40+-grade resilience

```
GET /api/round-summary
  └─ board edge cache (45s)  ──HIT──▶ return cached board, zero KV/upstream
       │ MISS
       ├─ read PUSH_LOG once ─▶ indexLatestPushes (once)
       └─ mapPool(gradeIds, limit=6, perGrade)
             perGrade: grade-games/{id} edge cache (≤60s)
                         │HIT─▶ parse body.data
                         │MISS▶ fetchGradeGames ─▶ warm shared cache (byte-for-byte)
                         └─ selectLatestRound ─▶ build+join fixtures
```

Cost is bounded three ways, matching the design's reasoning: the shared grade-games cache means boards are rarely cold, the 45s board cache means ~1 assembly per window regardless of poller count, and `mapPool`'s limit of 6 caps concurrent fan-out. `mapPool` settles every result, so one grade's rejection can't abort the batch; per-grade `try/catch` maps `UpstreamError` to `{ gradeId, error: err.message }` and any other throw to `fetch_failed`, then continues. A top-level `try/catch` wraps the whole assembly and still returns `200 { rounds: [], errors: [{ gradeId: "*", ... }] }` on an unexpected throw. The grade-feed cache warm-write reproduces the `/api/grades/:id/games` handler's expressions (`listTtl`, the `{ gradeId, count, data }` key order, the `Cache-Control` string) so the two writers stay interchangeable under the shared key — this is the deliberate new write the design calls out, not accidental drift from `resolveFullGame`.

### Response contract ↔ frontend render

The Worker emits `{ generatedAt, rounds[], errors[] }`; each division carries `gradeId, competition, round, roundShort, roundNum, fixtures[]`; each fixture carries exactly `id, match, scheduled, status, score, ok, ttId, lastPushTs` with no `venue` key. The frontend types in `lib/api/playhq.ts` match field-for-field, `getRoundSummary` mirrors `getPushLog` (`cache: "no-store"`, throw on `!res.ok`, defensive array coercion), and the page groups by the Worker's pre-sorted `rounds`, renders every fixture, keys "not pushed yet" off `lastPushTs === null`, and tints a rejected push (`ok === false`) red with a warning glyph. `statusChip` is imported from the shared reference module, so the chip mapping is the tested one. The log fetch and summary fetch run under one `Promise.allSettled` on the existing poll, so a summary failure never blanks the log and the summary keeps its prior board on rejection.

### Scope

The reverted push-log-only summary is not reintroduced — the board is sourced entirely from `getRoundSummary`, and a grep for log-derived summary logic in the page found nothing. No `wrangler.toml`, `package.json`, or lockfile changes (no new deps). Edits are confined to `playhq-worker/src/index.ts`, `reporting-ui/lib/api/playhq.ts`, `reporting-ui/app/push-log/page.tsx`, plus the new `lib/round-summary/roundSummary.ts` and its test. The existing log table, filters, sort, and polling are byte-unchanged.

</details>

<details>
<summary>File map</summary>

- `playhq-worker/src/index.ts` — inline pure-helper copies + the `GET /api/round-summary` handler (board cache, grade fan-out via `mapPool`, push-log join, never-5xx wrapper).
- `reporting-ui/lib/api/playhq.ts` — `RoundSummary*` types + `getRoundSummary` fetcher.
- `reporting-ui/app/push-log/page.tsx` — summary board section above the unchanged log; `allSettled` load; `statusChip` import.
- `reporting-ui/lib/round-summary/roundSummary.ts` — the tested reference pure helpers.
- `reporting-ui/lib/round-summary/roundSummary.test.ts` — 29 tests across selection, join, and supporting helpers.

Full diff: `git diff main` in the `round-summary` worktree.

</details>
