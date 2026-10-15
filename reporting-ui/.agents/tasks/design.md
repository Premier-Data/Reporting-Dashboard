# Design: Merge / move checks between saved masters

## Overview

Add an admin-only action to the accuracy-compare "Manage saved masters" dialog
that MOVES every accuracy check attached to one saved master (the **source**)
onto another saved master (the **destination**), then RE-GRADES the destination
group against the destination master's XML using the app's existing
overlap-scoped grading path. After the move the source master name has no active
checks left, so it disappears from the saved-master dropdown, and all of its
checks live under the destination name graded against the destination master.

The real use case is a master that was accidentally uploaded twice, producing
two dropdown entries for the same fixture. Because the two masters are
effectively identical, re-grading the moved checks against the destination
yields the same scores — but the operation MUST re-grade regardless, so a moved
check is never left tagged to the destination name while still graded against
the source XML.

This is a destructive, bulk, data-mutating operation on production accuracy
checks. The design below pins down the exact mutation sequence, the
failure-ordering guarantee, the overlap-scoped re-grade, the pure logic to add
and unit-test, and the dialog UX.

### Technology stack (locked)

- TypeScript, React 19 Client Component (`"use client"`), Next.js App Router.
  Per `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`,
  state, `useEffect`, and `onClick`/`onChange` event handlers require a Client
  Component; `ManageMastersDialog.tsx` is already `"use client"` and this
  feature only adds more event-handler-driven interactions to it.
- Supabase JS client (`@/lib/supabase`) for all data access, invoked directly
  from client event handlers. **NO Server Actions, NO Route Handlers** — this
  matches the locked decision and the entire existing `lib/api/accuracyChecks.ts`
  data layer.
- Vitest for the pure-logic unit tests (mirrors the existing
  `master-manage-logic.test.ts` pattern).

### Scope constraint

Only three files change (plus the logic test):

- `lib/api/accuracyChecks.ts` — add `mergeMasters(...)` and its
  `MergeMastersResult` interface. **`mergeMasters` MUST be defined in this file**
  because its re-grade loop calls the module-private `gradeOverlapScoped`, which
  is declared `function gradeOverlapScoped(...)` with no `export`. It must NOT
  be exported solely to let `mergeMasters` live elsewhere — co-locating keeps the
  single grader private and keeps the merge re-grade byte-identical to
  `propagateMasterCorrection`.
- `app/accuracy-compare/master-manage-logic.ts` — add pure helpers
  (`validMergeDestinations`, `canMergeInto`).
- `app/accuracy-compare/master-manage-logic.test.ts` — add their unit tests.
- `app/accuracy-compare/ManageMastersDialog.tsx` — add the per-row
  "Move all checks into…" action, destination picker, confirm, busy/message,
  and `onChanged` refresh. The matching `onChanged` union extension also lands
  in `app/accuracy-compare/page.tsx` — but see the note below.

> **Page-handler note.** The task's scope list names only
> `accuracyChecks.ts`, `ManageMastersDialog.tsx`, and `master-manage-logic.ts`
> (+ test). Wiring the new `onChanged` `merge` case requires a matching union
> arm and branch in `app/accuracy-compare/page.tsx` (the consumer of
> `onChanged`). This is a mechanical, additive extension of the existing
> `rename|delete|replace` handler — mirroring the `delete` branch — not a new
> architectural decision. The design calls it out so it is not treated as an
> out-of-scope surprise. Extend the `onChanged` union with the `merge` arm (the
> single instruction, no fallback): it mirrors the existing `delete` branch
> exactly and is the consistent choice.

No DB schema change. No change to the comparison engine
(`lib/comparison/xml-compare.ts`), the overlap-window helper
(`lib/comparison/overlap-window.ts`), disputes, or any unrelated file.

---

## Background: what the existing code already gives us

Read against the actual sources in this worktree.

### `resolveActiveGroupIds(fileName)` (`lib/api/accuracyChecks.ts`)

Returns the ids of the active (`deleted_at IS NULL`) rows that belong to the
same **normalized group** (`trim()` + case-insensitive) as `fileName`. It uses
a loose server-side `ilike` prefilter, then narrows with the JS `sameMasterName`
filter so the id set is exactly the dropdown's grouping. `mergeMasters` uses it
to find the SOURCE group's ids. This is the correct id-targeting primitive —
never a bare `.eq` on the raw stored string.

### `renameMaster(oldFileName, newFileName)` (`lib/api/accuracyChecks.ts`)

Resolves the source group's ids, then — crucially — **rejects a collision with a
different existing active master**: if any active row OUTSIDE the group already
has the normalized `newFileName`, it throws
`A master named "…" already exists`. It targets rows by `.in("id", groupIds)`
and updates `file_name_master` only.

