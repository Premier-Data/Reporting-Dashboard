# Implementation Plan — Round-Summary board (`/api/round-summary` + Push Activity summary table)

Source of truth: the APPROVED design at `.worktrees/round-summary/reporting-ui/.agents/tasks/design.md`
and its review `design-review.md`. This plan sequences that design faithfully; it does not re-decide
the architecture. All paths are absolute. Windows/PowerShell. Work in the ISOLATED worktree only.
Do NOT commit, push, or deploy. No new dependencies anywhere.

## Grounding confirmed by reading the actual code

- Worker `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\playhq-worker\src\index.ts` (1933 lines):
  `competitionLabel` (l.85), `corsHeaders` (l.227), `json(body,status,extra)` (l.249), `resolveFullGame`
  cache-read pattern + `grade-games/{id}` key (l.355–390), `UpstreamError` (l.541), `UUID_RE` (l.551),
  `fetchGradeGames` (l.557, throws `UpstreamError("api_key_not_configured",500)` when `PHQ_API_KEY` unset),
  `PushLogEntry` type (l.885–901), `PUSH_LOG_KEY = "recent"` / `PUSH_LOG_MAX = 100` (l.902–903),
  `recordPushLog` (l.907), the push-pipeline inline `stripGrade` regex `/\s+(men|women)\s+premier.*$/i`
  with `(n ?? "?")` fallback (l.1140–1141), `scheduledKickoffMs({date,time})` exported (l.992),
  `restStatusUnknown` (l.1003), `mapPool(items,limit,fn)` settles-all/never-rejects (l.1039), the
  `competitors.find(c => c.isHomeTeam === true/false)` home/away pattern in `toFixtureLite` (l.1255–1256).
- Router (inside `fetch`): OPTIONS→204 and non-GET→405 at the top (l.1481–1488); `ttl` + `cache = caches.default`
  (l.1493–1494); `/api/grades/:id/games` handler writes the shared cache with
  `JSON.stringify({ gradeId, count: games.length, data: games })`, `listTtl = Math.min(ttl,60) || 60`,
  `Cache-Control: public, max-age=${listTtl}` via `ctx.waitUntil(cache.put(...))` (l.1564–1607); the
  `/api/push-log` string-matched block returns `json({count,entries},200,cors)` (l.1788–1800), immediately
  before the final `^\/api\/fixtures\/([^/]+)\/(live-scores|live|status)$` regex and the terminal 404.
- Frontend `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\lib\api\playhq.ts`:
  `WORKER_BASE`, `getPushLog(signal)` using `cache:"no-store"` (the fetcher to mirror), `PushLogEntry`
  (carries optional `playhqId`/`ttId`), `GameStatus`, `PlayHqGame`.
