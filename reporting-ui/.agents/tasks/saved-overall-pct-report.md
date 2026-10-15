# Findings: Saved "OVR %" vs Compare-page "OVERALL %" discrepancy

READ-ONLY investigation. No code was changed. All line numbers below are from
the files as they exist on branch `main` (HEAD `46b274f`).

Files traced:
- `app/accuracy-compare/page.tsx` (Range selector, overlap filter, Save/Update handlers, cards)
- `lib/comparison/player-accuracy.ts` (`computePlayerAccuracy`, `computePlayerAccuracyByScope`)
- `lib/comparison/xml-compare.ts` (`compareInstances` / `summary.accuracy`)
- `lib/api/accuracyChecks.ts` (`saveAccuracyCheck`, `updateAccuracyCheck`, `computeStoredPlayerAccuracy`, `propagateMasterCorrection`)
- `app/accuracy-checks/page.tsx` (Accuracy History columns)

---

## 1. Summary answer (the crux)

The compare page's **"OVERALL 94.8% (254/268)"** card and the Accuracy
History **"OVR 46.7%"** column are the SAME metric *formula* (exact-match
player accuracy, `exact / master`, from `computePlayerAccuracy`) but computed
over **different instance sets**:

- **Compare card = OVERLAP-scoped.** The cards on the compare page compute
  player accuracy over the instances left after the Range filter (`inRange`),
  which in "Overlap" mode is just the analyst's coded window (467 master / 600
  analyst instances in your example). See `playerAccuracy` useMemo,
  `app/accuracy-compare/page.tsx:2044-2056`.

- **Saved OVR = FULL-GAME-scoped.** The value stored in `player_accuracy`
  (which the History "OVR" column reads) is recomputed from the **entire raw
  master/analyst XML with NO range filter** at save time. See
  `computeStoredPlayerAccuracy` → `computePlayerAccuracyByScope`,
  `lib/api/accuracyChecks.ts:131-154`. Because the full master has ~1600
  instances and the analyst only coded ~596, the ~1000 un-coded master events
  all count as non-exact (missed), dragging OVER­ALL down to 46.7%.

So the discrepancy is **NOT** a difference between "player accuracy" and
"`exact/masterTotal`". It is the **same player-accuracy calculation run over two
different scopes**: overlap (card) vs full game (saved). The user's hunch is
essentially correct — the saved number is a full-game figure while the card is
overlap-scoped — but the specific stored field that drives the History "OVR"
column is `player_accuracy.both.overall.pct`, not `exact/master_total`.

### Important correction about the two History columns

The History row actually shows TWO separate numbers that must not be conflated:

| History column | Source in code | What it is |
|---|---|---|
| `OVR / PASS / OFF / DEF / GK / OTH` | `storedGroupPct(c, key)` → `check.player_accuracy.both[key].pct` (`app/accuracy-checks/page.tsx:214-221, 1322`) | Exact-match **player accuracy**, FULL-game scope, per group |
| `Ex/Mas` (e.g. `411/487`) | `c.exact` / `c.master_total` (`app/accuracy-checks/page.tsx:1335`; sort key `app/accuracy-checks/page.tsx:574-575`) | The comparison **summary** (`summary.exact / summary.masterTotal`) |

The brief read these as one metric ("OVR 46.7%, EX/MAS 411/487"). They are
two different stored fields. `411/487` is the saved `summary.accuracy`
numerator/denominator; `46.7%` is `player_accuracy.both.overall.pct`. (As a
sanity check, `411/487 ≈ 84.4%`, which is not 46.7%, confirming they are
independent values.)

---

## 2. Every "overall %" / accuracy number in the flow

### (a) Comparison engine `summary.accuracy` — `lib/comparison/xml-compare.ts`

- `compareInstances(masterRaw, analystRaw, tolerance, masterFileName)` builds
  `summary` at `lib/comparison/xml-compare.ts:1415-1429`.
- `masterTotal = master.length` (`:1297`) — the count of master instances
  **passed in** (after any filtering the caller applied).
- `exact = count("exact")` (the exact-match rows).
- `accuracy = masterTotal > 0 ? exact / masterTotal : 0` (`:1426`).

So `summary.accuracy` = exact ÷ (number of master instances supplied). It is
NOT inherently full-game or overlap — it depends entirely on what the caller
passes. See §3 for who passes what.

### (b) "Golden Player Accuracy" cards (OVERALL/PASSING/OFF/DEF/GK/OTH)

- Produced by `computePlayerAccuracy(rows)` (`lib/comparison/player-accuracy.ts:376-420`),
  which runs `buildGroup` per group.
- Each group `pct = exact / master` where `master` = master instances **in the
  supplied `rows`** whose stat belongs to that group, and `exact` = those the
  analyst matched exactly (`buildGroup`, `lib/comparison/player-accuracy.ts:300-345`;
  `pct` at `:340`).
