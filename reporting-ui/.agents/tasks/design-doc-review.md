# Design review — Player Category Volume (analyst vs master)

Reviewed: `.agents/tasks/design.md` (third cycle; the design records 0 HIGH / 1
MEDIUM / 3 NIT from the prior on-disk review, all marked addressed).

Review method: read the design in full, then verified every load-bearing claim
against source in the worktree
(`.worktrees/player-category-tally/reporting-ui/`):
`lib/comparison/player-accuracy.ts`, `lib/comparison/xml-compare.ts`,
`app/accuracy-compare/page.tsx`, `vitest.config.ts`, `package.json`.

## Verdict

APPROVED. No HIGH or MEDIUM findings. Four NITs below; none block
implementation. The highest-risk area (scope agreement with the Golden cards)
is correct — see Verified Assumptions.

---

## Findings

### 1 [NIT] — "SAME philosophy as player-accuracy.ts" is an imprecise framing
**Where:** D2.1, and the docstring claim that `categoryAccuracy` is "the SAME
philosophy... applied at the category-volume level."

**Problem:** `player-accuracy.ts` deliberately sums per-stat absolute errors
*before* dividing, specifically so an over-count on one stat cannot cancel an
under-count on another (the module docstring calls this out: "+8 tackles
cancelling -13 ball recoveries"). The new metric sums each side's category
*volume* first, then takes a single `|a - m|`. At the category level an
over-count in one sub-stat CAN cancel an under-count in another sub-stat of the
same group. So it is not the same philosophy — it is the absolute-difference
*shape* applied to an already-summed volume. This is intended (the feature is an
explicit volume reconciliation that ignores sub-stat breakdown), so it is not a
defect, but the wording overstates the equivalence.

**Fix:** Reword D2.1 to: "This reuses the absolute-difference SHAPE of
`player-accuracy.ts` — `(master − |diff|)/master`, floored/capped, null at 0 —
but applied to the per-category VOLUME total rather than to summed per-stat
errors. Unlike the Golden metric it does not guard against sub-stat
cancellation, because this section is deliberately breakdown-agnostic."

### 2 [NIT] — `foulsDrawn` is an undocumented member of the "dropped here" set
**Where:** FR5 / D2.4 step 7 / D3, which enumerate the stats that diverge
between this section's drop rule and `relevant()`.

**Problem:** `bumpFootball` classifies "fouls drawn" into a distinct
`foulsDrawn` key (verified in `player-accuracy.ts`), and no displayed category's
`parts` includes `foulsDrawn` (Other uses `fouls`, not `foulsDrawn`). A player
coded ONLY with "Fouls Drawn" therefore totals 0 across all five displayed
categories and is dropped here. `relevant()` also omits `foulsDrawn`, so it
agrees in this case — but the design's divergence lists (ballRecoveries /
groundDuels / aerials / headers) are presented as exhaustive and silently omit
`foulsDrawn` and also `groundDuels`/`aerial` sub-keys' exact names. This is a
completeness gap in the explanatory text, not a logic error.

**Fix:** Add a parenthetical to FR5/D3: "(Likewise `foulsDrawn` maps to no
displayed category and is not counted toward the drop rule; it is neither shown
nor retained-for.)" Keeps the enumeration honest without changing behaviour.

### 3 [NIT] — AC list does not pin the over-count-in-one-category tally case
**Where:** Acceptance Criteria AC5/AC6 test `categoryAccuracy` directly, and AC7
tests a clean Defensive tally, but no AC exercises the aggregator producing an
OVER-count at the category level (analyst volume > master volume for a group via
`computePlayerCategoryTally`, not the bare metric).

**Problem:** The sub-stat-cancellation behaviour noted in Finding 1 is only
reachable through the aggregator. Without an AC, a future refactor that changed
`categoryTotal` (e.g. clamped per-part) could pass all stated ACs while silently
altering results.

