# Implementation Plan — Overlap-scoped saved accuracy %

Derived from the APPROVED design at `.agents/tasks/design.md` (verdict
`.agents/tasks/design-review.json` = APPROVED). This plan sequences that design;
it does not re-decide architecture. The three design-review NITs are folded into
the relevant items (caller named `handleUpdateCheck` not `handleUpdate`; null —
not undefined — analyst XML is a genuine ungradeable row; the home/away split
happens inside `computePlayerAccuracyByScope` on the idempotency-preserved
labels).

All paths are absolute and all work stays inside
`c:\Users\AndyDin\reporting-dashboard\.worktrees\overlap-scope\reporting-ui`
(hereafter `<ui>`). Windows / PowerShell. Run commands with that as the cwd.
Do NOT commit or push — the orchestrator finalizes git.

## Verified facts from the codebase (ground truth for this plan)

- Build: `npm run build` (= `next build`). Tests: `npm test` (= `vitest --run`).
  Lint: `npm run lint` (= `eslint`). Vitest runs under **jsdom**
  (`<ui>\vitest.config.ts`), so `DOMParser` is available in tests.
- `<ui>\lib\comparison\xml-compare.ts` already contains: the `canonicaliseTeams`
  **idempotency guard** (`isCanon` passes already-Home/Away sets through) AND the
  `mTeams.length === 0 || aTeams.length === 0` early return — BOTH legs the
  design relies on. `baseAction` already canonicalises `\bcatches\b` → `catch`.
  `compareInstances(masterRaw, analystRaw, tolerance, masterFileName?)` and
  `canonicaliseTeams(master, analyst, tolerance, masterFileName?)` are exported;
  `Instance` has numeric `.mid`.
- `<ui>\lib\comparison\player-accuracy.ts` exports
  `computePlayerAccuracyByScope(masterInstances, analystInstances, tolerance,
  masterFileName?)` which canonicalises once then does the home/away split
  internally on the preserved labels, and `type StoredPlayerAccuracy`.
- `<ui>\lib\api\accuracyChecks.ts` has: `instancesFromRaw` (XML or JSON feed),
  `computeStoredPlayerAccuracy` (null when `!xmlMaster || !xmlAnalyst` or master
  parses empty), `saveAccuracyCheck` (reads `input.result.summary`),
  `updateAccuracyCheck` (reads `input.result.summary`; conditional `!== undefined`
  metadata writes), `propagateMasterCorrection` (full-game
  `compareInstances` + `computePlayerAccuracyByScope` per row; throws on row
  update error), and `backfillPlayerAccuracy` (per-row body currently
  `if (!xmlErr && xmlRow) { pa = computeStoredPlayerAccuracy(...); update {
  player_accuracy: pa } }`, writing ONLY `player_accuracy`). `AccuracyCheckXml`
  type exists in this file.
- `<ui>\app\accuracy-compare\page.tsx`: `analystWindow` useMemo currently inlines
  `[master, analyst].filter(...).reduce((a,b)=> b.instances.length < a.instances.length ? b : a)`
  then `Math.min/max` over `.mid`, returning `{start, end, source: smaller.name}`.
  `source` is NOT read anywhere (only `.start`/`.end` are, in `effectiveRange`
  and the manual-range placeholders). `handleUpdateCheck` is the SOLE caller of
  `updateAccuracyCheck` and always passes `xmlAnalyst`, `fileNameMaster`,
  `tolerance`; `handleOverrideMaster` calls `propagateMasterCorrection`, not
  update. `rangeMode`/`effectiveRange`/`inRange`/`canonical` and all live grading
  memos are to stay untouched.
- catch/catches is DONE: `baseAction` has the rule; `<ui>\lib\comparison\cross-exact.test.ts`
  already asserts master `Catch` vs analyst `Catches` (and vice versa) = exact,
  alongside no-regression cases (short vs long passes stay non-exact, etc.).

---

