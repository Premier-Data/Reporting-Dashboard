# Implementation Plan — AFL shallow/deep depth variants count as EXACT

## Goal

In the Accuracy Comparison timeline/matcher (`compareInstances`), when the MASTER coded the shallow variant of an AFL stat and the ANALYST coded the deep variant (or vice versa) at the same player/team/time, that pairing must score **exact**, not wrong_stat/missed/extra. Scope is AFL only, and all three depth pairs, each collapsing within its OWN base stat:

- `Marks i50 - Shallow` ↔ `Marks i50 - Deep`
- `Rebound 50s - Shallow` ↔ `Rebound 50s - Deep`
- `Shallow I50` ↔ `Deep I50`

Everything else (player, team, time tolerance) must still be required for exact.

---

## Findings from exploration (evidence, read before implementing)

**File under change:** `reporting-ui/lib/comparison/xml-compare.ts`.

### How "exact" is decided (traced)

- `fieldsOk(m, a)` (~line 1095) sets `statOk = sameBaseAction(m.stat, a.stat)` (~line 1101) and `categoryOk = sameStatGroup(m.stat, a.stat)` (~line 1128).
- `quality(m, a)` (~line 1157): the FIRST tier is `if (statOk && playerOk && teamOk) return 8;`. **`categoryOk`/`sameStatGroup` is NOT consulted when `statOk` is true.** `categoryOk` only matters for the lower wrong-stat tiers (6 and 1).
- Candidate pairing (~line 1200): any pair with `quality > 0` and within `tolerance` becomes a candidate; global-greedy picks best-quality first.
- Status assignment (~line 1247): `if (statOk && playerOk && teamOk) status = "exact";`.

**Conclusion (comparability decision, with evidence):** Making `sameBaseAction` return true for an in-base shallow↔deep pair is sufficient on its own. Once `statOk` is true, `quality` returns 8 (given same player + team) and the status becomes `exact` — the pair is selected as a candidate (q=8 beats everything) and never falls out to missed/extra. **No change to `STAT_PREFERENCES` / `sameStatGroup` is required**, because the exact path short-circuits on `statOk` before `categoryOk` is ever read. This matches the task's "rely on base-equality short-circuiting if it does" option. `STAT_PREFERENCES` must therefore be left untouched to avoid introducing new unintended wrong-stat pairings. (Verified by tests in step 4; flagged as the one behavioural assumption to confirm.)

### `baseAction` / `sameBaseAction` today (~lines 548–579)

`baseAction` lowercases via `normStat`, strips outcome words (`successful|unsuccesful|successful|effective|ineffective`), canonicalises `catches→catch`, collapses whitespace. `sameBaseAction` returns true if `normStat(a) === normStat(b)` OR non-empty `baseAction(a) === baseAction(b)`.

Note: the existing outcome strip includes `effective|ineffective`. The depth labels (`Marks i50 - Shallow`, `Rebound 50s - Shallow/Deep`, `Shallow I50`, `Deep I50`) contain none of those outcome words, so existing normalisation leaves them intact apart from lowercasing/whitespace — our new rules operate on that normalised string.

### AFL classifier precedence (mirror this ordering) — `lib/comparison/afl-player-accuracy.ts` `bumpAfl`

The existing AFL Golden classifier already keeps the three bases distinct with this precedence:
- `marks i50` + `shallow` → shallowI50Mark; `marks i50` + `deep` → deepI50Mark (matched BEFORE bare i50).
- `shallow i50` → shallowI50; `deep i50` → deepI50 (plain Scoring inside-50).
- `rebound 50s` + `shallow` → shallowRebound; `rebound 50s` + `deep` → deepRebound.

Our `baseAction` rules must follow the SAME order/guards so the three bases stay mutually distinct and never collapse into each other. Because `buildGroup`/AFL Golden accuracy keys off the `exact` status produced by `compareInstances`, fixing `sameBaseAction` automatically flows through to the stat/category breakdowns and AFL Golden accuracy with no further change.

### Football non-regression (confirmed)

