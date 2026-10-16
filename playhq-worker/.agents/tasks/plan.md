# Implementation Plan — fix live-detection in `liveFixtureIds` so in-play NTFL scores push to TT

Scope: ONE file — `src/index.ts` in this worktree
(`c:\Users\AndyDin\reporting-dashboard\.worktrees\worker-live-detect\playhq-worker\src\index.ts`).
This is the Cloudflare Worker, NOT the Next.js app. No new npm dependency, no new HTTP client.

## Context established by exploration (read before editing)

Confirmed by reading the code (not assumed):

- **The bug** — `liveFixtureIds(env)` (`src/index.ts` ~line 1016) loads every grade's games via
  `fetchGradeGames(gradeId, env)` and keeps a fixture only when its REST `g.status` is
  `IN_PROGRESS`/`LIVE`. The PlayHQ REST grade feed never sets those for NTFL (games go
  `UPCOMING` → `FINAL`), so the set is empty during play and `scheduled()` pushes nothing.
  `teamlists-upcoming-report.md` in this worktree confirms the fixture `22c22bb1` reports REST
  `status: "UPCOMING"` while live.

- **Current return contract** — `liveFixtureIds` returns `String(g.id)`, i.e. the **FULL UUID**
  from the grade feed (e.g. `22c22bb1-471b-4ae3-8295-15568b69a829`). `scheduled()` and `/api/push`
  pass each id to `pushFixtureToTT(shortId, env)`, whose first line is
  `resolveFullGame(shortId, env)`. `resolveFullGame` matches on `full === gameId || full.split("-")[0] === gameId`, so it accepts a full UUID. **Keep returning full UUIDs** — do not change the shape.

- **Spectator plumbing to REUSE** (already in the file, do NOT add a new client):
  - `async function fetchGame(id: string, env: Env): Promise<unknown>` (~line 510) — POSTs the
    spectator GraphQL `game` op and returns the `game` object (`{ id, status, updatedAt, ... }`),
    or throws `UpstreamError`. The spectator `game` query takes the **SHORT** id; the `/api/fixtures/:id/live` route calls `fetchGame(id, env)` with the id from the URL (short id). So to probe a grade-feed fixture (full UUID), pass `fullId.split("-")[0]`.
    We only need `game.status` for live-detection; no normalising needed in `liveFixtureIds`.
  - `UpstreamError` class (~line 560) — caught/swallowed per-candidate.

- **Grade-feed record shape** (`toFixtureLite`, ~line 1068): each game `g` has
  `g.id` (full UUID), `g.status`, and `g.schedule = { date: "2026-10-02", time: "20:00:00", timezone: "Australia/Darwin" }`. `date`/`time` are **local venue time**.

- **UI reference logic** (read, to mirror) — `reporting-ui/app/live-scores/page.tsx` `load()`:
  ```js
  const now = Date.now();
  const WINDOW_BEFORE = 30 * 60 * 1000;      // 30 min before kickoff
  const WINDOW_AFTER  = 4 * 60 * 60 * 1000;  // 4 h after kickoff
  const candidates = data.filter((g) => {
    if (!restStatusUnknown(g.status)) return false;   // "" or "NULL"
    const d = scheduleDate(g); if (!d) return false;
    const dt = d.getTime();
    return now >= dt - WINDOW_BEFORE && now <= dt + WINDOW_AFTER;
  });
  const results = await Promise.allSettled(candidates.map((g) => getLiveScore(g.id)));
  // keep only where isLive(r.value.status)  → status IN_PROGRESS/LIVE
  ```
  Helper semantics copied from `reporting-ui/lib/api/playhq.ts`:
  - `restStatusUnknown(s)` → `true` when `String(s ?? "").trim().toUpperCase()` is `""` or `"NULL"`.
  - `isLive(s)` → `String(s).toUpperCase()` is `"IN_PROGRESS"` or `"LIVE"`.
  - `scheduleDate(g)` → `new Date(\`${date}T${time || "00:00:00"}\`)`, **no timezone suffix**.

- **CRITICAL worker-vs-browser difference (do not blind-copy the UI):** the UI's `scheduleDate`
  parses `"2026-10-02T20:00:00"` with **no offset**, so the browser interprets it in the *viewer's*
  local zone — which for the intended user equals the venue zone (Australia/Darwin). A Cloudflare
  Worker runs in **UTC**, so the same string would be read as 20:00 UTC and the window would be
  ~9.5 h wrong, probing candidates at the wrong wall-clock time. The Worker MUST apply the venue
  offset explicitly. NTFL = Australia/Darwin = **UTC+09:30, no DST**, and `KNOWN_GRADE_IDS` is all
  NTFL/EFNL/GVL/PFL (all Australian, none observing DST in a way that affects an NTFL Fri/Sat
  night window materially). Decision: compute the kickoff epoch as
  `Date.parse(\`${date}T${time||"00:00:00"}+09:30\`)`, reading the fixed Darwin offset. This is a
  deliberate, documented assumption, not the UI's implicit one. (Keep it in a single constant so a
  future multi-tz need is a one-line change.)

