# Verification — live-during-play detection fix in `liveFixtureIds`

Scope of change: ONLY `playhq-worker/src/index.ts`. No changes to reporting-ui,
wrangler.toml, payload builders, cron schedule, the display fixture map, or any
npm dependency. `git status` after cleanup shows only `src/index.ts` modified
(plus the untracked `.agents/` task dir) and no stray scratch/temp files.

## What changed

1. Added pure, exported, testable helpers above `pushFixtureToTT`:
   - `WINDOW_BEFORE_MS` (30 min) / `WINDOW_AFTER_MS` (4 h) — mirror the UI window.
   - `NTFL_UTC_OFFSET = "+09:30"` — Darwin fixed offset (no DST). Documented
     rationale: the Worker runs in UTC, so unlike the browser UI it must apply
     the venue offset explicitly or the window would be ~9.5 h wrong.
   - `scheduledKickoffMs({date,time})` → kickoff epoch ms, or `null` when the
     date is missing/unparseable. Mirrors the UI `scheduleDate` + explicit offset.
   - `restStatusUnknown(status)` → `""`/`"NULL"` (verbatim from UI semantics).
   - `isSpectatorLive(status)` → `IN_PROGRESS`/`LIVE` (mirrors UI `isLive`).
   - `isLiveCandidate(status, scheduledMs, nowMs)` → true when status is
     unknown OR `UPCOMING` AND kickoff is inside the window. Excludes
     FINAL/IN_PROGRESS/LIVE.
   - `mapPool(items, limit, fn)` → bounded-concurrency (limit 4) worker pool
     returning `PromiseSettledResult[]`; never rejects (per-item try/catch).

2. Rewrote `liveFixtureIds(env)` to UNION two passes, keeping the FULL-UUID
   return shape that `pushFixtureToTT` → `resolveFullGame` already accepts:
   - (a) Cheap first pass, UNCHANGED behaviour: any grade-feed game whose REST
     status is already `IN_PROGRESS`/`LIVE` is added (no regression).
   - (b) Spectator probe: non-live games that are in-window + unknown/UPCOMING
     become candidates `{ fullId, shortId: fullId.split("-")[0] }`, collected
     across all grades, then probed via the existing `fetchGame(shortId, env)`
     (same spectator `game` op behind `/api/fixtures/:id/live`) with
     `mapPool(..., 4, ...)`. Candidates the spectator feed reports as live are
     added by their FULL id. Rejected probes are ignored, never rethrown.

## Commands run and results

- `npm run typecheck` (= `tsc --noEmit`, worker's real tsconfig with Cloudflare
  worker types, `strict: true`) — **Exit 0 (GREEN)**. Run in the worktree
  worker dir `.worktrees\worker-live-detect\playhq-worker`. The node_modules
  junction resolved fine; no fallback to the main tree was needed.
- `npx wrangler deploy --dry-run --outdir .wrangler-dryrun-tmp` — **Exit 0**,
  reported `Total Upload: 48.56 KiB / gzip: 13.73 KiB`. Dry run only, no deploy.
  Temp outdir deleted afterwards. (Wrangler 3.114.17 printed an out-of-date
  advisory; non-fatal.)
- Pure-helper unit test: no test runner is installed and new deps are forbidden,
  so a throwaway `src/_scratch_live_detect.test.mts` was run with Node 22.19's
  built-in `node:test` + `node:assert/strict`. Because Node's strip-only mode
  rejects `index.ts`'s TS parameter property (`UpstreamError(public status)`),
  `index.ts` was first transpiled to a temp `.wrangler-tsc-tmp/index.js`
  (`npx tsc ... --outDir .wrangler-tsc-tmp`; it still emits JS despite the
  expected missing-ambient-type errors) and the test imported the emitted JS.
  Result: **8 tests, 8 pass, 0 fail**. Scratch file and temp dir deleted
  afterwards; `npm run typecheck` re-run — still GREEN.

### Assertions that passed
- `scheduledKickoffMs({date:"2026-10-16",time:"19:40:00"})` ===
  `Date.parse("2026-10-16T19:40:00+09:30")`; `null` for missing/bad/`null` date.
- `restStatusUnknown` true for `""`/`"NULL"`/`null`/`undefined`, false for
  `UPCOMING`/`FINAL`.
- `isSpectatorLive` true for `IN_PROGRESS`/`LIVE`, false otherwise.
- `isLiveCandidate("UPCOMING"/"",kickoff,…)` true at kickoff and at both window
  edges (−29 min, +3 h); false at −31 min and +5 h; false for `FINAL` and
  `IN_PROGRESS`; false when `scheduledMs` is `null`.

## Reasoned walkthrough of the required scenarios

(a) **Game live NOW** (REST `UPCOMING`, spectator `IN_PROGRESS`, within window):
    the cheap pass skips it (REST not live), but `isLiveCandidate` returns true
    so it is queued; `fetchGame(shortId)` returns `status: "IN_PROGRESS"`,
    `isSpectatorLive` is true, and its FULL id is added → pushed. ✔

(b) **Far-future / long-past UPCOMING game**: `isLiveCandidate` is false
    (outside the 30-min-before / 4-h-after window), so it is never queued and
    never probed — bounding cost to a handful of probes per tick. ✔

(c) **Spectator fetch error for one candidate**: `mapPool` wraps each `fn` call
    in try/catch and records a `rejected` settled result; the loop only acts on
    `fulfilled` results, so one failing probe is skipped and never aborts the
    batch or the scheduled loop (mirrors the worker's never-throw discipline). ✔

(d) **FINAL games**: `isLiveCandidate` excludes FINAL (not unknown/UPCOMING), so
    FINAL games are never probed. FINAL-time pushes are unaffected — this
    function only decides which fixtures to forward; the existing cheap pass and
    the downstream FINAL/accepted-score push paths are unchanged. ✔

(e) **Returned id shape**: still a `string[]` of FULL grade-feed UUIDs (both
    passes add `fullId`). `pushFixtureToTT(id)` → `resolveFullGame(id)` matches
    on `full === id || full.split("-")[0] === id`, so a full UUID is accepted —
    contract unchanged. ✔
