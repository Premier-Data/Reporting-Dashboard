# Design — Overlap-scoped saved accuracy %

## Overview

The accuracy figures stored on a saved check (`accuracy`, `exact`,
`master_total`, and the whole `player_accuracy` JSON that feeds the Accuracy
History OVR/PASS/OFF/DEF/GK/OTH columns, analyst profiles and leaderboards) are
currently **full-game scoped**: every recompute path grades the analyst's
instances against the *entire* master instance set with no range filter. The
compare page's live OVERALL card, by contrast, grades over the **overlap
window** — the coded section an analyst actually worked on — so the same check
reads e.g. 94.8% on screen in Overlap mode but is saved as 46.7%.

The user has decided the stored number must **always** be overlap-scoped,
regardless of which Range the compare page happens to show at save time. This
design makes the overlap window a single shared, pure, deterministic function
and routes **all three** recompute paths (save/update, master-correction
propagation, and the historical backfill) through it, so none can silently
re-impose full-game scope. It changes **only what is stored**; the compare
page's live Range selector (Overlap / Custom / Full game) is untouched, so
users can still inspect any range on screen.

Because the overlap window is deterministically derivable from the two instance
sets, every path re-derives it from the stored source (XML or JSON event feed,
via `instancesFromRaw`). **No DB schema change** and **no persisted range
column** are needed (see "Why no schema change" below).

The design also records the resolution of the second requirement — treating
`catch` and `catches` as the same stat — which is already implemented and is
documented here with its no-regression reasoning and test coverage.

