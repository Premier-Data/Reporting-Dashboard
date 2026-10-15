import { supabase } from "@/lib/supabase";
import {
    parseInstances,
    compareInstances,
    canonicaliseTeams,
} from "@/lib/comparison/xml-compare";
import type {
    ComparisonResult,
    CategoryBreakdown,
    TeamBreakdown,
    Instance,
} from "@/lib/comparison/xml-compare";
import { scopeToOverlap } from "@/lib/comparison/overlap-window";
import {
    jsonEventsToInstances,
    playerNumberMapFromReport,
} from "@/lib/comparison/json-adapter";
import {
    computePlayerAccuracyByScope,
    type StoredPlayerAccuracy,
} from "@/lib/comparison/player-accuracy";

/**
 * Turn a stored raw source string into instances, regardless of whether it's
 * SportsCode XML or a JSON event feed. The accuracy page can now grade a JSON
 * feed on either side, in which case `xml_master`/`xml_analyst` holds JSON
 * text — running parseInstances (which uses DOMParser and looks for
 * <instance> elements) on that silently returns [], which is exactly what made
 * saved checks recompute against an empty side and show a wrong (near-zero)
 * accuracy vs the live view. Detect JSON by a leading "{" and route it through
 * the same adapter the UI uses, so the stored numbers match the live ones.
 */
export function instancesFromRaw(raw: string | null | undefined): Instance[] {
    if (!raw) return [];
    if (raw.trimStart().startsWith("{")) {
        try {
            const parsed = JSON.parse(raw) as {
                allStatistics?: Parameters<typeof jsonEventsToInstances>[0];
                allParticipants?: {
                    playerUid?: number | null;
                    playerNumber?: number | null;
                }[];
            };
            if (Array.isArray(parsed.allStatistics)) {
                // Raw stat events carry no jersey number — join it from the
                // report's participants (playerUid -> number).
                return jsonEventsToInstances(parsed.allStatistics, {
                    playerNumberByUid: playerNumberMapFromReport(parsed),
                });
            }
            return [];
        } catch {
            return [];
        }
    }
    return parseInstances(raw);
}

/**
 * A saved accuracy check row (mirrors the accuracy_checks table).
 */
export interface AccuracyCheck {
    id: number;
    created_at: string;

    analyst_name: string;
    master_analyst_name: string | null;

    match_label: string | null;
    file_name_master: string | null;
    file_name_analyst: string | null;
    tolerance: number | null;

    accuracy: number;
    master_total: number;
    analyst_total: number;
    exact: number;
    wrong_stat: number;
    wrong_player: number;
    wrong_team: number;
    missed: number;
    extra: number;
    avg_time_drift: number;

    category_breakdown: CategoryBreakdown[] | null;
    team_breakdown: TeamBreakdown[] | null;

    // Raw source XML so a saved check can be fully re-opened.
    xml_master: string | null;
    xml_analyst: string | null;

    // Game video URL so it doesn't need to be re-found on re-open.
    video_url: string | null;

    // Sport the check was graded under ("afl" | "football"), so it
    // re-opens with the right player-stats table.
    sport: string | null;

    // Precomputed Player Accuracy (both/home/away group results) so the
    // "Checks by master fixture" table can render without re-fetching and
    // re-parsing the raw XML. Recomputed on save/update/propagate. Null on
    // older checks until backfilled.
    player_accuracy: StoredPlayerAccuracy | null;

    // Soft delete: when set, the check is treated as deleted (hidden from all
    // active views) but kept for review/restore. `deleted_by` is the username
    // that removed it. Null on active checks.
    deleted_at: string | null;
    deleted_by: string | null;
}

export interface SaveAccuracyCheckInput {
    analystName: string;
    masterAnalystName?: string | null;
    xmlMaster?: string | null;
    xmlAnalyst?: string | null;
    videoUrl?: string | null;
    sport?: string | null;
    matchLabel?: string | null;
    fileNameMaster?: string | null;
    fileNameAnalyst?: string | null;
    tolerance?: number | null;
    result: ComparisonResult;
}

/**
 * The SINGLE source of truth for every stored accuracy field. Deterministically
 * grades a check OVERLAP-SCOPED (the section the analyst coded), the SAME way
 * the compare page's live Overlap view does, regardless of any Range selected
 * at save time:
 *
 *   1. Canonicalise the FULL master/analyst sets with the SAME arguments the
 *      compare page uses (incl. the master file name), so the Home/Away mapping
 *      is derived from the whole file — not a subset that could flip it.
 *   2. Scope the already-canonical sets to the overlap window (shared helper).
 *   3. Grade over the scoped sets. compareInstances / computePlayerAccuracyByScope
 *      re-canonicalise, but hit canonicaliseTeams' idempotency guard (inputs are
 *      Home/Away-only) and pass through unchanged — so the stored both/home/away
 *      split matches the live Overlap view, not just the headline figure.
 *
 * Pure given (xml, tolerance, fileName). Returns null ONLY when ungradeable
 * (the source is unparsable or the master parses empty). Grading is client-side
 * (DOMParser), so in the real save flow this is effectively unreachable; a null
 * result is handled by each caller as an explicit "not graded yet" marker
 * (null columns) that the backfill later reconciles — never a silent fall back
 * to a Range-dependent, unknown-scope value.
 */
function gradeOverlapScoped(
    xmlMaster: string | null | undefined,
    xmlAnalyst: string | null | undefined,
    tolerance: number | null | undefined,
    fileNameMaster: string | null | undefined
): { result: ComparisonResult; playerAccuracy: StoredPlayerAccuracy } | null {
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
    //    idempotency guard (inputs are Home/Away-only), and pass through — so
    //    the labels are the full-set labels, matching the live view.
    const result = compareInstances(scoped.master, scoped.analyst, tol, name);
    const playerAccuracy = computePlayerAccuracyByScope(
        scoped.master,
        scoped.analyst,
        tol,
        name
    );
    return { result, playerAccuracy };
}

