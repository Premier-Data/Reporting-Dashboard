# Verification — Player Category Volume (analyst vs master)

Feature: per-player, per-category VOLUME tally below the Golden Player Accuracy
cards on `app/accuracy-compare/page.tsx`, backed by a new pure module
`lib/comparison/player-category-tally.ts` (+ unit test).

Iteration: FIRST. The `.agents/tasks/review.json` and `code-review.json`
on disk are STALE leftovers from OTHER features sharing this `.agents/tasks`
dir — `review.json`'s `reviewDoc` points at the `round-summary` worktree and its
findings are about push-log caps / Darwin offsets; `code-review.json`'s
`reviewDoc` points at the MAIN tree. Neither reviews player-category-tally, and
the feature's module did not yet exist. So this was implemented from scratch
against `design.md` + `plan.md`.

AGENTS.md Next.js-docs rule: N/A here. `page.tsx` is already a client component
(`"use client"`); the feature is pure client React (a `useMemo` + a local cell
component + a JSX table) plus a pure compute module. The only Next.js imports on
the page (`next/navigation`, `next/link`) are pre-existing and unchanged — no
new Next.js API surface is introduced, so there was nothing new to read docs for.

## Files changed (worktree), confirmed via `git -C … status --short`

```
 M app/accuracy-compare/page.tsx
?? lib/comparison/player-category-tally.test.ts
?? lib/comparison/player-category-tally.ts
```

Only the three intended files. `player-accuracy.ts` and `xml-compare.ts` are
import-only (no behaviour change).

## Scope agreement with the Golden cards (reasoned)

The new `playerCategoryTally` useMemo is built from the SAME source and the
IDENTICAL `inScope` predicate as the Golden `playerAccuracy` useMemo:

```ts
const inScope = (i: Instance) =>
  inRange(i) && (teamFilter === "all" || i.team === teamFilter);
computePlayerCategoryTally(
  canonical.master.filter(inScope),
  canonical.analyst.filter(inScope),
);
```

Both memos read from `canonical.master` / `canonical.analyst`, share the same
dependency array `[canonical, sport, tolerance, effectiveRange, teamFilter]`
(with the same `react-hooks/exhaustive-deps` disable the Golden memo uses), and
apply the same `inRange` + `teamFilter` filter. The only intentional structural
difference: the new section does NOT run `compareInstances` (volume
reconciliation needs no event pairing) — it hands the scoped instances straight
to the pure aggregator. Because both sections filter the same canonical arrays
with the same predicate, they cannot disagree on which events are in scope when
the active team filter (both/home/away) or the time range
(overlap/custom/full, via `effectiveRange`) changes.

## Commands — what ran, in which tree, and why

1. `npx tsc --noEmit`
   - TREE: WORKTREE (`c:\Users\AndyDin\reporting-dashboard\.worktrees\player-category-tally\reporting-ui`).
   - RESULT: clean, exit 0. This is the authoritative type-check of the edited
     `page.tsx` and the new module, since those files live only in the worktree.

2. `npx vitest --run lib/comparison/player-category-tally.test.ts`
   - First attempt TREE: WORKTREE — FAILED with "No test suite found in file …"
     (the documented worktree-junction collection failure). Confirmed it was the
     junction, not jsdom: adding `// @vitest-environment node` cut the run to
     ~2.5s (environment 1ms) but collection still failed the same way over the
     junction.
   - Resolution TREE: MAIN (`c:\Users\AndyDin\reporting-dashboard\reporting-ui`),
     per the task's guidance. The new module + test were COPIED into the main
     tree's `lib/comparison/`, run, then DELETED. The main tree already has
     matching `player-accuracy.ts` / `xml-compare.ts` exports (verified before
     copying), so the pure-logic test is valid there.
   - RESULT (main tree): `1 passed (1)`, `13 passed (13)`, exit 0. Covers the
     metric rule (AC1 6/6=100%, AC2 4/6≈67%, AC3 0/3=0%, AC4 0/0=null strict,
     AC5 9/6=50%, AC6 20/6 floored to 0) and the per-player category tally
     (AC7 Defensive = tackle+interception+clearance+block regardless of sub-stat
     split; AC8 one-side-only players appear; AC8a GK-only / blocks-only KEPT;
     AC8b ball-recovery/aerial-only DROPPED; AC9 analystOnly-last → team →
     number sort; empty inputs ⇒ []).
   - The two temporary copies were removed afterward; `git status` in the main
     tree shows no modified tracked files.
   - NOTE: the test file carries `// @vitest-environment node` (committed with
     the feature). It is a pure-logic test needing no DOM, so the node
     environment is the correct, meaningful choice and also sidesteps the slow
     jsdom setup over the junction.