`bumpFootball` (`lib/comparison/player-accuracy.ts`, ~line 73) classifies only: saves, blocked shot, catch, claim, punch, goal kick, keeper throws, goal, shot, short/long/through passes, crosses, touch, carry, tackle, dribble, intercept, clearance, block, ball recover, ground duels, aerial, header, fouls, throw, card, offside. **No football label contains `i50`, `inside 50`, `rebound 50s`, or a standalone `shallow`/`deep`.** Grep of `xml-compare.ts` for `i50|rebound 50|shallow|deep` returned only the AFL keyword `"i50"` in `AFL_KEYWORDS` (sport detection), not a football stat. Therefore the new `baseAction` rules cannot match any football label and cannot regress football scoring. (The rules are also guarded by the specific phrases `marks i50` / `rebound 50s` / word-boundary `i50`, further preventing accidental matches.)

### Build / test facts

- `package.json` scripts: `"test": "vitest --run"`; vitest `^3.2.7` is a dependency. Run one file with `npx vitest run <path>`.
- The change is pure TypeScript with no Next.js API surface. AGENTS.md requires reading the relevant guide under `node_modules/next/dist/docs/` before touching any Next API — none is touched here, so no Next guide applies, but the rule is noted and honoured.
- No new dependencies. No React/DOM.

### Test homes

- `lib/comparison/cross-exact.test.ts` — exercises the real `compareInstances` on synthetic `Instance`s (helper `inst(id, start, stat, team, playerNumber)`), asserting `rows[0].status`. Ideal home for the new exact/non-regression pairing tests. Its helper hard-codes `category: "Passing"`; category does not affect `sameBaseAction`/exact status, so it is fine to reuse as-is for AFL stat strings.
- `lib/comparison/afl-player-accuracy.test.ts` — player-accuracy classification tests (reads `r.master.stat`, `r.status`). Relevant for confirming the three bases stay distinct at the classifier level if we add a direct `sameBaseAction`/`baseAction` assertion; primary coverage lives in `cross-exact.test.ts`.

---

## Plan

- [ ] 1. Add the three AFL depth-collapse rules to `baseAction` in `reporting-ui/lib/comparison/xml-compare.ts`, applied AFTER the existing outcome-strip/`catches` normalisation, with marks & rebound handled FIRST and the plain-i50 case guarded to exclude mark/marks/rebound.
      Compute the normalised string first (as today), then, before `return`, map it: (a) if it contains `marks i50` AND (`shallow` OR `deep`) → base `marks i50`; (b) else if it contains `rebound 50s` AND (`shallow` OR `deep`) → base `rebound 50s`; (c) else if it contains `i50` AND (`shallow` OR `deep`) AND NOT (`mark` / `marks`) AND NOT `rebound` → base `scoring i50` (distinct sentinel so plain Scoring I50 never collides with the two mark/rebound bases). The three returned bases (`marks i50`, `rebound 50s`, `scoring i50`) MUST be mutually distinct strings. Keep the change minimal and contained to `baseAction`; do NOT touch `STAT_PREFERENCES`, `sameStatGroup`, `quality`, the exact branch, or team/player/time logic (per the comparability finding above).
      Files: `reporting-ui/lib/comparison/xml-compare.ts`
      Verify: `npx vitest run lib/comparison/cross-exact.test.ts` (run from `reporting-ui/`) passes after step 2–3 tests are added; existing cases in that file still pass.

- [ ] 2. Add positive exact-match tests for all three depth pairs (both directions) to `reporting-ui/lib/comparison/cross-exact.test.ts`, using the existing `inst(...)` helper and `compareInstances(master, analyst, 3, "Home vs Away")` at the same player + team + time.
      Cases (assert `rows[0].status === "exact"` each, and the reverse master/analyst swap for each pair): `Marks i50 - Shallow` ↔ `Marks i50 - Deep`; `Rebound 50s - Shallow` ↔ `Rebound 50s - Deep`; `Shallow I50` ↔ `Deep I50`.
      Files: `reporting-ui/lib/comparison/cross-exact.test.ts`
      Verify: `npx vitest run lib/comparison/cross-exact.test.ts` — all new positive cases pass.