/**
 * Persists a comparison result as an accuracy check attributed to the
 * graded analyst (and, optionally, the analyst who coded the master).
 */
export async function saveAccuracyCheck(
    input: SaveAccuracyCheckInput
): Promise<AccuracyCheck> {
    // Grade OVERLAP-SCOPED from the raw source, NOT from input.result (which
    // reflects whatever Range the compare page happened to show). This is the
    // single derivation shared by update/propagate/backfill, so the stored
    // number always matches the live Overlap view.
    const graded = gradeOverlapScoped(
        input.xmlMaster,
        input.xmlAnalyst,
        input.tolerance,
        input.fileNameMaster
    );
    if (!graded) {
        // Ungradeable (unparsable / empty master). Do NOT fall back to the
        // Range-dependent input.result — that would store an unknown-scope row
        // and break the "always overlap" invariant. Store null accuracy columns
        // (an explicit "not graded yet" marker, same shape backfill fills) and
        // keep the raw XML so the next backfill reconciles it in the browser.
        console.warn(
            "saveAccuracyCheck: source ungradeable; saving row without accuracy (reconciled by backfill)."
        );
    }
    const s = graded?.result.summary;

    const row = {
        analyst_name: input.analystName.trim(),
        master_analyst_name: input.masterAnalystName?.trim() || null,
        match_label: input.matchLabel?.trim() || null,
        file_name_master: input.fileNameMaster ?? null,
        file_name_analyst: input.fileNameAnalyst ?? null,
        tolerance: input.tolerance ?? null,

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

        xml_master: input.xmlMaster ?? null,
        xml_analyst: input.xmlAnalyst ?? null,
        video_url: input.videoUrl?.trim() || null,
        sport: input.sport ?? null,

        // Overlap-scoped Player Accuracy (all scopes) from the same grade, so
        // the fixture table reads a small stored field instead of re-parsing.
        player_accuracy: graded?.playerAccuracy ?? null,
    };

    const { data, error } = await supabase
        .from("accuracy_checks")
        .insert(row)
        .select()
        .single();

    if (error) {
        console.error("Failed saving accuracy check:", error);
        throw new Error(error.message || "Failed saving accuracy check");
    }

    return data as AccuracyCheck;
}

export interface UpdateAccuracyCheckInput {
    id: number;
    /** The corrected master XML to store. */
    xmlMaster: string;
    /** The recomputed comparison result (master vs the check's analyst). */
    result: ComparisonResult;
    /**
     * Optional full-check fields. When provided (e.g. from the "Update check"
     * button on the comparison page), these are written too so an in-place
     * update fully mirrors a fresh save. Omit them (e.g. from the dispute
     * master-correction flow) to only rewrite master XML + summary.
     */
    masterAnalystName?: string | null;
    analystName?: string | null;
    matchLabel?: string | null;
    fileNameMaster?: string | null;
    fileNameAnalyst?: string | null;
    tolerance?: number | null;
    xmlAnalyst?: string | null;
    videoUrl?: string | null;
    sport?: string | null;
}

/**
 * Update an EXISTING saved check in place (no new row). Always rewrites the
 * master XML and recomputed summary/breakdowns + precomputed player_accuracy.
 * Any optional full-check fields provided (label, analysts, video, etc.) are
 * updated too, so this can serve both the dispute master-correction flow and
 * a full "Update check" from the comparison page.
 */
export async function updateAccuracyCheck(
    input: UpdateAccuracyCheckInput
): Promise<AccuracyCheck> {
    // Grade OVERLAP-SCOPED from the (edited) master vs the analyst, NOT from
    // input.result. The sole caller (handleUpdateCheck on the compare page)
    // always passes xmlAnalyst/fileNameMaster/tolerance, so this normally
    // produces a real overlap-scoped grade.
    let graded = gradeOverlapScoped(
        input.xmlMaster,
        input.xmlAnalyst,
        input.tolerance,
        input.fileNameMaster
    );
    // Defensive: if a FUTURE caller omits xmlAnalyst entirely (partial update),
    // recover the analyst side from the stored row so we never blank a
    // previously-good row. (A null — but provided — analyst XML is a genuine
    // ungradeable row and is NOT recovered here.)
    if (!graded && input.xmlAnalyst === undefined) {
        const { data: cur } = await supabase
            .from("accuracy_checks")
            .select("xml_analyst, file_name_master, tolerance")
            .eq("id", input.id)
            .single();
        if (cur) {
            const c = cur as {
                xml_analyst: string | null;
                file_name_master: string | null;
                tolerance: number | null;
            };
            graded = gradeOverlapScoped(
                input.xmlMaster,
                c.xml_analyst,
                input.tolerance ?? c.tolerance,
                input.fileNameMaster ?? c.file_name_master
            );
        }
    }
    if (!graded) {
        console.warn(
            "updateAccuracyCheck: source ungradeable; writing null accuracy (reconciled by backfill)."
        );
    }
    const s = graded?.result.summary;

    const row: Record<string, unknown> = {
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

        xml_master: input.xmlMaster,

        // Overlap-scoped Player Accuracy from the same grade.
        player_accuracy: graded?.playerAccuracy ?? null,
    };

    // Only overwrite these when explicitly provided.
    if (input.masterAnalystName !== undefined)
        row.master_analyst_name = input.masterAnalystName?.trim() || null;
    if (input.analystName !== undefined)
        row.analyst_name = input.analystName?.trim() || null;
    if (input.matchLabel !== undefined)
        row.match_label = input.matchLabel?.trim() || null;
    if (input.fileNameMaster !== undefined)
        row.file_name_master = input.fileNameMaster ?? null;
    if (input.fileNameAnalyst !== undefined)
        row.file_name_analyst = input.fileNameAnalyst ?? null;
    if (input.tolerance !== undefined) row.tolerance = input.tolerance ?? null;
    if (input.xmlAnalyst !== undefined)
        row.xml_analyst = input.xmlAnalyst ?? null;
    if (input.videoUrl !== undefined)
        row.video_url = input.videoUrl?.trim() || null;
    if (input.sport !== undefined) row.sport = input.sport ?? null;

    const { data, error } = await supabase
        .from("accuracy_checks")
        .update(row)
        .eq("id", input.id)
        .select()
        .single();

    if (error) {
        console.error("Failed updating accuracy check:", error);
        throw new Error(error.message || "Failed updating accuracy check");
    }

    return data as AccuracyCheck;
}

