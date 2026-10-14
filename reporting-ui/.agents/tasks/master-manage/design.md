# Manage Saved Masters — Requirements & Technical Design

## Summary

On the Accuracy Comparison page (`app/accuracy-compare/page.tsx`), the "...or reuse a saved master" dropdown lets a user pick a previously-saved master to re-grade against. This feature adds admin-only **management** of those saved masters directly from that control:

1. **Rename** the display filename shown in the dropdown (`file_name_master`), propagated across every sibling check so grouping stays intact.
2. **Delete** a saved master — allowed **only** when it has no accuracy checks attached (precise predicate defined below). When checks are attached, delete is blocked and the user is steered to Replace.
3. **Replace** a saved master's XML/JSON by uploading/selecting a new feed, which re-grades every attached check via the existing, proven `propagateMasterCorrection` flow.

The change is deliberately narrow and conservative: it touches only `app/accuracy-compare/page.tsx`, `lib/api/accuracyChecks.ts`, one new small dialog component, and one new pure-logic module plus its test. It does **not** change `lib/comparison/*`, disputes, unrelated files, or the database schema.

> **Revision note (design review iteration 1).** This revision resolves all five findings in `.agents/tasks/master-manage/design-review.json` (1 HIGH, 2 MEDIUM, 2 NIT). The central change is **Finding 1**: all mutations now target the *same* case-insensitive/trimmed group the dropdown already uses to de-duplicate, implemented via one shared id-resolving helper. Findings 2–5 follow from that single rule or are small clarifications. See **Responses to design-review findings** at the end.

### Next.js constraints read before designing

Per `AGENTS.md` ("This is NOT the Next.js you know"), I read the bundled docs under `node_modules/next/dist/docs/` before specifying any Next.js-touching code:

- `01-app/01-getting-started/05-server-and-client-components.md` — Client Components are required for state, event handlers, and browser APIs. `app/accuracy-compare/page.tsx` already begins with `"use client"` (confirmed line 1), so it is a Client Component. The new dialog and all mutation triggers live inside this client boundary. Per the "Preventing environment poisoning" section, only `NEXT_PUBLIC_`-prefixed env vars reach the client; this feature introduces no new secrets.
- `01-app/01-getting-started/07-mutating-data.md` — Describes Server Functions / Server Actions (`"use server"`) and `revalidatePath`/`refresh` as the framework's mutation path. **This app does not use that pattern for accuracy data.** The existing data layer (`lib/api/accuracyChecks.ts`) mutates Supabase directly from the browser via the shared `supabase` client (e.g. `propagateMasterCorrection`, `deleteAccuracyCheck`, `updateAccuracyCheck` all run client-side and are invoked from `onClick`/async event handlers). To stay consistent with the established, working pattern — and because there is no server runtime wired for these mutations — the new `renameMaster`/`deleteMaster` functions follow the **same client-side Supabase** approach, invoked from event handlers (the doc's "Event Handlers" invocation path), **not** Server Actions. There is accordingly no `revalidatePath`/`refresh`; the UI refreshes state by re-calling `getSavedMasters()` after each mutation, exactly as the page already seeds `savedMasters` in a `useEffect` (line ~1460).

This decision is locked: **client-side Supabase mutations, no Server Actions, no new route handlers.**

## Data model (verified against the real code)

There is **no `masters` table**. A "saved master" is a *derived* concept: the set of `accuracy_checks` rows sharing the same `file_name_master`, each carrying an identical copy of the master in its `xml_master` column. Confirmed by reading `lib/api/accuracyChecks.ts`:

- `SavedMaster` = `{ checkId, fileName, videoUrl }`. `getSavedMasters()` (line ~762) selects `id, file_name_master, video_url, created_at` where `xml_master IS NOT NULL` and `deleted_at IS NULL`, ordered newest-first, then **de-duplicates by `file_name_master.trim().toLowerCase()`** (most-recent row wins) so each master appears once in the dropdown. The `checkId` returned is just the newest row that holds that master's XML; `SavedMaster.fileName` is that newest row's **exact stored string** (original casing/whitespace preserved).
- `propagateMasterCorrection(fileNameMaster, xmlMaster)` (line ~329) selects every non-deleted check with that `file_name_master` (currently via exact `.eq`), rewrites `xml_master`, and recomputes each check's accuracy against **its own** `xml_analyst`. Returns `{ updated, analysts }`.
- `getMasterCheckSiblings(fileNameMaster)` (line ~411) returns `{ count, analysts }` for non-deleted rows with that `file_name_master` (currently via exact `.eq`); `count = data?.length` (row count, not distinct analysts).
- Checks are **soft-deleted** via `deleted_at` / `deleted_by` (`deleteAccuracyCheck`, line ~1080). All active views filter `deleted_at IS NULL`. `restoreAccuracyCheck` / `getDeletedAccuracyChecksMeta` provide the recovery path.