> **Revision note (v2).** This is a revision pass addressing
> `design-review.json` (2 HIGH, 3 MEDIUM, 4 NIT). The structural change versus
> v1 is the **canonicalise-then-scope** ordering (findings #1 and #2): the API
> layer now canonicalises the FULL instance sets first — with the *same*
> `canonicaliseTeams` arguments the compare page uses, including the master file
> name — and only then filters by `.mid`, so the stored Home/Away split is
> provably identical to the live Overlap view, not just the headline `both`
> figure. A per-finding resolution log is at the end of this document.
>
> **Revision note (v3).** Second review pass addressing the v2
> `design-review.json` (2 MEDIUM, 2 NIT). Changes: (1b) `updateAccuracyCheck` is
> now specified SEPARATELY from save with its full `row` object, its conditional
> `!== undefined` metadata writes preserved, and a stored-row analyst-XML
> fallback so an `xmlAnalyst`-less partial update can never blank a good row —
> plus call-site verification that the sole caller always passes both XMLs and
> the master-correction flow uses `propagateMasterCorrection`, not update. The
> backfill per-row body now shows the preserved `xmlErr`/`!xmlRow` fetch guard
> (skip-and-continue). Two NITs (length-0 early-return second leg; dropping the
> dead `analystWindow.source` field) are folded in. The v3 resolution log is at
> the very end.

## Technology stack (locked)

TypeScript, Next.js (App Router) client components, Supabase JS client
(`@/lib/supabase`) under the authenticated admin session, Vitest for pure-logic
tests. No new dependencies. Grading is **client-side only**: `instancesFromRaw`
→ `parseInstances` uses the browser `DOMParser` (and a JSON-feed parser for
`{`-prefixed payloads) and returns `[]` outside a browser, so the shared helper
and all recompute paths that touch the raw source run in the browser, exactly as
they do today. No change to that execution model.

## The canonical overlap window (requirement 1)

### What the compare page does today

`app/accuracy-compare/page.tsx` derives `analystWindow` from the two loaded
files (symbol `analystWindow`; current source):

```ts
const files = [master, analyst].filter(f => !!f && f.instances.length > 0);
if (files.length === 0) return null;
const smaller = files.reduce((a, b) =>
  b.instances.length < a.instances.length ? b : a);   // STRICT < : ties keep `a`
const mids = smaller.instances.map(i => i.mid);
return { start: Math.min(...mids), end: Math.max(...mids), source: smaller.name };
```

In `auto` (Overlap) mode `effectiveRange = { start, end }` of `analystWindow`,
and `inRange(i) = i.mid >= start && i.mid <= end` (**inclusive both ends**).

Crucially, the compare page builds `canonical` ONCE over the **full** sets, with
the master file name:

```ts
const canonical = useMemo(() => {
  if (!master || !analyst) return null;
  return canonicaliseTeams(master.instances, analyst.instances, tolerance, master.name);
}, [master, analyst, tolerance]);
```

and every live grade then filters that already-canonical set by `inRange`
before re-grading:

```ts
// result (OVERALL card):
compareInstances(canonical.master.filter(inRange), canonical.analyst.filter(inRange), tolerance, master?.name);
// playerAccuracy memo (OVR/PASS/… cards):
const cmp = compareInstances(canonical.master.filter(inScope), canonical.analyst.filter(inScope), tolerance);
computePlayerAccuracy(cmp.rows);
```

Note two things that matter for the stored path:

1. The player-accuracy memo's `compareInstances` call omits the file-name
   argument. That is **safe only because** its inputs (`canonical.master/…`)
   are *already* Home/Away-labelled by the one full-set `canonicaliseTeams`
   call above, and `compareInstances`' internal re-canonicalisation hits the
   **idempotency guard** (see below) and passes them through unchanged. So the
   live Home/Away labels are the product of a **full-set, with-file-name**
   canonicalisation. Note the guard has a precondition: it requires BOTH sides
   non-empty (`arr.length > 0`). When scoping (or a team filter) empties one
   side, the guard does NOT fire — but `canonicaliseTeams` then hits its
   `mTeams.length === 0 || aTeams.length === 0` early return and likewise passes
   the instances through unchanged. So labels are preserved in every scoped case
   by one of these two legs; a refactor must keep BOTH (finding #3). The scoped
   stored path relies on the same two-leg guarantee.
2. The window is derived from **raw** `master.instances` / `analyst.instances`
   (pre-canonicalisation), keyed only on `.mid` and `.length`. Because
   `canonicaliseTeams` only relabels `team` and never touches `.mid`, the window
   selects the identical rows whether applied before or after canonicalisation.

### Why the v1 "scope then canonicalise" ordering was wrong (findings #1, #2)

`canonicaliseTeams` (`lib/comparison/xml-compare.ts`) derives the Home/Away
mapping **from the instance set it is handed** — `topTwoTeams` frequency order,
a `coOccur` time-alignment tally, `parseHomeAwayFromFileName` +
`teamNameSimilarity`, and a **frequency fallback** when the file name is not
usable. Running it on the overlap **subset** (fewer instances) can therefore
resolve Home/Away differently than running it on the **full** set and then
filtering. Mid-based filtering commutes with relabeling for *row selection*, but
NOT for the Home/Away *labels*. v1 canonicalised the subset, so stored
`player_accuracy.home` / `.away` could disagree with the live Overlap view even
when `both` agreed — violating the user's "saved == what I see in Overlap mode"
requirement for the home/away scopes.

The compare page avoids this precisely because it canonicalises the full set
once (with the file name) and the second, subset-level `compareInstances` call
hits this guard in `canonicaliseTeams`:

```ts
// Idempotency guard: if the instances are ALREADY canonicalised (teams are only
// "Home"/"Away"/""), pass them through unchanged rather than re-deriving labels
// from the subset (which could flip Home/Away).
const isCanon = (arr) => arr.length > 0 && arr.every(i => {
  const t = normTeam(i.team); return t === "home" || t === "away" || t === "";
});
if (isCanon(master) && isCanon(analyst)) return { master, analyst, mapped: true, displayNames: {home:null,away:null} };
```

### The fix: canonicalise FULL sets first, then scope by `.mid`

The stored path mirrors the compare page exactly. Canonicalise the full
master/analyst sets with the **same arguments** the page uses
(`canonicaliseTeams(master, analyst, tol, fileNameMaster)` — note the master
file name is passed, matching the page's `canonical`), then filter the
*already-canonical* instances by the overlap window, then grade. Because the
scoped inputs are already Home/Away-only, both the downstream `compareInstances`
and `computePlayerAccuracyByScope` re-canonicalisations hit the idempotency
guard and preserve the full-set labels. The Home/Away split is then provably the
same labels the live Overlap view shows.

### Shared pure helper

Add a new module `lib/comparison/overlap-window.ts` (pure, no DOM, no Supabase)
exporting the window math. It operates on `.mid`/`.length` only and is agnostic
to whether teams are raw or canonical, so it can be applied either before or
after `canonicaliseTeams`:

```ts
import type { Instance } from "./xml-compare";

export type OverlapWindow = { start: number; end: number; source: "master" | "analyst" };

/**
 * The overlap window = [min(mid), max(mid)] of whichever instance set has
 * FEWER instances (the coded section). Mirrors the compare page's analystWindow
 * EXACTLY: strict `<` on length so a tie keeps `master` (the first candidate),
 * min/max over `.mid`, inclusive bounds. Returns null when neither side has
 * instances (caller then treats scope as "no filter" / ungradeable).
 */
export function deriveOverlapWindow(
  master: Instance[],
  analyst: Instance[]
): OverlapWindow | null {
  const candidates: Array<{ arr: Instance[]; source: "master" | "analyst" }> = [];
  if (master.length > 0) candidates.push({ arr: master, source: "master" });
  if (analyst.length > 0) candidates.push({ arr: analyst, source: "analyst" });
  if (candidates.length === 0) return null;
  // STRICT `<` to match the page's reduce: a tie keeps the earlier candidate
  // (master), identical to `[master, analyst].reduce(...)`.
  const smaller = candidates.reduce((a, b) => (b.arr.length < a.arr.length ? b : a));
  let start = Infinity;
  let end = -Infinity;
  for (const i of smaller.arr) {
    if (i.mid < start) start = i.mid;
    if (i.mid > end) end = i.mid;
  }
  return { start, end, source: smaller.source };
}

/** Inclusive both ends — identical to the page's inRange. */
export function inOverlap(i: Instance, w: OverlapWindow): boolean {
  return i.mid >= w.start && i.mid <= w.end;
}

/**
 * Filter a master+analyst pair to the overlap window. Call this on sets that
 * are ALREADY canonicalised (so the Home/Away labels match the full-set live
 * view). When the window can't be derived (one side empty) returns the inputs
 * unchanged — the downstream grader then yields a 0-master, ungradeable result,
 * matching today's behaviour.
 */
export function scopeToOverlap(
  master: Instance[],
  analyst: Instance[]
): { master: Instance[]; analyst: Instance[]; window: OverlapWindow | null } {
  const window = deriveOverlapWindow(master, analyst);
  if (!window) return { master, analyst, window: null };
  return {
    master: master.filter((i) => inOverlap(i, window)),
    analyst: analyst.filter((i) => inOverlap(i, window)),
    window,
  };
}
```

Tie-break parity: the compare page's
`[master, analyst].reduce((a, b) => b.length < a.length ? b : a)` keeps `a`
(master) on a tie because the test is strict `<`; the helper pushes master first
and uses the same strict `<`, so it keeps master on a tie too. This is asserted
by a permanent property test (Testing item 2).

### Aligning the compare page (confirm "saved == what I see in Overlap mode")

To guarantee the live Overlap view and the stored value derive the *same* window
from the *same* inputs, repoint the page's `analystWindow` useMemo at the shared
helper, preserving the display `source` string:

```ts
const analystWindow = useMemo(() => {
  if (!master || !analyst) return null;
  const w = deriveOverlapWindow(master.instances, analyst.instances);
  if (!w) return null;
  return { start: w.start, end: w.end };   // only .start/.end are ever read
}, [master, analyst]);
```

The `source` field is **dropped** (finding #4): a grep for `analystWindow.source`
returns no matches — nothing reads it — so it was dead state. Only
`analystWindow.start`/`.end` are consumed (the manual-range placeholders and
`effectiveRange`), and both are preserved unchanged. If a future debugging need
arises, the discriminant is still available on the helper's `OverlapWindow.source`
without reintroducing it on the memo.

This is the only change to `app/accuracy-compare/page.tsx`. It does **not** touch
`rangeMode`, `effectiveRange`, `inRange`, `canonical`, or any live-view grading
`useMemo` — `effectiveRange` still honours full/manual/auto exactly as now. It
only moves the auto-window math into the shared function so there is a single
definition.

`source` previously held `smaller.name` (the file name) but was **never read**
(verified: a grep for `analystWindow.source` across
`app/accuracy-compare/page.tsx` returns no matches), so it is dropped from the
refactored memo rather than re-mapped (findings #4 and #6). The helper still
exposes `OverlapWindow.source` as a `"master" | "analyst"` discriminant for the
tests and any future debugging. `analystWindow.start`/`.end` are read for the
manual-range placeholders and for `effectiveRange`; both are unchanged.

Equivalence is bounded precisely: the helper reproduces the page's window
*selection and bounds*; the Home/Away *labels* match because both paths
canonicalise the FULL sets with the master file name BEFORE scoping (next
section). Both facts are covered by tests.

## Overlap-scoped stored player_accuracy AND summary (requirement 2)

The stored summary columns (`accuracy`, `exact`, `master_total`, the Ex/Mas
pair) come from a `ComparisonResult` the **caller** produced. At save/update
that result reflects the live Range selector; at propagate it is a fresh
full-game `compareInstances`. These disagree, and neither is guaranteed to be
overlap. The player_accuracy JSON is computed separately. The fix makes BOTH the
summary and the player_accuracy flow from a single API-layer derivation keyed off
the stored source, so they always agree with each other and with the live
Overlap view.

Introduce one internal helper in `lib/api/accuracyChecks.ts`. It is the single
source of truth for every stored accuracy field:

```ts
import { canonicaliseTeams } from "@/lib/comparison/xml-compare";
import { scopeToOverlap } from "@/lib/comparison/overlap-window";
import { computePlayerAccuracyByScope } from "@/lib/comparison/player-accuracy";

/**
 * Deterministic overlap-scoped grade of a check. Canonicalise the FULL sets
 * first (SAME canonicaliseTeams arguments the compare page uses, incl. the
 * master file name), THEN scope to the overlap window, THEN grade over the
 * scoped-and-already-canonical sets. compareInstances / computePlayerAccuracyByScope
 * re-canonicalise, but hit the idempotency guard and preserve the full-set
 * Home/Away labels — so the stored both/home/away split matches the live
 * Overlap view, not just the headline. Returns null when ungradeable (missing
 * or empty master after parse). Pure given (xml, tolerance, fileName).
 */
function gradeOverlapScoped(
  xmlMaster: string | null | undefined,
  xmlAnalyst: string | null | undefined,
  tolerance: number | null | undefined,
  fileNameMaster: string | null | undefined
) {
  const masterRaw = instancesFromRaw(xmlMaster);
  const analystRaw = instancesFromRaw(xmlAnalyst);
  if (masterRaw.length === 0) return null;
  const tol = tolerance ?? 3;
  const name = fileNameMaster ?? null;

  // 1. Canonicalise the FULL sets, exactly like the page's `canonical`.
  const canon = canonicaliseTeams(masterRaw, analystRaw, tol, name);

  // 2. Scope the ALREADY-canonical sets by mid.
  const scoped = scopeToOverlap(canon.master, canon.analyst);

  // 3. Grade over the scoped sets. Both calls re-canonicalise, hit the
  //    idempotency guard (inputs are Home/Away-only), and pass through — so the
  //    labels are the full-set labels, matching the live view.
  const result = compareInstances(scoped.master, scoped.analyst, tol, name);
  const playerAccuracy = computePlayerAccuracyByScope(scoped.master, scoped.analyst, tol, name);
  return { result, playerAccuracy };
}
```

`computeStoredPlayerAccuracy` is reimplemented as a thin wrapper so existing
callers keep working while sharing the identical derivation:

```ts
function computeStoredPlayerAccuracy(xmlMaster, xmlAnalyst, tolerance, fileNameMaster) {
  try {
    return gradeOverlapScoped(xmlMaster, xmlAnalyst, tolerance, fileNameMaster)?.playerAccuracy ?? null;
  } catch (err) {
    console.error("Failed precomputing player_accuracy:", err);
    return null;
  }
}
```

**Argument parity assertion (findings #1, #2).** The stored path calls
`canonicaliseTeams(master, analyst, tol, fileNameMaster)` — identical argument
list to the page's `canonical`. The downstream `compareInstances` /
`computePlayerAccuracyByScope` receive already-canonical inputs, so their own
re-canonicalisation is a no-op (idempotency guard). The live view's labels come
from the same full-set, with-file-name canonicalisation. Therefore
`both`/`home`/`away` and the headline summary are all derived from identical
Home/Away labels on identical rows. This is asserted by a fixture test with a
file name present and a team whose coded-count order differs within the overlap
window vs the full game (Testing item 7).

Because the summary and the player_accuracy now come from the *same* scoped,
same-labelled instances in the *same* function, the Ex/Mas pair and the OVR
column can no longer disagree, and both match the Overlap-mode view.

## All three recompute paths use the shared derivation (requirement 3)

1a. **`saveAccuracyCheck`** — replace the `computeStoredPlayerAccuracy(...)`
   call and the `s = input.result.summary` usage with a single
   `gradeOverlapScoped(input.xmlMaster, input.xmlAnalyst, input.tolerance,
   input.fileNameMaster)` call. Write the full column set from it:

   ```ts
   const graded = gradeOverlapScoped(input.xmlMaster, input.xmlAnalyst, input.tolerance, input.fileNameMaster);
   const s = graded?.result.summary;
   const row = {
     ...meta,
     accuracy: s?.accuracy ?? null, master_total: s?.masterTotal ?? null, analyst_total: s?.analystTotal ?? null,
     exact: s?.exact ?? null, wrong_stat: s?.wrongStat ?? null, wrong_player: s?.wrongPlayer ?? null,
     wrong_team: s?.wrongTeam ?? null, missed: s?.missed ?? null, extra: s?.extra ?? null, avg_time_drift: s?.avgTimeDrift ?? null,
     category_breakdown: graded?.result.byCategory ?? null,
     team_breakdown: graded?.result.byTeam ?? null,
     player_accuracy: graded?.playerAccuracy ?? null,
     xml_master: input.xmlMaster ?? null, xml_analyst: input.xmlAnalyst ?? null, ...
   };
   ```

   The `category_breakdown` / `team_breakdown` now come from `graded.result`, so
   the stored breakdowns are overlap-scoped and consistent with the headline
   (same rows). See finding #4 note below on the History consumers.

   **Fallback (finding #5).** `gradeOverlapScoped` returns null only when the
   source is unparsable or the master parses empty. Because grading is
   client-side with `DOMParser`, this is effectively unreachable in the real
   save flow (the user is in the browser having just graded the file on screen);
   it would only occur if the XML were corrupt. When it does occur the design
   does **not** fall back to the range-dependent `input.result.summary` (that
   would store an unknown-scope row and silently break the "always overlap"
   invariant). Instead: write the accuracy columns and `player_accuracy` as
   **null** (an explicit "not graded yet" marker — the same shape backfill
   already treats as fillable), keep the raw `xml_master`/`xml_analyst`, and
   `console.warn` that the row was saved ungraded. The row is then reconciled by
   the next backfill run (which, running in the browser, can parse it). The save
   is never blocked. State surfaced to the UI: the save succeeds but the History
   OVR/Ex/Mas cells read blank until backfill, exactly like a pre-player_accuracy
   row today.

1b. **`updateAccuracyCheck`** — specified SEPARATELY from save because its
   input shape and null-grade risk differ (finding #1). `UpdateAccuracyCheckInput`
   marks `xmlAnalyst`, `fileNameMaster`, and `tolerance` **optional**, and the
   function conditionally writes `master_analyst_name` / `analyst_name` /
   `match_label` / `file_name_master` / `file_name_analyst` / `tolerance` /
   `xml_analyst` / `video_url` / `sport` only when the corresponding input field
   is `!== undefined`. All of that MUST be preserved; only the accuracy /
   breakdown / `player_accuracy` sources change to the overlap-scoped grade.

   **Call-site verification (resolves finding #1 via option (c), with option (a)
   as defense-in-depth).** There is exactly ONE caller of `updateAccuracyCheck`
   in the codebase — `handleUpdate` in `app/accuracy-compare/page.tsx` (the
   "Update check" button). Verified it always passes `xmlAnalyst: analyst?.raw
   ?? null`, `fileNameMaster: master?.name ?? null`, and `tolerance`. The
   dispute / "override master" master-correction flow (`handleOverrideMaster`)
   does **not** call `updateAccuracyCheck` at all — it calls
   `propagateMasterCorrection` (path 2 below). So in practice the update path
   always has the analyst XML and would produce a real overlap-scoped grade, not
   a null one. The review's regression scenario (a dispute update omitting
   `xmlAnalyst`) does not exist against the current call graph.

   Because the TYPE still permits an `xmlAnalyst`-less call, the design adds a
   guard so the invariant cannot be violated by a future caller: when
   `gradeOverlapScoped` returns null **specifically because `input.xmlAnalyst`
   was not provided** (as opposed to being provided-but-unparsable), re-derive
   the analyst side from the STORED row before grading, so the update stays
   overlap-scoped instead of blanking a previously-good row. Fetch
   `xml_analyst`, `file_name_master`, `tolerance` for `input.id`, then grade with
   the input value where present and the stored value as fallback:

   ```ts
   // Prefer the overlap-scoped grade from the input. If the analyst XML was not
   // passed (dispute-style partial update), fall back to the stored row's
   // analyst XML / file name / tolerance so we never blank a good row.
   let graded = gradeOverlapScoped(input.xmlMaster, input.xmlAnalyst, input.tolerance, input.fileNameMaster);
   if (!graded && input.xmlAnalyst === undefined) {
     const { data: cur } = await supabase
       .from("accuracy_checks")
       .select("xml_analyst, file_name_master, tolerance")
       .eq("id", input.id)
       .single();
     if (cur) {
       const c = cur as { xml_analyst: string | null; file_name_master: string | null; tolerance: number | null };
       graded = gradeOverlapScoped(
         input.xmlMaster,
         c.xml_analyst,
         input.tolerance ?? c.tolerance,
         input.fileNameMaster ?? c.file_name_master
       );
     }
   }
   const s = graded?.result.summary;

   const row: Record<string, unknown> = {
     accuracy: s?.accuracy ?? null, master_total: s?.masterTotal ?? null, analyst_total: s?.analystTotal ?? null,
     exact: s?.exact ?? null, wrong_stat: s?.wrongStat ?? null, wrong_player: s?.wrongPlayer ?? null,
     wrong_team: s?.wrongTeam ?? null, missed: s?.missed ?? null, extra: s?.extra ?? null, avg_time_drift: s?.avgTimeDrift ?? null,
     category_breakdown: graded?.result.byCategory ?? null,
     team_breakdown: graded?.result.byTeam ?? null,
     xml_master: input.xmlMaster,
     player_accuracy: graded?.playerAccuracy ?? null,
   };
   // PRESERVED verbatim — conditional writes only when provided:
   if (input.masterAnalystName !== undefined) row.master_analyst_name = input.masterAnalystName?.trim() || null;
   if (input.analystName !== undefined) row.analyst_name = input.analystName?.trim() || null;
   if (input.matchLabel !== undefined) row.match_label = input.matchLabel?.trim() || null;
   if (input.fileNameMaster !== undefined) row.file_name_master = input.fileNameMaster ?? null;
   if (input.fileNameAnalyst !== undefined) row.file_name_analyst = input.fileNameAnalyst ?? null;
   if (input.tolerance !== undefined) row.tolerance = input.tolerance ?? null;
   if (input.xmlAnalyst !== undefined) row.xml_analyst = input.xmlAnalyst ?? null;
   if (input.videoUrl !== undefined) row.video_url = input.videoUrl?.trim() || null;
   if (input.sport !== undefined) row.sport = input.sport ?? null;
   ```

   The one deliberate difference from save's fallback: because the stored-row
   fallback recovers the analyst XML, a null grade on update is now only
   reachable when `input.xmlMaster` itself is unparsable OR the stored row also
   has no analyst XML — a genuinely ungradeable row. In that case the same
   null-grade rule as save applies (null accuracy columns + null
   `player_accuracy` + `console.warn`; never a range-dependent fallback), and
   the row is reconciled by the next backfill. The update is never blocked. The
   fetch is a single-row read on `input.id` and only runs on the (effectively
   unreachable) `xmlAnalyst === undefined` + null-grade branch, so it adds no
   cost to the normal "Update check" path.

2. **`propagateMasterCorrection`** — today it grades `compareInstances(master,
   analystInstances, tol, fileNameMaster)` and `computePlayerAccuracyByScope(
   master, analystInstances, …)` over the **full** corrected master per row.
   Replace both with one `gradeOverlapScoped(xmlMaster, row.xml_analyst,
   row.tolerance, fileNameMaster)` per row and write summary + breakdowns +
   player_accuracy from it (same column list as save). Keep writing
   `xml_master: xmlMaster` so the corrected master is persisted. On
   `gradeOverlapScoped === null` for a row, skip that row's accuracy columns the
   same way as the save fallback (null + warn) rather than aborting the whole
   propagation; the Supabase-error path is unchanged (throw). This is the path
   that most needs the fix: without it, the next master correction silently
   rewrites every sibling check back to full-game scope.

3. **`backfillPlayerAccuracy` / `recomputeAllPlayerAccuracy`** — the per-row body
   currently computes only `pa = computeStoredPlayerAccuracy(...)` and writes
   only `{ player_accuracy: pa }`. Rewrite it to grade once and write the full
   overlap-scoped column set so a backfilled row is never left half-converted
   (overlap player_accuracy + full-game accuracy/exact/master_total). The list
   query is unchanged (`select("id, tolerance, file_name_master")`, with the
   `force ? all : .is("player_accuracy", null)` branch preserved), and the
   per-row XML is still fetched one row at a time.

   **The existing per-row XML-fetch guard MUST be preserved (finding #2).**
   Today the loop does `if (!xmlErr && xmlRow) { ... } else { skipped += 1; if
   (xmlErr) console.error(...) }`. The rewrite keeps that guard FIRST so a
   per-row fetch error can never dereference a null `xmlRow` and abort the whole
   run — it is counted `skipped` and the loop continues. Explicit per-row body:

   ```ts
   // One row at a time — xml blobs are large (unchanged fetch).
   const { data: xmlRow, error: xmlErr } = await supabase
     .from("accuracy_checks")
     .select("xml_master, xml_analyst")
     .eq("id", row.id)
     .single();

   // PRESERVED fetch guard: a per-row fetch error is skipped, never fatal.
   if (xmlErr || !xmlRow) {
     skipped += 1;
     if (xmlErr) console.error(`Backfill XML fetch failed ${row.id}:`, xmlErr);
     onProgress?.({ done: i + 1, total: rows.length });
     continue;
   }

   const graded = gradeOverlapScoped(
     (xmlRow as AccuracyCheckXml).xml_master,
     (xmlRow as AccuracyCheckXml).xml_analyst,
     row.tolerance,
     row.file_name_master
   );
   if (!graded) {
     skipped += 1;                 // null grade -> leave row untouched, never partial-write
     onProgress?.({ done: i + 1, total: rows.length });
     continue;
   }

   const s = graded.result.summary;
   const { error: upErr } = await supabase.from("accuracy_checks").update({
     accuracy: s.accuracy, master_total: s.masterTotal, analyst_total: s.analystTotal,
     exact: s.exact, wrong_stat: s.wrongStat, wrong_player: s.wrongPlayer,
     wrong_team: s.wrongTeam, missed: s.missed, extra: s.extra, avg_time_drift: s.avgTimeDrift,
     category_breakdown: graded.result.byCategory ?? null,
     team_breakdown: graded.result.byTeam ?? null,
     player_accuracy: graded.playerAccuracy,
   }).eq("id", row.id);
   if (!upErr) updated += 1; else { skipped += 1; console.error(`Backfill update failed ${row.id}:`, upErr); }
   onProgress?.({ done: i + 1, total: rows.length });
   ```

   Three skip-and-continue branches (fetch error, null grade, update error) all
   count the row `skipped`, call `onProgress`, and continue — none throws, so a
   single bad row never aborts a bulk run (matching the existing contract and the
   Error-handling section). Both the summary columns AND `player_accuracy` are
   written in the single per-row `update`, so a row is either fully
   overlap-scoped or untouched — never a mix. Re-running produces identical
   values (idempotent). The existing `force` semantics are unchanged:
   `force=false` still only fills rows missing `player_accuracy` (now with the
   full column set), `force=true` (`recomputeAllPlayerAccuracy`) overwrites every
   row.

All three now share one derivation (`gradeOverlapScoped` → `canonicaliseTeams`
(full) → `scopeToOverlap` → `deriveOverlapWindow` → grade), so there is exactly
one definition of "overlap" and one Home/Away labelling across save, propagate
and backfill.

### Finding #4 — History breakdown consumers under overlap scope

Verified in `app/accuracy-checks/page.tsx`. The stored breakdowns now become
overlap-scoped; confirming no consumer cross-references a full-game total:

- **Category breakdown panel** renders `check.category_breakdown.map(...)` as
  per-category rows (label + its own exact/master ratio). No cross-reference to
  `master_total`. Internally consistent under overlap.
- **Team breakdown panel** renders `check.team_breakdown.filter(t => t.masterTotal > 0).map(...)`
  as per-team ratios. The `masterTotal > 0` filter is per-team and remains valid
  under overlap. No cross-reference to the headline total.
- **Ex/Mas column** (`c.exact / c.master_total`) and the summary stat tiles
  (`master_total`, `analyst_total`, etc.) all read the SAME overlap-scoped
  summary that `gradeOverlapScoped` wrote, so they stay mutually consistent.
- **`masterTotalMismatches` banner** compares `master_total` ACROSS sibling
  checks (same `file_name_master`) to flag a re-coded master. Under overlap each
  row's `master_total` is the master-instance count *within that check's overlap
  window*; sibling checks of the same master can legitimately have different
  overlap windows (different coded sections), so this banner may fire more
  often. It is advisory only (a "click to inspect" prompt, not a correctness
  gate) and does not block anything. **This is the one visible behavioural
  change and is called out as a manual-verify item**, not asserted as a no-op:
  an admin should confirm the banner's heuristic is still useful post-backfill,
  and if it becomes noisy, a follow-up can switch it to compare parsed full
  master counts (via `diagnoseMasterConsistency`, which already parses XML) rather
  than the now-overlap-scoped stored `master_total`. No change is made to it in
  this task.

## Historical backfill (requirement 4)

Existing stored rows are full-game and must be re-scoped. The mechanism is the
existing admin-triggered **`recomputeAllPlayerAccuracy`** (a thin
`backfillPlayerAccuracy(onProgress, force=true)` wrapper), already wired to a
button on the Accuracy History page and already structured to run one row at a
time with progress (to dodge Postgres statement timeouts on large XML blobs).
With the per-row body above it now rewrites BOTH the overlap-scoped summary
columns AND `player_accuracy` for every row, so a single admin run re-scopes
every historical check.

- The bulk run is **admin-triggered in-app** and cannot be executed from this
  environment (it needs the browser `DOMParser`/JSON parser and the
  authenticated Supabase session). This design does not run it; it makes the
  button do the right thing.
- **Until an admin runs it, Accuracy History mixes overlap-scoped-new rows
  (saved/propagated after this change) with full-game-old rows (not yet
  backfilled).** This is expected and acceptable; the backfill converges every
  row to overlap scope. The run is idempotent, so it can be repeated safely.
- `force=false` (null-only fill) is left for the original one-time population
  use; the re-scope uses `force=true` to overwrite existing values.

No new admin UI is required beyond the existing recompute button; optionally its
label/confirmation copy can note "re-scopes historical checks to the overlap
section" so the admin understands the effect, but that is cosmetic.

## Live compare view is unchanged (requirement 5)

The only edit to `app/accuracy-compare/page.tsx` is repointing `analystWindow`
at the shared helper. `rangeMode`, `effectiveRange`, `inRange`, the Range
selector UI, `canonical`, and the live OVERALL / player-accuracy / breakdown
`useMemo`s keep working exactly as now — users can still switch to Full game or
Custom on screen. Only the API-layer write path forces overlap scope. The live
"Update check" button still passes its `ComparisonResult` in, but
`updateAccuracyCheck` now ignores that result's summary for the stored accuracy
columns and re-derives everything from the overlap-scoped source inside
`gradeOverlapScoped` (falling back to the stored row's analyst XML if the input
omits it — see path 1b), so what lands in the row is overlap regardless of the
on-screen Range at the moment of saving. The conditional `!== undefined` writes
for the optional metadata fields (label, analysts, video, sport, etc.) are
unchanged, so a partial update still only touches the fields it was given.

## Why no schema change (persisted range column rejected)

The overlap window is a pure function of the two stored instance sets
(`deriveOverlapWindow`), and both `xml_master` and `xml_analyst` are already
persisted on every row. Either column may hold XML or a JSON event feed;
`instancesFromRaw` handles both (`{`-prefixed → JSON parser, else DOMParser) and
the window math is `.mid`-based and format-agnostic, so re-derivation from the
stored source is sound for every row regardless of format. A persisted range
column would:

- add a migration and a column that can drift out of sync with the source it is
  meant to describe (e.g. after a master correction changes the instance set),
  reintroducing exactly the stale-column class of bug `fixStaleMasterTotals`
  already exists to clean up;
- require save, propagate and backfill to all write it consistently — the same
  coordination problem deterministic re-derivation solves for free.

Deterministic re-derivation is strongly preferred and chosen. No schema change.

## Second requirement — `catch` / `catches` treated as the same stat

**Status: already implemented and tested** (landed in `baseAction`). Documented
here for completeness and to lock the approach.

Where the normalisation belongs: stat-equality for scoring lives in `baseAction`
(`lib/comparison/xml-compare.ts`), which `sameBaseAction` uses to decide an
"exact" stat match. The fix canonicalises the plural to the singular inside
`baseAction`:

```ts
.replace(/\bcatches\b/g, "catch")
```

so a master `Catch` and an analyst `Catches` (either direction) collapse to the
same base action and score **exact** at the same time + player. This is the
correct layer: it is the single chokepoint both the live compare and the stored
player-accuracy grade flow through (`computePlayerAccuracyByScope` →
`compareInstances` → `sameBaseAction`), so the overlap-scoped stored numbers
inherit it automatically — no separate change needed in the API layer.

No-regression reasoning:

- The rule is **word-anchored** (`\bcatches\b`) and scoped to this one word, not
  blanket plural-stripping, so unrelated stats are not merged.
- `bumpFootball` in `player-accuracy.ts` already classifies both `catch` and
  `catches` into `gkCatches` via `s.includes("catch")` (substring covers both),
  so grouping is unaffected and consistent with the exact-match change.
- Existing coverage: `lib/comparison/cross-exact.test.ts` asserts master `Catch`
  vs analyst `Catches` scores `exact` and vice versa, alongside the pre-existing
  cross/pass base-action cases which still pass — guarding against regression to
  other stat matching.

## Error handling (concrete, per operation)

- **`instancesFromRaw` / `parseInstances` outside a browser, or empty master**
  → `instancesFromRaw` returns `[]`; `gradeOverlapScoped` returns null when
  `masterRaw.length === 0`. Save/update/propagate then write null accuracy
  columns + null `player_accuracy` (explicit "ungraded" marker, NOT a
  range-dependent fallback — finding #5) and `console.warn`; the save is not
  blocked and the row is reconciled by the next backfill. Backfill counts the
  row as `skipped` and leaves it untouched. Recoverable, no throw.
- **`updateAccuracyCheck` with `xmlAnalyst` omitted (null grade on the input)**
  → the update path first retries by fetching the stored row's `xml_analyst` /
  `file_name_master` / `tolerance` for `input.id` and grading from that
  (finding #1), so a partial update stays overlap-scoped. Only if that stored
  fallback is also ungradeable (unparsable master, or no stored analyst XML)
  does it fall to the null-grade marker above. The verified sole call site
  (`handleUpdate`) always passes `xmlAnalyst`, so this branch is defensive, not
  on the live path. The stored-row fetch error (if the `select` fails) leaves
  `graded` null and routes to the null-grade marker; no throw.
- **Backfill per-row XML fetch error** → the preserved `if (xmlErr || !xmlRow)`
  guard counts the row `skipped`, logs on `xmlErr`, calls `onProgress`, and
  `continue`s. It never dereferences a null `xmlRow` and never aborts the run
  (finding #2).
- **`deriveOverlapWindow` on an empty side** → returns null; `scopeToOverlap`
  passes the (canonical) inputs through unfiltered, and the downstream grade
  yields a 0-master ungradeable result — identical to today's empty-side
  outcome. Recoverable, no throw.
- **Malformed source (parse throws)** → caught in
  `computeStoredPlayerAccuracy`'s try/catch (returns null). `gradeOverlapScoped`
  itself is called inside save/update/propagate/backfill where a throw would be
  surfaced; it is wrapped so a parse throw degrades to the null-grade path
  above rather than aborting a save. Recoverable.
- **Supabase insert/update error** (save/update/propagate) → unchanged:
  `console.error` + `throw new Error(error.message ...)` (fatal to that call,
  surfaced to the caller's UI). The backfill loop logs and counts the row as
  `skipped` and continues (one bad row never aborts a bulk run). Matches the
  existing contract exactly.
- **Partial backfill interruption** → each row is written independently in one
  idempotent per-row `update`, so a re-run finishes the remainder and
  re-converges already-done rows to the same values. No transaction needed, and
  no row is ever half-converted (summary + player_accuracy written together).

## Input validation

- `tolerance` — optional; `?? 3` default preserved everywhere (unchanged).
- `fileNameMaster` — optional; `?? null` passed through to `canonicaliseTeams`
  on BOTH the full-set canonicalisation and the downstream re-grade (identical
  argument on every path — the parity requirement of findings #1/#2).
- `xmlMaster` / `xmlAnalyst` — required for a gradeable result; when either is
  missing/empty the grade returns null (handled above). No new limits imposed;
  blob size is already bounded by the one-row-at-a-time fetch strategy.
- `Instance.mid` — a finite number produced by `codeTime`; `deriveOverlapWindow`
  computes min/max over it. The non-empty guard in the helper ensures start/end
  are finite whenever a window is returned (never `±Infinity` bounds).

## Invariants and ownership

- **"Stored accuracy is overlap-scoped"** — owned by the API layer
  (`gradeOverlapScoped` in `lib/api/accuracyChecks.ts`). It is the only place
  that writes the accuracy columns + `player_accuracy`, so the invariant cannot
  be bypassed by a caller passing a differently-scoped `ComparisonResult`. The
  only escape hatch is the explicit null-grade marker, which is self-describing
  and reconciled by backfill.
- **"Stored Home/Away labels == live Overlap view"** — owned by the
  canonicalise-full-then-scope ordering inside `gradeOverlapScoped`, which feeds
  `canonicaliseTeams` the identical arguments the page's `canonical` uses and
  relies on the idempotency guard to preserve those labels through the scoped
  re-grade.
- **"One definition of the overlap window"** — owned by
  `lib/comparison/overlap-window.ts`; both the compare page and the API layer
  import it, so they cannot drift.
- **"save == propagate == backfill"** — follows from all three calling
  `gradeOverlapScoped`, pure given (source, tolerance, fileName).
- **Determinism / idempotency** — `deriveOverlapWindow`, `scopeToOverlap`,
  `canonicaliseTeams`, `compareInstances` and `computePlayerAccuracyByScope` are
  all pure functions of their inputs, so re-running any path on an unchanged row
  yields identical stored values.

## Files to change

- **New** `lib/comparison/overlap-window.ts` — `deriveOverlapWindow`,
  `inOverlap`, `scopeToOverlap`, `OverlapWindow` type. Pure, no DOM/Supabase.
- **New** `lib/comparison/overlap-window.test.ts` — pure-logic Vitest tests.
- `lib/api/accuracyChecks.ts` — add `gradeOverlapScoped` (canonicalise-full →
  scope → grade); reimplement `computeStoredPlayerAccuracy` over it; route
  `saveAccuracyCheck`, `updateAccuracyCheck`, `propagateMasterCorrection`, and
  the `backfillPlayerAccuracy` loop through it (summary + player_accuracy +
  breakdowns, full column list, null-grade = ungraded marker / skip).
  `updateAccuracyCheck` is spec'd separately (path 1b): preserve its conditional
  `!== undefined` metadata writes and add the stored-row analyst-XML fallback for
  `xmlAnalyst`-less partial updates. The backfill loop keeps its per-row
  `xmlErr`/`!xmlRow` fetch guard (skip-and-continue, never fatal).
- `app/accuracy-compare/page.tsx` — **only** repoint `analystWindow` at
  `deriveOverlapWindow`; no live-view behaviour change.
- `lib/comparison/xml-compare.ts` — **no change** (catch/catches already landed
  in `baseAction`; idempotency guard already present); listed only to note it is
  deliberately untouched for the comparison engine's core matching.

## Testing

Pure-logic (`lib/comparison/overlap-window.test.ts`, Vitest, no DOM):

1. **Window = fewer-instance file.** Master with 10 instances spanning
   mid 0–1000, analyst with 3 instances spanning mid 200–500 → window
   `{start:200,end:500,source:"analyst"}`. Swap sizes → source `"master"`.
2. **Tie keeps master (permanent property test, finding #8).** For randomized
   master/analyst length pairs — including equal lengths — assert
   `deriveOverlapWindow` selects the fewer-length array and, on a tie, `master`
   (`source === "master"`). This is the durable invariant that survives the page
   refactor, not a diff against a copied formula.
3. **Inclusive bounds.** An instance whose `mid` equals `start` or `end` is kept
   by `inOverlap`; one just outside is dropped.
4. **Empty side.** `deriveOverlapWindow([], analyst)` and `(master, [])` behave
   per spec; `scopeToOverlap` passes through with `window:null`.
5. **One-time parity with the compare page formula (finding #8).** Reproduce the
   page's prior inline `[master,analyst].reduce(...)` + min/max on fixtures and
   assert it equals `deriveOverlapWindow` — a one-time correctness check that the
   refactor preserved the window math. (Complemented by the permanent property
   test in item 2.)
6. **End-to-end scope effect.** On a fixture where the analyst coded only a
   sub-section of a full-game master, assert `compareInstances` over
   `scopeToOverlap(canonicaliseTeams(...))` yields a materially higher
   `exact/master` ratio than over the full sets (the 46.7% → ~94.8% behaviour),
   locking the semantics.
7. **Home/Away label parity canon-then-scope (findings #1, #2).** Fixture with a
   master file name present and two teams whose coded-count order DIFFERS within
   the overlap window versus the full game (so a subset-only canonicalisation
   would flip Home/Away). Assert that
   `gradeOverlapScoped`'s pipeline — `canonicaliseTeams(full, …, name)` then
   `scopeToOverlap` then grade — produces the SAME `home`/`away` split as
   canonicalising the full set, filtering by the same window, and grading
   (the live path). Also assert that scoping the subset FIRST and canonicalising
   AFTERWARD would differ (documents why the ordering matters, as a guard against
   regressing to v1).

What is unit-testable: everything in `overlap-window.ts`, the scoped-vs-full
grading contract, and the canon-then-scope label parity — all pure and
deterministic. What is **integration/manual only**: the Supabase writes in
save/update/propagate/backfill, the admin bulk re-scope run (need the browser
DOMParser + authenticated session), and the `masterTotalMismatches` banner
behaviour post-backfill (finding #4 manual-verify item). The design confines all
new logic to pure functions precisely so the risky data-semantics change is
covered by fast unit tests, with the DB plumbing kept as thin, unchanged-shape
calls.

The catch/catches behaviour remains covered by the existing
`lib/comparison/cross-exact.test.ts`; no change there.

## Out of scope

- The comparison engine's core matching (`compareInstances` / `codeTime` /
  stat-preference logic) beyond reusing it on overlap-filtered inputs.
- The compare page's live Range selector behaviour.
- Any DB schema/migration (deterministic re-derivation chosen instead).
- AFL player accuracy (football only, as today).
- Changing the `masterTotalMismatches` banner heuristic (flagged as a
  post-backfill manual-verify item; not altered here).

---

## Review-finding resolution log (v2)

- **#1 (HIGH) — scope-before-canon ≠ canon-before-filter for Home/Away labels.**
  ADDRESSED (preferred fix). `gradeOverlapScoped` now canonicalises the FULL
  sets first (`canonicaliseTeams(masterRaw, analystRaw, tol, name)`), then
  `scopeToOverlap` filters the already-canonical instances by `.mid`, then grades.
  The downstream re-canonicalisations hit the idempotency guard and preserve the
  full-set labels, so stored `home`/`away` provably match the live Overlap view.
  Testing item 7 asserts the label parity (and that the old ordering would
  differ).
- **#2 (HIGH) — live memo passes no master file name while stored path does.**
  ADDRESSED. Confirmed in source that the page builds `canonical` WITH
  `master.name`; the live player-accuracy memo's own `compareInstances` omits
  the name but operates on those already-canonical instances (idempotency
  guard), so the live labels are the with-file-name full-set labels. The stored
  path uses the identical `canonicaliseTeams(…, name)` arguments on the full set.
  Argument parity is stated explicitly ("Argument parity assertion") and tested
  (item 7).
- **#3 (MEDIUM) — backfill described as one-liner but writes only
  player_accuracy.** ADDRESSED. The backfill per-row body is now spelled out in
  full: `gradeOverlapScoped` → null ⇒ `skipped`/`continue` (never partial-write)
  → otherwise a single `update` writing the complete column set
  (`accuracy, master_total, analyst_total, exact, wrong_stat, wrong_player,
  wrong_team, missed, extra, avg_time_drift, category_breakdown, team_breakdown,
  player_accuracy`).
- **#4 (MEDIUM) — stored breakdown scope change vs History consumers.**
  ADDRESSED. Verified the category/team breakdown panels render per-row ratios
  only and the Ex/Mas + stat tiles read the same overlap-scoped summary (all
  internally consistent). The one genuine behavioural change — the
  `masterTotalMismatches` sibling banner — is explicitly called out as a
  manual-verify item with a documented follow-up option, not asserted as a no-op.
- **#5 (MEDIUM) — fallback can store a mixed-scope row.** ADDRESSED. The
  range-dependent `input.result.summary` fallback is removed. On a null grade the
  write stores null accuracy columns + null `player_accuracy` (an explicit
  "ungraded" marker) and warns; the row is reconciled by backfill. Stated that
  this path is effectively unreachable in the client save flow (DOMParser is
  present) and only triggers on corrupt source.
- **#6 (NIT) — `analystWindow.source` usage.** ADDRESSED. Grepped
  `analystWindow.source` → no matches; the field is written but never read, so
  the discriminant→name mapping is display-safe. Result stated in "Aligning the
  compare page".
- **#7 (NIT) — line numbers slightly off.** ADDRESSED. Exact line numbers
  removed; the design now refers to stable symbol names (`analystWindow`,
  `canonical`, the player-accuracy memo).
- **#8 (NIT) — parity test guards a reproduced formula.** ADDRESSED. The parity
  test is kept as a one-time check (item 5) and a permanent property test
  (item 2) is added: randomized length pairs including ties assert fewer-length
  selection and tie-keeps-master.
- **#9 (NIT) — "re-derive from XML" under-describes JSON-fed rows.** ADDRESSED.
  Prose now says "re-derive from the stored source (XML or JSON event feed, via
  `instancesFromRaw`)" and the no-schema-change rationale notes the window math
  is format-agnostic.

## Review-finding resolution log (v3 — second review's findings)

- **#1 (MEDIUM) — `updateAccuracyCheck` not re-specified for its real
  optional-field / dispute-flow shape; null-grade rule could blank a good row.**
  ADDRESSED with options (c) + (a) combined. Verified against source: the ONLY
  caller of `updateAccuracyCheck` is `handleUpdate` in
  `app/accuracy-compare/page.tsx`, which always passes `xmlAnalyst`,
  `fileNameMaster`, and `tolerance`; the dispute / "override master" flow
  (`handleOverrideMaster`) calls `propagateMasterCorrection`, NOT
  `updateAccuracyCheck`. So the regression scenario does not exist on the current
  call graph (option c). Because the TYPE still marks those fields optional,
  path 1b additionally adds a guard (option a): on a null grade caused by
  `input.xmlAnalyst === undefined`, re-derive the analyst side from the stored
  row before grading, so a future partial caller stays overlap-scoped instead of
  blanking the row. The full `row` object is now shown with the conditional
  `!== undefined` metadata writes preserved verbatim and only the
  accuracy/breakdown/`player_accuracy` sources changed to `graded`.
- **#2 (MEDIUM) — backfill per-row body dropped the XML-fetch-error guard.**
  ADDRESSED. The spelled-out backfill body now leads with the preserved
  `if (xmlErr || !xmlRow) { skipped += 1; … continue; }` guard before any
  dereference, then null-grade skip, then the single full-column update, each
  branch counting `skipped` + `onProgress` + `continue`. Stated explicitly that
  a per-row XML-fetch error is counted skipped and never aborts the run,
  reconciling the body with the Error-handling section.
- **#3 (NIT) — idempotency-guard argument omitted the length-0 early-return
  second leg.** ADDRESSED. "What the compare page does today" note 1 now states
  that the guard requires both sides non-empty, and that when scoping empties a
  side the `mTeams/aTeams.length === 0` early return preserves labels instead —
  so both legs must survive a refactor.
- **#4 (NIT) — refactored `analystWindow` returned a dead `source` field.**
  ADDRESSED. The field is dropped from the memo (nothing reads it); the
  discriminant remains available on the helper's `OverlapWindow.source` for tests
  / future debugging. Noted in "Aligning the compare page".