- Page `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\app\push-log\page.tsx`:
  `"use client"`, `POLL_MS = 5000`, helpers `cleanReply`, `shortMatch`, `shortRound` (branch order
  R#/GF/PF/SF/QF/EF), `roundNum` (`9999` sentinel), `clock` (NaN-guarded); `load` useCallback + `abortRef`
  + `useEffect` `setInterval(load, POLL_MS)` gated on `live`. These stay unchanged; the summary is added above.
- Tests: `vitest ^3.2.7`, `npm test` → `vitest --run`, `vitest.config.ts` includes `**/*.test.ts` in a
  `jsdom` environment; colocated suites exist under `lib/comparison/*.test.ts`, `lib/api/cache.test.ts`,
  `lib/pwa/*.test.ts` (import style: `import { describe, it, expect } from "vitest"`).
- Next.js 16 client-fetch pattern confirmed in
  `...\reporting-ui\node_modules\next\dist\docs\01-app\01-getting-started\06-fetching-data.md`: Client
  Components fetch via the `use` API or a community library; the page's existing browser `fetch` +
  `useEffect` + `setInterval` is the community-library-style client pattern. No Server Component caching,
  `use cache`, or route handler is involved, so none of the Next 16 server-caching semantics apply — the
  new fetcher/section are pure client-side additions.
- **KNOWN JUNCTION ARTIFACT:** `...\reporting-ui\node_modules` is a `<JUNCTION>` to the MAIN tree's
  `node_modules` (`c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules`). Per
  `.agents/tasks/handoff.md`, module collection under the junction produces two documented false failures:
  vitest "No test suite found" and Turbopack "Symlink node_modules points out of filesystem root". When a
  verify step below hits either artifact, re-run that command against the MAIN tree
  `c:\Users\AndyDin\reporting-dashboard\reporting-ui` (which has the real `node_modules`) after copying the
  new/edited files there, OR copy the pure helper + its test to a scratch dir outside both trees and run with
  the main tree's vitest. `npx tsc --noEmit` type-checks the real edited sources in the worktree and is the
  authoritative type check — run it in the worktree. Do NOT delete through the junction and do NOT touch the
  main tree's port-3000 dev server.

## Design decisions already locked by the design (not re-opened here)

Three-tier latest-round rule (started → imminent(≤now+6h) → first-upcoming, undated fallback to highest by
`compareRounds`); `roundNum: number|null` (no `9999` in JSON); push-log join on the full UUID keeping
max-`ts`; `mapPool` limit 6; two cache layers (per-grade `grade-games/{id}` ≤60s + 45s board); `venue`
omitted; the IN_PROGRESS/LIVE chip branch is a defensive, unit-tested fallthrough that never fires for the
NTFL grade feed. These are implemented as specified; this plan only orders the work.

---

# Implementation Plan

- [ ] 1. Create the shared pure-helper module `lib/round-summary/roundSummary.ts` (frontend, the tested reference implementation).
      Export, with NO I/O / no `env` / no `caches`, over the minimal structural `RoundInputGame` type from design §1.9
      (`{ round?: { name?: string|null }|null; schedule?: { date?: string|null; time?: string|null }|null }`):
      `roundNumOf(name): number|null` (first `\d+`, else null — NOT the `9999` sentinel),
      `shortRound(round?: string): string` (reproduce `page.tsx` branch order EXACTLY: `round N`→`R{n}`, then
      grand final→GF, prelim→PF, semi→SF, qualif→QF, elim→EF, else the trimmed name),
      `displayStatus(raw): string` (`""`/`"NULL"`→`"UPCOMING"`, else `String(raw)` normalised),
      `stripGradeName(name?: string|null): string` (regex `/\s+(men|women)\s+premier.*$/i`, `.trim()`; keep the
      `(n ?? "?")` fallback to match the push pipeline — note it in a comment),
      `statusChip(status: string): string` (class-mapper: FINAL→emerald, UPCOMING/other→slate, IN_PROGRESS/LIVE→amber/pulse
      defensive branch),
      `compareRounds(a, b): number` (numbered-before-unnumbered via a `hasNum` flag; numbered by `roundNum`; two
      unnumbered by locale name compare; never compares `null` as a number),
      `selectLatestRound(games: RoundInputGame[], nowMs: number): { roundName: string; roundNum: number|null } | null`
      (the full §1.7 three-tier rule using `game.round?.name ?? ""`, `scheduledKickoffMs(game.schedule)` imported from
      the worker? — see note below —, `LOOKAHEAD_MS = 6*60*60*1000`, per-round `{roundNum,hasNum,earliestKickoff}`),
      `indexLatestPushes(entries): Map<string, PushLogEntry>` (key by `playhqId`, skip empty id, keep max numeric
      `Date.parse(ts)`, ties keep first seen). `PushLogEntry` is imported as a type from `@/lib/api/playhq`.
      NOTE on `scheduledKickoffMs`: the worker's copy is not importable from the Next app; add a tiny local
      `scheduledKickoffMs({date,time})` inside this module (Darwin `+09:30`, `Date.parse`, null on missing/NaN) byte-identical
      in behaviour to the worker's exported helper (design §1.7/§1.9), so the pure helpers stay self-contained and testable.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\lib\round-summary\roundSummary.ts`
      Verify: `cd c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui; npx tsc --noEmit` — no new type errors (authoritative in the worktree).

- [ ] 2. Create the colocated unit tests `lib/round-summary/roundSummary.test.ts` covering every case the design requires.
      Use `import { describe, it, expect } from "vitest"` (match `lib/comparison/*.test.ts`). Cover:
      `selectLatestRound` — all-future→tier C first upcoming; mid-round all-UPCOMING with earliest kickoff ≤now→that round
      via tier A (the NTFL-quirk regression guard, NOT last week); between-rounds with next round >6h away→tier A returns the
      started round; morning-of-new-round nothing started but next ≤now+6h→tier B rolls forward; split weekend N started AND
      N+1 within 6h but not started→selects N not N+1; finals name ("Grand Final")→`roundNum:null` ordered after numbered;
      all-date-less→step-5 fallback to highest by `compareRounds`; empty array→null.
      `compareRounds` — numbered-before-unnumbered; numbered by number; two unnumbered by name; sign flips on swap.
      `indexLatestPushes` — multiple entries one id→max-ts wins; several ids keyed correctly; empty/absent `playhqId` skipped;
      empty input→empty map; out-of-order timestamps→latest still chosen.
      `roundNumOf` (number vs null), `shortRound` (R#, GF, PF, SF, QF, EF, passthrough), `displayStatus("")/("NULL")==="UPCOMING"`,
      `stripGradeName`, and `statusChip` mappings INCLUDING the IN_PROGRESS/LIVE branch in isolation.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\lib\round-summary\roundSummary.test.ts`
      Verify: `cd c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui; npx vitest --run lib/round-summary`
      — the new suite passes. If this hits the junction "No test suite found" artifact, re-run against the MAIN tree per the
      junction note (copy the two files into `c:\Users\AndyDin\reporting-dashboard\reporting-ui\lib\round-summary\` and run
      `npx vitest --run lib/round-summary` there, then remove the copies). Depends on item 1.

- [ ] 3. Add the `GET /api/round-summary` endpoint + inline pure-helper copies to the Worker.
      In `playhq-worker/src/index.ts`, add inline copies (pure, behaviourally identical to item 1) of `roundNumOf`,
      `shortRound`, `displayStatus`, `stripGradeName`, `compareRounds`, `selectLatestRound`, `indexLatestPushes`
      (reusing the file's existing exported `scheduledKickoffMs`), placed near the other helpers. Then add the route handler
      inside `fetch`, matching `url.pathname === "/api/round-summary"` placed immediately AFTER the `/api/push-log` block
      (l.~1800) and BEFORE the `^\/api\/fixtures\/...$` regex. Behaviour per design §1.1–§1.12:
      parse grade ids with the exact `(env.KNOWN_GRADE_IDS ?? DEFAULT_GRADE_IDS.join(",")).split(",").map(trim).filter(Boolean).filter(UUID_RE.test)`;
      read `PUSH_LOG` KV ONCE (`env.PUSH_LOG?.get(PUSH_LOG_KEY)`, JSON.parse, `[]` on failure with one `console.log`) and build
      the `indexLatestPushes` map once; board edge-cache read-through on key `new Request("https://playhq-cache/round-summary")`
      (HIT→return stored text with `X-Cache:HIT`+cors, zero KV reads); on MISS assemble via `mapPool(gradeIds, 6, perGrade)`
      where `perGrade` does cache-read of `grade-games/{id}` → on miss `fetchGradeGames` → on miss ALSO write the shared cache
      reproducing the `/api/grades/:id/games` expressions byte-for-byte (`ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ?? "90") || 90)`,
      `listTtl = Math.min(ttl,60) || 60`, body `{ gradeId, count: data.length, data }`, `Cache-Control: public, max-age=${listTtl}`,
      `ctx.waitUntil`) → `selectLatestRound` → build fixtures for all games whose `round.name` equals the selected round
      (id=full UUID, match=`${stripGradeName(home.name)} vs ${stripGradeName(away.name)}` via `competitors.find(isHomeTeam===true/false)`,
      scheduled=`date?`\``${date}T${time||"00:00:00"}`\``:null`, status=`displayStatus(game.status)`, join each fixture by id into
      the push index for `score/ok/ttId/lastPushTs` else all null, NO `venue` key), sort fixtures by `scheduled` asc (nulls last)
      then `match`. Per-grade try/catch: `UpstreamError`→push `{gradeId, error: err.message}`; other→`{gradeId, error:"fetch_failed"}`;
      `continue`. Collect fulfilled results into `rounds`, sort by `competition` then `compareRounds`. Wrap whole assembly so any
      unexpected throw still returns `200 { generatedAt, rounds: [], errors:[{gradeId:"*",error}] }`. Write board cache with 45s TTL
      on the miss path (`ctx.waitUntil`), return via `json(body, 200, cors)` with `X-Cache:MISS`. CORS on every path via the shared
      `cors`. The endpoint never emits 5xx.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\playhq-worker\src\index.ts`
      Verify: `cd c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\playhq-worker; npm run typecheck` (tsc --noEmit) passes,
      then `npx wrangler deploy --dry-run` succeeds (bundles, no deploy). Depends on item 1 for the reference behaviour.