**Fix:** Add AC7b: master labels `["Tackles Successful","Interceptions"]`
(Defensive m = 2), analyst labels `["Blocks","Blocks","Clearances"]`
(Defensive a = 3) ⇒ Defensive `{ a: 3, m: 2, pct: 0.5 }` (`(2 − |3 − 2|)/2`),
proving category volume sums across sub-stats before the metric runs.

### 4 [NIT] — Scope-chip display uses `teamDisplay`, diverging from the plain player cell
**Where:** D6 "Team filter" (scope chip `teamFilter === "all" ? "Both teams" :
teamDisplay(teamFilter)`) vs the Display-name note that the player cell shows
canonical `row.team` (NOT run through `teamDisplay`) for parity.

**Problem:** Minor internal inconsistency in presentation choice: the section's
header chip maps the canonical team to a club name, but its row labels show the
raw canonical `Home`/`Away`. Both choices individually match existing sections
(the chip mirrors the Category-breakdown header chip at page ~line 3345, which
does use `teamDisplay`; the player cell mirrors the Player stats table which
does not), so this is defensible, but the design should state that the mismatch
is deliberate so an implementer does not "fix" one to match the other.

**Fix:** Add one line to D6: "Intentional asymmetry: the header chip uses
`teamDisplay` (matching the other section headers) while row labels keep
canonical `row.team` (matching the Player stats table rows). Do not unify them."

---

## Verified Assumptions

All confirmed by reading source in the worktree.

1. **Scope agreement (highest-risk).** The Golden `playerAccuracy` useMemo
   (page ~line 2071) uses exactly
   `const inScope = (i) => inRange(i) && (teamFilter === "all" || i.team === teamFilter);`
   over `canonical.master.filter(inScope)` / `canonical.analyst.filter(inScope)`,
   with dep array `[canonical, sport, tolerance, effectiveRange, teamFilter]`.
   D1 reproduces this verbatim and correctly requires the new memo to use the
   IDENTICAL predicate over the SAME `canonical.*`. The new section does NOT run
   `compareInstances`, which is correct for volume reconciliation and is the
   intended structural difference. There is no path where the new section could
   draw from a different instance set than the Golden cards. ✓

2. **`relevant()` composition** (page ~line 635): sums `touches, totalPasses,
   throughSucc, throughUnsucc, carries, crosses, shots, goals, tackles,
   interceptions, clearances, ballRecoveries, dribblesSucc, dribblesUnsucc,
   groundDuelsWon, groundDuelsLost, aerialWon, aerialLost, headers, fouls`.
   Design Finding 1 (3A) lists this set correctly and correctly identifies the
   divergence (GK / blocks / throwIns / cards / offsides kept here but omitted by
   `relevant()`; ballRecoveries / groundDuels / aerials / headers dropped here
   but kept by `relevant()`). ✓

3. **`playerTable` keying/display/sort** (page ~line 2163): key
   `` `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}` ``, display
   `` `${r.team} - #${r.number ?? "?"}` ``, comparator `analystOnly`-last →
   `if (a.team !== b.team) return a.team.localeCompare(b.team)` →
   `(a.number ?? 999) - (b.number ?? 999)`. D2.3 / D2.4 step 8 / AC9 reproduce
   these byte-for-byte. Team-casing split (lowercased map key vs first-seen-case
   stored `team`) also matches. ✓

4. **`playerTable` sources from `result.rows`** (a second `canonicaliseTeams`
   pass via `compareInstances(..., master?.name)`), NOT from `canonical.*`.
   D2.3 / D5 describe this correctly and the idempotency / preserved-team
   rationale for why the two row sets agree in practice yet may diverge in
   membership. ✓

5. **`deriveFootball` keys used by `categoryTotal`** exist and match
   `FOOTBALL_GROUPS` parts: Passing = `passesExThrough + totalThroughBalls +
   crosses`; Offensive = `shots + goals`; Defensive = `tackles + interceptions +
   clearances + blocks`; Goalkeeper = `gkSaves + gkBlocks + gkCatches + gkClaims
   + gkPunches + gkGoalKicks + gkThrows`; Other = `touches + carries + dribbles +
   throwIns + cards + fouls + offsides`. FR4 lists these correctly. ✓

