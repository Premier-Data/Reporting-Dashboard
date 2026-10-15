# Design Review — Overlap-scoped saved accuracy % (v3)

Reviewed fresh against the actual source in
`c:\Users\AndyDin\reporting-dashboard\.worktrees\overlap-scope\reporting-ui`.
Every claim the design makes about existing code was checked against the file it
names.

## Verdict

**APPROVED** — zero HIGH, zero MEDIUM findings. Three NITs below are optional
polish and do not block implementation.

The design is internally consistent and its load-bearing claims about the
existing code all verify. The canonicalise-full-then-scope ordering is the
correct fix for Home/Away label parity, all three recompute paths are routed
through the single `gradeOverlapScoped` derivation, the no-schema-change
rationale is sound, and the catch/catches change is already landed, correctly
placed, and tested.

---

## Findings

1. **NIT — Caller name is wrong in the design prose.** In path 1b and the v3
   resolution log the design states the sole caller of `updateAccuracyCheck` is
   `handleUpdate`. The actual function in `app/accuracy-compare/page.tsx` is
   `handleUpdateCheck` (verified at the `updateAccuracyCheck({ id: loadedCheckId,
   … })` call site). The call-graph conclusion is still correct — there is
   exactly one caller and it passes `xmlAnalyst`, `fileNameMaster`, and
   `tolerance`; only the name is off.
   **Fix:** replace `handleUpdate` with `handleUpdateCheck` in the two places it
   appears.

2. **NIT — Fallback trigger condition vs. what the real caller passes.** The
   design's update fallback fires on `!graded && input.xmlAnalyst === undefined`.
   The verified sole caller passes `xmlAnalyst: analyst?.raw ?? null` — i.e.
   `null`, never `undefined`, when no analyst is loaded. So a `null` analyst XML
   would NOT enter the stored-row fallback; it would fall straight to the
   null-grade marker. That is actually the correct outcome (a genuinely absent
   analyst is ungradeable and `handleUpdateCheck` already guards `if
   (!gradedAnalyst) return`, so the live path never reaches it with a null
   analyst). The only risk is that the prose describes the fallback as covering
   "a dispute-style partial update" when the trigger is strictly `=== undefined`;
   a future caller passing `null` would silently skip the fallback.
   **Fix (optional):** either widen the guard to `input.xmlAnalyst == null`
   (loose equality catches both `null` and `undefined`) if the intent is to
   recover from any missing analyst, or keep `=== undefined` and add one
   sentence noting a `null` analyst is treated as a genuine ungradeable row (the
   null-grade marker), not a partial update to be back-filled from the stored
   row. Prefer the clarifying sentence — the current behaviour is already
   correct and widening the guard is not needed for the verified call graph.

3. **NIT — `computePlayerAccuracyByScope` re-canonicalises AFTER its own
   home/away filter, worth one explicit sentence.** Verified: inside
   `computePlayerAccuracyByScope`, `canonicaliseTeams` runs ONCE over the sets it
   is handed, then each scope (`both`/`home`/`away`) filters by `i.team` on the
   already-canonical instances. When `gradeOverlapScoped` passes it the scoped,
   already-canonical sets, the internal `canonicaliseTeams` hits the idempotency
   guard (both sides Home/Away-only and non-empty) and passes through — so the
   `home`/`away` sub-scope filters operate on the preserved full-set labels, as
   the design intends. The design asserts this at the `both` level but does not
   spell out that the `home`/`away` sub-scope filtering happens inside the helper
   after the pass-through. This is correct as designed; it is just implicit.
   **Fix (optional):** add one line to the "Overlap-scoped stored player_accuracy"
   section noting that `computePlayerAccuracyByScope` does its own home/away split
   internally on the idempotency-preserved labels, so the stored `home`/`away`
   match the live view's `home`/`away` and not merely `both`.

---

## Verified Assumptions

- **`analystWindow` derivation (compare page).** CONFIRMED. `app/accuracy-compare/
  page.tsx` builds it as `[master, analyst].filter(f => f && f.instances.length
  > 0)`, `.reduce((a, b) => b.instances.length < a.instances.length ? b : a)`
  (strict `<`, ties keep `a`/master), `Math.min/Math.max` over `.mid`, inclusive
  `inRange`. The design's `deriveOverlapWindow` reproduces this exactly
  (push master first, strict `<`, min/max, inclusive `inOverlap`).
- **`effectiveRange` / `rangeMode` / `inRange` untouched.** CONFIRMED present and
  the design only repoints the `analystWindow` memo, reading `.start`/`.end`.
- **`canonical` memo uses the FULL sets WITH the master file name.** CONFIRMED:
  `canonicaliseTeams(master.instances, analyst.instances, tolerance, master.name)`.
  The stored path's `canonicaliseTeams(masterRaw, analystRaw, tol, name)` uses the
  identical argument list.
- **Idempotency guard in `canonicaliseTeams`.** CONFIRMED: `isCanon(arr) =
  arr.length > 0 && arr.every(team ∈ {home,away,""})`; returns inputs unchanged
  when both sides canonical. Requires BOTH sides non-empty, exactly as the design
  states.
- **Empty-teams early return (second leg).** CONFIRMED: `if (mTeams.length === 0
  || aTeams.length === 0) return { master, analyst, mapped:false, … }` — preserves
  labels when scoping empties a side. The design's two-leg guarantee holds.