3. `npm run build`
   - First attempt TREE: WORKTREE — FAILED with the documented Turbopack panic
     `TurbopackInternalError: Symlink [project]/node_modules is invalid, it
     points out of the filesystem root` (the worktree-junction build failure).
   - Resolution TREE: MAIN, per the task's guidance. The edited `page.tsx` and
     the new module were staged into the main tree (main's original `page.tsx`
     backed up to `page.tsx.bak` first), built, then the main tree was restored
     byte-for-byte (`page.tsx.bak` moved back over `page.tsx`, the new module
     deleted).
   - RESULT (main tree): build succeeded, exit 0. TypeScript finished in ~14.6s,
     all 37 routes generated including `/accuracy-compare`. Main tree confirmed
     clean afterward via `git status --short` (no modified tracked files).

## Cleanup

- Temporary main-tree copies of the module + test removed.
- Main-tree `page.tsx` restored from backup; backup file removed.
- No scratch files left in the worktree (only the three intended changes).

---

# Verification — AFL Golden Player Accuracy cards

Feature: AFL Golden Player Accuracy category cards (Overall + Scoring / Defence
/ Possession / Disposals / Other) on `app/accuracy-compare/page.tsx`, backed by
a new pure module `lib/comparison/afl-player-accuracy.ts` (+ unit test), reusing
the shared exact-match engine via a generalized `buildGroup`.

Iteration: FIRST. The `.agents/tasks/review.json` on disk is a STALE leftover
from ANOTHER feature — its verdict is `APPROVED` with zero findings and its
`reviewDoc` points at the `player-category-tally` worktree. No `afl-review.md`
exists and the AFL module did not yet exist. So this was implemented from
scratch against `plan.md`.

AGENTS.md Next.js-docs rule: N/A for new API surface. `page.tsx` is already a
client component (`"use client"`); the change is a pure `useMemo` + one JSX
render branch reusing the existing `PlayerAccuracyCard`. No new Next.js API is
introduced.

## Files changed (worktree)

```
 M app/accuracy-compare/page.tsx
 M lib/comparison/player-accuracy.ts        (buildGroup generalized; football default preserved)
?? lib/comparison/afl-player-accuracy.ts
?? lib/comparison/afl-player-accuracy.test.ts
```

## buildGroup generalization (football unchanged)

`buildGroup(group, rows, opts?)` now accepts an optional `BuildGroupOpts`
`{ classify?, loosePassPartKeys?, isPassStat? }`. Defaults reproduce football
exactly: `classify = footballClassifier` (the former private `statDerivedKeys`,
now exported), `loosePassPartKeys = LOOSE_PASS_PART_KEYS`, `isPassStat =
isPassStat`. `computePlayerAccuracy` / `computePlayerAccuracyByScope` call sites
were NOT changed (still call `buildGroup(group, rows)` with no opts), so
football behavior is byte-for-byte unchanged. AFL passes
`{ classify: aflClassify, loosePassPartKeys: new Set() }` so the football looser
same-player pass rule can never apply to AFL (exact-match only).

Both page memos gate on `sport` (`"football"` vs `"afl"`), so only one Golden
block ever renders; the football memo/render/`PlayerAccuracyCard` are untouched.

## Commands — run directly in the worktree, exit 0

1. `npx vitest --run lib/comparison/afl-player-accuracy.test.ts`
   - RESULT: `1 passed (1)`, `14 passed (14)`, exit 0. Covers group membership
     (9/8/7/11/11), all named collision cases, overall spanning all five groups
     (master = sum of groups' masters), zero-master group → pct null, and
     exact-match counting (non-exact rows, incl. a same-player pass-like row, do
     NOT count — AFL has no loose rule).
2. `npx vitest --run` (full suite)
   - RESULT: `13 passed (13)` test files, `158 passed (158)` tests, exit 0.
     Existing football/player-accuracy/json-adapter tests stay green, proving
     the buildGroup generalization did not regress football.
3. `npx tsc --noEmit` — clean, exit 0.
4. `npm run build` — succeeded, exit 0; all 37 routes generated including
   `/accuracy-compare`. No dev server started.

Unlike the player-category-tally iteration, these ran directly in the worktree
without the junction workarounds (vitest, tsc and build all completed and exited
0 against `.worktrees/afl-golden/reporting-ui`).

## Cleanup

- No scratch files created. `.env` / `.env.local` not staged.