- [ ] 3. Add cross-base NON-collapse (negative) tests to the same file, proving a shallow/deep variant is NEVER exact against a DIFFERENT base, and that same-time/same-player is still required.
      Cases: `Marks i50 - Shallow` vs `Rebound 50s - Deep` → NOT `exact`; `Marks i50 - Shallow` vs `Deep I50` → NOT `exact`; `Rebound 50s - Shallow` vs `Deep I50` → NOT `exact`. Also one football non-regression case already covered by existing short-vs-long pass test; optionally add a football pair with no i50/rebound/shallow/deep to confirm no accidental collapse. Keep assertions on `rows[0].status`.
      Files: `reporting-ui/lib/comparison/cross-exact.test.ts`
      Verify: `npx vitest run lib/comparison/cross-exact.test.ts` — negative cases assert `.not.toBe("exact")` and pass.

- [ ] 4. Run the full comparison test suite and typecheck to confirm no regression across the exact-classification-dependent code (stat/category breakdowns, AFL/football Golden accuracy, player-category tally).
      Files: none (verification only).
      Verify: from `reporting-ui/` run `npx vitest run lib/comparison` — all tests pass (including `afl-player-accuracy.test.ts`, `check-category.test.ts`, `player-category-tally.test.ts`, `cross-exact.test.ts`). Then run `npx vitest --run` for the whole suite. If a typecheck is wired, run `npx tsc --noEmit`; otherwise rely on vitest's esbuild compile of the touched module.

---

## Needs verification during implementation

- The comparability conclusion ("`statOk` short-circuits to quality 8 before `categoryOk` is read, so no `STAT_PREFERENCES` change is needed") is derived from reading `quality`/`fieldsOk`. Step 2's positive tests are the authoritative confirmation. If any positive pair comes back as `missed`/`extra`/`wrong_stat` instead of `exact`, the root cause is candidate eligibility — in that case ALSO add the three depth pairs to `STAT_PREFERENCES` (each variant listing its sibling) so `categoryOk` is satisfied, re-run, and keep the `baseAction` change. Do not change the exact-branch logic itself.
- Confirm the real master/analyst label spellings in production data match the phrases guarded here (`Marks i50 - Shallow/Deep`, `Rebound 50s - Shallow/Deep`, `Shallow I50`/`Deep I50`). The guards use substring checks on the normalised (lowercased) label, matching the existing `bumpAfl` approach, so minor spacing/casing differences are tolerated; genuinely different wording would need the guard phrases widened.

---

## Verification note (implementation run)

**Iteration:** FIRST (no `afl-depth-exact-review.json` present).

**Change made (minimal, inside `baseAction` only):** after the existing outcome-strip / `catches` normalisation in `baseAction` (`lib/comparison/xml-compare.ts`), added AFL depth-collapse rules guarded by `shallow`/`deep`:
- `marks i50` → base `marks i50`
- `rebound 50s` → base `rebound 50s`
- plain inside-50 (`i50`, NOT mark/marks, NOT rebound) → sentinel `scoring i50`

Rules fire in that order (marks & rebound first); the three returned bases are mutually distinct, so cross-pair comparisons stay non-exact. `STAT_PREFERENCES`/`sameStatGroup`/`quality`/exact-branch/team-player-time logic were NOT touched. The comparability assumption from the plan held: `statOk` short-circuits `quality` to 8, so no `STAT_PREFERENCES` change was needed (confirmed by the positive tests all returning `exact`).

**Tests added** to `lib/comparison/cross-exact.test.ts`: both-direction exact for all three pairs; cross-pair non-exact (marks↔rebound, marks↔i50, rebound↔i50); football regression (short vs long still non-exact, short success↔unsuccess still exact).

**Commands run (from `reporting-ui/`) and results:**
- `npx vitest run lib/comparison/cross-exact.test.ts` → **12 passed** (5 new AFL cases included).
- `npx vitest run lib/comparison` → **7 files, 69 passed**.
- `npx vitest --run` (full suite) → **13 files, 165 passed**.
- `npx tsc --noEmit` → **clean (exit 0)**.
- `npm run build` → **succeeded** (all routes prerendered; no dev server started).

Build required `.env`/`.env.local`; these were copied from the sibling main checkout `reporting-ui/` FOR THE BUILD ONLY and DELETED afterwards. No env files committed. `npm install` was run in the worktree (no node_modules initially). No new dependencies added. Pure-TS change, no Next.js API surface (AGENTS.md Next-guide rule noted; nothing to read since no Next API touched).