export interface PropagateMasterResult {
    /** How many checks were updated (including the source check). */
    updated: number;
    /** Distinct analyst names whose checks were re-graded. */
    analysts: string[];
}

/**
 * The master file is a single source of truth: correcting it should apply to
 * EVERY check graded against that same master, not just the one being viewed.
 *
 * Given a corrected master XML and the master file name, this rewrites
 * `xml_master` on every check with that `file_name_master` and RECOMPUTES each
 * one's accuracy against ITS OWN analyst XML (the analyst side is untouched).
 * So an admin corrects the master once — from any analyst's dispute — and all
 * checks of that master reflect it; later corrections keep building on it.
 *
 * Matching key: `file_name_master` (the master file is always the same file).
 */
export async function propagateMasterCorrection(
    fileNameMaster: string,
    xmlMaster: string
): Promise<PropagateMasterResult> {
    // Every check for this master, with the analyst XML needed to re-grade.
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("id, analyst_name, tolerance, xml_analyst, file_name_master")
        .eq("file_name_master", fileNameMaster)
        .is("deleted_at", null);

    if (error) {
        console.error("Failed loading checks for master:", error);
        throw new Error(error.message || "Failed loading checks for master");
    }

    const analysts = new Set<string>();
    let updated = 0;

    for (const row of (data ?? []) as {
        id: number;
        analyst_name: string;
        tolerance: number | null;
        xml_analyst: string | null;
        file_name_master: string | null;
    }[]) {
        // Re-grade this check against the corrected master, OVERLAP-SCOPED the
        // same deterministic way as save/update/backfill — so a later master
        // correction can never silently rewrite siblings back to full-game scope.
        const graded = gradeOverlapScoped(
            xmlMaster,
            row.xml_analyst,
            row.tolerance,
            fileNameMaster
        );
        if (!graded) {
            // Ungradeable row: write null accuracy columns (reconciled by
            // backfill) and continue rather than aborting the whole propagation.
            console.warn(
                `propagateMasterCorrection: check ${row.id} ungradeable; writing null accuracy.`
            );
        }
        const s = graded?.result.summary;

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
                xml_master: xmlMaster,
                player_accuracy: graded?.playerAccuracy ?? null,
            })
            .eq("id", row.id);

        if (upErr) {
            console.error(`Failed updating check ${row.id}:`, upErr);
            throw new Error(upErr.message || "Failed propagating master");
        }
        updated += 1;
        if (row.analyst_name) analysts.add(row.analyst_name);
    }

    return { updated, analysts: Array.from(analysts) };
}

/**
 * Count how many checks share a master file (for a confirmation prompt before
 * propagating a correction). Returns the count and the distinct analyst names.
 */
export async function getMasterCheckSiblings(
    fileNameMaster: string
): Promise<{ count: number; analysts: string[] }> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("analyst_name")
        .eq("file_name_master", fileNameMaster)
        .is("deleted_at", null);
    if (error) {
        console.error("Failed counting master siblings:", error);
        return { count: 0, analysts: [] };
    }
    const analysts = Array.from(
        new Set(
            (data ?? [])
                .map((r) => (r as { analyst_name: string }).analyst_name)
                .filter(Boolean)
        )
    );
    return { count: data?.length ?? 0, analysts };
}

// ---- Manage saved masters (rename / delete) -----------------------
//
// A "saved master" is a DERIVED concept: the set of accuracy_checks rows
// sharing the same file_name_master. The dropdown (getSavedMasters) groups
// those rows by the NORMALIZED key `file_name_master.trim().toLowerCase()`, so
// a single entry can fold in rows whose stored name differs only by case or
// surrounding whitespace. These management mutations therefore resolve a master
// to the SAME normalized group and act by the resulting row-id list — never by
// a bare `.eq` on the raw stored string — so the dropdown's grouping and the
// mutations' targeting always agree.
//
// The three equality/validation helpers below are kept CHARACTER-IDENTICAL to
// `app/accuracy-compare/master-manage-logic.ts` (which carries their unit
// tests). They are inlined here rather than imported because this `lib/` module
// must not depend on `app/`; the logic module remains the single contract.

/** Trim only, no case-fold (what gets persisted). */
function normalizeMasterName(name: string): string {
    return name.trim();
}

/** Non-empty-after-trim validation for a master display name. */
function isValidMasterName(name: string): boolean {
    return name.trim().length > 0;
}