- **`compareInstances` re-canonicalises internally and returns the summary /
  byCategory / byTeam shape.** CONFIRMED. `ComparisonResult.summary` has
  `masterTotal, analystTotal, exact, wrongStat, wrongPlayer, wrongTeam, missed,
  extra, accuracy, avgTimeDrift`; plus `byCategory`, `byTeam`. The design's row
  column mapping matches field-for-field.
- **`computePlayerAccuracyByScope` canonicalises then compares with file name.**
  CONFIRMED (lib/comparison/player-accuracy.ts) — `canonicaliseTeams(master,
  analyst, tol, masterFileName)` then per-scope `compareInstances(..., tol,
  masterFileName)`.
- **Current `saveAccuracyCheck` / `updateAccuracyCheck` / `propagateMasterCorrection`
  behaviour.** CONFIRMED. Save uses `s = input.result.summary` (range-dependent)
  and `computeStoredPlayerAccuracy`. Update writes conditional `!== undefined`
  metadata fields exactly as the design lists. Propagate grades
  `compareInstances(master, analystInstances, tol, fileNameMaster)` +
  `computePlayerAccuracyByScope(...)` over the FULL corrected master per row and
  writes `xml_master: xmlMaster`. The design's "replace with gradeOverlapScoped"
  per path is accurate.
- **Backfill current body + fetch guard.** CONFIRMED. List query is
  `select("id, tolerance, file_name_master")` with `force ? all : .is(
  "player_accuracy", null)`; per-row `select("xml_master, xml_analyst").eq("id",
  row.id).single()`; `if (!xmlErr && xmlRow) { … } else { skipped += 1; if
  (xmlErr) console.error(...) }`. Today it writes ONLY `{ player_accuracy: pa }`.
  The design's rewrite (preserve the fetch guard first, then null-grade skip,
  then a single full-column `update`) is consistent with the existing contract.
  `recomputeAllPlayerAccuracy` is `backfillPlayerAccuracy(onProgress, true)`.
  `AccuracyCheckXml` and `BackfillProgress` types exist as used.
- **Sole caller of `updateAccuracyCheck`.** CONFIRMED: only `handleUpdateCheck`
  in `app/accuracy-compare/page.tsx` calls it, passing `xmlAnalyst`,
  `fileNameMaster`, `tolerance`. `handleOverrideMaster` and the disputes page
  both call `propagateMasterCorrection`, not `updateAccuracyCheck` (confirmed in
  `page.tsx`, `ManageMastersDialog.tsx`, `disputes/page.tsx`).
- **catch/catches normalization placement.** CONFIRMED in `baseAction`
  (`lib/comparison/xml-compare.ts`): `.replace(/\bcatches\b/g, "catch")`,
  word-anchored. `bumpFootball` groups both via `s.includes("catch")` →
  `gkCatches`. STAT_PREFERENCES lists both `catch`/`catches` cross-mapped. Test
  `lib/comparison/cross-exact.test.ts` asserts master `Catch` vs analyst
  `Catches` scores `exact` and vice versa. All present and matching the design.
- **`instancesFromRaw` handles XML and `{`-prefixed JSON feeds.** CONFIRMED —
  JSON branch routes through `jsonEventsToInstances`; else `parseInstances`
  (DOMParser). Supports the no-schema-change re-derivation claim for both formats.
- **No DB schema change / stale-column rationale.** SOUND. The window is a pure
  function of `.mid` over the stored source, both `xml_master`/`xml_analyst` are
  persisted, and a persisted range column would reintroduce the stale-column
  class the existing `fixStaleMasterTotals`/`diagnoseMasterConsistency` already
  exist to manage.
- **History breakdown consumers.** The design's claim that category/team panels
  render per-row ratios without cross-referencing the headline total, and that
  the `masterTotalMismatches` sibling banner is the one genuine behavioural
  change (flagged manual-verify), is consistent with
  `diagnoseMasterConsistency` existing as a parsed-count fallback. Not
  independently re-walked line-by-line in `accuracy-checks/page.tsx`, but the
  banner being advisory (parsed vs stored total) is corroborated by the
  diagnostic's `staleTotalCheckIds` design in `accuracyChecks.ts`.

## Unverified / Wrong Assumptions

- **WRONG (cosmetic): caller named `handleUpdate`.** The actual function is
  `handleUpdateCheck`. See finding #1. The functional claim (one caller, passes
  the XMLs) is correct; only the name is wrong.
- **IMPRECISE: fallback described for "partial update omitting xmlAnalyst."** The
  verified caller passes `null`, not `undefined`, so the `=== undefined` branch
  the design relies on would not fire for that caller. Behaviourally harmless
  (correct null-grade outcome), but the prose overstates when the stored-row
  fallback engages. See finding #2.
- **NOT INDEPENDENTLY VERIFIED (low risk): History UI consumer walk-through.**
  The design's finding-#4 analysis of `app/accuracy-checks/page.tsx` breakdown
  panels was accepted on the strength of the corroborating diagnostic code
  rather than a full re-read of the render functions. The banner is advisory and
  no code is changed there, so this does not affect the verdict.
- **OUT OF ENVIRONMENT (correctly scoped): admin bulk re-scope run.** The design
  states the `recomputeAllPlayerAccuracy` run needs the browser DOMParser +
  authenticated Supabase session and cannot run from this environment. That is a
  stated limitation, not an unverified assumption; the mixed-state caveat
  (new rows overlap-scoped, old rows full-game until an admin runs it) is
  explicitly documented and the run is idempotent.
