# Zero-Score Push — Findings Report

File under investigation: `c:\Users\AndyDin\reporting-dashboard\playhq-worker\src\index.ts`

## Summary answer

The live-detection fix works, but `pushFixtureToTT` sources the score from the **wrong feed**. Detection now uses the SPECTATOR feed (`fetchGame`), but the SCORE sent to TT is built from the **REST game summary** path. For NTFL games the REST summary reports `status: "PENDING"` with `goals/behinds = 0` and `total = null` for the entire duration of play — it only populates once the game is FINAL. So while the game is live, `pushFixtureToTT` ships `0.0 (0) - 0.0 (0)` to TT even though the real score is available on the spectator feed the UI uses.

The single line responsible:

```
src/index.ts:1075   const live = summaryToScorersPeriods(shortId, summary);
```

`live` here comes from the summary, not the spectator feed. `ttScoreBody(fullId, live)` then reads `live.home.goals/behinds` (both 0) and pushes zeros.

## Evidence (code)

### 1. `pushFixtureToTT` builds the score from the REST summary

`pushFixtureToTT` (defined at `src/index.ts:1061`):

```
1065   const full = await resolveFullGame(shortId, env);
...
1070   let summary: Record<string, unknown> | null = null;
1071   try {
1072     summary = await fetchGameSummary(fullId, env);   // REST /games/{id}/summary
...
1075   const live = summaryToScorersPeriods(shortId, summary);   // <-- score source
1076   const lists = summaryToTeamLists(shortId, summary);
...
1079   const score = await ttPost(env, "/PlayHQScoreUpdate", ttScoreBody(fullId, live));
```

So `live` is produced by `summaryToScorersPeriods`, whose only input is the REST summary. The spectator feed (`fetchGame` / `normaliseLive`) is **never called** inside `pushFixtureToTT`. Detection (`liveFixtureIds`) uses the spectator feed, but score sourcing was not switched over.

### 2. `ttScoreBody` reads the score fields off `live`

`ttScoreBody` (`src/index.ts:815`):

```
817   return {
818     fixturePlayHQId: fullId,
819     homeTeamId: live.home.id ?? "",
820     awayTeamId: live.away.id ?? "",
821     homeG: live.home.goals ?? 0,
822     homeB: live.home.behinds ?? 0,
823     awayG: live.away.goals ?? 0,
824     awayB: live.away.behinds ?? 0,
825     requestType: "SCORE",
...
```

