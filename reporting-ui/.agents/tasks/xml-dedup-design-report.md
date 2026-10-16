# De-duplicating `xml_master` — Design & Scoping Report

**Status:** Design / decision-support only. No code changed, no migration run, no server touched.
**Scope:** `reporting-ui` (Next.js, client-side Supabase, anon key, RLS disabled on `accuracy_checks`).
**Primary concern (per user):** EGRESS. Storage is secondary.

---

## 1. Summary answer (read this first)

Today the master SportsCode XML / JSON feed is stored **once per check** in `accuracy_checks.xml_master`, and `propagateMasterCorrection` deliberately keeps that blob **byte-identical across every check of a master**. So a master with N checks holds **N identical copies** of a blob that is routinely hundreds of KB to a few MB. (The whole-table backup is ~1.77 MB JSON, so individual masters are a meaningful fraction of that; duplication scales linearly with checks-per-master.)

This duplication costs on three axes:

- **Storage:** N copies instead of 1.
- **Read egress:** every time a master is corrected/overridden/merged, or re-graded, the group is re-read; and `getAccuracyCheckById` pulls the blob on every saved-check re-open.
- **Write egress + write-amplification:** `propagateMasterCorrection` and `mergeMasters` write the *same* full master blob into **every** row of the group (N writes of the same large payload).

**Recommendation: do OPTION B now (read-path hygiene, no schema change, no migration), and treat OPTION A (a `masters` table) as a later, optional phase only if storage/write-amplification becomes a real cost.**

Rationale: the user cares primarily about egress, and most of the *recurring* egress waste is capturable with low-risk, no-migration changes. The single biggest *write-amplification* win (not rewriting the blob into N rows on every propagate/merge) is the one place that genuinely needs Option A to fully fix — but that is an **admin-frequency** operation, not a per-page-load cost, so it is lower priority than the user's main pain (egress on normal use). Option A is the "right" normalization but carries the largest blast radius (touches every read/write path, the compare page, history, disputes, merge, and backfill) and a real correctness risk around the "byte-identical master per check" grading invariant. **The payoff of A does not justify its risk until B's wins are measured.**

> ⚠️ One important nuance that changes the calculus: the list/leaderboard/dispute read paths are **already blob-free**. `getAccuracyChecksMeta`, `getAllAccuracyChecks`, `getAccuracyChecksForAnalyst`, and the deleted-checks list all project through `ACCURACY_CHECK_META_COLUMNS`, which **explicitly omits `xml_master`/`xml_analyst`**. So the high-frequency "load the dashboard" egress is already optimized. The remaining `xml_master` egress is concentrated in a smaller set of paths (re-open a check, correct/override/merge a master, master-timeline download, player-accuracy fallback, diagnostics, backfill). This materially shrinks the egress upside of a big migration and reinforces the "do B, defer A" recommendation.

---

## 2. Evidence — every READ of `xml_master`

All citations are `reporting-ui/lib/api/accuracyChecks.ts` unless noted.

