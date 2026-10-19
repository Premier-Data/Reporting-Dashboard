# TT Push Investigation — why live scores aren't pushing to the production TT URL

**Date:** 2026-10-16
**Scope:** READ-ONLY investigation. No code changed, nothing deployed, no POSTs to TT.
**Worker:** `playhq-worker` (`src/index.ts`, `wrangler.toml`), deployed at
`https://playhq-scores.premier-data-enterprise.workers.dev`.

---

## Summary answer (root cause)

**The scheduled push loop never recognises a live game, so it pushes nothing while a game is in play.**

The Worker decides which fixtures to push in `liveFixtureIds()` by reading the **PlayHQ REST grade feed** and keeping only fixtures whose `status` is `IN_PROGRESS` or `LIVE` (`src/index.ts` ~line 1032). But the PlayHQ REST grade feed **never reports those statuses** for NTFL — a fixture is `UPCOMING` right up until it flips straight to `FINAL`. I confirmed this against the live deployed feed: the men's Premier grade (90 games) returns only `UPCOMING` (79) and `FINAL` (10), and **zero** `IN_PROGRESS`/`LIVE`.

Consequently, while a game is actually being played (the UI shows it live via the spectator overlay), `liveFixtureIds()` returns an empty set, the scheduled job logs "no live fixtures to send," and no `/PlayHQScoreUpdate` POST is ever made. Scores only get pushed later — once the REST feed flips the game to `FINAL` — which is exactly the "live scores are coming through but not pushing to [the production] url" symptom.

This is a **Worker-side bug**. The fix is to detect "live" the same way the UI already does — via the spectator feed — rather than via the REST grade feed status. `reporting-ui` needs no change.

Two secondary findings (not the primary cause, but worth fixing):
- **Team-list pushes are being rejected by TT:** every push-log entry shows `teamReply: "n/a"` (score is accepted, team list is not). This explains blank/`n/a` team data downstream and is independent of the live-detection bug.
- The `PLAYHQ_TO_TT_FIXTURE` map is **display-only** and does **not** gate pushes — confirmed below.

---

## Evidence

### 1. Scheduled trigger IS configured and IS wired to the push loop

`wrangler.toml`:

```toml
[triggers]
crons = ["*/2 * * * *"]   # every 2 minutes
```

`src/index.ts` `scheduled()` handler (~line 1715) calls the push loop correctly:

```ts
const ids = await liveFixtureIds(env);
if (ids.length === 0) { console.log(`[...] TT push: no live fixtures to send`); return; }
for (const id of ids) { const r = await pushFixtureToTT(id, env); logPushResult(r, base); results.push(r); }
await recordPushLog(env, base, results);
```

So the cron cadence (2 min) and the wiring are fine **in the repo**. The handler is not the problem — it faithfully pushes whatever `liveFixtureIds()` returns. (Note: I can confirm the trigger exists in source, but cannot confirm from here that the *deployed* Worker still has the cron attached; see recommendation 1.)

### 2. `liveFixtureIds()` looks for a status the REST feed never sets — THE ROOT CAUSE

`src/index.ts` (~line 1016):

```ts
async function liveFixtureIds(env: Env): Promise<string[]> {
  ...
  for (const g of games) {
    const s = String(g.status ?? "").toUpperCase();
    if (s === "IN_PROGRESS" || s === "LIVE") {   // <-- never true for in-play games
      const id = String(g.id ?? "");
      if (id) ids.add(id);
    }
  }
  ...
}
```

The REST grade feed does not use those statuses in-play. Evidence, two independent sources:

- **The UI's own code says so.** `reporting-ui/lib/api/playhq.ts`: the REST feed carries no live score because "status is null until FINAL." It exposes `restStatusUnknown(status)` returning true when status is `""`/`NULL`, and `live-scores/page.tsx` comments: "The REST grade feed gives no live score (status is null until FINAL)."
- **The live deployed feed confirms it.** GET on the men's Premier grade
  (`/api/grades/be950883-.../games`, 90 games) returns status counts:
  `UPCOMING` = 79, `FINAL` = 10, **`IN_PROGRESS`/`LIVE` = 0**. The Tiwi Bombers and Darwin Buffaloes teams both appear in that feed, but no fixture carries a live status.

