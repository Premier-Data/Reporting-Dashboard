# Source the TT live-score push from the spectator feed

`pushFixtureToTT` now builds the TT score body from the SPECTATOR feed (`fetchGame` + `normaliseLive`) instead of the REST summary, which for NTFL reports `PENDING` with zero totals until a game is FINAL and was therefore shipping `0.0 (0) - 0.0 (0)` to TT during play. Team identity is reused from the already-resolved `full` record via `toFixtureLite(full)` — the same grade-feed team UUIDs `resolveGameTeams` would return — so no `ExecutionContext` plumbing and no extra network fetch were added. A `chooseLive` helper falls back to the summary-derived score when the spectator feed fails or carries no usable number, keeping FINAL/pre-game pushes correct and the push unconditional. Team-list sourcing stays on the authoritative REST summary, unchanged.

Watch for: nothing blocking. One behavioural note (possible): `chooseLive` prefers the spectator score the instant it carries any numeric field, including a genuine 0-0 at kickoff — intended, and still correct, but worth knowing the summary is only consulted when the spectator feed is entirely null.

**Verdict**: APPROVED

## High-level view

The fix redirects the score source inside `pushFixtureToTT`: the score path moves to the spectator feed while the team-list path and all non-score metadata stay on the REST summary. Both feeds were already present in the file, so this reuses `fetchGame`/`normaliseLive`/`toFixtureLite` rather than introducing anything new.

Team identity for the spectator normaliser comes from `toFixtureLite(full)` on the record `resolveFullGame` already produced. This is identical to what `resolveGameTeams` computes internally (it does `resolveFullGame` → `toFixtureLite` → `{home, away}` and ignores `ctx`), so the TT `homeTeamId`/`awayTeamId` remain the same grade-feed UUIDs as before — no id drift, no `ctx` threading, no second fetch.

Failure and pre-game behaviour is handled by `chooseLive` plus a swallowing try/catch: a spectator-fetch error yields `null`, and an empty spectator feed (all-null totals) fails `liveHasScore`, so in both cases the push falls back to the summary-derived score. The push is never skipped and never throws out of `pushFixtureToTT`, preserving its existing never-throw discipline.

The scope is tight: only `src/index.ts` and the task-dir note are modified, nothing is committed or merged, and no deploy was run.

<details>
<summary>Issues (1)</summary>

1. **Kickoff 0-0 preference (non-blocking)** — `chooseLive` returns the spectator score as soon as any total/goals/behinds field is a real number, so a genuine 0-0 at the opening bounce is pushed as 0-0 rather than deferring to the summary. This is the intended and correct behaviour (summary is also 0/PENDING pre-game); noted only so the fallback boundary is explicit. No action required.

</details>

<details>
<summary>Details</summary>

## Score source redirect and the summary/spectator split

The change rests on a clean division of responsibility that the diagnosis report identified: the REST summary is the authoritative roster and the authoritative post-FINAL total, but it is useless for in-play score because NTFL leaves `scoreTotal`/`scoreSubTotal` empty and `status: PENDING` until the game ends. The spectator feed (`game` GraphQL op, behind `/api/fixtures/:id/live`) carries the live totals the UI shows. The fix keeps `summaryToScorersPeriods` (now named `summaryLive`) and `summaryToTeamLists` on the summary, and routes only the score through the spectator path.

`spectatorLive` is built exactly as the `/live` route builds it: `toFixtureLite(full)` for team identity, `fetchGame(shortId, env)` for the game payload, then `normaliseLive(shortId, game, { home: lite.home, away: lite.away })`. `normaliseLive` fills `home/away.{total,goals,behinds}` from the spectator `statistics` (`TOTAL_SCORE`/`TOTAL_GOALS`/`TOTAL_BEHINDS`) — the precise fields `ttScoreBody` and the log `score` string consume. (confirmed, src/index.ts ~1120-1128, 465-505, 815-827)

## No ctx, no extra fetch — team identity reuse

`resolveGameTeams(gameId, env, ctx)` is literally `resolveFullGame(gameId, env)` → `toFixtureLite(match)` → `{ home: lite.home, away: lite.away }`, with `void ctx` — the `ctx` parameter is reserved and unused. `pushFixtureToTT` already holds the resolved `full` record from its own `resolveFullGame` call, so `toFixtureLite(full)` yields the identical `GameTeams` value with zero additional I/O. The diagnosis report floated threading `ctx` as one option; the implementation correctly chose the cheaper, equivalent reuse. (confirmed, src/index.ts 340-352, 1121-1123)