- [ ] 1. Create the pure shared overlap-window module.
      Add `lib/comparison/overlap-window.ts` exporting `type OverlapWindow =
      { start: number; end: number; source: "master" | "analyst" }`,
      `deriveOverlapWindow(master, analyst): OverlapWindow | null`,
      `inOverlap(i, w): boolean`, and `scopeToOverlap(master, analyst):
      { master; analyst; window: OverlapWindow | null }`, exactly per the design
      ("Shared pure helper" section). No DOM, no Supabase imports — type-only
      import of `Instance` from `./xml-compare`. `deriveOverlapWindow` pushes
      master first and selects the fewer-instance set with STRICT `<` (so a tie
      keeps master, matching the page's reduce), min/max over `.mid`, inclusive
      bounds; returns null when both sides are empty. `scopeToOverlap` filters
      both sides by `inOverlap` and returns the window (passes inputs through
      unchanged with `window: null` when the window can't be derived).
      Files: `lib/comparison/overlap-window.ts`
      Verify: `npm run build` succeeds (module compiles / type-checks). Full
      behavioural assertions land in item 2.

- [ ] 2. Add the pure-logic unit tests for the window helper and the scope/label
      contracts.
      Add `lib/comparison/overlap-window.test.ts` (Vitest) covering the design's
      Testing items 1–7: (1) window = fewer-instance file, with source
      `"analyst"` / `"master"` on swap; (2) PROPERTY test over randomized length
      pairs incl. ties — asserts fewer-length selection and tie-keeps-`master`;
      (3) inclusive bounds via `inOverlap` (mid == start/end kept, just-outside
      dropped); (4) empty-side behaviour (`deriveOverlapWindow([],a)` /
      `(m,[])`, and `scopeToOverlap` pass-through with `window: null`); (5)
      one-time parity: reproduce the page's prior inline
      `[master,analyst].reduce(...)` + min/max on fixtures and assert equality
      with `deriveOverlapWindow` (this is the "compare-page-equivalent window
      matches the shared helper for the same inputs" proof); (6) end-to-end scope
      effect: synthetic master of 1600 instances spanning mid 0..3600s and an
      analyst coding only 1200..1800s — assert the derived window is
      `[1200,1800]`, that `scopeToOverlap` yields only in-window instances, and
      that `compareInstances` over `scopeToOverlap(canonicaliseTeams(full,…))`
      gives a materially higher exact/master ratio than over the full sets
      (player-accuracy / grade over the filtered set differs from full-game);
      (7) Home/Away label parity: a fixture with a master file name present and
      two teams whose coded-count order differs within the overlap window vs the
      full game — assert the canonicalise-FULL-then-scope pipeline produces the
      SAME home/away split as the live path, and that scoping-first-then-
      canonicalising would differ (guards against regressing to v1 ordering).
      Files: `lib/comparison/overlap-window.test.ts`
      Verify: `npm test` — all new `overlap-window` tests pass and the existing
      suite (incl. `cross-exact.test.ts`) stays green.

- [ ] 3. Add the single overlap-scoped grading helper in the API layer.
      In `lib/api/accuracyChecks.ts` add `gradeOverlapScoped(xmlMaster,
      xmlAnalyst, tolerance, fileNameMaster)` per the design's "Overlap-scoped
      stored player_accuracy AND summary" section: `instancesFromRaw` both
      sides → return null when `masterRaw.length === 0` → `tol = tolerance ?? 3`,
      `name = fileNameMaster ?? null` → canonicalise the FULL sets with
      `canonicaliseTeams(masterRaw, analystRaw, tol, name)` → `scopeToOverlap`
      the already-canonical sets → grade with `compareInstances(scoped.master,
      scoped.analyst, tol, name)` and `computePlayerAccuracyByScope(scoped.master,
      scoped.analyst, tol, name)`; return `{ result, playerAccuracy }`. Import
      `canonicaliseTeams` from `@/lib/comparison/xml-compare` and `scopeToOverlap`
      from `@/lib/comparison/overlap-window`. Reimplement
      `computeStoredPlayerAccuracy` as a thin wrapper that returns
      `gradeOverlapScoped(...)?.playerAccuracy ?? null` inside its existing
      try/catch (keep the `console.error` on throw). Because
      `computeStoredPlayerAccuracy`'s old guard was `!xmlMaster || !xmlAnalyst`,
      preserve the "needs analyst XML" behaviour via `gradeOverlapScoped` naturally
      returning a result even with an empty analyst side — the stored value is now
      overlap-scoped regardless.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npm run build` succeeds; `npm test` stays green (no path rewired
      yet — this item only adds the helper and rewraps the existing one).

- [ ] 4. Route `saveAccuracyCheck` through the shared derivation.
      In `lib/api/accuracyChecks.ts`, replace `const s = input.result.summary`
      and the `computeStoredPlayerAccuracy(...)` call in the row object with a
      single `const graded = gradeOverlapScoped(input.xmlMaster,
      input.xmlAnalyst, input.tolerance, input.fileNameMaster)`. Write
      `accuracy/master_total/analyst_total/exact/wrong_stat/wrong_player/
      wrong_team/missed/extra/avg_time_drift` from `graded?.result.summary`
      (`?? null` each), `category_breakdown`/`team_breakdown` from
      `graded?.result.byCategory/byTeam ?? null`, and `player_accuracy` from
      `graded?.playerAccuracy ?? null`. Keep `xml_master`/`xml_analyst`/metadata
      exactly as now. Per design finding #5, do NOT fall back to
      `input.result.summary` on a null grade — null accuracy columns + null
      `player_accuracy` (ungraded marker) + `console.warn`; the save is never
      blocked. The Supabase insert-error path (`throw`) is unchanged.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npm run build` succeeds; `npm test` stays green.

- [ ] 5. Route `updateAccuracyCheck` through the shared derivation with the
      stored-row analyst fallback.
      In `lib/api/accuracyChecks.ts`, compute
      `let graded = gradeOverlapScoped(input.xmlMaster, input.xmlAnalyst,
      input.tolerance, input.fileNameMaster)`; if `!graded && input.xmlAnalyst
      === undefined`, fetch `xml_analyst, file_name_master, tolerance` for
      `input.id` and re-grade with the input value where present and the stored
      value as fallback (per design path 1b). Write the accuracy/breakdown/
      `player_accuracy` fields from `graded` (same shape as item 4). PRESERVE
      verbatim every conditional `if (input.X !== undefined) row.Y = ...` write
      (`master_analyst_name`, `analyst_name`, `match_label`, `file_name_master`,
      `file_name_analyst`, `tolerance`, `xml_analyst`, `video_url`, `sport`) and
      the unconditional `xml_master: input.xmlMaster`. Note (design-review NIT):
      the sole caller is `handleUpdateCheck` which always passes `xmlAnalyst`
      (`analyst?.raw ?? null`); a NULL analyst XML is a genuine ungradeable row
      (null-grade marker), NOT a partial update — the `=== undefined` fallback is
      defensive for a future caller only. The Supabase update-error `throw` is
      unchanged.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npm run build` succeeds; `npm test` stays green.

- [ ] 6. Route `propagateMasterCorrection` through the shared derivation.
      In `lib/api/accuracyChecks.ts`, replace the per-row
      `compareInstances(master, analystInstances, tol, fileNameMaster)` +
      `computePlayerAccuracyByScope(master, analystInstances, …)` pair with one
      `const graded = gradeOverlapScoped(xmlMaster, row.xml_analyst,
      row.tolerance, fileNameMaster)` per row, and write the full column set
      (summary + breakdowns + `player_accuracy`) from it, keeping
      `xml_master: xmlMaster`. On `graded === null` for a row, write null
      accuracy columns + null `player_accuracy` + `console.warn` and continue
      (do NOT abort the whole propagation). Keep the existing Supabase
      update-error behaviour (`throw`). The initial `master` parse via
      `instancesFromRaw(xmlMaster)` can remain (unused once rerouted) or be
      removed if lint flags it as unused — remove it to keep lint clean.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npm run build` succeeds; `npm run lint` reports no new errors;
      `npm test` stays green.

- [ ] 7. Rewrite the `backfillPlayerAccuracy` per-row body to write the full
      overlap-scoped column set with the preserved fetch guard.
      In `lib/api/accuracyChecks.ts`, change the per-row body from the current
      `if (!xmlErr && xmlRow) { … update { player_accuracy } }` shape to the
      design's guard-first form: `if (xmlErr || !xmlRow) { skipped += 1; if
      (xmlErr) console.error(...); onProgress?.(...); continue; }` → `const graded
      = gradeOverlapScoped((xmlRow as AccuracyCheckXml).xml_master,
      (xmlRow as AccuracyCheckXml).xml_analyst, row.tolerance,
      row.file_name_master)` → `if (!graded) { skipped += 1; onProgress?.(...);
      continue; }` → a single `update({ accuracy, master_total, analyst_total,
      exact, wrong_stat, wrong_player, wrong_team, missed, extra, avg_time_drift,
      category_breakdown, team_breakdown, player_accuracy })` from `graded`,
      counting `updated` / `skipped` on success / error exactly as now. Keep the
      list query (`select("id, tolerance, file_name_master")`, `force ? all :
      .is("player_accuracy", null)`) and the one-row-at-a-time XML fetch
      unchanged. Each of the three branches (fetch error, null grade, update
      error) must `skipped += 1`, call `onProgress`, and continue — none throws.
      `recomputeAllPlayerAccuracy` (force=true wrapper) is unchanged and is the
      admin-triggered historical backfill (requirement 4); runs in-browser only,
      not from this environment.
      Files: `lib/api/accuracyChecks.ts`
      Verify: `npm run build` succeeds; `npm test` stays green.

- [ ] 8. Repoint the compare page's `analystWindow` at the shared helper
      (window math only — no live-view behaviour change).
      In `app/accuracy-compare/page.tsx`, replace the `analystWindow` useMemo body
      with: `if (!master || !analyst) return null;` then `const w =
      deriveOverlapWindow(master.instances, analyst.instances); if (!w) return
      null; return { start: w.start, end: w.end };` and import
      `deriveOverlapWindow` from `@/lib/comparison/overlap-window`. DROP the
      `source` field (verified unread). Do NOT touch `rangeMode`,
      `effectiveRange`, `inRange`, `canonical`, the Range selector UI, or any live
      grading memo. The manual-range placeholders already read only
      `analystWindow.start`/`.end`, which are preserved. BEFORE editing, read the
      relevant Next.js guide under
      `<ui>\node_modules\next\dist\docs\` for App-Router client-component/useMemo
      guidance (AGENTS.md requires it; this Next.js has breaking changes).
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` succeeds (page type-checks and compiles under the
      installed Next.js); `npm test` stays green. Manually confirm the window
      math equals the shared helper via the parity test from item 2 (no new test
      needed here — item 2 proves equivalence for the same inputs).

- [ ] 9. Confirm the catch/catches requirement needs no new code and lock it with
      the existing test.
      No source change: `baseAction` in `lib/comparison/xml-compare.ts` already
      canonicalises `\bcatches\b` → `catch`, and the overlap-scoped stored path
      flows through `compareInstances` → `sameBaseAction`, so it inherits the
      behaviour automatically (no API-layer change). The behaviour is already
      covered by `lib/comparison/cross-exact.test.ts` (master `Catch` vs analyst
      `Catches` and the reverse both score exact), with no-regression cases
      (short vs long passes stay non-exact; unrelated-stat pairing unchanged) in
      the same file.
      Files: none (verification-only item)
      Verify: `npm test` — the `cross-exact.test.ts` catch/catches case passes
      along with the no-regression cases, confirming no change was needed.

- [ ] 10. Write the verification note.
      Add `.agents/tasks/verification-note.md` recording: the exact commands run
      and their outcomes (`npm run build`, `npm test`, `npm run lint`); that the
      overlap-window helper + canon-then-scope label parity + scoped-vs-full
      grading contract are covered by the new pure tests; and the
      INTEGRATION/MANUAL-ONLY caveats from the design — (a) the admin-triggered
      `recomputeAllPlayerAccuracy` historical backfill cannot run from this
      environment (needs the browser DOMParser + authenticated Supabase session),
      (b) until an admin runs it Accuracy History MIXES overlap-scoped-new rows
      with full-game-old rows (expected; backfill is idempotent and converges),
      and (c) the `masterTotalMismatches` sibling banner may fire more often
      under overlap scope — advisory only, flagged as a post-backfill
      manual-verify item, not changed here. Also note the live compare Range
      selector is intentionally unchanged (requirement 5).
      Files: `.agents/tasks/verification-note.md`
      Verify: file exists and lists real command results and the three caveats;
      final gate — re-run `npm run build` and `npm test` once more and confirm
      both pass.

## Dependency order

1 → 2 (tests import the helper). 1 → 3 (helper used by `gradeOverlapScoped`).
3 → 4,5,6,7 (all four reroute through `gradeOverlapScoped`). 1 → 8 (page imports
the helper); 8 can run any time after 1 but is grouped after the API rewires so
the whole feature lands coherently. 9 is verification-only (any time). 10 last
(records the final state). Every item leaves the tree buildable.

## Explicitly out of scope (do not change)

- `lib/comparison/xml-compare.ts` core matching (`compareInstances`/`codeTime`/
  stat-preference) beyond reusing it on overlap-filtered inputs — and no edit to
  the already-landed `baseAction` catch/catches rule.
- The compare page's live Range selector behaviour (`rangeMode`,
  `effectiveRange`, `inRange`, `canonical`, live grading memos).
- Any DB schema / migration (deterministic re-derivation chosen instead).
- The `masterTotalMismatches` banner heuristic (manual-verify item only).
