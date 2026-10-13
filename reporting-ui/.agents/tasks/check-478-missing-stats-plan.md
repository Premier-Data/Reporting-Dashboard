# Implementation Plan — Fix soccer master stats dropped when a pitch-zone label precedes the real stat

## Context and root cause (confirmed from code)

Symptom (check 478, SOCCER): the platform's master column starts at `03:25 Goal Kicks Successful`, dropping three real early stats — `Claimed` (0:52), `Keeper Throw Successful` (0:55), `Shot Off Target` (3:04). `Start Half 1` is correctly excluded as a half marker.

Root cause is in `parseInstances()` in `c:\Users\AndyDin\reporting-dashboard\reporting-ui\lib\comparison\xml-compare.ts`. The label loop assigns the stat/category from the FIRST label whose group is not `Team`/`Player`:

```ts
else if (!stat) {
  // First non-meta label is treated as the stat + category.
  category = group;
  stat = text;
}
```

The instance is then dropped by the exclusion guard a few lines later:

```ts
if (isExcludedCompareLabel(cleanStat) || isExcludedCompareLabel(category)) continue;
```

where `EXCLUDED_COMPARE_LABELS` includes the pitch zones `penalty box`, `back/middle/front third`. When an instance's XML lists its pitch-zone label (e.g. group/text `Penalty Box`, `Front Third`) BEFORE the real stat label, the pitch zone is captured as `stat`/`category` and the whole instance is dropped. Later events (e.g. `Goal Kicks Successful`) survive because their real stat label comes first. This exactly matches the reported symptom. The fixture `lib/comparison/__fixtures__/National League North 2026_08_full_Chester FC_Merthyr Town FC.xml` confirms the label shape: `Team` and `Player` labels first, then `<label><group>Category</group><text>Stat</text></label>`.

Design decisions for the fix (one or two sentences each):
- **Fix in the stat-selection step, not the exclusion guard.** Make the loop SKIP a label as a stat candidate when that label is a pitch-zone/excluded marker and keep scanning, so the first REAL stat label wins. This is the minimal change that preserves the existing drop behaviour for genuine markers.
- **Keep the final exclusion guard unchanged.** Start Half / End Half / Substitution instances carry no real stat label after the marker, so `stat` stays empty/excluded and the existing `isExcludedCompareLabel` guard still drops them — the fix must not let those through.
- **Match pitch zones tolerant of suffixes.** The symptom shows zone labels like `Penalty Box (a)` and `Front Third 116,`, which do NOT equal the bare set entries, so skipping must match a zone PREFIX (and/or the group name), not just an exact string. The existing exact-match `EXCLUDED_COMPARE_LABELS` set is kept for the final guard (half/sub markers are exact); a separate pitch-zone prefix check drives the skip.
- **JSON adapter needs no change.** In `json-adapter.ts`, each event carries a single explicit `statTypeCode`/`statTypeName`; a pitch zone would be its own event, not a competing label on the same event, so there is no "first label wins" ambiguity. `jsonEventsToInstances` already drops only events whose own stat code/name is excluded. This is documented in the plan but not modified.

READ-ONLY note: the DB was not reachable in the investigation step (no stored findings file was produced), so the exact stored XML for check 478 is not in-repo. The fix is written defensively against the symptom; its unit test encodes the exact affected events as a fixture so the behaviour is pinned regardless.

---

# Implementation Plan