/** The ONE grouping rule: case-insensitive + trim equality. */
function sameMasterName(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface RenameMasterResult {
    /** How many active rows were renamed. */
    updated: number;
}

export interface DeleteMasterResult {
    /** 1 when the single attached check was soft-deleted, 0 when none remained. */
    deleted: number;
}

/**
 * INTERNAL. Resolve the active (deleted_at IS NULL) rows that belong to the
 * SAME master group as `fileName` under trim + case-insensitive equality, and
 * return their ids.
 *
 * The `.ilike("file_name_master", fileName.trim())` is a deliberately loose
 * SERVER-SIDE prefilter: it is case-insensitive but NOT whitespace-insensitive,
 * and `_`/`%` in a filename are ILIKE wildcards that may over-match. The JS
 * `sameMasterName` filter afterwards narrows the result to exact normalized
 * equality, so the resolved id set is always correct regardless of what the
 * prefilter returned.
 */
async function resolveActiveGroupIds(fileName: string): Promise<number[]> {
    const key = normalizeMasterName(fileName);
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("id, file_name_master")
        .ilike("file_name_master", key)
        .is("deleted_at", null);
    if (error) {
        console.error("Failed resolving master group:", error);
        throw new Error(error.message || "Failed resolving master group");
    }
    return (data ?? [])
        .filter((r) =>
            sameMasterName(
                ((r as { file_name_master: string | null }).file_name_master ?? ""),
                fileName
            )
        )
        .map((r) => (r as { id: number }).id);
}

/**
 * Normalized active count for the deletable predicate and the advisory UI
 * count shown in the Manage dialog. Counts rows in the normalized group (NOT an
 * exact-string match), so it can never report 1 while case/space-variant
 * siblings the dropdown folded in survive.
 */
export async function countActiveGroupSiblings(
    fileName: string
): Promise<number> {
    return (await resolveActiveGroupIds(fileName)).length;
}

/**
 * Rename a saved master's display filename across EVERY active check in its
 * normalized group (including case/whitespace variants the dropdown folded
 * together), so they all regroup under the new name with no stray variant left
 * behind. Soft-deleted rows are intentionally untouched.
 *
 * Rejects an empty-after-trim name (pre-DB, no write) and a collision with a
 * DIFFERENT existing active master (membership defined by row id, so a pure
 * case/whitespace self-rename of the same group is allowed). Returns how many
 * rows were renamed.
 *
 * The collision guard is BEST-EFFORT: it is a client-side read (resolve group +
 * collision query) followed by a separate client-side update — a TOCTOU window.
 * There is no DB uniqueness constraint on file_name_master and no server
 * transaction (both out of scope), so concurrent renames/inserts can still
 * produce a duplicate name, which the next getSavedMasters() refresh surfaces
 * as two dropdown entries for the admin to re-rename. Running the guard against
 * a fresh query here narrows the race window; it does not eliminate it.
 */
export async function renameMaster(
    oldFileName: string,
    newFileName: string
): Promise<RenameMasterResult> {
    const next = normalizeMasterName(newFileName);
    if (!isValidMasterName(next)) {
        throw new Error("Master name cannot be empty.");
    }

    const groupIds = await resolveActiveGroupIds(oldFileName);
    if (groupIds.length === 0) {
        // Nothing active under the old name — nothing to rename.
        return { updated: 0 };
    }

    // Collision check by id-set membership. Skip it for a pure
    // case/whitespace self-rename (the whole group already matches `next`, so
    // there can be no outside row by definition).
    if (!sameMasterName(next, oldFileName)) {
        const { data: collisionRows, error: collisionError } = await supabase
            .from("accuracy_checks")
            .select("id, file_name_master")
            .is("deleted_at", null)
            .ilike("file_name_master", next);
        if (collisionError) {
            console.error("Failed checking master name collision:", collisionError);
            throw new Error(
                collisionError.message || "Failed to rename master."
            );
        }
        const groupIdSet = new Set(groupIds);
        const collides = (collisionRows ?? []).some((r) => {
            const row = r as { id: number; file_name_master: string | null };
            return (
                sameMasterName(row.file_name_master ?? "", next) &&
                !groupIdSet.has(row.id)
            );
        });
        if (collides) {
            throw new Error(
                `A master named "${next}" already exists. Choose a different name.`
            );
        }
    }

    const { data: updatedRows, error } = await supabase
        .from("accuracy_checks")
        .update({ file_name_master: next })
        .in("id", groupIds)
        .select("id");
    if (error) {
        console.error("Failed renaming master:", error);
        throw new Error(error.message || "Failed to rename master.");
    }
    return { updated: updatedRows?.length ?? 0 };
}

/**
 * Delete a saved master. Allowed ONLY when exactly one active check is in its
 * normalized group — in which case that single check IS the master and is
 * soft-deleted (set deleted_at/deleted_by), recoverable from "Deleted checks".
 *
 * Re-resolves the group and re-checks the predicate here (not trusting a
 * possibly-stale UI count): 0 rows → no-op `{ deleted: 0 }`; >1 rows → THROW
 * (the caller must Replace instead; this is the authoritative data-safety
 * guard that prevents orphaning or destroying another analyst's graded
 * accuracy); exactly 1 → soft-delete that single row by id.
 */
export async function deleteMaster(
    fileName: string,
    deletedBy?: string | null
): Promise<DeleteMasterResult> {
    const ids = await resolveActiveGroupIds(fileName);
    if (ids.length === 0) {
        return { deleted: 0 };
    }
    if (ids.length > 1) {
        throw new Error(
            `Cannot delete: ${ids.length} accuracy checks are attached to this master. Replace it instead.`
        );
    }
    const { error } = await supabase
        .from("accuracy_checks")
        .update({
            deleted_at: new Date().toISOString(),
            deleted_by: deletedBy ?? null,
        })
        .eq("id", ids[0]);
    if (error) {
        console.error("Failed deleting master:", error);
        throw new Error(error.message || "Failed to delete master.");
    }
    return { deleted: 1 };
}

// ---- Master consistency diagnostic --------------------------------

// A per-stat count difference of this check's master vs the reference master.
// We compare COUNTS PER STAT rather than trying to pair individual events,
// which avoids noise from re-graded players/timing. `delta = thisCount -
// referenceCount`: positive means this master has more of that stat, negative
// means fewer. The deltas sum to the master-total difference.
export interface MasterStatDiff {
    stat: string;
    referenceCount: number;
    thisCount: number;
    delta: number;
}

/** One sibling check's master snapshot, for the consistency diagnostic. */
export interface MasterSiblingCheck {
    checkId: number;
    analystName: string;
    createdAt: string;
    /** master_total stored on the row (as shown in the Ex/Mas column). */
    storedMasterTotal: number;
    /** Live count of parsed instances in this check's xml_master. */
    parsedMasterTotal: number | null;
    /** SHA-like short hash of the raw xml_master, to spot identical files. */
    xmlHash: string | null;
    /**
     * Per-stat count differences vs the reference (majority) master. Only
     * stats whose count differs are included, sorted by largest gap. Empty
     * when this master matches the reference (or is the reference).
     */
    statDiffs: MasterStatDiff[];
    /** Net master-total difference vs reference (sum of the stat deltas). */
    totalDelta: number;
    /** True when this check's master is the chosen reference version. */
    isReference: boolean;
}

export interface MasterConsistencyReport {
    fileNameMaster: string;
    checks: MasterSiblingCheck[];
    /** Distinct parsed instance counts seen across siblings. */
    distinctCounts: number[];
    /** Distinct xml hashes seen (byte-level file variants). */
    distinctHashes: number;
    /** True when every sibling parses to the same master instance count. */
    consistent: boolean;
    /**
     * Check ids whose STORED master_total disagrees with what their own
     * xml_master actually parses to — i.e. a stale column, not a real master
     * difference. These are what make the history banner fire while the
     * parsed masters are actually identical.
     */
    staleTotalCheckIds: number[];
}

// Tiny, fast, non-cryptographic hash (djb2) of a string, hex-encoded. Used
// only to tell whether two stored master files are byte-identical.
function cheapHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = (h * 33) ^ s.charCodeAt(i);
    }
    // >>> 0 keeps it an unsigned 32-bit int.
    return (h >>> 0).toString(16);
}