- [ ] 4. Add the `getRoundSummary` fetcher + response types to the frontend API module.
      In `lib/api/playhq.ts` add the exported types `RoundSummaryFixture`, `RoundSummaryDivision`, `RoundSummary` exactly per
      design §2.1 (`RoundSummaryFixture.status: GameStatus`; `roundNum: number|null`; no `venue`) and the async
      `getRoundSummary(signal?: AbortSignal): Promise<RoundSummary>` mirroring `getPushLog`: `fetch(`${WORKER_BASE}/api/round-summary`,
      { cache: "no-store", signal })`, throw on `!res.ok`, then defensively coerce (`generatedAt ?? ""`, `Array.isArray(rounds)?…:[]`,
      `Array.isArray(errors)?…:[]`).
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\lib\api\playhq.ts`
      Verify: `cd c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui; npx tsc --noEmit` — no new type errors.

- [ ] 5. Render the summary board ABOVE the existing log in the Push Activity page.
      In `app/push-log/page.tsx`: import `getRoundSummary` + the `RoundSummary` type and `statusChip` from
      `@/lib/round-summary/roundSummary`; add `const [summary, setSummary] = useState<RoundSummary | null>(null)`; inside the
      existing `load` callback run the push-log fetch and `getRoundSummary(ctrl.signal)` together with `Promise.allSettled` so one
      failure never blanks the other, and on summary success `setSummary(...)`, on rejection leave the previous board (null on first
      load). Reuse the SAME `POLL_MS`/`live`/`abortRef` — NO new poll loop; leave the log table, filters, sort, `shortRound`/`roundNum`,
      error banner, and layout BYTE-UNCHANGED. Insert a `<section>` between the filters block and the `{/* Body */}` log block:
      a "Round summary" heading + muted caption; for each `division` in `summary.rounds` (already sorted by the Worker) a bordered
      card (`border-white/10 bg-white/5`) with a header row `competition · roundShort`, then a compact table one row per fixture:
      `shortMatch(f.match)` | `statusChip(f.status)` chip | score (`font-mono text-sky-300` when `f.lastPushTs` non-null; muted italic
      `not pushed yet` when null; red tint + warning glyph when `ok === false`) | `clock(f.lastPushTs)` or `—`. Empty states:
      `summary === null`→render nothing; `summary.rounds` empty→single muted line "No divisions to summarise yet."; summary never
      shows the red error banner. Add the footnote: latest score still held in the push log (last 100 pushes); a fixture that scrolled
      out reads "not pushed yet". Reuse the existing palette/classes; no new deps; do NOT reintroduce any push-log-derived summary.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\app\push-log\page.tsx`
      Verify: `cd c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui; npx tsc --noEmit` — no new type errors.
      Depends on items 1 and 4.