- **OVERALL** spans the four CORE groups (Passing + Offensive + Defensive +
  Goalkeeper), EXCLUDING "Other", unless the check has no core events at all
  (`:398-414`). So OVERALL 254/268 = exact 254 of 268 in-scope core master
  events.
- Scope is decided by the CALLER, which filters instances **before** comparing.
  On the compare page the caller applies the active Range + team filter
  (`playerAccuracy` useMemo, `app/accuracy-compare/page.tsx:2044-2056`), so the
  card is **range-scoped** (overlap when Range = Overlap).

### (c) History table columns — `app/accuracy-checks/page.tsx`

- `OVR/PASS/OFF/DEF/GK/OTH` → `storedGroupPct(c, key)` →
  `check.player_accuracy.both[key].pct` (`:214-221`, rendered `:1322-1334`).
  These read the STORED `player_accuracy` JSON — full-game scope (see §3).
- `Ex/Mas` → `c.exact` / `c.master_total` (rendered `:1335`), i.e. the stored
  `summary.exact / summary.masterTotal` from the `accuracy_checks` row.
- The analyst averages, trend chart, all-analyst comparison, and problem-area
  analysis ALL read `storedGroupPct(...)` / `check.player_accuracy` (e.g.
  `averageGroups` `:239-262`, `trendData` `:... storedGroupPct`,
  `analystComparison` `:823-826`, `analystRecommendations` `:... pa.both`), so
  the full-game player-accuracy value is what propagates to the profile.

---

## 3. Role of the Range selector, and what gets SAVED

### Range selector state

- `rangeMode: "auto" | "full" | "manual"` (`app/accuracy-compare/page.tsx:902-905`).
  UI buttons: "Overlap" → `auto`, "Custom" → `manual`, "Full game" → `full`
  (`:2645-2676`).
- `analystWindow` = min/max `mid` of the **file with fewer instances** (the
  coded section) (`:1755-1770`).
- `effectiveRange` (`:1771-1781`): `full` → `[-∞, +∞]`; `manual` → parsed
  start/end; `auto` → `analystWindow` (the overlap).
- `inRange(i)` = `i.mid >= start && i.mid <= end` (`:1783-1784`).

### What the live view computes (all range-scoped)

- `result` (summary + rows shown): `compareInstances(canonical.master.filter(inRange),
  canonical.analyst.filter(inRange), ...)` (`:1813-1825`). **Range-scoped.**
- `playerAccuracy` (the cards): compares `canonical.*.filter(inScope)` where
  `inScope = inRange(i) && team filter` (`:2044-2056`). **Range-scoped.**

So on screen, both the summary and the cards honour the Range selector. In
"Overlap", both reflect the coded window.

### What actually gets SAVED (the mismatch)

`handleSaveCheck` (`:2220-2266`) and `handleUpdateCheck` (`:2270-2302`) pass:

- `result` → the **range-scoped** summary (because `result` is built from
  `inRange`-filtered instances). The code comment at `:2240-2242` says it saves
  "the full-window result (not the team/category-scoped one)", but that only
  means it skips the *team/category* filter — it still carries the active
  **Range** filter. So `summary.accuracy`, `exact`, `master_total` saved to the
  row ARE whatever Range was selected at save time (overlap, custom, or full).
- `xmlMaster` / `xmlAnalyst` → the **raw, unfiltered** XML (`master?.raw`,
  `analyst?.raw`).

Then inside `saveAccuracyCheck` / `updateAccuracyCheck`, the stored
`player_accuracy` is recomputed by `computeStoredPlayerAccuracy(xmlMaster,
xmlAnalyst, tolerance, fileNameMaster)` (`lib/api/accuracyChecks.ts:192-197`,
`269-274`). That helper does:

```
master = instancesFromRaw(xmlMaster)   // FULL file, no range filter
analyst = instancesFromRaw(xmlAnalyst) // FULL file, no range filter
computePlayerAccuracyByScope(master, analyst, tol, fileNameMaster)
```

(`lib/api/accuracyChecks.ts:131-154`; `computePlayerAccuracyByScope` at
`lib/comparison/player-accuracy.ts:449-480` — it canonicalises and compares the
whole files, with no concept of a time range.)

**Conclusion for §3:** The stored `player_accuracy` (what the History
OVR/PASS/… columns read, and what feeds every profile aggregate) is **ALWAYS
computed over the FULL game, regardless of the Range selected** — the Range
selector has no effect on it. The stored `summary` (`accuracy` / `exact` /
`master_total`, i.e. the `Ex/Mas` column) DOES follow the selected Range at save
time. This split is the root cause of the discrepancy.

---

## 4. Why 46.7% (saved OVR) vs 94.8% (compare card) differ so much

- Compare card OVERALL (94.8%, 254/268): `computePlayerAccuracy` over the
  **overlap** window — only the ~467 master instances inside the analyst's
  coded section are in `rows`, of which 268 are core-group master events, and
  254 matched exactly.
- Saved OVR (46.7%): `computePlayerAccuracyByScope` over the **full** master
  (~1600 instances). Every core-group master event in the un-coded ~2/3 of the
  game has no analyst counterpart → counts in the denominator but not as exact,
  so OVERALL collapses to ~46.7%.