/**
 * Diagnose why sibling checks of the SAME master file can show different
 * master totals. Fetches each check's stored xml_master, re-parses it to count
 * instances, and hashes the raw XML so identical vs edited files are obvious.
 *
 * Read-only: touches no data. Runs client-side (parseInstances needs the
 * browser DOMParser). Fetches XML one row at a time to avoid the statement
 * timeouts that batching hits on large blobs.
 */
export async function diagnoseMasterConsistency(
    fileNameMaster: string
): Promise<MasterConsistencyReport> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("id, analyst_name, created_at, master_total")
        .eq("file_name_master", fileNameMaster)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });

    if (error) {
        console.error("Failed loading sibling checks:", error);
        throw new Error(error.message || "Failed loading sibling checks");
    }

    const rows = (data ?? []) as {
        id: number;
        analyst_name: string;
        created_at: string;
        master_total: number;
    }[];

    // First pass: fetch + parse each check's master XML.
    type Parsed = {
        row: (typeof rows)[number];
        instances: ReturnType<typeof parseInstances> | null;
        xmlHash: string | null;
    };
    const parsed: Parsed[] = [];
    for (const row of rows) {
        // One row at a time — xml blobs are large.
        const { data: xmlRow, error: xmlErr } = await supabase
            .from("accuracy_checks")
            .select("xml_master")
            .eq("id", row.id)
            .single();

        let instances: ReturnType<typeof parseInstances> | null = null;
        let xmlHash: string | null = null;
        if (!xmlErr && xmlRow) {
            const xml = (xmlRow as { xml_master: string | null }).xml_master;
            if (xml) {
                try {
                    instances = parseInstances(xml);
                } catch {
                    instances = null;
                }
                xmlHash = cheapHash(xml);
            }
        }
        parsed.push({ row, instances, xmlHash });
    }

    // Choose the REFERENCE version: the xml hash shared by the most checks
    // (the master everyone else is compared against). Ties break on whichever
    // appears first.
    const hashFreq = new Map<string, number>();
    for (const p of parsed) {
        if (p.xmlHash) hashFreq.set(p.xmlHash, (hashFreq.get(p.xmlHash) ?? 0) + 1);
    }
    let referenceHash: string | null = null;
    let bestFreq = -1;
    for (const [h, n] of hashFreq.entries()) {
        if (n > bestFreq) {
            bestFreq = n;
            referenceHash = h;
        }
    }
    const referenceInstances =
        parsed.find((p) => p.xmlHash === referenceHash)?.instances ?? null;

    type PInst = { stat: string; category: string };
    const statOf = (i: PInst) => (i.stat || i.category || "—").trim();

    // Count instances per stat for a master. This is the basis of the diff:
    // comparing per-stat counts (not individual events) cleanly explains a
    // total difference and is immune to re-graded player/timing noise.
    const countByStat = (
        instances: ReturnType<typeof parseInstances> | null
    ): Map<string, number> => {
        const m = new Map<string, number>();
        for (const i of instances ?? []) {
            const s = statOf(i);
            m.set(s, (m.get(s) ?? 0) + 1);
        }
        return m;
    };

    const refCounts = countByStat(referenceInstances);

    const checks: MasterSiblingCheck[] = parsed.map((p) => {
        const isReference = p.xmlHash === referenceHash;
        const statDiffs: MasterStatDiff[] = [];
        let totalDelta = 0;

        if (!isReference && p.instances && referenceInstances) {
            const thisCounts = countByStat(p.instances);
            // Union of every stat seen in either master.
            const allStats = new Set<string>([
                ...refCounts.keys(),
                ...thisCounts.keys(),
            ]);
            for (const stat of allStats) {
                const referenceCount = refCounts.get(stat) ?? 0;
                const thisCount = thisCounts.get(stat) ?? 0;
                const delta = thisCount - referenceCount;
                if (delta !== 0) {
                    statDiffs.push({ stat, referenceCount, thisCount, delta });
                    totalDelta += delta;
                }
            }
            // Biggest absolute gaps first.
            statDiffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        }

        return {
            checkId: p.row.id,
            analystName: p.row.analyst_name,
            createdAt: p.row.created_at,
            storedMasterTotal: p.row.master_total,
            parsedMasterTotal: p.instances ? p.instances.length : null,
            xmlHash: p.xmlHash,
            statDiffs,
            totalDelta,
            isReference,
        };
    });

    const distinctCounts = Array.from(
        new Set(
            checks
                .map((c) => c.parsedMasterTotal)
                .filter((n): n is number => n != null)
        )
    ).sort((a, b) => a - b);
    const distinctHashes = new Set(
        checks.map((c) => c.xmlHash).filter(Boolean)
    ).size;

    const staleTotalCheckIds = checks
        .filter(
            (c) =>
                c.parsedMasterTotal != null &&
                c.parsedMasterTotal !== c.storedMasterTotal
        )
        .map((c) => c.checkId);

    return {
        fileNameMaster,
        checks,
        distinctCounts,
        distinctHashes,
        consistent: distinctCounts.length <= 1,
        staleTotalCheckIds,
    };
}