`mergeMasters` is conceptually "rename source → destination, but DELIBERATELY
ALLOW the collision renameMaster forbids, then also set `xml_master` and
re-grade." We do **not** call `renameMaster` (its collision guard is the whole
thing we need to bypass). We reuse its *mechanics*: resolve ids via
`resolveActiveGroupIds`, update by `.in("id", …)`.

### `propagateMasterCorrection(fileNameMaster, xmlMaster)` (`lib/api/accuracyChecks.ts`)

Loads every active check with that `file_name_master`, and for each one calls
`gradeOverlapScoped(xmlMaster, row.xml_analyst, row.tolerance, fileNameMaster)`,
writing summary + breakdowns + `player_accuracy` + `xml_master`. The analyst
side is untouched. **It `throw`s on the first per-row update error** (`if (upErr)
{ … throw … }`), so it is NOT resilient to a single bad row — the reason
`mergeMasters` inlines its own loop (§1 Step 4) rather than delegating to it.

**Overlap-scoped confirmation (REQUIRED by the task).** `gradeOverlapScoped`
(same file) is the single shared grader for save / update / propagate /
backfill. It canonicalises the full sets, then calls `scopeToOverlap(...)` from
`lib/comparison/overlap-window.ts` (which derives the window via
`deriveOverlapWindow`), then grades over the scoped sets. `propagateMasterCorrection`
calls `gradeOverlapScoped` for every row — therefore the propagate path **is
already overlap-scoped**. The merge re-grade reuses this exact function, so it
inherits the same overlap-scoped behaviour with no new grading code and no
full-game recompute path.

### `getSavedMasters()` / `getSavedMasterXml(checkId)` (`lib/api/accuracyChecks.ts`)

`getSavedMasters()` returns `SavedMaster[]` = `{ checkId, fileName, videoUrl }`,
de-duplicated by the normalized file name (`created_at desc`, **first-seen /
most-recent check wins**), lightweight (no XML blob). `getSavedMasterXml(checkId)`
fetches one master's raw `xml_master` on demand by the check id the
`SavedMaster` carries, returning `null` on error/missing.