- [ ] 1. Add a pitch-zone detector and make `parseInstances` skip pitch-zone labels when selecting the stat, so the first REAL stat label wins.
      In `lib/comparison/xml-compare.ts`: add a small helper near `isExcludedCompareLabel` (e.g. `isPitchZoneLabel(group, text)`) that normalises (lowercase, trim, collapse whitespace) and returns true when the group OR text STARTS WITH one of the pitch-zone bases (`back third`, `middle third`, `front third`, `penalty box`) — tolerant of trailing suffixes like `(a)` / ` 116,`. Then change the label loop's `else if (!stat)` branch so a label that is a pitch zone (via `isPitchZoneLabel(group, text)`) is NOT taken as the stat; the loop continues scanning subsequent labels for the first non-pitch-zone, non-Team/Player label, which becomes `category`/`stat`. Leave the post-loop exclusion guard (`isExcludedCompareLabel(cleanStat) || isExcludedCompareLabel(category)`) exactly as-is so Start Half / End Half / Substitution (and instances that are ONLY a pitch zone with no real stat) are still dropped.
      Files: c:\Users\AndyDin\reporting-dashboard\reporting-ui\lib\comparison\xml-compare.ts
      Verify: `npm test` (vitest) still passes with no regressions in `lib/comparison/*.test.ts`; this item is covered by the new test added in item 2. Build check in item 4.

- [ ] 2. Add a unit test that pins the check-478 behaviour: instances whose pitch-zone label precedes the real stat are KEPT, while half/substitution markers are still dropped.
      Create a new test file following the existing `cross-exact.test.ts` style (vitest + jsdom from `vitest.config.ts`, so `parseInstances`' DOMParser works). Build small raw-XML `<instance>` blocks mirroring the real label order and feed them through `parseInstances`. Cover: (a) an instance with `<label><group>Penalty Box</group><text>Penalty Box (a)</text></label>` BEFORE `<label><group>Goal Keeper</group><text>Claims</text></label>` parses to a KEPT instance with `stat === "Claims"` / `category === "Goal Keeper"`; (b) the same for a `Front Third 116,` zone before `Shots Off Target`; (c) a `Start Half 1` marker instance is still dropped (not present in output); (d) an instance that is ONLY a pitch-zone label (no real stat after it) is still dropped. Assert the kept-instance count and the specific `stat`/`category` values.
      Files: c:\Users\AndyDin\reporting-dashboard\reporting-ui\lib\comparison\pitch-zone-stat.test.ts (new)
      Verify: `npx vitest run lib/comparison/pitch-zone-stat.test.ts` — all new cases pass; they FAIL against the pre-item-1 code (red/green confirms the fix).

- [ ] 3. Add a focused regression test confirming the pitch-zone-first instances now flow through `compareInstances` and appear on the master side (not missed by exclusion).
      In the same new test file (or a sibling `describe`), construct a master set containing a pitch-zone-first `Claims` instance plus a later `Goal Kicks Successful`, and a matching analyst set, then call `compareInstances(master, analyst, 3, "Home vs Away")` and assert the early `Claims` instance produces a row (its master is non-null) rather than being absent. This guards the end-to-end path the platform uses, not just the parser.
      Files: c:\Users\AndyDin\reporting-dashboard\reporting-ui\lib\comparison\pitch-zone-stat.test.ts
      Verify: `npx vitest run lib/comparison/pitch-zone-stat.test.ts` — the comparison case passes; the master row for the early stat is present.

- [ ] 4. Confirm the full suite and the production build are green.
      No new code in this step; it is the verification gate for items 1-3.
      Files: (none)
      Verify: run `npm test` (expect all comparison tests, including the new file, to pass) and `npm run build` (Next.js 16 build completes with no type errors). Per the workspace rule, this Next.js has breaking changes vs training data — if the build surfaces a Next.js API/config issue, consult `node_modules/next/dist/docs/` before changing anything; the fix here touches only plain TS parsing logic, so no Next.js API changes are expected.

---

## Notes for the implementer
- Do NOT loosen the exclusion guard or remove any entry from `EXCLUDED_COMPARE_LABELS`; half markers and substitutions must still be excluded.
- The `json-adapter.ts` path (`jsonEventsToInstances` / `isExcludedStatLabel`) is intentionally left unchanged — it has no multi-label-per-event ambiguity. If a future JSON feed were found to attach a pitch zone as the event's own `statTypeCode`/`statTypeName`, that would be a separate issue.
- The pitch-zone prefix matching should remain conservative (anchored at the start of the normalised group/text) so it never swallows unrelated stats that merely contain a zone word.