/**
 * Recompute + persist `master_total` for checks whose stored value has drifted
 * from what their xml_master actually parses to. Read the master XML, count
 * instances, and write the corrected count. Returns how many rows were fixed.
 *
 * Fixes the case where the history "master totals differ" banner fires purely
 * because a stored total is stale (the master files are actually identical).
 * Runs client-side (parseInstances). Pass the check ids from a
 * MasterConsistencyReport's `staleTotalCheckIds`.
 */
export async function fixStaleMasterTotals(
    checkIds: number[]
): Promise<{ fixed: number }> {
    let fixed = 0;
    for (const id of checkIds) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select("xml_master")
            .eq("id", id)
            .single();
        if (error || !data) {
            console.error(`Failed loading XML for check ${id}:`, error);
            continue;
        }
        const xml = (data as { xml_master: string | null }).xml_master;
        if (!xml) continue;
        let count: number;
        try {
            count = parseInstances(xml).length;
        } catch {
            continue;
        }
        const { error: upErr } = await supabase
            .from("accuracy_checks")
            .update({ master_total: count })
            .eq("id", id);
        if (upErr) {
            console.error(`Failed fixing master_total for ${id}:`, upErr);
            continue;
        }
        fixed += 1;
    }
    return { fixed };
}

/**
 * Subscribe to UPDATEs of a single accuracy check row (via Supabase Realtime).
 * Fires `onUpdate` whenever the row changes (e.g. a corrected master saved
 * from the Disputes page), so an open view can offer to reload. Returns an
 * unsubscribe function.
 *
 * NOTE: Requires Realtime to be enabled for the `accuracy_checks` table in the
 * Supabase dashboard (Database → Replication / Publications). Without it the
 * callback simply never fires — the feature degrades gracefully.
 */
export function subscribeToAccuracyCheck(
    id: number,
    onUpdate: () => void
): () => void {
    const channel = supabase
        .channel(`accuracy_check_${id}`)
        .on(
            "postgres_changes",
            {
                event: "UPDATE",
                schema: "public",
                table: "accuracy_checks",
                filter: `id=eq.${id}`,
            },
            () => onUpdate()
        )
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
}

export interface SavedMaster {
    /** The check row that holds this master's most-recent XML. */
    checkId: number;
    fileName: string;
    videoUrl: string | null;
}

/**
 * Distinct saved masters, for the "reuse master" dropdown.
 *
 * Only lightweight columns are fetched here (NOT the large `xml_master`
 * blob): a single dropdown needs just the file names. The full XML for
 * whichever master the user actually picks is loaded on demand via
 * `getSavedMasterXml(checkId)`. Fetching every stored master XML up front
 * pulls megabytes of XML across every check and hammers the database —
 * which made this dropdown hang.
 *
 * De-duplicated by master file name (most recent wins).
 */
export async function getSavedMasters(): Promise<SavedMaster[]> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("id, file_name_master, video_url, created_at")
        .not("xml_master", "is", null)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Failed loading saved masters:", error);
        return [];
    }

    const seen = new Set<string>();
    const masters: SavedMaster[] = [];
    for (const row of data ?? []) {
        const fileName = (row as any).file_name_master as string | null;
        const id = (row as any).id as number | null;
        if (!fileName || id == null) continue;
        const key = fileName.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        masters.push({
            checkId: id,
            fileName,
            videoUrl: (row as any).video_url ?? null,
        });
    }
    return masters;
}

/**
 * Load one saved master's raw XML on demand (when the user picks it from
 * the "reuse master" dropdown), by the check id that holds it.
 */
export async function getSavedMasterXml(
    checkId: number
): Promise<string | null> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("xml_master")
        .eq("id", checkId)
        .single();

    if (error) {
        console.error("Failed loading saved master XML:", error);
        return null;
    }
    return ((data as any)?.xml_master as string | null) ?? null;
}

/**
 * Fetch a single accuracy check by id (used to re-open a saved check in
 * the Accuracy Comparison tab).
 */
export async function getAccuracyCheckById(
    id: number
): Promise<AccuracyCheck | null> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("*")
        .eq("id", id)
        .single();

    if (error) {
        console.error("Failed loading accuracy check:", error);
        return null;
    }

    return data as AccuracyCheck;
}

/**
 * All accuracy checks where this analyst was the one being graded,
 * newest first.
 */
export async function getAccuracyChecksForAnalyst(
    analystName: string
): Promise<AccuracyCheck[]> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("*")
        .is("deleted_at", null)
        .ilike("analyst_name", analystName.trim())
        .order("created_at", { ascending: true });

    if (error) {
        console.error("Failed loading accuracy checks:", error);
        throw new Error(error.message || "Failed loading accuracy checks");
    }

    return (data ?? []) as AccuracyCheck[];
}

/**
 * Every saved accuracy check (used to build leaderboards / summaries).
 */
export async function getAllAccuracyChecks(): Promise<AccuracyCheck[]> {
    const rows: AccuracyCheck[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select("*")
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) {
            console.error("Failed loading accuracy checks:", error);
            throw new Error(error.message || "Failed loading accuracy checks");
        }

        if (!data || data.length === 0) break;
        rows.push(...(data as AccuracyCheck[]));
        from += pageSize;
        if (data.length < pageSize) break;
    }

    return rows;
}

/**
 * A saved check without the heavy raw-XML blobs. Use this for list/summary
 * views (leaderboards, dispute lists) that never re-parse the source XML —
 * it avoids pulling potentially megabytes of xml_master/xml_analyst per row
 * into the browser.
 */
