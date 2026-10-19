# Per-player category-volume tally below the Golden Player Accuracy cards

Adds a new section to the football accuracy-compare page that reconciles, per player and per FOOTBALL category group (Passing / Offensive / Defensive / Goalkeeper / Other), how many events the analyst coded against how many the master coded — one number per side, independent of which exact sub-stat was coded and independent of event-level matching. The work lands as a new pure module `lib/comparison/player-category-tally.ts` (plus a unit test) and a rendered table in `app/accuracy-compare/page.tsx` directly under the exact-match Golden cards. The metric mirrors the Golden module's absolute-difference philosophy applied at the category-volume level, and classification is reused wholesale from `player-accuracy.ts` so the two sections can never drift on which stat belongs to which category.

Watch for: nothing blocking. The highest-risk property (scope agreement with the Golden cards) is satisfied — both memos filter the same `canonical.*` arrays with a byte-identical `inScope` predicate and share the same dependency array (confirmed). The metric, player keying, category composition, union/drop behaviour and heading distinction all hold.

**Verdict**: APPROVED

## High-level view

The new section is computed by a `useMemo` (`playerCategoryTally`) that sits beside the Golden `playerAccuracy` memo and filters `canonical.master` / `canonical.analyst` with the exact same `inScope = inRange(i) && (teamFilter === "all" || i.team === teamFilter)` predicate, over the same dependency array. The two sections therefore see the same instance set under every team filter and time range. The one deliberate structural difference is that the volume section skips `compareInstances` — it needs no event pairing — and hands the scoped instances straight to the pure aggregator.

The metric `categoryAccuracy(a, m)` returns `(m − |a − m|)/m` clamped to `[0,1]`, and `null` when `m === 0`. Null renders as `—`, never 100%. The required examples hold: 6/6→1, 4/6→2/3 (67%), 0/3→0, 0/0→null, with over-counts floored (9/6→0.5, 20/6→0).

Category totals come from summing each `FOOTBALL_GROUPS[key].parts[].key` out of `deriveFootball()`, so Defensive is tackles+interceptions+clearances+blocks exactly as the Golden module defines it. Classification (`bumpFootball`), derivation (`deriveFootball`), the zeroed counts (`initFootballCounts`) and the group definitions are imported, not re-implemented.

Rows are the union of players across both sides, keyed `team.toLowerCase()|number ?? "?"`, displayed and sorted byte-for-byte like the existing Player stats table (analystOnly-last → team localeCompare → number ?? 999). The single divergence from a pure union is a deterministic drop rule: a row is dropped only when all five displayed categories total 0 on both sides, which suppresses all-`—` walls while keeping any player with displayable volume on either side.

`player-accuracy.ts` and `xml-compare.ts` are import-only; the Golden computation, comparison engine and DB are untouched. Only `page.tsx` and the two new module files are production changes.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. All review focus points verified as correct.

</details>

<details>
<summary>Details</summary>

### Scope agreement with the Golden cards

This is the property the task flagged as highest risk, and it holds. The Golden memo (page.tsx ~2103) and the new memo (~2123) each define, inline, the identical predicate:

```ts
const inScope = (i: Instance) =>
  inRange(i) && (teamFilter === "all" || i.team === teamFilter);
```

Both read `canonical.master` / `canonical.analyst` and both carry the same dependency array `[canonical, sport, tolerance, effectiveRange, teamFilter]` behind the same `react-hooks/exhaustive-deps` disable. `inRange` closes over `effectiveRange`, so a change to the time range or the team toggle re-derives both memos from the same filtered arrays. There is no second instance source, no `result.rows` detour, no extra canonicalisation — the new section consumes exactly what the Golden cards consume. The only intentional difference is that it does not call `compareInstances`; volume reconciliation does not pair events, so pairing would be dead work here. The two sections cannot disagree on which events are in scope.

### The metric rule

`categoryAccuracy` returns `null` for `m === 0` before any division, so a zero-master category is "no data" (`—`), not a vacuous 100%. Otherwise it computes `(m − |a − m|)/m` and clamps with `Math.max(0, Math.min(1, raw))`. The `Math.max(0, …)` floors over-counts (20/6 → raw −2.33 → 0); the `Math.min(1, …)` is unreachable for non-negative counts and is kept only to hold the `[0,1]` contract for arbitrary numeric input. The required examples map directly onto the unit tests (AC1–AC6), which I read: 6/6→1, 4/6→`toBeCloseTo(2/3)`, 0/3→0, 0/0→`null` (asserted strictly), 9/6→0.5, 20/6→0.

The cell renderer (`CategoryTallyCell`) converts this to `cell.pct == null ? "—" : Math.round(pct*100) + "%"`, so 0/0 shows `—` and 4/6 shows `67%`. Whole-number rounding here is a deliberate cosmetic divergence from the Golden cards' precision, which the design explicitly permits.