- **Status quo decisions confirmed OUT of scope and left untouched:** `TT_BASE_URL`, the cron
  schedule, `PLAYHQ_TO_TT_FIXTURE`, `ttScoreBody`/`ttTeamBody`, the `/PlayHQTeamUpdate` n/a issue,
  and `reporting-ui`.

## Verification commands (discovered)

- Primary: `npm run typecheck` (= `tsc --noEmit`; `tsconfig.json` has `strict:true`, `noEmit:true`).
  Baseline confirmed GREEN before changes.
- Bundle check: `npx wrangler deploy --dry-run --outdir .wrangler-dryrun-tmp` — runs offline, no
  auth, exits 0 and reports `Total Upload`. Confirmed working. Delete `.wrangler-dryrun-tmp` after.
- No test framework is installed (no vitest/jest; only `dev`/`deploy`/`typecheck` scripts) and the
  task forbids new npm deps, so unit tests via a runner are not added. The new logic is isolated
  into **pure, exported helpers** (step 1) and verified by a throwaway Node script run with the
  bundled `tsx`-free approach below (step 4) — removed before finishing, so no dep is added.

---

## Steps

- [ ] 1. Add pure, testable helpers above `liveFixtureIds` (near the other top-level helpers, e.g.
      just before `pushFixtureToTT` ~line 968). Export them so a sanity script can import them.
      - `const WINDOW_BEFORE_MS = 30 * 60 * 1000;` and `const WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;`
      - `const NTFL_UTC_OFFSET = "+09:30";` (Australia/Darwin, no DST) with a comment explaining the
        worker-runs-in-UTC rationale from the Context section.
      - `export function scheduledKickoffMs(schedule): number | null` — takes `{date,time}` (the
        grade feed `g.schedule`), returns `Date.parse(\`${date}T${time||"00:00:00"}${NTFL_UTC_OFFSET}\`)`
        or `null` when `date` is missing / parse is `NaN`. Mirrors UI `scheduleDate` but with the
        explicit offset.
      - `export function restStatusUnknown(status): boolean` — `""`/`"NULL"` check, copied verbatim
        from the UI semantics.
      - `export function isSpectatorLive(status): boolean` — `IN_PROGRESS`/`LIVE` (reuse/rename of
        the existing inline check; mirrors UI `isLive`).
      - `export function isLiveCandidate(status, scheduledMs, nowMs): boolean` — returns
        `restStatusUnknown(status) && scheduledMs != null && nowMs >= scheduledMs - WINDOW_BEFORE_MS
        && nowMs <= scheduledMs + WINDOW_AFTER_MS`. (Also treat an explicit `UPCOMING` as unknown:
        extend `restStatusUnknown` OR OR-in `UPCOMING` here — see step 2 note. Pick ONE place and
        document it; recommended: broaden the candidate predicate to also accept `UPCOMING`, since
        the NTFL feed uses `UPCOMING` not empty, while leaving `restStatusUnknown` matching the UI.)
      Files: `src/index.ts`
      Verify: `npm run typecheck` — GREEN.

- [ ] 2. Add a bounded-concurrency mapper helper (no dependency) for probing candidates, mirroring
      the UI's `Promise.allSettled` but capped so a 2-min tick never probes 90 fixtures at once.
      Add `async function mapPool<T,R>(items: T[], limit: number, fn: (t:T)=>Promise<R>): Promise<PromiseSettledResult<R>[]>`
      — a simple worker-pool over an index cursor (e.g. `limit = 4`). Keep it generic and local.
      Note on candidate status: the NTFL REST feed reports `UPCOMING` (not empty), so the candidate
      filter in step 3 must accept BOTH empty/`NULL` (via `restStatusUnknown`) AND `UPCOMING`, while
      still EXCLUDING `FINAL`/`IN_PROGRESS`/`LIVE` (those are handled by the cheap first pass). Centralise this in `isLiveCandidate` from step 1.
      Files: `src/index.ts`
      Verify: `npm run typecheck` — GREEN.