export type AccuracyCheckMeta = Omit<AccuracyCheck, "xml_master" | "xml_analyst">;

// Every AccuracyCheck column except the two XML blobs, for projected selects.
const ACCURACY_CHECK_META_COLUMNS =
    "id, created_at, analyst_name, master_analyst_name, match_label, " +
    "file_name_master, file_name_analyst, tolerance, accuracy, master_total, " +
    "analyst_total, exact, wrong_stat, wrong_player, wrong_team, missed, extra, " +
    "avg_time_drift, category_breakdown, team_breakdown, video_url, sport, " +
    "player_accuracy, deleted_at, deleted_by";

/**
 * Like getAllAccuracyChecks but WITHOUT the xml_master/xml_analyst blobs.
 * Much lighter over the wire; use when the caller only needs the summary
 * fields (accuracy, breakdowns, sport, labels) and never re-parses XML.
 */
export async function getAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
    const rows: AccuracyCheckMeta[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select(ACCURACY_CHECK_META_COLUMNS)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) {
            console.error("Failed loading accuracy check meta:", error);
            throw new Error(error.message || "Failed loading accuracy checks");
        }

        if (!data || data.length === 0) break;
        rows.push(...(data as unknown as AccuracyCheckMeta[]));
        from += pageSize;
        if (data.length < pageSize) break;
    }

    return rows;
}

/** Just the raw XML blobs for one check (for on-demand parsing). */
export interface AccuracyCheckXml {
    id: number;
    xml_master: string | null;
    xml_analyst: string | null;
}

/**
 * Fetch the xml_master/xml_analyst blobs for a specific set of check ids,
 * in small batches. Used for on-demand work (e.g. Home/Away category
 * breakdowns) so the main list load never has to pull every check's XML at
 * once — which is large enough to hit Postgres statement timeouts.
 */
export async function getAccuracyChecksXml(
    ids: number[]
): Promise<Map<number, AccuracyCheckXml>> {
    const out = new Map<number, AccuracyCheckXml>();
    const unique = Array.from(new Set(ids));

    // Fetch ONE row per request. The XML blobs are large (1000s of instances
    // each), so pulling many rows in a single query returns a multi-MB payload
    // that hits Supabase/Postgres statement timeouts (observed 500s). A single
    // row is small and reliable. A few requests run concurrently for speed, and
    // a per-row failure is skipped (that check just shows no player accuracy)
    // rather than failing the whole load.
    const CONCURRENCY = 4;
    const fetchOne = async (id: number) => {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select("id, xml_master, xml_analyst")
            .eq("id", id)
            .single();
        if (error) {
            console.error(`Failed loading XML for check ${id}:`, error);
            return;
        }
        if (data) out.set(id, data as AccuracyCheckXml);
    };

    for (let i = 0; i < unique.length; i += CONCURRENCY) {
        const slice = unique.slice(i, i + CONCURRENCY);
        await Promise.all(slice.map(fetchOne));
    }

    return out;
}

export interface BackfillProgress {
    done: number;
    total: number;
}

/**
 * Compute + store Player Accuracy for saved checks, one row at a time (so it
 * never hits the statement-timeout that batching did). Reports progress via
 * the optional callback. Admin-triggered from the Accuracy History page.
 *
 * @param onProgress progress callback (done / total)
 * @param force when true, RECOMPUTES every check's `player_accuracy` from its
 *   XML — use this after the grouping logic changes so stored values are
 *   refreshed. When false (default), only fills checks where the field is null
 *   (a safe, idempotent one-time backfill).
 */
export async function backfillPlayerAccuracy(
    onProgress?: (p: BackfillProgress) => void,
    force = false
): Promise<{ updated: number; skipped: number }> {
    // Ids to process (small query — no XML pulled here). When forcing, take
    // every check; otherwise only those missing player_accuracy.
    const listQuery = supabase
        .from("accuracy_checks")
        .select("id, tolerance, file_name_master")
        .is("deleted_at", null);
    const { data, error } = force
        ? await listQuery
        : await listQuery.is("player_accuracy", null);

    if (error) {
        console.error("Failed listing checks to backfill:", error);
        throw new Error(error.message || "Failed listing checks to backfill");
    }

    const rows = (data ?? []) as {
        id: number;
        tolerance: number | null;
        file_name_master: string | null;
    }[];
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        // Fetch this one check's XML (single row = small, reliable).
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

        // Re-grade OVERLAP-SCOPED (deterministic, idempotent) and write the
        // FULL column set so a backfilled row is never half-converted (overlap
        // player_accuracy alongside stale full-game accuracy/exact/master_total).
        const graded = gradeOverlapScoped(
            (xmlRow as AccuracyCheckXml).xml_master,
            (xmlRow as AccuracyCheckXml).xml_analyst,
            row.tolerance,
            row.file_name_master
        );
        if (!graded) {
            skipped += 1; // null grade -> leave row untouched, never partial-write
            onProgress?.({ done: i + 1, total: rows.length });
            continue;
        }

        const s = graded.result.summary;
        const { error: upErr } = await supabase
            .from("accuracy_checks")
            .update({
                accuracy: s.accuracy,
                master_total: s.masterTotal,
                analyst_total: s.analystTotal,
                exact: s.exact,
                wrong_stat: s.wrongStat,
                wrong_player: s.wrongPlayer,
                wrong_team: s.wrongTeam,
                missed: s.missed,
                extra: s.extra,
                avg_time_drift: s.avgTimeDrift,
                category_breakdown: graded.result.byCategory ?? null,
                team_breakdown: graded.result.byTeam ?? null,
                player_accuracy: graded.playerAccuracy,
            })
            .eq("id", row.id);
        if (!upErr) {
            updated += 1;
        } else {
            skipped += 1;
            console.error(`Backfill update failed ${row.id}:`, upErr);
        }

        onProgress?.({ done: i + 1, total: rows.length });
    }

    return { updated, skipped };
}

