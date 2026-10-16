# Live-during-play detection for the PlayHQ push worker

`liveFixtureIds(env)` now detects NTFL games that are live *during play*, not just at FINAL. NTFL's REST grade feed never reports `IN_PROGRESS` — a game sits at `UPCOMING` and flips straight to `FINAL` — so the old "keep only REST IN_PROGRESS/LIVE" pass returned an empty set during play and nothing was pushed to TT. The fix mirrors the Next.js live-scores UI: it keeps the cheap REST pass and *unions* a second pass that builds a bounded candidate set (unknown/`UPCOMING` fixtures inside a kickoff window) and probes each candidate's spectator feed via the worker's existing `fetchGame`, treating spectator `IN_PROGRESS`/`LIVE` as live.

Watch for: the venue-offset handling (`NTFL_UTC_OFFSET = "+09:30"`) is a deliberate and necessary divergence from the UI, because the Worker runs in UTC while the browser reads the offset-less timestamp in local (venue) time — **confirmed** correct for NTFL/Darwin but it is a hard-coded single-zone assumption. No blocking issues found.

**Verdict**: APPROVED

## High-level view

The design keeps the existing REST status pass untouched and adds a spectator-probe pass on top, unioned into the same `Set`. This preserves every pre-existing push path (FINAL-time and accepted-score pushes are unaffected, since this function only decides *which* fixtures to forward) and adds the in-play case NTFL actually needs. The candidate gate (`isLiveCandidate`) excludes FINAL/IN_PROGRESS/LIVE so FINAL games are never probed and already-live games are caught cheaply without a probe.

Cost is bounded two ways: a kickoff window (30 min before to 4 h after scheduled start) trims the candidate list to the handful of games plausibly in play, and `mapPool(candidates, 4, …)` caps concurrency at four in-flight spectator probes per tick rather than firing one per fixture. The window math and status semantics are copied from `reporting-ui/app/live-scores/page.tsx` and `lib/api/playhq.ts`, with one documented adaptation for the Worker's UTC runtime.

The spectator probe reuses the worker's own `fetchGame(shortId, env)` — the same spectator `game` operation that backs `/api/fixtures/:id/live` — so there is no new HTTP client and no new dependency. Per-candidate failures are swallowed inside `mapPool` (each call is wrapped in try/catch and recorded as a settled result), so a single bad probe can neither throw out of the scheduled loop nor abort the batch.

The returned shape is unchanged in contract: a `string[]` of full grade-feed UUIDs, which `pushFixtureToTT → resolveFullGame` already accepts (it matches on full id or the short leading segment). Scope is limited to `src/index.ts` plus the untracked task notes; no deploy, no dependency, no touch to the UI, wrangler config, payload builders, cron, or the display map.

<details>
<summary>Issues (1)</summary>

1. **Single-zone offset assumption** — `NTFL_UTC_OFFSET = "+09:30"` is hard-coded for Darwin (no DST). Correct for every current NTFL grade, but a future grade in a DST-observing or different zone would compute a wrong kickoff and mis-window its candidates. Non-blocking: the code comment already flags the remedy (per-fixture `schedule.timezone → offset` lookup inside `scheduledKickoffMs`). Informational only.

</details>

<details>
<summary>Details</summary>

### Candidate window and kickoff parsing vs the UI

The UI (`page.tsx`, `load()`) filters candidates with `restStatusUnknown(g.status)`, `scheduleDate(g)`, and `now >= dt - 30min && now <= dt + 4h`. The worker reproduces the window constants verbatim (`WINDOW_BEFORE_MS = 30*60*1000`, `WINDOW_AFTER_MS = 4*60*60*1000`) and the status/date gates in `isLiveCandidate` + `scheduledKickoffMs`. **Confirmed** the bounds match.

Two intentional divergences, both correct:

- The UI's candidate predicate is `restStatusUnknown` only (`""`/`"NULL"`). The worker widens it to `restStatusUnknown(status) || status === "UPCOMING"`. This is the crux of the fix: the NTFL REST feed reports `UPCOMING`, not empty, so the UI's narrower predicate would never have matched NTFL fixtures either. Widening to include `UPCOMING` is the right superset and FINAL/IN_PROGRESS/LIVE remain excluded, so FINAL games are never probed. **Confirmed** against `statusBadge`/`restStatusUnknown` in the UI which treat `""`, `"NULL"`, and `"UPCOMING"` as the not-yet-played family.