### Player keying and the per-category totals

`ensure()` keys each player as `` `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}` `` and stores the first-seen team case for display/sort — matching `playerTable` exactly. Null jersey numbers are handled consistently across all three axes: `"?"` in the key, `#?` in the display string, and `number ?? 999` in the sort comparator. Lowercasing the key is safe because the inputs are already `canonicaliseTeams`-normalised upstream; the module correctly does not re-canonicalise a subset (the idempotency-guard bug the design calls out).

Category totals are built by running `bumpFootball` over each lowercased stat label into a fresh `FootballCounts`, deriving with `deriveFootball`, then summing `FOOTBALL_GROUPS[key].parts[].key` via `categoryTotal`. I confirmed against `player-accuracy.ts` that Defensive's parts are tackles + interceptions + clearances + blocks, so AC7 (master coded across four different defensive sub-stats → Defensive master 4) is satisfied by reuse, not by a re-listed key set that could drift. The `?? 0` guard in `categoryTotal` tolerates any part key absent from a derived object.

### Union row set and the drop rule

Players are accumulated from both sides into one map, so the row set is the union automatically; one-sided players appear with the missing side at 0 (and `analystOnly = inAnalyst && !inMaster`). The sole deviation from a strict union is the drop rule: `if (masterSum === 0 && analystSum === 0) continue`, where the sums are over the five displayed categories. This keeps a GK-only or blocks-only player (they feed Goalkeeper / Defensive) and drops a ball-recovery/aerial-only player (maps to no displayed category) — matching AC8a/AC8b. It is deterministic and distinct from `playerTable`'s `relevant()` filter, which the design documents as an intended divergence, not an accidental mismatch.

### Section distinction and gating

The new block is gated on `playerCategoryTally && playerCategoryTally.length > 0`, mirroring the Golden `{playerAccuracy && (…)}` gate, and both are football-only via the `sport !== "football"` early return in the memos. The heading "Player category volume (analyst vs master)" with its sub-caption ("Counts per category, ignoring which exact stat or whether events matched") reads clearly apart from the Golden "Player Accuracy" cards, so a reviewer won't confuse volume reconciliation with exact-match accuracy. The team-totals footer reuses `categoryAccuracy(aTot, mTot)` over the summed column counts, keeping the footer metric consistent with the cells.

### Isolation of untouched code

`git status --short` shows the only production changes are `app/accuracy-compare/page.tsx` and the two new files `lib/comparison/player-category-tally.ts` and `.test.ts`. The remaining modified paths are all under `.agents/tasks/` (design/plan/verification docs), not shipped code. `player-accuracy.ts` and `xml-compare.ts` are imported only — the grep across both trees shows identical exports, and the module adds no mutation of their state. The Golden computation, comparison engine and DB are untouched.

### Test coverage

The unit test exercises the metric (AC1–AC6) and the aggregator (AC7 category summing across sub-stats, AC8 one-sided players, AC8a GK-only and blocks-only kept, AC8b recovery/aerial-only dropped, AC9 sort order, empty inputs → `[]`). It uses a minimal `Instance` factory and `// @vitest-environment node`, correct for a pure-logic test with no DOM.

Not tested: the `page.tsx` wiring itself — the `inScope` equality between the two memos, the gating, and the footer totals are verified by reading, not by a test. That is consistent with the rest of this page (no component tests exist here) and the scope-agreement property is structural (same predicate, same deps) rather than data-dependent, so a test would add little. No action required.

### Verification evidence

verification.md records tsc `--noEmit` clean in the worktree (the authoritative type-check, since the edited files live only there), vitest `13 passed` and `npm run build` success — both run in the main tree after the documented worktree-junction collection/build failures (Turbopack symlink panic), with the main tree restored and confirmed clean afterward. The junction artifacts are a known environment limitation, not a defect in this change. Evidence is present and specific; per the task I did not re-run the suites.

</details>

<details>
<summary>File map</summary>

- `lib/comparison/player-category-tally.ts` — new pure module: `categoryAccuracy` metric + `computePlayerCategoryTally` aggregator, reusing `player-accuracy.ts` classification.
- `lib/comparison/player-category-tally.test.ts` — new unit test covering AC1–AC9 and empty inputs (node environment).
- `app/accuracy-compare/page.tsx` — new `playerCategoryTally` memo (same scope as Golden), `CategoryTallyCell` component, and the rendered volume table under the Golden cards.
- `.agents/tasks/*` — design/plan/verification doc updates (process artifacts, not shipped code).

Full diff: `git -C .worktrees/player-category-tally/reporting-ui diff` (base `main`).

</details>
