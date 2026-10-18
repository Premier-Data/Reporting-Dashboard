# Verification note — Round-Summary board

Commit-free record of what was verified, in which tree, and the result. All work
was done in the ISOLATED worktree
`c:\Users\AndyDin\reporting-dashboard\.worktrees\round-summary`. The main tree
was touched only as a verification fallback for the two known junction artifacts,
and was restored byte-for-byte afterward (confirmed `git status --short` clean).

## Iteration status

First iteration (implemented from scratch per `plan.md` / `design.md`). The
`review.json` present in `.agents/tasks/` has `verdict: APPROVED` but its
`reviewDoc` points at a different worktree (`req-reduction`) and its findings
describe facet caches / comp-sync — an unrelated feature. It is a stale/mismatched
artifact (the design.md's own "prior stale artifacts" note documents this class of
leftover), not a review of the round-summary work, so there were no round-summary
findings to fix. Implemented the plan as the first pass.

## Commands run, tree, result

| # | Command | Tree | Result |
|---|---------|------|--------|
| 1 | `npm run typecheck` (tsc --noEmit) | worktree `playhq-worker` | exit 0 ✓ |
| 2 | `npx wrangler deploy --dry-run` | worktree `playhq-worker` | exit 0 ✓ (bundle 59.41 KiB, no deploy; only an out-of-date-wrangler warning) |
| 3 | `npx tsc --noEmit` | worktree `reporting-ui` | exit 0 ✓ (authoritative type check) |
| 4 | `npx vitest --run lib/round-summary` | worktree `reporting-ui` | FAILED — junction artifact "No test suite found" (NOT a real failure) |
| 5 | `npx vitest --run lib/round-summary` | MAIN `reporting-ui` (helper+test copied in, then removed) | 29 passed ✓ |
| 6 | `npx vitest --run` (full suite) | MAIN `reporting-ui` | 121 passed, 10 files ✓ (no regressions; includes the new suite) |
| 7 | `npm run build` (next build, Turbopack) | worktree `reporting-ui` | FAILED — junction artifact "Symlink node_modules points out of filesystem root" (NOT a real failure) |
| 8 | `npm run build` | MAIN `reporting-ui` (4 edited files copied in, then restored) | exit 0 ✓ (all routes incl. `/push-log` compiled) |

`wrangler deploy` was NOT run (dry-run only). `GET /api/round-summary` was NOT
hit against the deployed worker (route not deployed yet); the handler was reasoned
against the live `/api/push-log` ({count, entries}) and `/api/grades/:id/games`
({gradeId, count, data}) shapes, which it reuses byte-for-byte.

### Junction-artifact fallback detail

The worktree's `node_modules` is a junction to the main tree's `node_modules`.
Both #4 and #7 failed with the two documented false failures. Fallback per plan:
copied `lib/round-summary/roundSummary.ts` + `roundSummary.test.ts` into the main
tree for #5/#6, and the 4 edited files (`lib/api/playhq.ts`, `app/push-log/page.tsx`,
plus the round-summary module/test) for #8. All copies were removed and the two
pre-existing main-tree files restored from backup afterward; `git status --short`
on the main tree under `reporting-ui/lib` and `reporting-ui/app/push-log` is empty.
The port-3000 dev server was never touched, and nothing was deleted through the
junction.

One test initially failed in the main tree (#5 first run): the "morning of a new
round → tier B" case had a prior dated round (`Round 2`, past) that correctly made
tier A fire. That was a TEST-DATA bug, not an implementation bug — tier B only
applies when NO round has started. The test was corrected to a genuine tier-B
scenario (no earlier started round) and all 29 then passed.

## Final latest-round rule (as implemented)

Group games by round name. Per round compute `roundNum = roundNumOf(name)`
(`number | null`), `hasNum`, and `earliestKickoff` = min of its fixtures'
`scheduledKickoffMs` (null if the round has no dated fixture). With
`now = Date.now()` and `LOOKAHEAD_MS = 6h`, select the first tier that yields a
round:

- **Tier A — started:** among rounds with `earliestKickoff != null && <= now`,
  pick the HIGHEST by `compareRounds`.
- **Tier B — imminent:** else, among rounds with `earliestKickoff <= now + 6h`,
  pick the HIGHEST.
- **Tier C — first upcoming:** else, pick the SMALLEST round that has any dated
  fixture.
- **Undated fallback:** if every round is date-less, pick the HIGHEST round by
  `compareRounds`.

`compareRounds`: numbered rounds order BEFORE unnumbered; two numbered by
`roundNum`; two unnumbered by name (locale compare) — never compares `null` as a
number. Tiers A and B are separate so a split weekend (round N started, N+1 within
6h but not started) selects N, not N+1.

Darwin single-offset caveat: `scheduledKickoffMs` hardcodes `+09:30` (NTFL /
Australia-Darwin, no DST). The selection inherits it; acceptable for the current
NT-region grades, and a future non-Darwin grade is a localised fix inside
`scheduledKickoffMs`. Byte-identical offset in the Worker inline copy and the
frontend reference module.

## 100-entry-cap caveat

`PUSH_LOG` is a ring buffer capped at `PUSH_LOG_MAX = 100` (newest-first). In peak
season one round across 40 grades × 4–6 fixtures is 160–240 pushes, and each
fixture is re-pushed every live cycle, so the 100 newest entries can cover LESS
than a full round. Consequence: a fixture pushed earlier whose entries have all
aged out shows `lastPushTs = null` → the board renders "not pushed yet" even
though it was pushed. This is a known, accepted limitation — the board reflects
"latest score the log still remembers", not an authoritative "ever pushed" ledger.
The frontend copy ("not pushed yet") and the section footnote surface this. The
single lever to remove it (raise `PUSH_LOG_MAX` or per-fixture KV keys) is out of
scope here (it changes the push-log storage contract + the `/api/push-log` reader).
