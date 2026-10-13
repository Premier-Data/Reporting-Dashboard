# Skip pitch-zone labels during stat selection so early soccer master stats survive (check 478)

`parseInstances` picked the first non-Team/Player label as an instance's stat. When a pitch-zone label (`Penalty Box (a)`, `Front Third 116,`) was listed before the real stat, the zone was captured as the stat and the whole instance was then dropped by the exclusion guard — which is why check 478's first three soccer master stats (`Claims`, `Keeper Throw Successful`, `Shot Off Target`) never reached the platform while later events survived. The fix adds a conservative, start-anchored `isPitchZoneLabel` detector and skips zone labels during stat selection so the first REAL stat label wins; a zone-only instance now leaves `stat` empty and is dropped explicitly. The exclusion guard and `EXCLUDED_COMPARE_LABELS` are untouched, so half/substitution markers still drop. A new test file pins all four parser cases plus the end-to-end `compareInstances` regression.

Watch for: nothing blocking. This is a second pass; the v1 blocker (missing verification evidence) is now resolved and all prior findings are closed or accepted out-of-scope. (confirmed)

**Verdict**: APPROVED

## High-level view

The change lives entirely in the stat-selection step of `parseInstances`, not the exclusion guard. A pitch-zone label is skipped as a stat candidate and the loop keeps scanning, so a real early stat that happens to sit behind a zone label is captured instead of being mistaken for the zone and dropped. This is the minimal fix for the reported symptom and leaves the drop behaviour for genuine markers intact.

The pitch-zone matcher is deliberately conservative: it normalises group/text and matches on `startsWith` against four bases, so suffixed zones like `Penalty Box (a)` are caught while unrelated stats that merely contain a zone word are not. A new explicit `if (!cleanStat) continue;` drops instances that carried only a zone, which previously fell out via the guard.

Scope is clean for the fix under review. The uncommitted working tree touches only `xml-compare.ts` and adds the new test file; `json-adapter.ts`, `clubConfig.ts`, and `clubLogos.ts` are not modified by this step. The `json-adapter.ts`/`json-adapter.test.ts` edits and the `STAT_START_OFFSETS` goal-offset change that appear when diffing against `main` belong to a separate, already-committed goal-timing fix (`8f0f03e`), accepted out-of-scope by the orchestrator in the prior pass.

Verification evidence was supplied by the coder: the new test file passes 5/5, the full comparison suite passes 16/16, and `npm run build` completes cleanly (after a stale `.next` cache was cleared). That closes the only v1 blocker.

<details>
<summary>Issues (0 blocking)</summary>

No blocking issues. Prior-pass findings are all resolved or accepted out-of-scope:

1. **Logo-URL change (clubConfig/clubLogos)** — accepted out-of-scope; confirmed untouched vs `main` in this pass.
2. **json-adapter.ts goal-timing edits** — accepted out-of-scope; the separate committed fix `8f0f03e`, not modified by this step.
3. **Missing verification evidence** — resolved; coder supplied vitest counts (5/5 new, 16/16 suite) and a clean build.
4. **Stale codeTime docstring** — resolved; docstring now uses the corner example and notes goals carry no fixed offset.

</details>

<details>
<summary>Details</summary>

## Pitch-zone skip in stat selection

The label loop's `else if (!stat)` branch now reads `else if (!stat && !isPitchZoneLabel(group, text))`. A zone label is no longer taken as the stat; the loop continues and the first non-Team/Player, non-zone label becomes `category`/`stat`. The new tests confirm `Penalty Box (a)` → `Claims`/`Goal Keeper` and `Front Third 116,` → `Shots Off Target`/`Shooting` are captured and kept, matching the check-478 symptom.

`isPitchZoneLabel` normalises each of group and text with `(s ?? "").toLowerCase().replace(/\s+/g, " ").trim()` and returns true when either `startsWith` one of `back third`, `middle third`, `front third`, `penalty box`. Anchoring at the start (rather than `includes`) is the right call: it tolerates trailing suffixes without swallowing a stat that merely contains a zone word elsewhere in its name.

## Exclusion guard and zone-only instances

`EXCLUDED_COMPARE_LABELS` is unchanged — every entry (substitution/substitute, start/end half, and the four pitch zones in both spaced and unspaced forms) is still present, and the post-loop `isExcludedCompareLabel(cleanStat) || isExcludedCompareLabel(category)` guard is intact. Start/End Half and Substitution carry no real stat after the marker, so `stat` stays empty or excluded and they still drop, as the `Start Half 1` test asserts.

Because zones are now skipped during selection, an instance that was only a zone would leave `stat` empty and would no longer be caught by the guard. The new `if (!cleanStat) continue;` before the guard handles that explicitly, and the zone-only test confirms such an instance is still dropped. This is additive — it does not loosen the guard.

## Test coverage

`pitch-zone-stat.test.ts` builds raw `<instance>` XML through the real `parseInstances` (jsdom DOMParser via `vitest.config.ts`) and covers the four parser cases — Penalty-Box-first kept, Front-Third-first kept, Start-Half dropped, zone-only dropped — plus a `compareInstances` regression that constructs a master with a pitch-zone-first `Claims` and asserts the resulting row's `master` is non-null, guarding the end-to-end path the platform uses.

Not tested: real stored check-478 XML (the DB was unreachable during investigation, per the plan), so the fixture encodes the symptom shape rather than the exact export. Acceptable given the constraint and the start-anchored matcher.

## Verification evidence (trusted, not re-run)

The coder reported, from `c:\Users\AndyDin\reporting-dashboard\reporting-ui`:
- `npx vitest --run lib/comparison/pitch-zone-stat.test.ts` → 1 file / 5 tests passed, matching the five cases in the file.
- `npx vitest --run lib/comparison` → 3 files / 16 tests passed (cross-exact 6, pitch-zone-stat 5, json-adapter 5).
- `npm run build` → Next.js 16.2.10 Turbopack, no TypeScript errors, 35 routes; a first run's `safeImageUrl` error was a stale `.next` cache and cleared after removing `.next`.

The evidence is specific and internally consistent with the files I read, so no spot-check was warranted.

## Scope note

Diffing against `main` surfaces the committed goal-timing fix `8f0f03e` (`json-adapter.ts`, `json-adapter.test.ts`, and the `STAT_START_OFFSETS`/`codeTime` goal-offset removal in `xml-compare.ts`). That is the fix for the user's 6:32-vs-7:52 goal symptom and must stay; it is out of scope for this pitch-zone review and was accepted as such by the orchestrator in the prior pass. The uncommitted working tree for the fix under review is only `xml-compare.ts` (the pitch-zone detector and parse change) plus the untracked `pitch-zone-stat.test.ts`.

</details>

<details>
<summary>File map</summary>

- `lib/comparison/xml-compare.ts` — adds `isPitchZoneLabel` + `PITCH_ZONE_BASES`; skips zone labels in stat selection; adds `if (!cleanStat) continue;` to drop zone-only instances. Exclusion guard and `EXCLUDED_COMPARE_LABELS` unchanged.
- `lib/comparison/pitch-zone-stat.test.ts` (new, untracked) — four parser cases + one `compareInstances` regression.

Out-of-scope in the `main` diff (separate committed goal fix `8f0f03e`, not part of this review): `lib/comparison/json-adapter.ts`, `lib/comparison/json-adapter.test.ts`, and the goal-offset portion of `xml-compare.ts`.

Full diff: `git diff HEAD` for the fix under review; `git diff main` for everything on the branch.

</details>
