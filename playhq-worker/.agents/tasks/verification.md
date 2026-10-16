# Verification — score-source fix (spectator-derived live score in pushFixtureToTT)

## What changed
`src/index.ts` only. Scope: `pushFixtureToTT` + two new PURE helpers (`liveHasScore`, `chooseLive`).

- Added `liveHasScore(live)` — true when any of total/goals/behinds on either side is a real `number` (the spectator normaliser leaves them `null` when the feed has no data; a live game fills them, including genuine 0).
- Added `chooseLive(spectatorLive, summaryLive)` — returns the spectator-derived `live` when it carries a usable score, else the summary-derived `live`. Pure, no I/O, never throws.
- In `pushFixtureToTT`:
  - Kept `resolveFullGame` + `fetchGameSummary`.
  - `summaryToScorersPeriods` output renamed to `summaryLive` (fallback source). Team-list push (`summaryToTeamLists` -> `lists` -> `ttTeamBody`) is UNCHANGED.
  - Built `spectatorLive` the same way `/api/fixtures/:id/live` does: `toFixtureLite(full)` for team identity, then `fetchGame(shortId, env)` + `normaliseLive(shortId, game, { home: lite.home, away: lite.away })`. Wrapped in try/catch so a spectator-fetch failure yields `null` (never throws out of the push).
  - `const live = chooseLive(spectatorLive, summaryLive);` feeds both `ttScoreBody(fullId, live)` AND the push-log `score` string + `match` — so the Push Activity log shows the real in-play score.
  - `status` / `competition` / `round` metadata still read from the summary / `full` record (unchanged).

### Why no ctx / no extra fetch
`resolveGameTeams(gameId, env, ctx)` internally is exactly `resolveFullGame(gameId, env)` -> `toFixtureLite(match)` -> `{ home: lite.home, away: lite.away }` (it ignores `ctx` via `void ctx`). `pushFixtureToTT` already holds the resolved `full` record, so `toFixtureLite(full)` yields the identical `GameTeams` value with no network call and no `ExecutionContext` plumbing. `GameTeams = { home: FixtureTeam; away: FixtureTeam } | null` and `toFixtureLite` returns `home`/`away` of type `FixtureTeam` ({id,name}) — shapes line up exactly, no adaptation needed.

## Commands run

### 1. Typecheck — WORKTREE tree
Tree: `c:\Users\AndyDin\reporting-dashboard\.worktrees\worker-score-source\playhq-worker`
```
npm run typecheck   # tsc --noEmit
```
Exit code: **0** (clean). The worktree's node_modules junction resolved fine — typecheck was run in the WORKTREE, not the main tree.

### 2. Bundle without deploy — WORKTREE tree
```
npx wrangler deploy --dry-run
```
Exit code: **0**. "Total Upload: 49.34 KiB / gzip: 13.90 KiB ... --dry-run: exiting now." No real deploy performed. (Wrangler printed an out-of-date-version warning, non-fatal.)

### 3. Throwaway pure-logic test (created, run, deleted)
`__chooseLive.throwaway.mjs` mirrored `liveHasScore` + `chooseLive` and asserted the cases below.
```
node __chooseLive.throwaway.mjs   ->  "all chooseLive cases passed"  (exit 0)
```
File deleted afterwards (`Test-Path` -> False).

## Reasoned walkthrough (acceptance criteria)

- **(a) LIVE game pushes the spectator score (non-zero, matches /live):** spectator feed yields `home.total=26, away.total=34` (real numbers). `liveHasScore(spectatorLive)` is true, so `chooseLive` returns `spectatorLive`. `ttScoreBody` reads `live.home.goals/behinds` + `live.away.goals/behinds` from that spectator normaliser — the exact fields `normaliseLive` fills from `statistics` `TOTAL_GOALS`/`TOTAL_BEHINDS`/`TOTAL_SCORE`, i.e. the same values `/api/fixtures/:id/live` returns. Zeros eliminated. Verified by throwaway case (a) and (d) (a just-started 0-0 live feed with numeric zeros is still chosen over a null summary).

- **(b) FINAL game still pushes correct totals via summary fallback:** post-game the spectator feed can be empty (all `null`). `liveHasScore(spectatorLive)` is false, so `chooseLive` returns `summaryLive`, which for a FINAL NTFL game carries real `scoreTotal` / `TOTAL_GOALS` / `TOTAL_BEHINDS`. Verified by throwaway case (b).

- **(c) spectator-fetch failure falls back to summary, never throws:** `fetchGame`/`normaliseLive` are wrapped in try/catch setting `spectatorLive = null`; `chooseLive(null, summaryLive)` returns `summaryLive`. The push proceeds; no throw escapes `pushFixtureToTT` (its existing never-throw discipline — early returns for not-found / summary-failed — is preserved, and the new code adds only a swallowing try/catch). Verified by throwaway case (c).

- **(d) team-list push unchanged:** `summaryToTeamLists(shortId, summary)` -> `lists` -> `ttTeamBody(fullId, lists)` path is byte-for-byte unchanged. Team lists remain sourced from the authoritative REST summary roster.

- **(e) log score string reflects real in-play score:** the push-log `score` and `match` strings read from the same chosen `live`, so the Push Activity log now shows the spectator in-play score during play (and the summary totals when final / on fallback).

- **(f) ttScoreBody team ids remain valid UUIDs:** spectator path ids come from `toFixtureLite(full)` -> `competitors[].id` (grade-feed team UUIDs) — the SAME source the previous summary path used (`summaryToScorersPeriods` also read `competitors[].id`) and the same ids `/live` returns via `resolveGameTeams`. So the UUIDs TT keys on are unchanged between paths; no risk of id drift.

## Junction reminder
The worktree uses a `node_modules` junction into the main tree. Here it resolved cleanly and typecheck + dry-run both ran in the WORKTREE. If a future run shows module-resolution failures in the worktree, re-run `npm run typecheck` in the MAIN tree at `c:\Users\AndyDin\reporting-dashboard\playhq-worker` and note the tree used.

## Not done (per instructions)
No commit, push, merge, worktree removal, or real deploy. No deps added. `wrangler.toml`, `liveFixtureIds`, team-list logic, TT_BASE_URL/cron/payload shapes untouched. reporting-ui and the main tree untouched.
