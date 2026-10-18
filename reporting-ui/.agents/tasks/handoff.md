# Handoff — Round-Summary board (`/api/round-summary` + Push Activity summary table)

Status: implemented, verified, and APPROVED in the ISOLATED worktree
`c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary`. NOT committed,
NOT pushed, NOT merged, NOT deployed. This note is the orchestrator's single
source for relaying state to the user and finishing the release.

## What was built

A Worker endpoint `GET /api/round-summary` assembles a per-division board for the
LATEST round of every known grade — every fixture in that round, each joined to
the latest score the push log still holds — and the Push Activity page renders
that board as a summary table ABOVE the existing raw log (which is byte-unchanged).
The board is sourced from the grade feed (not derived from the push log), so it
lists fixtures that have never been pushed, which is the point the earlier
push-log-only attempt could not satisfy. It scales to peak season (40+ divisions,
4–6 fixtures each) via two cache layers and a concurrency cap.

Files changed:

- `playhq-worker/src/index.ts` — inline pure-helper copies (`roundNumOf`,
  `shortRound`, `displayStatus`, `stripGradeName`, `compareRounds`,
  `selectLatestRound`, `indexLatestPushes`, reusing the file's exported
  `scheduledKickoffMs`) + the `GET /api/round-summary` handler: grade-id parse,
  single `PUSH_LOG` KV read, 45s board edge cache, per-grade fan-out via
  `mapPool(limit=6)` over the shared `grade-games/{id}` ≤60s cache, push-log join,
  and a never-5xx top-level wrapper.
- `reporting-ui/lib/api/playhq.ts` — `RoundSummary*` types + `getRoundSummary`
  fetcher (mirrors `getPushLog`: `cache:"no-store"`, throw on `!res.ok`, defensive
  array coercion).
- `reporting-ui/app/push-log/page.tsx` — summary board section above the unchanged
  log; the summary fetch runs alongside the log fetch under one `Promise.allSettled`
  on the existing poll (no new loop); `statusChip` imported from the reference module.