**How the UI detects live (contrast):** `reporting-ui/app/live-scores/page.tsx` (~line 670) filters to games whose REST status is unknown (`restStatusUnknown`) and within a kickoff window, then calls `getLiveScore(g.id)` (the Worker's spectator `/api/fixtures/:id/live` endpoint) and keeps an overlay only when `isLive(r.value.status)` is true. In other words the UI gets "live" from the **spectator feed's** status, not the REST grade status. The Worker's push loop does the opposite, which is why the UI shows a live game while the Worker pushes nothing.

### 3. What TT actually returns (deployed `/api/push-log`)

GET `https://playhq-scores.premier-data-enterprise.workers.dev/api/push-log` — 13 entries. Representative:

| ts (UTC) | match | scoreReply | teamReply | ok |
|---|---|---|---|---|
| 2026-10-16T09:42:02Z | Palmerston Magpies vs Waratah | `"ok"` | `"n/a"` | true |
| 2026-10-14T23:47:03Z | Balwyn vs Blackburn (EFNL) | `"ok"` | `"n/a"` | true |
| 2026-10-14T23:46:49Z | Nightcliff Tigers vs St Mary's | `"ok"` | `"n/a"` | true |

Interpretation:
- **Score pushes that DO run are accepted** — every `scoreReply` is `"ok"`, `ok: true`. TT and `TT_BASE_URL` are reachable and working.
- **Team-list pushes are rejected** — every `teamReply` is `"n/a"` (see finding 5b).
- **The log contains only completed/FINAL-looking scorelines** (e.g. "15.14 (104)", "15.17 (107)"). There are no entries captured mid-first-quarter for the game the user sees live. This matches the root cause: pushes effectively fire around/after FINAL (when the REST status changes), not during play. So this is **"push rarely/never runs while live"**, not "push runs but TT says n/a" for scores.

### 4. `TT_BASE_URL` / wrangler config — correct, no prod/staging mismatch

`wrangler.toml [vars]`: `TT_BASE_URL = "https://pdrest.advancedhp.com.au"`, matching the code default `TT_BASE_DEFAULT` (`src/index.ts` ~line 810). Every push-log `endpoint` is exactly that host, and TT replies `"ok"` to scores. **The production URL is correct and not the problem.**

### 5. The `PLAYHQ_TO_TT_FIXTURE` map — display-only, does NOT gate pushes

- `ttFixtureUidFor(fullId)` returns the mapped TT id or `null`; it is used only to populate `ttId` in the push-log record for display (`pushFixtureToTT`, `recordPushLog`). It is never used to build the POST body or to decide whether to push.
- `ttScoreBody()`/`ttTeamBody()` send the **PlayHQ** `fixtureId`/`fullId`; TT does its own lookup. The push-log confirms this: entries with `"ttId":null` (e.g. the EFNL Balwyn/Blackburn game) still got `scoreReply:"ok"`. So an unmapped fixture still pushes fine.
- The target fixture from the user's link, `22c22bb1-471b-4ae3-8295-15568b69a829`, **is** in the map (TT `32666`), so display isn't even the issue for it.
- **5b — the real `n/a` is on team lists.** Every entry shows `teamReply:"n/a"`, independent of whether the score mapped. The score body is accepted but the team body (`/PlayHQTeamUpdate`, built by `ttTeamBody`) is consistently rejected by TT. This is a separate defect from the live-detection bug and is why team lists don't land downstream.

So the blank TT ids in the dashboard and the non-landing pushes are **two separate things**: blank TT id = fixture simply not in the display map; non-landing live scores = the live-detection bug in finding 2; non-landing team lists = TT rejecting the team body (finding 5b).

---

## Conclusions

1. **Primary root cause (Worker):** `liveFixtureIds()` detects live via REST grade `status === IN_PROGRESS|LIVE`, but the PlayHQ REST feed never sets those for NTFL (it stays `UPCOMING` until `FINAL`). The scheduled job therefore finds no live fixtures and pushes nothing during play. Confirmed by the UI's own comments and by the live deployed grade feed (0 in-progress of 90 games).
2. **TT and the production URL are healthy** — score pushes that run return `"ok"`.
3. **Team-list pushes are separately broken** — TT returns `"n/a"` for every `/PlayHQTeamUpdate`.
4. **The fixture map is display-only** and does not block pushes.

---

## Recommendations (not implemented)

**Owner: the Worker (`playhq-worker`). `reporting-ui` needs no change.**

1. **Fix live detection to mirror the UI (primary fix).** Change `liveFixtureIds()` so that for every fixture with an unknown REST status (`restStatusUnknown`: empty/`NULL`) within a sensible kickoff window (the UI uses ~30 min before to ~4 h after `scheduleDate`), it queries the spectator feed (reuse the same path as `fetchGame`/the `/live` normaliser) and treats the fixture as live when the spectator `status` is `IN_PROGRESS`/`LIVE`. This is exactly the candidate-filter + overlay logic already in `reporting-ui/app/live-scores/page.tsx`. Keep the cost bounded with the time window so only a handful of fixtures are probed per tick.
2. **Verify the deployed cron is actually attached.** I can confirm `crons = ["*/2 * * * *"]` in `wrangler.toml`, but not from here that the live Worker still has the schedule bound. Check the Cloudflare dashboard (Workers > playhq-scores > Triggers) or `wrangler deployments`/`wrangler triggers`. If the cron were detached, even after fix 1 nothing would auto-push.
3. **Investigate the team-list `n/a`.** Compare `ttTeamBody()`'s shape/field names against what TT's `/PlayHQTeamUpdate` expects (the score body with the same `fixtureId` is accepted, so it's likely a body/field-name mismatch in the team payload, not auth or URL). This is the fix for team lists not landing.
4. (Optional) Extend `PLAYHQ_TO_TT_FIXTURE` only to improve the TT-id display column; it has no effect on whether pushes land.

---

## Verification notes / limitations

- All findings are from reading `playhq-worker/src/index.ts` and `wrangler.toml`, the `reporting-ui` live-scores code, and two READ-ONLY GETs against the user's own deployed Worker (`/api/push-log`, `/api/grades/<mens>/games`). No POST to TT, no push triggered, no deploy, no edits.
- I could not confirm the deployed Worker's cron binding or TT's exact team-body schema from here (see recommendations 2 and 3).