- [ ] 3. Rewrite the body of `liveFixtureIds(env)` (~line 1016) to UNION two passes, keeping the
      full-UUID return shape. Replace only the per-game loop; keep the `gradeIds` resolution,
      `UUID_RE` guard, per-grade `try/catch continue`, and `const ids = new Set<string>()`.
      For each grade's `games`:
        a. **Cheap first pass (unchanged behaviour, no regression):** if
           `isSpectatorLive(g.status)` → `ids.add(String(g.id))` (full UUID).
        b. **Candidate build:** collect `g` where `isLiveCandidate(g.status, scheduledKickoffMs(g.schedule), Date.now())` is true AND it was not already added in (a). Capture `{ fullId: String(g.id), shortId: String(g.id).split("-")[0] }` per candidate.
      Then probe candidates ACROSS all grades with `mapPool(candidates, 4, async (c) => { const game = await fetchGame(c.shortId, env) as Record<string,unknown>; return { fullId: c.fullId, status: String(game?.status ?? "") }; })`.
      For each `fulfilled` result where `isSpectatorLive(result.status)` → `ids.add(result.fullId)`.
      `rejected` results (a spectator fetch that threw `UpstreamError`/timeout) are ignored — never
      rethrown — mirroring the `ttPost` never-throw discipline so one bad candidate can't abort the
      scheduled loop. Return `[...ids]` (full UUIDs, unchanged contract for `pushFixtureToTT`).
      Files: `src/index.ts`
      Verify: `npm run typecheck` — GREEN; then `npx wrangler deploy --dry-run --outdir .wrangler-dryrun-tmp` exits 0 and prints `Total Upload`; delete `.wrangler-dryrun-tmp`.

- [ ] 4. Sanity-check the pure window/candidate logic without adding a dependency. Write a temporary
      `src/_scratch_live_detect.test.mts` that imports the exported helpers and asserts with Node's
      built-in `node:assert` + `node --test` (no npm install needed; Node >=18 has the test runner):
        - `scheduledKickoffMs({date:"2026-10-16",time:"19:40:00",timezone:"Australia/Darwin"})`
          equals `Date.parse("2026-10-16T19:40:00+09:30")`.
        - `isLiveCandidate("UPCOMING", kickoff, kickoff)` is `true`;
          `isLiveCandidate("UPCOMING", kickoff, kickoff - 31*60*1000)` is `false` (before window);
          `isLiveCandidate("UPCOMING", kickoff, kickoff + 5*60*60*1000)` is `false` (after window);
          `isLiveCandidate("FINAL", kickoff, kickoff)` is `false`.
        - `isSpectatorLive("IN_PROGRESS")` true, `isSpectatorLive("UPCOMING")` false.
      Run: `node --test --experimental-strip-types src/_scratch_live_detect.test.mts` from the
      worker dir (strip-types runs TS directly on Node 22+; if the installed Node rejects it, fall
      back to compiling just that file with `npx tsc` to a temp `.mjs` and running it). Confirm all
      assertions pass, then DELETE the scratch file. This is verification only — no dep, no commit.
      Files: `src/_scratch_live_detect.test.mts` (temporary; removed before finishing)
      Verify: `node --test ...` reports `pass N / fail 0`; afterwards the scratch file no longer
      exists and `npm run typecheck` is still GREEN.

- [ ] 5. Final regression gate on the whole file.
      Files: none (verification only)
      Verify: `npm run typecheck` exits 0 AND `npx wrangler deploy --dry-run --outdir .wrangler-dryrun-tmp`
      exits 0; delete `.wrangler-dryrun-tmp`. Confirm no changes leaked outside `src/index.ts`
      (`git status` shows only `src/index.ts` modified and no stray scratch/temp files).

## Notes / assumptions (made rather than stalling)

- Window constants mirror the UI exactly (30 min before, 4 h after).
- Concurrency cap chosen at 4 (UI probes all candidates at once, but a round is ~5 NTFL games, so
  4 is ample and bounds a worst case). A single-grade NTFL round yields only a handful of
  candidates, so this never explodes to 90 probes.
- The Darwin fixed-offset decision is the one intentional divergence from the UI; it is required
  because the Worker runtime is UTC. If a future grade sits in a DST-observing zone, replace
  `NTFL_UTC_OFFSET` with a per-fixture `schedule.timezone` → offset lookup — isolated to
  `scheduledKickoffMs`, so the blast radius is one function.
- `fetchGame` is passed the SHORT id (`fullId.split("-")[0]`) because that is what the spectator
  `game` op and the existing `/api/fixtures/:id/live` route use; the full UUID is what we RETURN.