> **Which destination XML the merge grades against.** `destCheckId` is the
> `SavedMaster.checkId` of the destination the admin picked, i.e. the destination
> group's **most-recent** master row's XML — the exact master the admin saw in
> the dropdown. Step 4 then brings the WHOLE destination group onto that one XML
> (see Step 4's side-effect note). This is deliberate: the destination master is
> treated as a single source of truth, and the most-recent row defines it.

### `master-manage-logic.ts`

Pure helpers with unit tests (`master-manage-logic.test.ts`): `sameMasterName`
(the one grouping rule), `normalizeMasterName`, `isValidMasterName`,
`isMasterDeletable`, `masterAffordance(count, isAdmin)`. The data layer inlines
character-identical copies of the three equality/validation helpers. We add new
pure helpers here.

### `ManageMastersDialog.tsx` + page wiring

Admin-gated dialog (`isAdmin` → `masterAffordance`). Each row has a lazily
fetched advisory `count: number | null` (via `countActiveGroupSiblings` in the
mount effect; starts `null`, filled async), per-row `busy`, `message`, and
sub-UI flags (`editing`, `replacing`). Mutations run from event handlers and on
success call `onChanged({ type, … })` then the dialog shows a message
(`handleReplaceFile` is the template: it composes
`` `Replaced. Re-graded ${res.updated} check${…}${res.analysts.length ? ` (${res.analysts.join(", ")}).` : "."}` ``).
The page's `onChanged` (in `app/accuracy-compare/page.tsx`) is a
`rename|delete|replace` union; each arm keeps the in-view `master` consistent
and always calls `refreshSavedMasters()` → `getSavedMasters()` →
`setSavedMasters`. We extend the union with a `merge` case.

---

## 1. Data layer: `mergeMasters(...)`

Add to `lib/api/accuracyChecks.ts` (and nowhere else — see Scope, re the private
`gradeOverlapScoped`).

```ts
export interface MergeMastersResult {
  /** Active source rows re-tagged onto the destination. */
  moved: number;
  /** Active destination-group rows re-graded (includes the moved ones). */
  regraded: number;
  /** Distinct analyst names across the re-graded destination group. */
  analysts: string[];
}

export async function mergeMasters(
  sourceFileName: string,
  destFileName: string,
  destCheckId: number,
): Promise<MergeMastersResult>
```

`destCheckId` is passed in from the `SavedMaster` the admin picked, so the exact
destination XML holder is unambiguous (two dropdown entries can differ only by
case/space; the id removes any doubt).

### Sequence (exact, ordered for the failure guarantee)

**Step 0 — Normalize + guard inputs (pure, pre-DB).**

```ts
const destName = normalizeMasterName(destFileName); // defined ONCE, up front
```

`destName` is the single normalized destination value used by every subsequent
step — the value Step 3 writes into `file_name_master` and the value Step 4
keys its reload on. (`sourceFileName` is passed as-is to `resolveActiveGroupIds`,
which normalizes internally for the group match.)

- If `sameMasterName(sourceFileName, destFileName)` → **throw**
  `"Source and destination are the same master."` (A merge into self is a
  no-op/error; guards the degenerate case.) This mirrors the pure
  `canMergeInto` helper (§3) so the UI never even offers it, but the data layer
  re-guards authoritatively.

**Step 1 — Resolve the SOURCE group ids.**
`const sourceIds = await resolveActiveGroupIds(sourceFileName);`
If `sourceIds.length === 0` → **return** `{ moved: 0, regraded: 0, analysts: [] }`
(nothing active to move; idempotent no-op — e.g. a double-click after the first
merge already emptied the source). The UI treats a zero result as "already
moved / nothing to do".

**Step 2 — Fetch the DESTINATION XML and confirm the destination is real.**
`const destXml = await getSavedMasterXml(destCheckId);`
If `destXml == null` → **throw** `"Destination master has no stored XML."`
Then confirm the destination still has ≥1 active check:
`const destIds = await resolveActiveGroupIds(destFileName);`
If `destIds.length === 0` → **throw**
`"Destination master has no active checks."`
Both guards run BEFORE any write, so a missing/empty destination aborts with
zero mutations.

> **What the non-null XML guard does and does NOT guarantee.** Step 2 only
> checks `destXml == null`. A destination whose stored `xml_master` is a
> non-null but *unparsable* blob passes this guard, the source rows still move
> (Step 3), and then every re-grade returns `gradeOverlapScoped(...) === null`,
> writing null-accuracy markers across the whole group. This is NOT a
> regression — it is exactly how `propagateMasterCorrection`/`backfill` behave
> on an unparsable master today, and it is reconciled by a later backfill. The
> guard confirms the destination row *exists and holds some XML*; it does not
> parse or validate that XML. (`getSavedMasters` only lists masters whose check
> has non-null `xml_master`, so a null here is already defensive.)

**Step 3 — Re-tag the source rows onto the destination (single update, name +
XML together).** Set BOTH `file_name_master` AND `xml_master` in the SAME
update, so there is never an intermediate state where a row carries the
destination NAME but the source XML:

```ts
const { data: movedRows, error } = await supabase
  .from("accuracy_checks")
  .update({ file_name_master: destName, xml_master: destXml })
  .in("id", sourceIds)
  .select("id");
if (error) {
  console.error("mergeMasters: failed re-tagging source rows:", error);
  throw new Error(error.message || "Failed to move checks.");
}
const moved = movedRows?.length ?? 0;
```

Targeting by `.in("id", …)` uses the resolved id list (never a raw `.eq`), and
the WHERE touches only the source group (`deleted_at` already respected —
`resolveActiveGroupIds` filtered it, so soft-deleted source rows are
intentionally left behind under the old name and do NOT move). Because
name + XML moved together, the moved rows are already internally consistent
(destination name, destination XML; Step 4 recomputes their summary from that
XML).

> **Why name + XML in one update, then re-grade — the failure-ordering
> guarantee.** The forbidden end-state is "row tagged to destination NAME but
> its stored `xml_master`/summary reflect the SOURCE master." Writing
> `file_name_master` and `xml_master` in the same statement makes the moved
> rows' XML already match the destination the instant they adopt the
> destination name. Step 4 then recomputes the summary columns from that XML. If
> the process dies between Step 3 and Step 4, the moved rows hold the
> destination name AND the destination XML; their summary columns are briefly
> the old (source-graded) numbers — but since the real use case is identical
> duplicate masters those numbers are already equal, and in all cases a re-run
> of the merge (idempotent) or a `propagateMasterCorrection` / `backfill` over
> the destination fully reconciles them. There is NEVER a window where the
> stored `xml_master` disagrees with `file_name_master`.

**Step 4 — Re-grade the WHOLE destination group, overlap-scoped, resilient.**

This is the single, normative implementation. (A delegating variant was
considered and rejected — see "Rejected alternative (A)" below.) `mergeMasters`
runs its OWN re-grade loop that reproduces `propagateMasterCorrection`'s body
exactly — SAME `gradeOverlapScoped` grader, SAME column writes — but COLLECTS
per-row failures (logs and skips a failed row, continues) instead of throwing on
the first one. The error policy is the only difference.

The loop reloads the destination group by its **normalized id-list** — NOT a
bare `.eq("file_name_master", destName)`. `destName` is trim-only (`normalizeMasterName`
does not case-fold — confirmed in both `master-manage-logic.ts` and the inlined
copy in `accuracyChecks.ts`), whereas the dropdown's grouping rule folds in rows
whose stored `file_name_master` differs by case OR surrounding whitespace
(`sameMasterName` = `trim().toLowerCase()`, enforced by `resolveActiveGroupIds`).
A Postgres `.eq` is an exact, case- and whitespace-sensitive match, so a bare
`.eq(destName)` would MISS the destination's pre-existing rows stored under a
case/whitespace variant — leaving them neither re-tagged to `destXml`, nor
re-graded, nor counted in `regraded`, which directly contradicts this step's
"whole destination group" promise and under-reports the user-visible `regraded`
number. Instead, resolve the destination group's ids with the module's own
id-targeting primitive (consistent with Step 1 and Step 2) and select
`.in("id", destGroupIds)`. The moved source rows are included because Step 3 set
their `file_name_master` to `destName`, which normalizes into the same group:

```ts
// Resolve the destination group the SAME way Step 1/Step 2 resolve groups —
// normalized (trim + case-fold), NOT a bare .eq. This includes the moved
// source rows (Step 3 set them to destName) AND any destination rows stored
// under a case/whitespace variant, so "the whole destination group" is
// literally true and `regraded` is accurate.
const destGroupIds = await resolveActiveGroupIds(destName);
const { data: rows, error: loadErr } = await supabase
  .from("accuracy_checks")
  .select("id, analyst_name, tolerance, xml_analyst, file_name_master")
  .in("id", destGroupIds)
  .is("deleted_at", null);
if (loadErr) {
  console.error("mergeMasters: failed loading destination group:", loadErr);
  throw new Error(loadErr.message || "Failed loading destination checks.");
}

const analysts = new Set<string>();
let regraded = 0;

for (const row of (rows ?? []) as {
  id: number;
  analyst_name: string;
  tolerance: number | null;
  xml_analyst: string | null;
  file_name_master: string | null;
}[]) {
  // SAME overlap-scoped grader as save/update/propagate/backfill.
  const graded = gradeOverlapScoped(
    destXml,
    row.xml_analyst,
    row.tolerance,
    destName
  );
  if (!graded) {
    // Ungradeable row (empty/unparsable master or analyst): write the
    // null-accuracy marker and continue, exactly as propagateMasterCorrection
    // does — reconciled by a later backfill.
    console.warn(`mergeMasters: check ${row.id} ungradeable; writing null accuracy.`);
  }
  const s = graded?.result.summary;

  // Column object copied VERBATIM from propagateMasterCorrection so the two
  // paths cannot drift. xml_master is set to destXml (the whole group adopts
  // the destination master's XML — see side-effect note).
  const { error: upErr } = await supabase
    .from("accuracy_checks")
    .update({
      accuracy: s?.accuracy ?? null,
      master_total: s?.masterTotal ?? null,
      analyst_total: s?.analystTotal ?? null,
      exact: s?.exact ?? null,
      wrong_stat: s?.wrongStat ?? null,
      wrong_player: s?.wrongPlayer ?? null,
      wrong_team: s?.wrongTeam ?? null,
      missed: s?.missed ?? null,
      extra: s?.extra ?? null,
      avg_time_drift: s?.avgTimeDrift ?? null,
      category_breakdown: graded?.result.byCategory ?? null,
      team_breakdown: graded?.result.byTeam ?? null,
      xml_master: destXml,
      player_accuracy: graded?.playerAccuracy ?? null,
    })
    .eq("id", row.id);

  if (upErr) {
    // RESILIENT: a per-row failure is logged and SKIPPED, never thrown.
    // The row keeps the destination name + destination XML from Step 3
    // (consistent, just with possibly-stale summary numbers) and is excluded
    // from the regraded count so the summary reports the true re-graded total.
    console.error(`mergeMasters: re-grade failed for check ${row.id}:`, upErr);
    continue;
  }
  regraded += 1;
  if (row.analyst_name) analysts.add(row.analyst_name);
}

return { moved, regraded, analysts: Array.from(analysts) };
```

For the moved rows this is the operation's core correctness step: their
summary + `player_accuracy` + breakdowns are rewritten to be consistent with the
destination master. For the destination's original rows, see the side-effect
note — they are re-tagged onto `destXml` and re-graded too.

> **Side effect — the whole destination group is re-tagged to `destXml`
> (intended).** The loop selects EVERY active row in the destination's
> **normalized group** (`resolveActiveGroupIds(destName)` → `.in("id", …)`),
> which includes the destination's pre-existing checks — even those stored under
> a case/whitespace variant of `destName` — and writes `xml_master: destXml` on
> all of them. So the merge does not
> only move the source's checks: it makes the ENTIRE destination group's
> `xml_master` the picked destination XML (the most-recent destination row's).
> This is deliberate — the destination master is a single source of truth, and
> the merge consolidates the group onto one master XML (the same consolidation
> `propagateMasterCorrection` performs on any correction). If a destination row
> previously held a *different* `xml_master` (e.g. a prior partial replace),
> this merge overwrites it with `destXml` and re-grades it. That is the intended
> behaviour, not a bug; the alternative (re-grading only the moved `sourceIds`)
> was rejected because it would leave the destination group with mixed master
> XML, defeating the "consolidate duplicates under one master" purpose. The UI
> copy (§4) therefore reports **`moved`** (source rows that changed name) and
> **`regraded`** (whole group) as distinct numbers so "Moved N checks" can never
> imply more rows changed owner than did.

### Rejected alternative (A): delegate to `propagateMasterCorrection`

A tempting shorter Step 4 is `const prop = await propagateMasterCorrection(destName, destXml); return { moved, regraded: prop.updated, analysts: prop.analysts };`.
**Rejected.** `propagateMasterCorrection` `throw`s on the first per-row update
error, so one bad/locked row would abort the re-grade *after* the Step-3 move
already happened, stranding later rows source-graded until a retry. The task
requires "collect/report failures; a per-row update failure must not abort
silently." The inline loop above is the resilient implementation; it reuses the
same grader and the same column object, so correctness is identical and only the
error policy differs.

### Idempotency

Running `mergeMasters` twice is safe. The second run resolves an EMPTY source
group (its rows now carry the destination name) and returns
`{ moved: 0, regraded: 0, analysts: [] }` at Step 1 before any write. (A re-grade
on a second run would recompute identical numbers anyway.) There is no uniqueness
constraint and no transaction (out of scope); like `renameMaster`, the guard
reads are best-effort against a TOCTOU window, which the next `getSavedMasters()`
refresh surfaces for the admin.

---

## 2. Collision & semantics (explicit)

- **Collision is the whole point.** Unlike `renameMaster`, which THROWS when the
  target name already belongs to a different active master, `mergeMasters`
  **intentionally moves the source ids onto the existing destination name**.
  There is deliberately no collision guard — merging into an existing master is
  the feature. This MUST be stated in the function's doc comment so a future
  reader does not "fix" it by adding `renameMaster`'s guard.
- **Self-merge guard.** `sameMasterName(source, dest)` (normalized, trim +
  case-insensitive) → throw (Step 0). A master cannot be merged into itself.
- **Empty source** → no-op return (Step 1).
- **Missing destination XML / empty destination group** → throw before any
  write (Step 2).
- **Same-analyst checks are NOT deduped.** If an analyst had a check under both
  source and destination, BOTH survive under the destination after the move.
  `mergeMasters` never inspects `analyst_name` for dedup — it moves by id and
  re-grades by group. Multiple checks per analyst under one master is allowed
  and expected (confirmed decision #3).
- **No fixture validation.** `mergeMasters` does not compare the source and
  destination master contents, team names, or fixture labels. It is an admin
  judgement call (confirmed decision #4).

---

## 3. Pure logic to add + unit-test (`master-manage-logic.ts`)

Two new pure functions, each with Vitest coverage in the existing
`master-manage-logic.test.ts`. They drive the UI's destination list and the
self-merge guard, with no DB or React.

```ts
/**
 * Valid merge destinations for a given source master: every saved master
 * EXCEPT the source itself (by sameMasterName). Pure; drives the picker.
 */
export function validMergeDestinations<T extends { fileName: string }>(
  masters: T[],
  sourceFileName: string,
): T[] {
  return masters.filter((m) => !sameMasterName(m.fileName, sourceFileName));
}

/**
 * Guard: a merge is allowed only when source and destination are DIFFERENT
 * masters (normalized) and both names are valid. Mirrors the data layer's
 * Step-0 self-merge guard so the button can be disabled before any call.
 */
export function canMergeInto(sourceFileName: string, destFileName: string): boolean {
  return (
    isValidMasterName(sourceFileName) &&
    isValidMasterName(destFileName) &&
    !sameMasterName(sourceFileName, destFileName)
  );
}
```

### Unit tests (add to `master-manage-logic.test.ts`)

`validMergeDestinations`:
- excludes the source by exact name;
- excludes a case/whitespace variant of the source (`"Game A"` source excludes
  `" game a "`);
- returns all others, order preserved;
- empty input → empty; single-master input (only the source) → empty (no valid
  destination, so the UI offers no merge).

`canMergeInto`:
- `true` for two distinct non-empty names;
- `false` when equal, or equal under trim/case-fold;
- `false` when either name is empty/whitespace.

---

## 4. UX in the Manage dialog (`ManageMastersDialog.tsx`)

Add a per-row "Move all checks into…" affordance, admin-gated exactly like the
existing rename/delete/replace controls (shown only when `aff.canManage`). It
sits alongside the existing row action buttons.

### Row state additions

Extend `RowState` with merge sub-UI fields (keeping the established lazy
`freshRow` pattern; initialise them in `freshRow`):

```ts
merging: boolean;         // the destination-picker sub-UI is open
mergeDest: string | null; // selected destination fileName
mergeConfirm: boolean;    // confirm step is showing
```

### Interaction flow

1. **Open picker.** A "Move checks…" button (reuse an appropriate
   `lucide-react` icon already imported, e.g. an arrow/merge glyph) toggles
   `patchRow(m.fileName, { merging: !row.merging, message: null, mergeConfirm: false, mergeDest: null })`.
2. **Pick a destination.** Render a `<select>` whose options come from
   `validMergeDestinations(masters, m.fileName)` (a `SavedMaster[]`, so the
   source itself is never selectable). Each option value is the destination
   `fileName`; the matching `SavedMaster` (for its `checkId`) is looked up on
   confirm by `masters.find((x) => sameMasterName(x.fileName, mergeDest))`. If
   the list is empty (only one saved master exists), show
   "No other master to move into" and offer no action.
3. **Confirm step.** Once a destination is chosen, show the confirm copy using
   the advisory source count (`row.count`, the same value the row already
   displays). The count is `null` until the mount effect fills it, so interpolate
   it defensively — mirroring the row's existing
   `row.count == null → "Counting attached checks…"` treatment — so it never
   renders "Move null check(s)":

   - when `row.count == null`:
     > **Move all checks for `<source>` into `<dest>`**
     > Move all checks for "`<source>`" into "`<dest>`". "`<source>`" will be
     > removed. This re-grades the moved checks against "`<dest>`". This can't
     > be undone from here.
   - when `row.count` is a number N:
     > **Move all checks for `<source>` into `<dest>`**
     > Move N check(s) for "`<source>`" into "`<dest>`". "`<source>`" will be
     > removed. This re-grades the moved checks against "`<dest>`". This can't
     > be undone from here.

   A primary "Move" button (disabled unless
   `canMergeInto(m.fileName, mergeDest)` and not `row.busy`), and a Cancel. The
   copy matches the locked UI string "Move all checks for ___ into ___".
4. **Execute.** On confirm, `patchRow(m.fileName, { busy: true, message: null })`
   then:
   ```ts
   const dest = masters.find((x) => sameMasterName(x.fileName, mergeDest!));
   // dest is guaranteed by validMergeDestinations having produced the option.
   const res = await mergeMasters(m.fileName, dest.fileName, dest.checkId);
   ```
   On success, compose a message that mirrors `handleReplaceFile` by surfacing
   `res.moved`, `res.regraded`, and `res.analysts`:
   - if `res.moved === 0`: `"Nothing to move — source was already empty."`
   - else:
     `` `Moved ${res.moved} check${res.moved === 1 ? "" : "s"} into "${dest.fileName}"; re-graded ${res.regraded}${res.analysts.length ? ` (${res.analysts.join(", ")})` : ""}. Source removed.` ``

   This USES `res.analysts` (the finding that it was otherwise dead), listing the
   affected analysts exactly as the replace flow does. Then clear the sub-UI
   (`merging: false, mergeConfirm: false, mergeDest: null`) and
   `await onChanged({ type: "merge", source: m.fileName, dest: dest.fileName })`.
   On throw, surface `err.message` in `row.message`, set `busy: false`, keep the
   row so the admin can retry or pick a different destination. Mirrors the
   existing `saveRename` / `handleReplaceFile` try/catch/busy/message shape.

### Busy / disabled

While `row.busy`, disable the select, Move, and Cancel (same pattern as the
rename inputs), using the existing Tailwind `disabled:opacity` treatment.

### Count for the confirm copy

The row already fetches an advisory `count` via `countActiveGroupSiblings` in the
mount effect; reuse it directly (with the `null` fallback above). No extra fetch
and no new count helper is added — the design does NOT add a
`getMasterGroupSummary`; `row.count` plus `res.analysts` from the merge result
cover the confirm and success copy.

### `onChanged` wiring (page)

Extend the `onChanged` union in both `ManageMastersDialog`'s prop type and
`app/accuracy-compare/page.tsx` with:

```ts
| { type: "merge"; source: string; dest: string }
```

In the page handler, treat `merge` like the existing `delete` branch for the
in-view master, then refresh:
- If the in-view `master?.name === change.source`, clear it:
  `setMaster((cur) => (cur && cur.name === change.source ? null : cur));`
  (the source master no longer exists; the admin can re-pick the destination
  from the dropdown). This mirrors the existing `delete` branch exactly.
- Always `await refreshSavedMasters()` so the dropdown drops the source and the
  destination's attached-check count grows. The dialog's own mount effect
  re-fetches counts from the refreshed `masters` list, so the destination row's
  advisory count updates on the next render.

Admin gating is unchanged: the dialog is only mounted when `canManageMasters`
(`admin`/`super_admin`), and every merge control is behind `aff.canManage`.

---

## 5. No DB schema change

The operation is pure column mutation on `accuracy_checks`
(`file_name_master`, `xml_master`, and the summary/`player_accuracy`/breakdown
columns written by the re-grade). No new table, column, index, or constraint.
"Saved master" remains a derived grouping over `file_name_master`.

---

## Edge cases

- **Double-submit / re-run:** second run finds an empty source group → `moved:0`
  no-op. Safe.
- **Source == destination (incl. case/space variants):** blocked by
  `canMergeInto` in the UI and by Step-0 `sameMasterName` guard in the data
  layer.
- **Destination deleted between picker open and confirm:** Step 2's
  `resolveActiveGroupIds(destFileName)` returns empty → throw; no rows moved.
- **Destination master row has null `xml_master`:** `getSavedMasterXml` returns
  null → throw before any write. (`getSavedMasters` only lists masters whose
  check has non-null `xml_master`, so this is defensive.)
- **A moved/destination row is ungradeable** (empty/unparsable analyst or master
  XML): `gradeOverlapScoped` returns null → null-accuracy marker written, row
  counted as regraded (its columns were written) but flagged by the warn log,
  reconciled by a later backfill. Same behaviour as
  `propagateMasterCorrection`/`backfill` today.
- **A destination row's update fails mid-loop:** logged and SKIPPED (not
  thrown); it is excluded from `regraded`. The row keeps the destination name +
  destination XML from Step 3 (consistent); a retry/backfill reconciles its
  summary. The rest of the group still re-grades.
- **Destination group had a different `xml_master`:** intentionally overwritten
  with `destXml` and re-graded (see Step 4 side-effect note).
- **Soft-deleted source rows:** excluded by `resolveActiveGroupIds`; they stay
  under the old name and do not move. Acceptable — they are not active and don't
  appear in the dropdown.
- **Same analyst under both masters:** both checks persist under the
  destination; no dedup. Confirmed decision #3.
- **TOCTOU:** no transaction/constraint (out of scope). A concurrent insert
  under the source name during the merge may be missed; the next refresh
  surfaces it as a lingering source entry to re-merge. Documented, same posture
  as `renameMaster`.

---

## Testability

- **Unit (Vitest, no DB/React):** `validMergeDestinations` and `canMergeInto`
  in `master-manage-logic.ts` — the destination-list derivation and the
  self-merge guard. These are the risky pure bits and are fully covered (see
  §3), mirroring the existing `master-manage-logic.test.ts` pattern.
- **Integration (manual / against Supabase):** `mergeMasters` is an
  orchestration of already-tested primitives (`resolveActiveGroupIds`,
  `getSavedMasterXml`) plus a re-grade loop that duplicates the verified
  `propagateMasterCorrection` body. Its own branches — self-merge throw,
  empty-source no-op, missing-dest-XML throw, moved count, re-grade count,
  per-row failure collection — are exercised against a real Supabase table (no
  transaction/mock layer exists in this codebase, matching how
  `renameMaster`/`propagateMasterCorrection` are verified). The deterministic
  grading itself is already covered by the shared `gradeOverlapScoped` /
  overlap-window tests and is not re-tested here.
  - **Drift risk (noted):** the re-grade column object is copied verbatim from
    `propagateMasterCorrection`. If a future change edits one path's column set,
    the other must be kept in sync. A later refactor could factor a shared
    `buildGradeUpdate(graded, xmlMaster)` builder used by both; that is out of
    this task's scope but is the recommended way to remove the duplication.
- **UI:** the dialog's merge flow is driven by the pure helpers above; the
  component wiring (busy/message/confirm/onChanged) mirrors the existing,
  already-shipped rename/delete/replace flows and is validated by the same
  manual admin walkthrough: source disappears, destination count grows, moved
  checks show destination-graded numbers.

---

## Summary of the exact mutation sequence (the contract)

1. `destName = normalizeMasterName(dest)`. Guard `sameMasterName(source, dest)`
   → throw. (pure, pre-DB)
2. `sourceIds = resolveActiveGroupIds(source)`; empty → return `{moved:0,regraded:0,analysts:[]}`.
3. `destXml = getSavedMasterXml(destCheckId)`; null → throw.
   `resolveActiveGroupIds(dest)` empty → throw. (both pre-write)
4. One UPDATE `{ file_name_master: destName, xml_master: destXml }` WHERE
   `id IN sourceIds` (name + XML together — the ordering guarantee); error →
   throw. `moved = movedRows.length`.
5. Reload the destination group by NORMALIZED id-list —
   `destGroupIds = resolveActiveGroupIds(destName)` then
   `.in("id", destGroupIds).is("deleted_at", null)`, NOT a bare
   `.eq("file_name_master", destName)` (so case/whitespace-variant destination
   rows are included and `regraded` is accurate) — and re-grade EACH row via
   `gradeOverlapScoped` (overlap-scoped), writing the column object copied
   verbatim from `propagateMasterCorrection` (`xml_master: destXml`), COLLECTING
   per-row failures (log + `continue`, exclude from `regraded`) instead of
   aborting.
6. Return `{ moved, regraded, analysts }`.

---

## Review responses (latest revision iteration)

Addressing every finding in the current `.agents/tasks/design-review.json` /
`design-review.md` (verdict: CHANGES_REQUESTED — 1 MEDIUM + 2 NITs). The
`design-review.dispute-permissions.*` files describe a SEPARATE, APPROVED
feature (empty-slot dispute permissions) and raise no findings against this
merge-masters design, so there is nothing to resolve there.

- **Finding 1 (MEDIUM — Step 4 bare `.eq("file_name_master", destName)`
  partially consolidates case/whitespace-variant destination groups and
  under-counts `regraded`): ADDRESSED (preferred fix chosen).** Step 4 now
  reloads the destination group by the module's normalized id-targeting
  primitive — `destGroupIds = resolveActiveGroupIds(destName)` then
  `.in("id", destGroupIds).is("deleted_at", null)` — exactly as Step 1/Step 2
  resolve groups, instead of a bare case/whitespace-sensitive `.eq`. The moved
  source rows are included (Step 3 wrote them to `destName`) and so are
  destination rows stored under a case/whitespace variant, so "the whole
  destination group" is literally true and `regraded` is accurate. Grounded
  against source: `normalizeMasterName` is trim-only, `resolveActiveGroupIds`
  narrows by `sameMasterName` (`trim().toLowerCase()`), and `renameMaster`
  already targets by `.in("id", groupIds)` — all confirmed in
  `lib/api/accuracyChecks.ts`. The Step-4 code block, the Step-4 side-effect
  note, and the §Summary contract item 5 are all updated to the id-list reload.
- **N1 (NIT — Step 2 non-null-XML guard oversells what it guarantees):
  ADDRESSED.** Added a note under Step 2 stating the guard only confirms the
  destination row exists and holds *some* XML; a non-null-but-unparsable blob
  still proceeds, moves the source rows, and writes null-accuracy markers across
  the group (reconciled by backfill) — identical to
  `propagateMasterCorrection`/`backfill` behaviour today, not a regression.
- **N2 (NIT — Page-handler note left a dangling "fallback"): ADDRESSED.**
  Deleted the fallback fork; the note now gives one instruction — extend the
  `onChanged` union with the `merge` arm, mirroring the existing `delete`
  branch.

## Review responses (prior revision iteration)

Retained for history — addressing the earlier `design-review.json`:

- **#1 (HIGH — two contradictory Step 4s): ADDRESSED.** The delegating snippet
  is removed from the normative Step 4 and demoted to "Rejected alternative (A)."
  The inline resilient loop (B) is now the single Step 4 implementation, and the
  `return { moved, regraded, analysts }` reads from the loop's own `regraded`
  counter and `analysts` set (no `prop.updated`/`prop.analysts`).
- **#2 (HIGH — missing column object): ADDRESSED.** The literal update object is
  inlined verbatim from `propagateMasterCorrection` (all 14 columns incl.
  `xml_master: destXml` and `player_accuracy`). A §Testability note flags the
  copy-in-sync risk and the shared-builder refactor as the out-of-scope cleanup.
- **#3 (MEDIUM — private `gradeOverlapScoped`): ADDRESSED.** §Scope and §1 now
  state `mergeMasters` MUST live in `lib/api/accuracyChecks.ts` because
  `gradeOverlapScoped` is module-private and must not be exported solely for
  this.
- **#4 (MEDIUM — `destName` ordering): ADDRESSED.** `const destName =
  normalizeMasterName(destFileName)` is defined at Step 0 and used consistently;
  Step 3 writes `file_name_master: destName` and Step 4 reloads with
  `.eq("file_name_master", destName)`, explicitly the same value.
- **#5 (MEDIUM — whole-group side effect / moved vs regraded): ADDRESSED.** A
  dedicated side-effect note states the merge re-tags the ENTIRE destination
  group's `xml_master` to the picked `destXml` and re-grades all of them
  (intended single-source-of-truth consolidation; the restrict-to-`sourceIds`
  alternative is named and rejected). The UI copy now reports `moved` and
  `regraded` as distinct numbers.
- **#6 (NIT — `getMasterGroupSummary` in Scope): ADDRESSED.** Removed from Scope
  and the body; the design explicitly does not add it and reuses `row.count` +
  `res.analysts`.
- **#7 (NIT — null confirm count): ADDRESSED.** §4 step 3 specifies the
  `row.count == null` fallback copy (no number), mirroring the existing
  "Counting attached checks…" treatment.
- **#8 (NIT — unused `analysts`): ADDRESSED.** The success copy now interpolates
  `res.analysts` (`(${res.analysts.join(", ")})`), mirroring `handleReplaceFile`.
- **#9 (NIT — most-recent destination XML assumption): ADDRESSED.** A sentence
  under §Background and the Step-2/Step-4 notes state the merge grades against
  the most-recent destination row's XML (the `SavedMaster` the admin saw) and
  brings the whole group onto it.