- `scheduleDate` in the UI does `new Date("yyyy-mm-ddThh:mm:ss")` with no offset — the browser reads it in the viewer's local zone, which for the intended (venue) audience is Darwin. A Cloudflare Worker runs in UTC, so the same offset-less string would be parsed ~9.5 h off and the window would be wrong. `scheduledKickoffMs` appends `NTFL_UTC_OFFSET = "+09:30"` explicitly. **Confirmed** correct for NTFL (Australia/Darwin, no DST). The only caveat is the single-zone hard-code noted in Issues; the code comment already documents the per-fixture-timezone remedy.

Cost is bounded: only in-window unknown/`UPCOMING` fixtures become candidates, so the probe set is a handful per tick rather than all 90+ fixtures across grades.

### Spectator probe reuses existing worker functions

The probe calls `fetchGame(c.shortId, env)` — the same function behind the `/api/fixtures/:id/live` handler (also used at index.ts lines 1650, 1783) — which POSTs the spectator `game` operation and returns the game object carrying `.status`. **Confirmed** no new HTTP client, no new fetch wrapper, no new dependency. The short id is derived as `fullId.split("-")[0]`, matching the short/spectator id convention `resolveFullGame` itself uses when matching (`full.split("-")[0] === gameId`).

### Failure isolation and bounded concurrency

`mapPool<T,R>(items, limit, fn)` runs a fixed pool of `min(limit, items.length)` workers pulling from a shared cursor, wrapping each `fn` call in try/catch and recording a `PromiseSettledResult`. It resolves `Promise.all` over the workers, never rejecting. The probe loop only acts on `fulfilled` results, so a rejected spectator fetch (timeout, 429, 403, 502 — all of which `fetchGame` throws as `UpstreamError`) is dropped for that one candidate and never propagates out of `liveFixtureIds` into the scheduled loop. **Confirmed** concurrency is capped at 4.

### Union preserves the existing REST path

Pass (a) is the original check, unchanged in effect: any grade-feed game whose REST status is already `IN_PROGRESS`/`LIVE` is added by full id and `continue`s (so it is never also queued as a probe candidate). Pass (b) adds spectator-live candidates. Both write into the same `Set<string>`, so the result is a true union. **Confirmed** no regression: FINAL-time pushes and accepted-score pushes live downstream of this function and are untouched; this function only selects which fixtures to forward, and it can only *add* fixtures relative to the old behaviour.

### Return shape / push contract

Both passes add `fullId` (the grade-feed UUID), so the return stays `string[]` of full UUIDs. `pushFixtureToTT(id) → resolveFullGame(id)` matches on `full === id || full.split("-")[0] === id`, so a full UUID is accepted. **Confirmed** the contract is unchanged; the old code also returned full grade-feed ids (`String(g.id)`), so this is shape-identical to before.

### Scope and verification

`git status` shows only `playhq-worker/src/index.ts` modified plus the untracked `.agents/` task dir; `git diff --stat` reports the single file (+135/−6). **Confirmed** reporting-ui, wrangler.toml, payload builders, cron, and the display map are untouched, and no dependency was added.

Per the task instruction not to re-run the suites, verification evidence was read from `.agents/tasks/verification.md` rather than re-executed: `npm run typecheck` (tsc --noEmit, strict) exit 0; `wrangler deploy --dry-run` exit 0 (dry run, no deploy); 8/8 pure-helper unit assertions pass via a throwaway `node:test` harness, with scratch/temp artifacts deleted and typecheck re-run green afterward. The recorded assertions exercise the window edges (−29 min and +3 h true; −31 min and +5 h false), `null` schedule handling, and FINAL/IN_PROGRESS exclusion — the exact edge cases the fix hinges on. The evidence is specific and internally consistent; no spot-check re-run was warranted.

### Files changed

- `playhq-worker/src/index.ts` — adds `scheduledKickoffMs`, `restStatusUnknown`, `isSpectatorLive`, `isLiveCandidate`, `mapPool`, and rewrites `liveFixtureIds` to union the REST pass with a bounded spectator-probe pass.
- `playhq-worker/.agents/tasks/*` — verification notes and this review (untracked, not part of the shipped change).

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\worker-live-detect diff`

</details>