6. **Metric rule & examples.** `categoryAccuracy` as specified gives
   6/6 ⇒ 1 (AC1), 4/6 ⇒ 2/3 ≈ 0.6667 → "67%" (AC2), 0/3 ⇒ 0 (AC3),
   0/0 ⇒ null → "—" (AC4), 9/6 ⇒ 0.5 (AC5), 20/6 ⇒ 0 floored (AC6). `m === 0 ⇒
   pct: null` is returned BEFORE any division, and D6's `CategoryTallyCell`
   renders `pct == null` as `—`, never 100%. The "null is never 100%" invariant
   holds. ✓

7. **AC7 hand-check.** Master `["Interceptions","Clearances","Blocks","Tackles
   Successful"]` ⇒ Defensive volume 4; analyst `["Interceptions","Clearances"]`
   ⇒ 2; `categoryAccuracy(2,4) = (4−2)/4 = 0.5`. Passing 0/0 ⇒ null. Matches. ✓

8. **AC8a / AC8b hand-check.** `["Save","Save","Catch"]` ⇒ Goalkeeper > 0 ⇒
   kept; outfield `["Blocks"]` ⇒ Defensive > 0 ⇒ kept. `["Ball Recovery","Aerial
   Win"]` ⇒ all five displayed categories 0 ⇒ dropped. Matches. ✓

9. **`bumpFootball` expects a lowercased label** and the page already calls it
   with `stat.toLowerCase()`; D2.4 step 9 / D4 require the same. ✓

10. **Render anchor.** The Golden block `{playerAccuracy && (` closes with `)}`
    at ~line 2946, immediately followed by the "Category breakdown + per-stat
    breakdown" grid (`<div className="mt-4 grid ...">`). D6's structural anchor
    (insert after the Golden block's closing `)}`, before the Category-breakdown
    grid) is correct. ✓

11. **Reused table styling classes** verified at the cited locations: row
    `group border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60` +
    `bg-red-50/60`; sticky player `<td>` `sticky left-0 z-10 whitespace-nowrap
    px-4 py-2 font-medium text-slate-800` with `bg-red-50`/`bg-white` +
    `group-hover:bg-slate-50`; badge `ml-2 rounded bg-red-100 px-1.5 py-0.5
    text-[10px] font-semibold text-red-700`; `tfoot sticky bottom-0 z-10`; totals
    row `border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900` with
    the sticky `Team totals` cell `sticky left-0 z-20 whitespace-nowrap
    bg-slate-100 px-4 py-2.5 text-left`. All match D6. ✓

12. **Test runner (D9).** `package.json` `"test": "vitest --run"`,
    `vitest@^3.2.7`; `vitest.config.ts` sets `environment: "jsdom"` and
    `include: ["**/*.test.ts", "**/*.test.tsx"]`. D9 states this correctly. ✓

13. **`Instance` type fields** D8's fixtures rely on (`id, start, end, mid, team,
    playerNumber, playerRaw, stat, category, code`) all exist on the exported
    `Instance` type in `xml-compare.ts`. ✓

14. **No behaviour change to `player-accuracy.ts`** — the design only imports
    `initFootballCounts`, `bumpFootball`, `deriveFootball`, `FOOTBALL_GROUPS`,
    `FootballCounts`, all of which are exported. Scope discipline (two new files
    + `page.tsx`) is consistent across NFR2 / D7. ✓

## Unverified / Wrong Assumptions

None. Every externally-checkable claim in the design was confirmed against
source. The design's own "Reviewer Unverified items — now verified" notes
(footer classes, player-cell classes, runner config, the stale-review-file
correction) were independently re-checked here and are accurate.