- [ ] 6. Full frontend verification pass.
      Files: none (verification only).
      Verify, in `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui`:
      (a) `npx tsc --noEmit` — clean;
      (b) `npm run build` — Next.js 16 `next build` completes with no type errors (reads `node_modules/next/dist/docs/` first if any
      Next.js API/config error surfaces, per AGENTS.md);
      (c) `npx vitest --run` — the new `lib/round-summary/roundSummary.test.ts` passes and all pre-existing suites
      (`lib/comparison/*`, `lib/api/cache.test.ts`, `lib/pwa/*`) still pass.
      JUNCTION FALLBACK: if (b) hits the Turbopack "Symlink node_modules points out of filesystem root" artifact or (c) hits
      vitest "No test suite found", re-run that specific command against the MAIN tree
      `c:\Users\AndyDin\reporting-dashboard\reporting-ui` after copying the new/edited files
      (`lib/round-summary/roundSummary.ts`, `lib/round-summary/roundSummary.test.ts`, `lib/api/playhq.ts`,
      `app/push-log/page.tsx`) there; record which tree each command ran against; remove any temporary copies afterward; never
      touch the main tree's port-3000 dev server and never delete through the junction. `npx tsc --noEmit` in the worktree remains
      the authoritative type check. Depends on items 1–5.

- [ ] 7. Full worker verification pass.
      Files: none (verification only).
      Verify, in `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\playhq-worker`:
      `npm run typecheck` (tsc --noEmit) passes, then `npx wrangler deploy --dry-run` succeeds (bundle only, no deploy).
      The worker has its own real `node_modules` (no junction), so no fallback is needed here. Confirm the inline worker helper
      copies remain behaviourally identical to `lib/round-summary/roundSummary.ts` (the tested reference). Depends on item 3.

## Notes / assumptions

- The worker keeps inline copies of the pure helpers because the task forbids adding a test runner to the worker; the
  frontend `roundSummary.ts` + `.test.ts` pins the behaviour and is the reviewer's reference for the inline copies.
- `scheduledKickoffMs` is re-implemented locally in `roundSummary.ts` (the worker's export is not importable from the Next
  app); both use the fixed Darwin `+09:30` offset per design §1.7, a known bounded limitation for the current NT-region grades.
- Do NOT commit/push/deploy; no new dependencies; `wrangler.toml` unchanged (edge cache uses `caches.default` only).