The teams shape matches what `normaliseLive` expects: its third parameter is typed `GameTeams = { home: FixtureTeam; away: FixtureTeam } | null`, and `toFixtureLite` returns `home`/`away` of type `FixtureTeam = { id: string | null; name: string | null }`. Passing `{ home: lite.home, away: lite.away }` is a valid non-null `GameTeams`; `normaliseLive` reads `teams?.home.id`/`teams?.away.id` for the ids. No adaptation needed. (confirmed, src/index.ts 264-287, 334, 465-469, 1223, 1249-1270)

## Fallback and never-throw discipline

```
             spectator fetch
                   │
          try ─────┼───── catch → spectatorLive = null
           │                           │
   normaliseLive(...)                  │
           │                           │
           ▼                           ▼
   chooseLive(spectatorLive, summaryLive)
           │
   spectatorLive && liveHasScore(spectatorLive) ? spectatorLive : summaryLive
```

`liveHasScore` returns true only when at least one of total/goals/behinds on either side is a real `number`; the spectator normaliser leaves them `null` when the feed has no data (pre-game, empty, or failed). So two failure modes both fall back to the summary: a thrown fetch (caught → `null`) and a not-yet-live/empty spectator feed (all-null → `liveHasScore` false). In both cases a FINAL game still pushes its real summary totals, and the push is never skipped. The new code adds only a swallowing try/catch, so the function keeps its existing never-throw contract (early returns for not-found and summary-failed are untouched). (confirmed, src/index.ts 1061-1090 helpers, 1120-1128)

The one boundary worth stating explicitly: because `liveHasScore` accepts a genuine numeric 0, a 0-0 live feed at the opening bounce is chosen over the summary. That is correct — the summary is also 0/PENDING at that point — but it means the summary is consulted for score only when the spectator feed is entirely null, not merely zero. (possible, by design)

## Log score and TT team ids

The chosen `live` feeds both `ttScoreBody(fullId, live)` and the push-result `score`/`match` strings, so the Push Activity log reflects the same spectator in-play score (and the summary totals on fallback) rather than diverging from what TT receives. (confirmed, src/index.ts 1128, 1151-1153)

`ttScoreBody` keys TT on `live.home.id`/`live.away.id`. On the spectator path these come from `teams.home.id`/`teams.away.id` = `toFixtureLite(full).home/away.id` = `teamOf(competitor).id` = the grade-feed `competitors[].id` UUIDs. That is the same source the old summary path used and the same ids `/live` returns via `resolveGameTeams`, so the UUIDs TT matches on do not drift between the two sources. (confirmed, src/index.ts 1234-1239, 1256-1267, 819-820)

## Unchanged surfaces

Team-list sourcing is byte-for-byte intact: `summaryToTeamLists(shortId, summary)` → `lists` → `ttTeamBody(fullId, lists)`, still from the REST roster. Non-score metadata (`status` from summary, `competition` from the game url, `round` from the `full` record) is unchanged. `liveFixtureIds`, `wrangler.toml`, reporting-ui, dependencies, and all payload shapes are untouched — the diff is confined to `src/index.ts` (two new pure helpers plus the `pushFixtureToTT` body) and the task-dir verification note. (confirmed, git diff + git status)

## Verification evidence and scope

The coder's note records `npm run typecheck` (exit 0) and `npx wrangler deploy --dry-run` (exit 0, 49.34 KiB bundle, no deploy) run in the worktree, plus a throwaway pure-logic test of `liveHasScore`/`chooseLive` that was deleted afterward. Per the review mandate these suites were not re-run; the evidence is present and the diff is consistent with it, leaving no articulable doubt to spot-check. `git status` shows only `src/index.ts` and `.agents/tasks/verification.md` modified, and `git log` shows HEAD unchanged — nothing committed, merged, or deployed. (confirmed, verification.md + git status/log)

</details>

<details>
<summary>File map</summary>

- `playhq-worker/src/index.ts` — added pure helpers `liveHasScore` and `chooseLive`; redirected the score in `pushFixtureToTT` to the spectator feed with a summary fallback. Team-list path and metadata unchanged.
- `playhq-worker/.agents/tasks/verification.md` — coder's verification note (typecheck, dry-run, reasoned walkthrough).

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\worker-score-source\playhq-worker diff`

</details>