- `reporting-ui/lib/round-summary/roundSummary.ts` — NEW tested reference pure
  helpers (the behavioural pin for the Worker's inline copies).
- `reporting-ui/lib/round-summary/roundSummary.test.ts` — NEW, 29 tests across
  selection, push-log join, and supporting helpers.

No new dependencies; `wrangler.toml`, `package.json`, and lockfiles unchanged.
Full diff: `git diff main` in the worktree.

## Verification results (and WHICH TREE each ran in)

All work was done in the worktree. The main tree was touched ONLY as a fallback
for the two known junction artifacts, then restored byte-for-byte
(`git status --short` confirmed clean afterward).

| # | Command | Tree | Result |
|---|---------|------|--------|
| 1 | `npm run typecheck` (tsc --noEmit) | WORKTREE `playhq-worker` | exit 0 ✓ |
| 2 | `npx wrangler deploy --dry-run` | WORKTREE `playhq-worker` | exit 0 ✓ (bundle 59.41 KiB, no deploy; only an out-of-date-wrangler warning) |
| 3 | `npx tsc --noEmit` | WORKTREE `reporting-ui` | exit 0 ✓ (authoritative type check) |
| 4 | `npx vitest --run lib/round-summary` | WORKTREE `reporting-ui` | FAILED — junction artifact "No test suite found" (NOT a real failure) |
| 5 | `npx vitest --run lib/round-summary` | MAIN `reporting-ui` (helper+test copied in, then removed) | 29 passed ✓ |
| 6 | `npx vitest --run` (full suite) | MAIN `reporting-ui` | 121 passed, 10 files ✓ (no regressions) |
| 7 | `npm run build` (next build, Turbopack) | WORKTREE `reporting-ui` | FAILED — junction artifact "Symlink node_modules points out of filesystem root" (NOT a real failure) |
| 8 | `npm run build` | MAIN `reporting-ui` (4 edited files copied in, then restored) | exit 0 ✓ (all routes incl. `/push-log` compiled) |

Junction-artifact fallback was hit on #4 and #7: the worktree's `node_modules` is
a junction to the main tree's, which makes vitest and Turbopack report two
documented false failures. The fallback copied the relevant files into the MAIN
tree for #5/#6/#8, ran there, then removed all copies and restored the two
pre-existing main-tree files from backup; the main tree verified clean afterward.
The port-3000 dev server was never touched and nothing was deleted through the
junction. `npx tsc --noEmit` in the worktree (#3) is the authoritative type check.

Not verified (by design): `wrangler deploy` was dry-run only — the route is NOT
deployed, so `GET /api/round-summary` was NOT hit live; the handler was reasoned
against the live `/api/push-log` and `/api/grades/:id/games` response shapes it
reuses byte-for-byte.

## Latest-round selection rule (as implemented)

Group games by round name. Per round compute `roundNum` (`number | null`, first
`\d+` in the name else null), `hasNum`, and `earliestKickoff` = min of its
fixtures' `scheduledKickoffMs` (null if the round has no dated fixture). With
`now = Date.now()` and `LOOKAHEAD_MS = 6h`, pick the first tier that yields a round:

- Tier A — started: among rounds with `earliestKickoff != null && <= now`, pick the HIGHEST by `compareRounds`.
- Tier B — imminent: else, among rounds with `earliestKickoff <= now + 6h`, pick the HIGHEST.
- Tier C — first upcoming: else, pick the SMALLEST round that has any dated fixture.
- Undated fallback: if every round is date-less, pick the HIGHEST round by `compareRounds`.

`compareRounds`: numbered rounds order BEFORE unnumbered; two numbered by `roundNum`;
two unnumbered by locale name compare; it never compares `null` as a number. Tiers A
and B are kept separate so a split weekend (round N started, N+1 within 6h but not
started) selects N, not N+1. The far-future bug is structurally avoided: tier A's
upper bound is `now`, and the only forward-looking tier (C) takes the smallest dated
round, so a full season in the feed on day one resolves to Round 1, not the final.

## CAVEATS to relay to the user

1. Worker deploy is manual, done by the USER. The `/api/round-summary` route is
   bundled and dry-run-verified but NOT deployed. The user must run
   `wrangler deploy` in `playhq-worker` for the endpoint to go live. The Next app
   (`reporting-ui`) ships via its own pipeline, not wrangler — the summary table
   won't show data until the Worker route is deployed.
2. Only KNOWN grades are summarised. The board covers grades in `KNOWN_GRADE_IDS`
   (the same list that drives pushing). Adding divisions means adding their grade
   ids there — new divisions will not appear otherwise.
3. Push-log 100-entry cap. `PUSH_LOG` is a ring buffer capped at 100 entries
   (newest-first). In peak season one round across 40 grades × 4–6 fixtures is
   160–240 pushes, so the 100 newest can cover less than a full round. A fixture
   pushed earlier whose entries have aged out will render "not pushed yet" even
   though it was pushed. This is known and accepted; the UI footnote says the board
   shows the latest score the log still remembers, not an authoritative "ever
   pushed" ledger. Removing it (raise the cap or per-fixture KV) is out of scope —
   it changes the push-log storage contract.

Minor inherited caveat: `scheduledKickoffMs` hardcodes the Darwin `+09:30` offset
(no DST). Bounded and acceptable for the current NT-region grades; a future
non-Darwin grade could skew the tier A/B boundary by hours — fix is localised to
that one helper.

## CLEANUP for the orchestrator

The following still exist and must be merged/handled by the orchestrator (NOT by
this step):

- Branch: `feature/round-summary`
- Worktree: `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary`

Order matters. The two `node_modules` JUNCTIONS below must be REMOVED BEFORE
removing the worktree (removing the worktree while the junctions are in place can
delete through them into the MAIN tree's real `node_modules`):

- `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\playhq-worker\node_modules`
- `c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary\reporting-ui\node_modules`

Remove those two junctions first, then merge `feature/round-summary` and remove the
worktree.