It depends entirely on `live.home.goals/behinds` and `live.away.goals/behinds`. If those are 0, TT receives 0. (The log's `score` string `0.0 (0) - 0.0 (0)` is built at `src/index.ts:1099` from the same `live.*.goals/behinds/total`.)

### 3. Why those fields are 0 mid-game — the summary normaliser

`summaryToScorersPeriods` (`src/index.ts:628`) derives per-side totals from the REST summary's `competitors[].scoreSubTotal` / `scoreTotal`:

```
705   const sideTotals = (comp) => {
706     const sub = comp?.scoreSubTotal as Array<{ type?: string; value?: number }>;
707     return {
708       total: typeof comp?.scoreTotal === "number" ? comp.scoreTotal : null,
709       goals: subVal(sub, "TOTAL_GOALS"),
710       behinds: subVal(sub, "TOTAL_BEHINDS"),
711     };
712   };
```

For NTFL, the REST `/games/{id}/summary` does not fill in `scoreTotal` / `scoreSubTotal` (and `status` stays `PENDING`) until the game is FINAL. During play those are absent, so `subVal` returns 0 and `scoreTotal` is null. Hence `goals = 0`, `behinds = 0`, `total = null`.

### 4. The feed that DOES have the in-play score — spectator normaliser

The UI's 19–28 (now 26–34) comes from `/api/fixtures/:id/live`, which uses the spectator feed:

- Route handler: `src/index.ts:1783` `const game = await fetchGame(id, env)` then `src/index.ts:1795` `normaliseLive(id, game, teams)`.
- `normaliseLive` (`src/index.ts:468`) reads in-play totals from `result.{home,away}.statistics` via `statVal(..., "TOTAL_SCORE" | "TOTAL_GOALS" | "TOTAL_BEHINDS")` (`src/index.ts:491-493`, `src/index.ts:501-503`). These ARE populated live.
- `reporting-ui/lib/api/playhq.ts` `getLiveScore` calls `GET {WORKER_BASE}/api/fixtures/{id}/live` — the same spectator route.

The mismatch is exact: **detection switched to spectator; score sourcing did not.** `pushFixtureToTT` still reads the summary-based normaliser (`summaryToScorersPeriods`), which is zero-during-play.

## Supporting live evidence (read-only GETs, no push)

Both fetched at the same moment for short id `22c22bb1` (Tiwi Bombers v Darwin Buffaloes, NTFL Men's Premier):

`GET /api/fixtures/22c22bb1/live` (spectator → `normaliseLive`):
- `status: "LIVE"`, clock "2nd Quarter" 13:03
- home Tiwi: `goals 4, behinds 2, total 26`
- away Darwin: `goals 5, behinds 4, total 34`
- full scorers + Q1/Q2 period breakdown present

`GET /api/fixtures/22c22bb1/scorers` (REST summary → `summaryToScorersPeriods`, the EXACT function the push uses):
- `status: "PENDING"`
- home Tiwi: `goals 0, behinds 0, total null`
- away Darwin: `goals 0, behinds 0, total null`
- empty scorers, empty periods

The `/scorers` endpoint returns exactly what `pushFixtureToTT` feeds into `ttScoreBody` → `homeG 0, homeB 0, awayG 0, awayB 0`. That is precisely the `0.0 (0) - 0.0 (0)` seen in the Push Activity log. Proven.

(`/api/fixtures/:id/scorers` route uses `fetchGameSummary` + `summaryToScorersPeriods` at `src/index.ts:1578-1580`, mirroring the push path.)

## Conclusions

1. The zeroed push is caused by `pushFixtureToTT` building the TT score body from the REST summary (`summaryToScorersPeriods`), which reports 0/null until the game is FINAL for NTFL.
2. The correct in-play score is already produced by the spectator path (`fetchGame` + `normaliseLive`) that the UI and `/api/fixtures/:id/live` use.
3. Once the game goes FINAL the summary would carry real totals, so the final push would be correct — but every in-play push is zero. This matches the symptom: pushes fire (detection fixed) but carry a zeroed score.

## Recommended fix (NOT implemented — Worker-only, no new deps)

In `pushFixtureToTT` (`src/index.ts:1061`), source the SCORE from the spectator feed, the same way `/api/fixtures/:id/live` does, while keeping team-list sourcing on the summary.

Concretely:

- Keep `resolveFullGame` and `fetchGameSummary` for the team-list push (`summaryToTeamLists`) and for the non-score metadata (status, competition label, round). The summary is the authoritative COMPLETE roster, so team-list sourcing should stay as-is.
- For the SCORE, fetch the spectator game and normalise it the same way the live route does:
  - `const game = await fetchGame(shortId, env);`
  - `const teams = await resolveGameTeams(shortId, env, ctx);` (spectator feed carries no team identity; `/live` resolves teams this way at `src/index.ts:1785`). Note: `pushFixtureToTT` currently has no `ctx` in scope — either thread `ctx` through from the scheduled/`/api/push` callers, or reuse the `full` record already resolved (`resolveFullGame` returns the grade record; `toFixtureLite(full)` yields `home/away` id+name, which is what `resolveGameTeams` does internally), avoiding a new fetch.
  - `const live = normaliseLive(shortId, game, teams);`
  - Pass THIS `live` to `ttScoreBody(fullId, live)`.
- `ttScoreBody` needs NO shape change: `normaliseLive` already outputs the same `NormalisedLive` shape with `home/away.{id,name,total,goals,behinds}` populated from the spectator `statistics` (`TOTAL_GOALS` / `TOTAL_BEHINDS` / `TOTAL_SCORE`). The fields `ttScoreBody` reads (`home.goals`, `home.behinds`, `away.goals`, `away.behinds`) are exactly the ones the spectator normaliser fills in-play.

Nuances:
- Keep the log `score` string (`src/index.ts:1099`) reading from the spectator `live` so the Push Activity log reflects the real in-play score too.
- The team id fields in `ttScoreBody` (`live.home.id` / `live.away.id`) must remain valid UUIDs. From the summary path they came from `competitors[].id`; from the spectator path they come from the resolved `teams` (grade-feed team UUIDs). Verify TT expects the grade-feed team UUID; the resolved team ids from `resolveGameTeams`/`toFixtureLite` are the same ones `/live` already returns, so this should match what the UI shows.
- Optional hardening: if the spectator fetch fails or the game is not yet live, fall back to the summary-based `live` (current behaviour) rather than skipping the push, so a FINAL game still pushes correct totals.

No new dependencies required — this reuses `fetchGame`, `normaliseLive`, and `resolveGameTeams`/`toFixtureLite` already present in `src/index.ts`.