| # | Site | Needs master XML for… | Blob pulled today? | Notes |
|---|------|----------------------|--------------------|-------|
| R1 | `getAccuracyCheckById` (`select("*")`, ~L1327) | the **specific check** being re-opened on the compare page — but the master XML it needs is the **group's** master (all siblings are identical) | **Yes** — `select("*")` pulls `xml_master` **and** `xml_analyst` | Called by compare-page re-open (`app/accuracy-compare/page.tsx` ~L1687) and by the disputes modal (`app/disputes/page.tsx` ~L856). The compare re-open genuinely needs `xml_master` to rebuild the master file; disputes needs it to render the editable master timeline. Both need the **analyst** XML too. |
| R2 | `getSavedMasterXml(checkId)` (~L1307) | the **master group** (one representative check holds the canonical copy) | Yes (one row, `xml_master` only) | The intended "fetch master once" accessor. Used by the reuse-master dropdown (`app/accuracy-compare/page.tsx` ~L2524) and by `mergeMasters` to read the destination master. This is already the efficient shape. |
| R3 | `getSavedMasters()` (~L1270) | nothing — only needs **presence** of a master | **No** — selects `id, file_name_master, video_url, created_at`; uses `.not("xml_master","is",null)` as a *filter* only | Already blob-free by design (comment explicitly says fetching every master XML "made this dropdown hang"). Good. |
| R4 | `getAccuracyChecksXml(ids)` (~L1480) | per-check player-accuracy fallback (needs **both** master+analyst for that check) **and** master-timeline download (needs just the **group** master) | Yes (one row at a time, `xml_master`+`xml_analyst`, concurrency 4) | Two very different callers share this. Player-accuracy fallback is genuinely per-check (needs the analyst side). The master-timeline download (`app/accuracy-checks/page.tsx` ~L1142) only needs the **group** master and currently pulls `xml_analyst` too — wasted egress. |
| R5 | `propagateMasterCorrection` group load (~L434) | re-grade the group; selects `xml_analyst` (NOT `xml_master`) | No master blob read | Reads analyst XML per row to re-grade; the corrected master comes from the caller. Good on the read side. |
| R6 | `mergeMasters` group reload (~L859) | re-grade destination group; selects `xml_analyst` only | No master blob read | Reads destination master once via R2, then analyst-only per row. Good. |
| R7 | `diagnoseMasterConsistency` (~L1042) | **detect divergence** between siblings' masters — purpose is to compare each row's master | Yes (per row, `xml_master` only) | This path *inherently needs per-row master XML* under today's model. Under Option A it becomes trivial/obsolete (all checks share one master row → divergence impossible). |
| R8 | `fixStaleMasterTotals` (~L1183) | recount instances in each row's own master | Yes (per row, `xml_master` only) | Repairs a stale `master_total` column. Under Option A, becomes a single recount per master. |
| R9 | `backfillPlayerAccuracy` (~L1545) | re-grade each row (needs master+analyst for that row) | Yes (per row, both blobs) | Admin batch tool. Per-check by nature (grades vs each row's analyst), but the master is identical across the group. |

**Classification for the reference model:** Only R1 (compare re-open), R4 (player-accuracy fallback), and R9 (backfill) need the master XML *in combination with that check's analyst XML*. In every one of those the master value is the **group's** master, not a per-check value. R2/R3/R6 already treat the master as a group-level resource. R7/R8 only exist *because* the master is duplicated and can drift — they largely disappear under a normalized model.

## 3. Evidence — every WRITE of `xml_master`

| # | Site | Write shape today | Egress / amplification cost |
|---|------|-------------------|------------------------------|
| W1 | `saveAccuracyCheck` insert (~L262) | writes `xml_master` on the new row | 1 blob write per new check — a duplicate if the master already exists in the group |
| W2 | `updateAccuracyCheck` (~L392) | always rewrites `xml_master` on one row | 1 blob write |
| W3 | `propagateMasterCorrection` (~L477, in loop) | writes the **same** corrected `xml_master` into **every** row of the group, one UPDATE per row | **N blob writes of an identical payload** — the core write-amplification. Admin frequency. |
| W4 | `mergeMasters` step 3 (~L837) | sets `file_name_master` + `xml_master` to the destination's on all source rows (one `.in` update) | writes dest blob onto M source rows |
| W5 | `mergeMasters` step 4 (~L900, in loop) | rewrites `xml_master = destXml` on **every** destination-group row | **N blob writes of an identical payload** |
| W6 | compare-page override-master (`app/accuracy-compare/page.tsx` ~L2378) | calls `propagateMasterCorrection` → W3 | same as W3 |
| W7 | compare-page "save corrected master" (~L1159) | calls `propagateMasterCorrection` → W3 | same as W3 |
| W8 | disputes "save corrected master" (`app/disputes/page.tsx` ~L1022) | calls `propagateMasterCorrection` → W3 | same as W3 |
| W9 | `ManageMastersDialog` replace-master (~L236) | calls `propagateMasterCorrection` → W3 | same as W3 |

**`renameMaster` does NOT touch `xml_master`** — confirmed: it only updates `file_name_master` (~L691). So renames are already cheap and are unaffected by any option.

**`fixStaleMasterTotals` writes only `master_total`**, not the blob (~L1200). Unaffected.

---

## 4. Design options

### Option A — `masters` table (full normalization)

Add a `masters` table holding each master's XML once; `accuracy_checks` drops `xml_master` and gains `master_id` (or `master_key`) FK. Reads join/fetch the master row; propagate/override/merge update **one** `masters` row instead of N check rows.

- **Storage saved:** maximal — 1 copy per master vs N.
- **Read egress saved:** eliminates R1/R4/R9 pulling a per-check duplicate; the compare re-open fetches the master row once. But note the big list paths are **already** blob-free, so the recurring per-page read saving is modest.
- **Write egress saved:** **largest win here** — W3/W5 collapse from N identical blob writes to **1**. Also makes R7/R8 (consistency diagnostics / stale-total repair) largely obsolete, since a group can no longer diverge.
- **Migration complexity:** **High.** Backfill a `masters` row per normalized `file_name_master`, point every check at it, dual-read during cutover, then drop the column. 1000+ rows.
- **Rollback:** harder — once `xml_master` is dropped you depend on `masters`; keep the old column through a long dual-write window to stay reversible.
- **Correctness risk:** **Highest.** The grading invariant is "the exact same master XML reaches `gradeOverlapScoped`/`compareInstances` for each check." A join/indirection must return **byte-identical** XML. Any normalization of the key (`file_name_master.trim().toLowerCase()` grouping — see `getSavedMasters`, `resolveActiveGroupIds`) must map every historical variant to exactly one master row without merging two genuinely-different masters that happen to share a name, and without splitting one master whose rows differ only by case/whitespace. The existing `diagnoseMasterConsistency` logic exists precisely because siblings **can** currently hold different bytes — a naive migration that picks "one" master per name could silently change grades for the minority rows.
- **Schema / RLS:** needs DDL (new table, FK) + an RLS decision. The project **disables RLS** on `accuracy_checks` (`migrations/fix_accuracy_checks_rls.sql`) and uses the anon key client-side; a new `masters` table must follow the same posture (disable RLS, or add permissive anon policies) or client reads/writes break.

### Option B — keep the column, stop fetching/writing it redundantly (RECOMMENDED FIRST)

Leave the schema untouched. Fix the *access patterns* so the master blob is read once per group and never pulled when not needed:

- **B1 — stop over-selecting on re-open (R1):** `getAccuracyCheckById` uses `select("*")`. The compare re-open and disputes modal both need `xml_master` + `xml_analyst`, so a bare switch to meta-columns would break them — but the fix is to confirm nothing *else* calls `getAccuracyCheckById` for a blob-free purpose (grep shows only those two callers, both of which need the blobs), so this one is already near-minimal. The real saving in B is below.
- **B2 — master-timeline download (R4 caller):** fetch only `xml_master` for that one representative check, not `xml_master`+`xml_analyst`. Halves that download's egress.
- **B3 — reuse the in-memory master across a group:** where a view already holds one check's master (e.g. the compare page after re-open), reuse it for the whole group rather than re-fetching per sibling. Compare already does this via `getSavedMasterXml` + the dropdown; keep that discipline.
- **Storage saved:** **none** (schema unchanged).
- **Read egress saved:** the recurring, per-interaction waste (R4 pulling the analyst blob it doesn't use; any redundant per-sibling master fetch). Captures most of the *read* egress that isn't already handled by the meta projection.
- **Write egress saved:** **none** — W3/W5 still write N copies. This is Option B's key limitation.
- **Migration:** none. **Rollback:** trivial (revert code). **Correctness risk:** **low** — the stored bytes are untouched, so grades cannot change; only which columns are selected changes.

### Option C — content-addressed / Storage-bucket dedup

Hash each distinct master XML; store once in a hash-keyed table or a Supabase Storage bucket; checks reference by hash.

- **Storage saved:** maximal (identical blobs collapse to one).
- **Read/write egress:** similar to A on reads; Storage egress is **metered separately** from DB egress, so this shifts cost rather than purely removing it, and adds Storage API calls.
- **Migration complexity:** High, plus a new storage surface and its own access-control model.
- **Correctness risk:** Medium-high — hashing must be over a canonical byte form; otherwise two "same" masters hash differently and don't dedup, or whitespace-trivial differences collide.
- **Verdict:** more moving parts than A for the same correctness burden, and it muddies the egress accounting (DB vs Storage). **Not recommended** for this app's "primarily reduce egress" goal.

---

## 5. Migration plan (for Option A, if/when pursued)

Only relevant if the write-amplification of W3/W5 is measured to matter. Sequence designed for **no downtime, no data loss, reversible**:

1. **Add `masters` table + nullable `master_id` on `accuracy_checks`** (DDL in a new file under `reporting-ui/migrations/`, run in the Supabase SQL editor like the existing migrations). Match the RLS posture of `accuracy_checks` (RLS disabled, or permissive anon policies). Keep `xml_master` in place.
2. **Backfill (idempotent):** for each normalized `file_name_master` group (same key as `resolveActiveGroupIds`: `trim().toLowerCase()`), create one `masters` row from a **chosen** canonical blob and set every member check's `master_id`. **Before choosing**, run `diagnoseMasterConsistency` logic per group: if a group has >1 distinct `xmlHash`, STOP and surface it — those rows are not actually identical and must be reconciled (or kept distinct) first, or the migration will change grades. Can run **client-side** from an admin tool (raw blob copy needs no DOMParser) one group at a time, mirroring the existing one-row-at-a-time pattern used to dodge statement timeouts; re-runnable because it keys on `master_id IS NULL`.
3. **Dual-read deploy:** change read paths to prefer `masters.xml` via `master_id`, falling back to the row's `xml_master` when `master_id` is null. Deploy before dropping anything.
4. **Dual-write deploy:** `propagate`/`override`/`merge`/`save`/`update` write the master to the `masters` row (once) **and** keep writing `xml_master` during the transition window so rollback stays possible.
5. **Verify** parity (every active check resolves to a byte-identical master vs its old `xml_master`), then **drop `xml_master`** and the dual-write in a final migration.
6. **Rollback:** before step 5, revert code; data is intact because `xml_master` was still maintained. After step 5, rollback requires repopulating `xml_master` from `masters` (a reverse backfill) — hence keep the dual-write window generous.

Running safely on 1000+ rows: paginate (the code already pages at 1000) and process one group/row at a time for blob work, exactly as `backfillPlayerAccuracy`, `diagnoseMasterConsistency`, and `getAccuracyChecksXml` already do to avoid Postgres statement timeouts on large blobs.

---

## 6. Correctness invariants (must hold for ANY option)

The grading contract is in `gradeOverlapScoped` (accuracyChecks.ts): for each check, the **exact same master XML** must reach `canonicaliseTeams` → `scopeToOverlap` → `compareInstances` / `computePlayerAccuracyByScope`. Guarantees required:

- **Byte-identical master per check.** Today this is enforced *by duplication* (every row literally holds the bytes) plus `propagateMasterCorrection`/`mergeMasters` overwriting the whole group together.
  - **Option B** preserves this trivially — bytes are never moved.
  - **Option A** must guarantee the join returns the same bytes the row would have held. The risk is the **grouping key**: `file_name_master` grouping is case/whitespace-insensitive, and `diagnoseMasterConsistency` proves groups *can* currently hold divergent bytes. Collapsing a divergent group to one `masters` row **would change grades** for the minority. The migration MUST detect and resolve divergent groups before collapsing (step 2 above).
- **No scope drift.** The overlap-scoped re-grade is identical across save/update/propagate/merge/backfill today (shared `gradeOverlapScoped`). Any option must keep feeding that same function; neither B nor A changes the grader, only where the master bytes come from.

---

## 7. Risk assessment & recommendation

**Blast radius of Option A:** every check read/write path (R1, R4, R9; W1–W9), the compare page re-open + override + save, the disputes correction modal, the history master-timeline download + consistency diagnostics + stale-total repair, `mergeMasters`, and the backfill admin tools. Plus new DDL and an RLS decision. This is essentially the entire accuracy subsystem.

**What could go wrong with A:** silent grade changes from collapsing divergent same-name groups; a join/normalization mismatch returning the wrong master bytes; RLS misconfig blocking anon client access; an interrupted migration leaving mixed `master_id`/`xml_master` state (mitigated by dual-read/dual-write and idempotent backfill).

**What Option B captures:** most of the *read-path* egress not already handled by the blob-free meta projection, at near-zero risk and zero migration. It does **not** fix storage or the W3/W5 write-amplification.

**Recommendation:**

1. **Do Option B now.** Trim R4's master-timeline download to `xml_master`-only, confirm no blob-free caller uses `getAccuracyCheckById`, and keep the "fetch master once per group, reuse in memory" discipline. Lowest risk, no migration, captures the bulk of the recurring egress the meta projection doesn't already cover.
2. **Measure.** Because the list/leaderboard/dispute paths are already blob-free, confirm with actual Supabase egress metrics where the remaining `xml_master` bytes are going before committing to a migration. The dominant remaining cost is likely the **write-amplification of propagate/override/merge** (W3/W5) — an admin-frequency, not per-load, cost.
3. **Only then consider Option A**, and only if write-amplification or storage is measured to justify its blast radius. If pursued, follow the dual-read/dual-write migration in §5 and the divergent-group guard in §6. Do **not** pursue Option C — it shifts egress to a separately-metered Storage surface without a clear net win for this goal.

**Bottom line:** Option B is the lowest-risk option that captures most of the egress win the user cares about, so pursue it first; Option A is the only full fix for storage + write-amplification but its payoff does not justify its risk until B is in place and metrics prove the remaining cost is real.