### Grouping-key mismatch this design must reconcile (the HIGH finding)

`getSavedMasters` groups by the **normalized** key `fileName.trim().toLowerCase()`, so a single dropdown entry can represent rows whose stored `file_name_master` differs only by case or surrounding whitespace (e.g. `"Game1.xml"`, `"game1.xml"`, `"Game1.xml "`). But `propagateMasterCorrection`, `getMasterCheckSiblings`, and (naively) a rename/delete all key on the **exact** stored string via `.eq("file_name_master", x)`. The newest row's exact string is what reaches the UI as `SavedMaster.fileName`.

I confirmed stored names are **not** canonicalized: `saveAccuracyCheck` (line ~158) writes `file_name_master: input.fileNameMaster ?? null` with **no** trim or case-fold (verified in source). So I cannot assume the stored strings are already normalized.

**Decision — adopt the normalized group as the one true grouping rule, applied uniformly.** Every operation in this feature (the deletable count, rename, delete, and the Replace target) resolves a master to **the set of active rows whose `file_name_master` matches the selected name under `sameMasterName` = trim + lower-case equality** — the exact rule `getSavedMasters` uses for de-dup. Operations then act by the resulting **row-id list**, never by a bare `.eq` on the raw string. This guarantees the dropdown's grouping and the mutations' targeting always agree (satisfies AC #3 and AC #6).

I rejected the "make everything exact-match (change `getSavedMasters` dedup to exact)" alternative: it would make two visually-identical names appear as two dropdown entries, which is a worse UX and a regression in the existing reuse flow. Normalized-everywhere keeps today's dropdown behavior and makes mutations honor it.

### The single insert path (decisive for the delete predicate)

I grepped for every `accuracy_checks` insert: the **only** insert is `saveAccuracyCheck` (line ~158), driven by `handleSaveCheck()` in the page (line ~2203), which **requires** a non-empty `analystName` (`.trim()` written to `analyst_name`) and **always** writes a full comparison `result` (so `accuracy`, `master_total`, breakdowns, etc. are populated). There is **no code path that creates a "saved-but-never-graded placeholder" master** with a null/empty analyst or no accuracy result.

**Consequence:** every row that produces a saved-master dropdown entry is already a *graded accuracy check* belonging to some analyst. Candidate (a) from the brief — a placeholder-vs-graded distinction — **does not exist in this data model** and must not be used. Candidate (c) — a flag — would require a schema change, which is out of scope. That leaves candidate (b), the count of attached (active) checks, as the only grounded predicate.

## RESOLVED definitional question — the exact DELETABLE predicate

> **A saved master is DELETABLE iff exactly one active check belongs to its normalized group.**
>
> `deletable(fileName) ≡ countActiveGroupSiblings(fileName) === 1`
>
> where `countActiveGroupSiblings(fileName)` counts `accuracy_checks` rows that (i) have `deleted_at IS NULL` and (ii) satisfy `sameMasterName(row.file_name_master, fileName)` — the trim + case-insensitive group rule above. **Crucially the count is over the normalized group, not an exact-string match**, so it can never report `1` while case/space-variant siblings the dropdown folded in survive.

Rationale, grounded in the model above:

- Because every row is a graded accuracy, "has accuracies attached" means **more than one** graded check depends on this master. Deleting such a master would either orphan or destroy other analysts' graded results — exactly what the brief forbids. So when `count > 1`, delete is **blocked** and the user is routed to **Replace** (which preserves every check and re-grades them).
- When `count === 1`, the master exists **solely because of a single check** — the master and that one accuracy are the same object. There are no *other* analysts' accuracies to protect. Removing it is the user discarding a one-off saved master they no longer want to reuse. This is the "no [other] accuracies attached" case, and it is safe.
- `count === 0` cannot occur for a master that appears in the dropdown (it is derived from at least one non-deleted check). The predicate returns `false` for 0 defensively, and `deleteMaster` treats "0 rows in group" as a no-op success (already gone).

This predicate is **pure and unit-testable** given a count (see Testing).

### What DELETE removes at the DB level, and the no-orphan proof

`deleteMaster(fileName, deletedBy)` performs a **soft delete** of the single attached check — identical mechanism to the existing `deleteAccuracyCheck`: it sets `deleted_at = now()` and `deleted_by` on the one active row in the group. It does **not** hard-delete, does **not** touch `xml_master`/`xml_analyst`, and does **not** cascade to disputes (soft delete leaves them restorable, matching existing behavior).

To make the operation safe under concurrency, `deleteMaster` **re-resolves the group and re-checks the predicate inside the mutation path** rather than trusting a possibly-stale UI count:

1. Resolve the active group: fetch candidate rows with `.ilike("file_name_master", fileName.trim())` (case-insensitive, no wildcards) and `deleted_at IS NULL`, then filter in JS to the ids where `sameMasterName(row.file_name_master, fileName)`. (The `.ilike` is a server-side prefilter; the JS `sameMasterName` filter is what makes the match trim-insensitive, since PostgREST `.ilike` without wildcards is case- but not whitespace-insensitive.)
2. If the resolved id list is empty → no-op, return `{ deleted: 0 }` (already gone).
3. If the id list has length > 1 → **throw** `"Cannot delete: N accuracy checks are attached to this master. Replace it instead."` (the UI will have shown Replace, but this is the authoritative guard).
4. If exactly one id → soft-delete that single row by id (`update({ deleted_at, deleted_by }).eq("id", id)`).

**No-orphan / no-data-loss proof:** The DB-side guard means a soft-delete only ever fires when exactly one active check is in the normalized group. That one check *is* the master; no other row's `xml_master` or accuracy depends on it. No graded accuracy belonging to a different check is modified or removed. Because the match is over the normalized group (not an exact string), there is no hidden case/space-variant sibling that could survive a "count===1" delete — the count and the delete operate on the identical id set. Because the delete is soft, even the single removed check is recoverable from the existing "Deleted checks" review view (`getDeletedAccuracyChecksMeta` / `restoreAccuracyCheck`). Therefore deletion can neither orphan nor destroy graded accuracy data. (Hard delete is explicitly rejected here to keep parity with the proven soft-delete recovery story and to avoid cascading dispute removal.)

## RESOLVED — exact RENAME scope and collision behavior

`renameMaster(oldFileName, newFileName)`:

- **Scope — which rows change (normalized group, by id):** `renameMaster` first resolves the **active group** of `oldFileName` to a list of row ids using the same normalized rule as delete (`.ilike(oldFileName.trim())` prefilter → JS filter on `sameMasterName`). It then updates `file_name_master = <trimmed new name>` on exactly those ids. This renames **every** active sibling in the group — including case/space variants the dropdown folded together — so all of them regroup under the new name and no stray variant resurfaces as a separate dropdown entry after refresh (satisfies AC #3). Soft-deleted rows are intentionally left on the old name — they are hidden from every active view, and rewriting history rows is unnecessary; the active group is what the dropdown and propagate logic operate on.
- **Normalization of the new value:** `newFileName` is trimmed before storage (`normalizeMasterName`). Empty-after-trim is rejected before any DB write (see validation). No case-folding is applied to the stored value — the display name preserves the user's casing; the trim+lower-case is only ever a *comparison* key, never what gets persisted.
- **Collision behavior (no-merge policy), defined by set membership:** Let `groupIds = { ids where sameMasterName(file_name_master, oldFileName) and deleted_at IS NULL }` (the set being renamed). A **collision exists iff** there is an active row `r` with `sameMasterName(r.file_name_master, next)` **and** `r.id ∉ groupIds`, where `next = normalizeMasterName(newFileName)`. If a collision exists the rename is **rejected** with `"A master named \"<next>\" already exists. Choose a different name."` This definition is consistent with the normalized targeting: renaming a group to a name that differs only by case/whitespace *from itself* is allowed (every matching row is in `groupIds`, so there is no outside row), while renaming onto a genuinely different master's name is blocked. Merging two distinct masters is **not** performed, because their `xml_master` blobs may differ and silently collapsing them into one dropdown entry would make `getSavedMasters` pick just one XML (most-recent) and hide the other — a data-correctness hazard.
- **Concurrency honesty (the race, stated not hidden):** the collision guard is a client-side read (resolve group + collision query) followed by a separate client-side update — a classic TOCTOU window. There is **no DB uniqueness constraint on `file_name_master`** (it is a plain nullable column — verified) and no server transaction, so two admins renaming toward the same name, or an insert landing between the read and the write, can still produce a duplicate name. This is **best-effort** and accepted as low-probability for an admin-only, low-concurrency control: the next `getSavedMasters()` refresh will surface any duplicate as two dropdown entries, and the admin can re-rename. A hard guarantee would require a DB unique constraint, which is **out of scope**. The guard runs inside `renameMaster` against a fresh query (not just in the UI) to **narrow the race window**, not to eliminate it.
- **Return:** `{ updated: number }` — how many active rows were renamed (the size of `groupIds`).

## RESOLVED — exact REPLACE behavior

Replace is only offered when the master is **not** deletable (`count > 1`), i.e. it has attached accuracies. It **reuses `propagateMasterCorrection(fileName, newXml)` unchanged** — no new grading logic.

- **`file_name_master` stays the SAME.** This is the deliberate decision: `propagateMasterCorrection` keys on `file_name_master`, and keeping the name constant means the grouping and the single dropdown entry persist, every attached check is found and re-graded, and the user sees the same master "updated in place." Renaming during replace would fragment the group.
- **Group targeting for Replace — explicit decision.** `propagateMasterCorrection` matches by exact `.eq("file_name_master", fileNameMaster)` and re-grades by writing `xml_master` on the matched rows. This design **keeps `propagateMasterCorrection` untouched** (it is the proven, data-mutating grading path and the brief says reuse it, don't reinvent). The Replace handler calls `propagateMasterCorrection(SavedMaster.fileName, newXml)` — the newest exact stored name for the selected dropdown entry — and keeps the name unchanged, exactly like today's override/`saveCorrectedMaster` buttons.
  - **The user-facing sibling count** shown in the Replace pop-up ("N accuracy checks will be re-graded") comes from the **normalized** `countActiveGroupSiblings`, so it is accurate for the dropdown's grouping.
  - **Known, pre-existing limitation (not worsened, not in scope to fix):** if a single dropdown entry folds in rows whose `file_name_master` differs only by case/whitespace *and that group was never renamed*, the exact-match propagate re-grades only the exact-string subset. This is a pre-existing property of `propagateMasterCorrection` that today's override/correct-master buttons already share; this feature does not make it worse. In practice `renameMaster` consolidates such a group onto one exact string the moment an admin renames it, after which Replace covers the whole group. Fully normalizing the grading match would mean changing `propagateMasterCorrection` to act by a resolved id list — a larger, riskier change to the grading path, explicitly **out of scope** here. The design records this tradeoff rather than hiding it.
- The new file may be **XML or JSON** (the master Dropzone already sets `allowJson`; `instancesFromRaw` inside `propagateMasterCorrection` already handles a leading-`{` JSON feed, so JSON masters re-grade correctly).
- After replace, the page mirrors the existing override/`saveCorrectedMaster` handler (line ~1094): optionally update the in-view `master` state if the replaced master is the one currently loaded, surface the `{ updated, analysts }` count via `masterSaveMsg`, and re-call `getSavedMasters()`.
- Replace does **not** add a new row; it rewrites `xml_master` on existing rows (same as today's override/correct-master buttons).

## New API functions (`lib/api/accuracyChecks.ts`)

All follow the file's existing style: `async`, direct `supabase` calls, `console.error` + `throw new Error(error.message || "...")` on failure, `deleted_at IS NULL` filters. A small **internal** helper centralizes the normalized group resolution so rename, delete, and the count never drift apart.

```ts
export interface RenameMasterResult { updated: number }
export interface DeleteMasterResult { deleted: number }

/**
 * INTERNAL (not exported, or exported only for the unit test if convenient):
 * resolve the active (deleted_at IS NULL) rows that belong to the SAME master
 * group as `fileName` under trim + case-insensitive equality, and return their
 * ids. Uses a .ilike(trimmed) server prefilter + JS sameMasterName() filter so
 * the match is both case- and whitespace-insensitive (PostgREST .ilike without
 * wildcards is case- but not whitespace-insensitive).
 */
async function resolveActiveGroupIds(fileName: string): Promise<number[]>;

/** Normalized active count for the deletable predicate + advisory UI count. */
export async function countActiveGroupSiblings(fileName: string): Promise<number>;

/**
 * Rename a saved master's display filename across every active check in its
 * normalized group. Rejects an empty name and a collision with a DIFFERENT
 * existing active master (membership defined by row id, see below). Returns how
 * many rows were renamed. Best-effort against concurrent writers (no DB unique
 * constraint; out of scope).
 */
export async function renameMaster(
  oldFileName: string,
  newFileName: string
): Promise<RenameMasterResult>;

/**
 * Delete a saved master. Allowed ONLY when exactly one active check is in its
 * normalized group (soft-deletes that single check). Throws if >1 are attached
 * — the caller must Replace instead. No-op (deleted: 0) when none remain.
 */
export async function deleteMaster(
  fileName: string,
  deletedBy?: string | null
): Promise<DeleteMasterResult>;
```

### `resolveActiveGroupIds(fileName)` steps
1. `const key = fileName.trim();` — select `id, file_name_master` from `accuracy_checks` with `.ilike("file_name_master", key)` and `.is("deleted_at", null)`.
2. Filter the returned rows in JS to those where `sameMasterName(row.file_name_master, fileName)` (trim + lower-case equality) — this adds whitespace-insensitivity the `.ilike` lacks.
3. Return the matching `id`s. Supabase error → `console.error` + throw.

### `countActiveGroupSiblings(fileName)` steps
Return `(await resolveActiveGroupIds(fileName)).length`. (Replaces the earlier reliance on `getMasterCheckSiblings`' exact `.eq` count for *this feature's* decisions; `getMasterCheckSiblings` is left unchanged for its existing dispute/correction callers. The dialog's analyst-name list may still come from `getMasterCheckSiblings` for display, but the authoritative count driving deletable/replace comes from `countActiveGroupSiblings`.)

### `renameMaster` steps
1. `const next = normalizeMasterName(newFileName);` — if `!isValidMasterName(next)` throw `"Master name cannot be empty."` (pure validator, below). No DB write yet.
2. `const groupIds = await resolveActiveGroupIds(oldFileName);` — the set being renamed. If empty, return `{ updated: 0 }` (nothing to rename).
3. **Collision check (by id-set membership):** fetch candidate collision rows `select("id, file_name_master").is("deleted_at", null).ilike("file_name_master", next)`; a collision exists iff any returned row `r` has `sameMasterName(r.file_name_master, next)` **and** `r.id ∉ groupIds`. If so → throw the collision message. (Skip this query when `sameMasterName(next, oldFileName)` is already true for the whole group, i.e. a pure case/whitespace self-rename — there is no outside row by definition.)
4. `update({ file_name_master: next }).in("id", groupIds).select("id")`; return `{ updated: rows.length }`. (Updating by the resolved id list — not by `.eq` on the raw string — is what makes rename honor the normalized group.)
5. Any Supabase error → `console.error` + throw. Document in the function JSDoc that the guard is best-effort (TOCTOU; no DB unique constraint; out of scope).

### `deleteMaster` steps
As enumerated in the no-orphan proof above, implemented on `resolveActiveGroupIds`: resolve group ids; 0 → no-op `{ deleted: 0 }`; >1 → throw the "N attached, Replace instead" message; exactly 1 → soft-delete that id via `update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy ?? null }).eq("id", id)`. Returns `{ deleted }`.

## New pure-logic module (`app/accuracy-compare/master-manage-logic.ts`)

Extracted so the risky bits are unit-tested without a DB or React. Mirrors the existing `dispute-permissions.ts` + `*.test.ts` pattern.

```ts
/** DELETABLE predicate: a master is safe to delete iff exactly one active
 *  check is in its (normalized) group. (0 is treated as not-deletable/no-op.) */
export function isMasterDeletable(activeGroupCount: number): boolean {
  return activeGroupCount === 1;
}

/** Non-empty-after-trim validation for a master display name. */
export function isValidMasterName(name: string): boolean {
  return name.trim().length > 0;
}

/** Normalized display name actually stored (trimmed, no case-fold). */
export function normalizeMasterName(name: string): string {
  return name.trim();
}

/** Case-insensitive/trim equality used for dropdown dedup, group resolution,
 *  and collision (the ONE grouping rule, mirrors getSavedMasters' dedup key). */
export function sameMasterName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** What the manage UI should offer for a master, given its (normalized) active
 *  count and whether the current user may manage. Pure — drives button
 *  enablement and the delete-vs-replace fork. */
export interface ManageAffordance {
  canManage: boolean;            // admin/super_admin
  canRename: boolean;            // canManage
  canDelete: boolean;            // canManage && isMasterDeletable(count)
  mustReplaceToRemove: boolean;  // canManage && count > 1
}
export function masterAffordance(
  activeGroupCount: number,
  isAdmin: boolean
): ManageAffordance;
```

The data layer imports `sameMasterName`/`normalizeMasterName`/`isValidMasterName` from this module (or inlines the identical one-liners if an import from `app/` into `lib/` is undesirable per the project's import direction — the implementer picks whichever matches existing conventions; the logic and its tests are the contract). Keeping `sameMasterName` as the single definition is what guarantees dropdown dedup, group resolution, rename, delete, and collision all use the identical rule.

## Permissions

Rename / Delete / Replace are gated to admins exactly like the page's existing master-edit and dispute-resolve gates (`user?.role === "admin" || user?.role === "super_admin"`, confirmed at lines ~968–970 and ~992–993). A new derived boolean:

```ts
const canManageMasters =
  user?.role === "admin" || user?.role === "super_admin";
```

Non-admins **must not see or trigger** any manage affordance: the edit/trash/replace controls and the Manage-masters entry point are rendered only when `canManageMasters` is true. The delete path is additionally guarded by the DB-side group re-check so a crafted call cannot cause data loss. Note on enforcement authority: consistent with the rest of this client-side data layer, the *intended* authoritative enforcement is Supabase Row-Level Security on `accuracy_checks` (unchanged by this feature). **RLS policies live in the Supabase project, not in this repo, so they could not be verified here**; if RLS is permissive, the client-side role check is the only real gate — the same situation as the existing `canEditMaster`/`canResolveDispute` features. This matches the established pattern and is not expanded by this feature.

## UX design

**Entry point — per-master affordances in a Manage dialog (chosen over inline trash icons on the `<option>`s).** A native `<select>` cannot host per-row buttons, and the dropdown must keep its existing "pick a master to reuse" behavior intact. So: next to the dropdown, when `canManageMasters`, render a small **"Manage masters"** button (a `Pencil`/`Settings` affordance consistent with existing `lucide-react` icons already imported). It opens a new `ManageMastersDialog` client component listing each `SavedMaster` with, per row: the filename, an **edit (rename)** control, and a **delete** control.

- **Rename:** inline edit (text input seeded with the current name) with Save/Cancel. Save is disabled until `isValidMasterName(trimmed)` and the name actually changed. On Save → `renameMaster(old, new)`; on collision/empty error, show the thrown message inline on that row. On success, refresh and show a success line.
- **Delete:** the trash control's behavior forks on `masterAffordance(count, isAdmin)`:
  - If `canDelete` (count === 1) → a confirm step ("Delete this saved master? This removes the one check that uses it; it can be restored from Deleted checks.") → `deleteMaster(fileName, user?.username ?? null)`.
  - If `mustReplaceToRemove` (count > 1) → a **Replace pop-up** instead: it explains "This master can't be deleted because N accuracy checks are graded against it. Upload a new master file to replace it — every attached check will be re-graded." It presents a file picker (reusing the master `Dropzone` with `allowJson`) / re-use path, then calls `propagateMasterCorrection(fileName, newXml)`.
- Each row shows its active-group count (from `countActiveGroupSiblings`) so the admin understands why delete is or isn't available. Counts are fetched when the dialog opens (one lightweight query per master, or batched) and are **advisory**; the mutations re-verify server-side.
- **Stale-count handling:** if an advisory count is stale (e.g. another admin added a check since the dialog opened), a Delete click may hit the DB-side `>1` guard and throw. In that case the dialog **shows the thrown guard message inline on that row and re-fetches `getSavedMasters()` + the counts**, so the UI self-corrects to the real state (and the row flips to offering Replace). No behavior change beyond surfacing the message and refreshing.

**Status + refresh:** all three operations surface success/error through the existing `masterSaveMsg` state (and/or a dialog-local message mirroring that pattern). After **any** successful mutation, re-run `getSavedMasters()` and `setSavedMasters(...)` so the dropdown and the dialog list reflect the change immediately — reusing the exact loader already in the `useEffect` at line ~1460. If the currently-loaded in-view master (`master.name`) was renamed or replaced, update `master` state accordingly so the open comparison view stays consistent (replace mirrors the override handler at line ~2334 / `saveCorrectedMaster` at ~1094).

The existing dropdown `onChange` → `getSavedMasterXml(sm.checkId)` → `setMaster(...)` flow (lines ~2458–2490) is **unchanged**.

## Error handling (per operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `renameMaster` | empty name after trim | yes (user re-enters) | throw `"Master name cannot be empty."` | no (validation, pre-DB) |
| `renameMaster` | `next` collides with a different active master (id-set membership) | yes (choose another) | throw collision message | no (expected) |
| `renameMaster` | group empty (old name no longer present) | n/a | `{ updated: 0 }` success | no |
| `renameMaster` | Supabase select/update error | fatal for this attempt | throw `error.message \|\| "Failed to rename master."` | `console.error` |
| `deleteMaster` | >1 active checks in group | yes (switch to Replace) | throw `"Cannot delete: N accuracy checks are attached…"` | no (expected guard) |
| `deleteMaster` | 0 active rows in group | n/a (idempotent) | `{ deleted: 0 }` success | no |
| `deleteMaster` | Supabase select/update error | fatal for this attempt | throw `error.message \|\| "Failed to delete master."` | `console.error` |
| `resolveActiveGroupIds` | Supabase select error | fatal (propagates to caller) | throw | `console.error` |
| Replace (`propagateMasterCorrection`) | load/update error | fatal for this attempt | throw (existing behavior) | `console.error` (existing) |
| Replace | new file unparsable / empty master instances | yes (pick another file) | surfaced via `masterSaveMsg`; no DB write if instances empty-guard added at call site | no |

UI layer: every thrown error is caught at the event-handler level (`try/catch`, matching `saveCorrectedMaster` at line ~1094) and written to `masterSaveMsg` / the dialog message; the dialog never leaves the user without feedback. Non-fatal validation errors keep the dialog open with the input focused. The TOCTOU race on rename is accepted and surfaced on the next refresh (see Rename concurrency note).

## Input validation (each external input)

- **`newFileName` (rename):** required, string, trimmed; must be non-empty after trim; no explicit max length is imposed by this feature (the column already stores arbitrary filenames). Behavior on failure: reject before DB write with a clear message. Collision checked by normalized id-set membership.
- **`fileName` (delete / replace target):** supplied programmatically from `SavedMaster.fileName` (not free user text); treated as the selected group's representative name and resolved to active ids via `resolveActiveGroupIds`. If the resolved group is empty, the mutation is a no-op (`deleted: 0`) / rejected.
- **Replace file:** must be a `.xml` or `.json` the existing `Dropzone`/parse path accepts; if `instancesFromRaw(newXml)` yields an empty master, the call site blocks propagation and shows a message (don't overwrite good masters with an unparsable one).

## Invariants and ownership

- **"One master = one normalized `file_name_master` group" grouping invariant** — owned by the shared `sameMasterName` rule plus `renameMaster`'s no-merge collision guard and the decision that Replace keeps the name unchanged. Enforced in the data layer (group resolution + collision), not the UI, because it protects data correctness. Best-effort against concurrent writers (no DB unique constraint; out of scope).
- **"Delete never destroys another analyst's accuracy" invariant** — owned by `deleteMaster`'s DB-side group re-check (authoritative, over the normalized group), with the UI predicate as a first-line gate. Enforced in the data layer.
- **"Dropdown and mutations use the same grouping key" invariant** — owned by routing dropdown dedup, `countActiveGroupSiblings`, `renameMaster`, and `deleteMaster` through the single `sameMasterName`/`resolveActiveGroupIds` definition. This is the fix for the HIGH review finding.
- **"Dropdown always reflects current masters" invariant** — owned by the page: re-fetch `getSavedMasters()` after every mutation (and after a stale-count guard throw).

## Testability

- **Unit (vitest, no DB/React)** — new `app/accuracy-compare/master-manage-logic.test.ts` covering:
  - `isMasterDeletable` (0 → false, 1 → true, 2+ → false),
  - `isValidMasterName` (empty/whitespace → false, real → true),
  - `normalizeMasterName` (trims, preserves case),
  - `sameMasterName` (case- and whitespace-insensitive: `"Game1.xml"` vs `"game1.xml "` → true; different name → false),
  - `masterAffordance` (admin vs non-admin × count 0/1/2 → correct `canDelete`/`mustReplaceToRemove`/`canRename`/`canManage`).
  Mirrors `dispute-permissions.test.ts`. Run with `npm test` (vitest `--run`).
- **Integration (manual / against Supabase)** — the `resolveActiveGroupIds`/`renameMaster`/`deleteMaster`/replace DB effects need a live Supabase (direct client calls), so they are integration-tested against a dev DB, not unit-mocked here. Verify specifically the normalized-group behavior that the HIGH finding was about:
  - seed two active rows with `file_name_master` differing only by case (`"Game1.xml"`, `"game1.xml"`) → the dropdown shows one entry; `countActiveGroupSiblings` returns 2; delete is **blocked**; rename updates **both** rows and no variant resurfaces;
  - a single-exact-spelling master → delete soft-deletes it, it appears in "Deleted checks" (restorable);
  - replace a shared master → `{ updated }` equals the sibling count and accuracies change; `file_name_master` unchanged; XML and JSON feeds both work.
  **Do not** disturb the main dev server on port 3000.

## Out of scope
- No DB schema changes, no `masters` table, no new columns or flags, **no DB unique constraint on `file_name_master`** (so the rename collision guard is best-effort by design).
- No changes to `lib/comparison/*`, disputes, or grading math (Replace reuses `propagateMasterCorrection` as-is; its exact-match targeting is left untouched).
- No Server Actions / route handlers (consistent with the existing client-side Supabase data layer, per the Next.js docs reviewed).
- No hard delete / merge of distinct masters.
- No change to the dropdown's existing "pick to reuse" behavior.

## Acceptance criteria
1. A non-admin sees the saved-master dropdown exactly as today and sees **no** rename/delete/replace controls or Manage entry point.
2. An admin sees a "Manage masters" affordance beside the dropdown; opening it lists every saved master with its active-group count.
3. Renaming a master to a valid, non-colliding name updates `file_name_master` on **all** active sibling checks in its normalized group (including case/whitespace variants); the dropdown shows the new name after refresh with **no** leftover variant entry; soft-deleted rows are untouched.
4. Renaming to an empty/whitespace name is rejected with a message and performs no DB write.
5. Renaming to a name that matches a **different** existing active master (by normalized id-set membership) is rejected with a collision message and performs no DB write (no merge). A pure case/whitespace self-rename of the same group is allowed.
6. Delete is enabled **only** when exactly one active check is in the normalized group; deleting soft-deletes that single check and it appears in "Deleted checks" (restorable); no case/whitespace-variant sibling survives a successful delete.
7. For a master with >1 attached checks (normalized count), delete is disabled/blocked and the UI presents a Replace pop-up; `deleteMaster` additionally throws if called in that state (DB-side guard over the normalized group).
8. Replacing a master's file re-grades every attached check via `propagateMasterCorrection`, keeps `file_name_master` unchanged, and reports the updated count; XML and JSON feeds both work.
9. After any successful rename/delete/replace, `getSavedMasters()` is re-fetched and the dropdown + dialog reflect the change without a page reload; a stale-count Delete that hits the DB guard surfaces the message and refreshes; the in-view master stays consistent if it was the one changed.
10. `isMasterDeletable`, `isValidMasterName`, `normalizeMasterName`, `sameMasterName`, and `masterAffordance` are covered by passing unit tests (including case/whitespace cases for `sameMasterName`); `npm test` is green and the app builds.
11. Only `app/accuracy-compare/page.tsx`, `lib/api/accuracyChecks.ts`, the new dialog component, and the new pure-logic module + test are modified/added.

## Assumptions
- `user` from `useAuth()` exposes `role` and `username` (verified on `UserAccount` in `lib/api/auth.ts`); `user?.username ?? null` is passed for `deleted_by`, matching the existing dispute delete calls.
- Supabase RLS on `accuracy_checks` is the intended authoritative gate for who can update/soft-delete (unchanged by this feature) but **could not be verified from this repo**; the role gate is a UX gate, consistent with existing admin-gated features in this file. If RLS is permissive, the client role check is the only gate — same as today.
- `getMasterCheckSiblings` is left unchanged for its existing callers; this feature's authoritative count comes from the new `countActiveGroupSiblings` (normalized). The analyst-name list for display may still reuse `getMasterCheckSiblings`.
- PostgREST `.ilike(value)` without wildcards is case-insensitive but not whitespace-insensitive; the JS `sameMasterName` filter after the prefilter supplies whitespace-insensitivity. If a future Supabase/PostgREST change alters `.ilike` semantics, the JS filter remains the source of truth.

## Responses to design-review findings

**Finding 1 (HIGH) — mutation key vs dropdown grouping key mismatch. ADDRESSED.** All three operations (count, rename, delete) now resolve a master to its **normalized group** (trim + case-insensitive, via `sameMasterName`) and act by **row-id list** through the shared `resolveActiveGroupIds`/`countActiveGroupSiblings` helpers — the identical rule `getSavedMasters` uses to de-dup. Rename updates every variant sibling; delete's count and soft-delete operate on the same id set, so no folded-in variant can survive a `count===1` delete. I adopted the review's **preferred** fix (normalize everywhere via `.ilike(trimmed)` prefilter + JS `sameMasterName`, act by id) and did **not** claim stored names are canonicalized on save (confirmed they are not — `saveAccuracyCheck` writes the raw value). See "Grouping-key mismatch…", the predicate, and the rename/delete steps.

**Finding 2 (MEDIUM) — collision check could not distinguish "same group" from "different master." ADDRESSED.** The collision rule is now defined by set membership on ids: `groupIds = {ids where sameMasterName(file_name_master, oldFileName)}`; a collision exists iff an active row `r` has `sameMasterName(r.file_name_master, next)` and `r.id ∉ groupIds`. Pure case/whitespace self-renames carry the whole group and are allowed. See "Collision behavior … defined by set membership" and `renameMaster` step 3.

**Finding 3 (MEDIUM) — rename guard is TOCTOU but claimed to avoid races. ADDRESSED.** The design now states the limitation honestly: best-effort guard, no DB unique constraint (out of scope), concurrent rename/insert can still create a duplicate that the next `getSavedMasters()` refresh surfaces as two entries. Wording changed from "to avoid races" to "to **narrow** the race window" in the rename and collision paragraphs. See "Concurrency honesty."

**Finding 4 (NIT) — advisory delete count can be stale vs the authoritative DB guard. ADDRESSED.** Added the UX "Stale-count handling" bullet: on the thrown guard message, show it inline on the row and re-fetch `getSavedMasters()` + counts so the row flips to offering Replace. No behavior change beyond surfacing + refreshing. Reflected in AC #9.

**Finding 5 (NIT) — `deletedBy` type mismatch (`string|undefined` vs `string|null`). ADDRESSED.** Call site passes `user?.username ?? null` (matching the existing dispute delete calls and `deleteAccuracyCheck(id, deletedBy?: string|null)`). See the UX Delete bullet and Assumptions.

**On the review's "Unverified" notes:** the RLS enforcement claim is softened to "intended authoritative gate, unverified in this repo" (Permissions + Assumptions). The exact line numbers remain approximate and are immaterial; the functions/handlers at those locations were re-confirmed to exist and behave as described during this revision.