This confirms the user's diagnosis in spirit, with one precision: the saved
number that tanks is `player_accuracy.both.overall.pct` (full-game exact-match
player accuracy), **not** `summary.accuracy` (`exact/master_total`). Both the
`Ex/Mas` summary and the `OVR` player-accuracy exist on the row; the profile
columns surface the player-accuracy one.

(Note on the `411/487` in the screenshot: if that row was saved while Range =
Full game, both the summary AND the player-accuracy are full-game. If it was
saved in Overlap, the summary would be overlap-scoped (~254/268-ish) while the
player-accuracy OVR would still be full-game. Either way, the OVR column is
full-game-scoped and that is what reads 46.7%.)

---

## 5. Recommendation (NOT implemented)

Goal: make the SAVED check % that lands on the analyst's profile reflect the
**overlap-scoped** player-accuracy OVERALL (e.g. 94.8%) that the user sees on
the compare card, instead of the full-game 46.7%.

### Where the fix lives

The single point to change is **what instance set `player_accuracy` is computed
from at save/update time**. Today `computeStoredPlayerAccuracy`
(`lib/api/accuracyChecks.ts:131-154`) always uses the full XML. To make the
saved value match the card, the overlap/range scoping that
`app/accuracy-compare/page.tsx` already applies must be carried into the stored
computation. Options, in order of smallest blast radius:

1. **Persist the already-correct card value.** The compare page already
   computes the range-scoped `playerAccuracy` (`:2044-2056`) and also knows the
   home/away canonical split. Compute the range-scoped `StoredPlayerAccuracy`
   on the page (all three scopes, filtered by `inRange`) and pass it into
   `saveAccuracyCheck` / `updateAccuracyCheck` as an explicit field, instead of
   letting `computeStoredPlayerAccuracy` recompute from raw XML. This makes
   "saved == what I see" exactly, with no server-side range logic.

2. **Thread a range into the save path.** Add an optional
   `{ rangeStart, rangeEnd }` to `SaveAccuracyCheckInput` /
   `UpdateAccuracyCheckInput`, filter `master`/`analyst` by `mid` inside
   `computeStoredPlayerAccuracy` before `computePlayerAccuracyByScope`, and have
   the compare page pass `effectiveRange`. Keeps computation server-side but
   requires persisting the range so backfill/propagate can reuse it.

### Decisions the user MUST make

- **Always overlap, or follow the Range at save time?** The cleanest and most
  defensible rule is: the saved profile % = the overlap window (the section the
  analyst actually coded), ALWAYS — because grading an analyst on sections they
  never coded is what produces the misleading 46.7%. If instead it should
  follow whatever Range is selected, the save path must persist the chosen
  range (otherwise re-grades/backfills can't reproduce it).
- **Does the summary (`Ex/Mas`, `accuracy`) also become overlap-only?** The
  summary already follows the selected Range at save time. If the profile should
  be fully consistent, both should use the same scope.

### Knock-on effects to account for

- **`propagateMasterCorrection`** (`lib/api/accuracyChecks.ts:... ~360-392`)
  recomputes `summary` and `player_accuracy` from the full master with NO range
  — it would re-introduce the full-game 46.7% on every master correction unless
  it is given/stores each check's range. This is the biggest trap: a fix in the
  save path alone will be silently undone the next time a master is corrected.
- **`backfillPlayerAccuracy` / `recomputeAllPlayerAccuracy`**
  (`lib/api/accuracyChecks.ts:~1201+`, `~1266+`) also recompute from full XML
  with no range. They must either persist/reuse the range or they will overwrite
  corrected values with full-game ones.
- **Existing stored `player_accuracy`** on historical rows is full-game. A
  one-time backfill (that knows each check's overlap window) is required for old
  checks to show the new number; otherwise History will mix overlap-scoped new
  checks with full-game old ones.
- **Profile aggregates / leaderboards** (`averageGroups` `:239-262`,
  `summariseByAnalyst` `lib/api/accuracyChecks.ts:1411+`, `analystComparison`,
  `trendData`, `analystRecommendations`) all read the stored
  player-accuracy/summary; they need no logic change but WILL shift materially
  once the stored values change — expect every analyst's historical average to
  jump. Flag this to stakeholders before backfilling.
- **To persist the range** for reproducible re-grades, a new column (e.g.
  `range_start` / `range_end`, or a `range_mode`) on `accuracy_checks` is
  effectively required; without it, propagate/backfill cannot recreate the
  overlap window and consistency breaks.

### Minimal-risk path

Option 1 (persist the card's already-computed range-scoped
`StoredPlayerAccuracy`) + add a persisted range column so
`propagateMasterCorrection`, `backfillPlayerAccuracy`, and
`recomputeAllPlayerAccuracy` can re-scope identically, then a one-time backfill.
Confirm with the user whether "overlap always" is the intended rule before any
implementation.