/**
 * Recompute + overwrite `player_accuracy` for EVERY saved check from its XML.
 * Use after the Player Accuracy grouping logic changes (e.g. a stat added to
 * or removed from a group) so all stored values reflect the new grouping.
 * Thin wrapper over backfillPlayerAccuracy with force=true.
 */
export async function recomputeAllPlayerAccuracy(
    onProgress?: (p: BackfillProgress) => void
): Promise<{ updated: number; skipped: number }> {
    return backfillPlayerAccuracy(onProgress, true);
}

/**
 * Delete a saved accuracy check (e.g. a mistaken save).
 */
export async function deleteAccuracyCheck(
    id: number,
    deletedBy?: string | null
): Promise<void> {
    // Soft delete: mark the row instead of removing it, so a mistakenly-deleted
    // check (and its disputes) can be reviewed and restored. Active views filter
    // out rows where deleted_at is set.
    const { error } = await supabase
        .from("accuracy_checks")
        .update({
            deleted_at: new Date().toISOString(),
            deleted_by: deletedBy ?? null,
        })
        .eq("id", id);

    if (error) {
        console.error("Failed deleting accuracy check:", error);
        throw new Error(error.message || "Failed deleting accuracy check");
    }
}

/**
 * Restore a soft-deleted check (clears deleted_at/deleted_by). Its disputes are
 * untouched by soft delete, so restoring the check makes them active again too.
 */
export async function restoreAccuracyCheck(id: number): Promise<void> {
    const { error } = await supabase
        .from("accuracy_checks")
        .update({ deleted_at: null, deleted_by: null })
        .eq("id", id);

    if (error) {
        console.error("Failed restoring accuracy check:", error);
        throw new Error(error.message || "Failed restoring accuracy check");
    }
}

/**
 * Permanently remove a check (and, via ON DELETE CASCADE, its disputes). Use
 * only from the "Deleted checks" review view to purge a check for good.
 */
export async function purgeAccuracyCheck(id: number): Promise<void> {
    const { error } = await supabase
        .from("accuracy_checks")
        .delete()
        .eq("id", id);

    if (error) {
        console.error("Failed purging accuracy check:", error);
        throw new Error(error.message || "Failed purging accuracy check");
    }
}

/**
 * All soft-deleted checks (metadata only, newest-deleted first) for the
 * "Deleted checks" review view.
 */
export async function getDeletedAccuracyChecksMeta(): Promise<
    AccuracyCheckMeta[]
> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select(ACCURACY_CHECK_META_COLUMNS)
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });

    if (error) {
        console.error("Failed loading deleted checks:", error);
        throw new Error(error.message || "Failed loading deleted checks");
    }
    return (data ?? []) as unknown as AccuracyCheckMeta[];
}

// ---- Aggregations -------------------------------------------------

export interface MasterCheckCount {
    masterAnalystName: string;
    count: number;
}

/**
 * How many master accuracy checks each person has completed
 * (grouped by master_analyst_name), highest first.
 */
export function countMasterChecks(
    checks: AccuracyCheckMeta[]
): MasterCheckCount[] {
    const map = new Map<string, number>();

    for (const c of checks) {
        const name = c.master_analyst_name?.trim();
        if (!name) continue;
        map.set(name, (map.get(name) ?? 0) + 1);
    }

    return Array.from(map.entries())
        .map(([masterAnalystName, count]) => ({ masterAnalystName, count }))
        .sort((a, b) => b.count - a.count);
}

export interface AnalystAccuracySummary {
    analystName: string;
    checks: number;
    avgAccuracy: number;
    latestAccuracy: number;
    totalMaster: number;
    totalExact: number;
    /** Average of per-check Home accuracy (null if no check has Home data). */
    avgHomeAccuracy: number | null;
    /** Average of per-check Away accuracy (null if no check has Away data). */
    avgAwayAccuracy: number | null;
}

/**
 * Read a canonical team's accuracy ("home" / "away") off a check's stored
 * team_breakdown. Teams are canonicalised to Home/Away at comparison time.
 */
function teamAccuracy(
    check: AccuracyCheckMeta,
    team: "home" | "away"
): number | null {
    const t = check.team_breakdown?.find(
        (b) => b.team.trim().toLowerCase() === team && b.masterTotal > 0
    );
    return t ? t.accuracy : null;
}

/**
 * Per-graded-analyst rollup across all their checks.
 */
export function summariseByAnalyst(
    checks: AccuracyCheckMeta[]
): AnalystAccuracySummary[] {
    const map = new Map<string, AccuracyCheckMeta[]>();

    for (const c of checks) {
        const key = c.analyst_name.trim();
        if (!key) continue;
        const arr = map.get(key) ?? [];
        arr.push(c);
        map.set(key, arr);
    }

    return Array.from(map.entries())
        .map(([analystName, list]) => {
            // Newest first (getAllAccuracyChecks returns desc), so [0] is latest.
            const sorted = [...list].sort(
                (a, b) =>
                    new Date(b.created_at).getTime() -
                    new Date(a.created_at).getTime()
            );
            const totalMaster = list.reduce((sum, c) => sum + c.master_total, 0);
            const totalExact = list.reduce((sum, c) => sum + c.exact, 0);

            const avg = (vals: number[]) =>
                vals.length > 0
                    ? vals.reduce((sum, v) => sum + v, 0) / vals.length
                    : null;
            const homeVals = list
                .map((c) => teamAccuracy(c, "home"))
                .filter((v): v is number => v != null);
            const awayVals = list
                .map((c) => teamAccuracy(c, "away"))
                .filter((v): v is number => v != null);

            return {
                analystName,
                checks: list.length,
                avgAccuracy:
                    list.reduce((sum, c) => sum + c.accuracy, 0) / list.length,
                latestAccuracy: sorted[0]?.accuracy ?? 0,
                totalMaster,
                totalExact,
                avgHomeAccuracy: avg(homeVals),
                avgAwayAccuracy: avg(awayVals),
            };
        })
        .sort((a, b) => b.checks - a.checks);
}
