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
import { scopeToOverlapPaired } from "@/lib/comparison/overlap-window";
import {
    jsonEventsToInstances,
    playerNumberMapFromReport,
} from "@/lib/comparison/json-adapter";
import {
    computePlayerAccuracyByScope,
    type StoredPlayerAccuracy,
} from "@/lib/comparison/player-accuracy";
import {
    computeAflPlayerAccuracyByScope,
    type StoredAflPlayerAccuracy,
} from "@/lib/comparison/afl-player-accuracy";
import { createCache } from "@/lib/api/cache";
import { masterKey, isSafeMasterWrite } from "@/lib/api/masterGroup";
// Cross-table invalidation (one-directional: accuracyChecks → disputes, no
// cycle — disputes.ts imports only @/lib/supabase and @/lib/api/cache). The
// two dispute list fetches are filtered by the parent check's deleted_at, so a
// check's soft-delete / restore / master-delete / purge changes which disputes
// they return and must clear these.
import {
    invalidateAllDisputesCache,
    invalidateOpenDisputeCountsCache,
} from "@/lib/api/disputes";

// ── Module-level caches for the two meta/list fetches ───────────────────────
//
// getAccuracyChecksMeta (active) and getDeletedAccuracyChecksMeta (soft-deleted)
// back revisited views that otherwise re-page the whole table on every mount.
// Cache the Promise so concurrent callers share one request; every check
// mutation invalidates the caches it can make stale (see the invalidation
// matrix in .agents/tasks/invalidation-matrix.md). The fetch bodies are the
// hoisted `fetch*` function declarations below.
const metaCached = createCache(fetchAccuracyChecksMeta);
const deletedMetaCached = createCache(fetchDeletedAccuracyChecksMeta);

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
 * A saved check's category. 'full_game' = all/most stat groups coded;
 * 'specific_stats' = only a couple of groups coded; 'golden_accuracy' = the
 * master coded far fewer events than the analyst (a spot-check sample). Legacy
 * rows predate this column and are stored as NULL (Uncategorised).
 */
export type CheckCategory = "full_game" | "specific_stats" | "golden_accuracy";

/**
 * Display labels for each category. SINGLE source reused by the save dropdown,
 * the inline editor, and the filter so the three option lists never drift.
 */
export const CHECK_CATEGORY_LABELS: Record<CheckCategory, string> = {
    full_game: "Full game",
    specific_stats: "Specific stats",
    golden_accuracy: "Golden Accuracy",
};

/** The category options, in display order. Shared by every category control. */
export const CHECK_CATEGORY_OPTIONS: readonly CheckCategory[] = [
    "full_game",
    "specific_stats",
    "golden_accuracy",
];

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

    // How the check is classified for filtering (full game / specific stats /
    // golden accuracy). Null on legacy rows saved before this column existed.
    category: CheckCategory | null;

    // Precomputed Player Accuracy (both/home/away group results) so the
    // "Checks by master fixture" table can render without re-fetching and
    // re-parsing the raw XML. Recomputed on save/update/propagate. Null on
    // older checks until backfilled. A football check stores StoredPlayerAccuracy
    // ({football,...}); an AFL check stores StoredAflPlayerAccuracy ({afl:true,...}).
    // The per-row reader discriminates on the stored shape, not the sport column
    // (legacy AFL rows may still carry a football-shaped value).
    player_accuracy: StoredPlayerAccuracy | StoredAflPlayerAccuracy | null;

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
    category?: CheckCategory | null;
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
export function gradeOverlapScoped(
    xmlMaster: string | null | undefined,
    xmlAnalyst: string | null | undefined,
    tolerance: number | null | undefined,
    fileNameMaster: string | null | undefined,
    // The sport the check is graded under. 'afl' routes player_accuracy through
    // the AFL golden computer (StoredAflPlayerAccuracy); any other value —
    // 'football', null, or an unknown string — keeps the football computer, the
    // safe default so legacy/untagged rows keep their existing football shape.
    sport: string | null | undefined
): {
    result: ComparisonResult;
    playerAccuracy: StoredPlayerAccuracy | StoredAflPlayerAccuracy;
} | null {
    const masterRaw = instancesFromRaw(xmlMaster);
    const analystRaw = instancesFromRaw(xmlAnalyst);
    if (masterRaw.length === 0) return null;
    const tol = tolerance ?? 3;
    const name = fileNameMaster ?? null;

    // 1. Canonicalise the FULL sets, exactly like the page's `canonical`.
    const canon = canonicaliseTeams(masterRaw, analystRaw, tol, name);

    // 2. Scope the ALREADY-canonical sets by mid, plus edge events just
    //    outside the window that pair with an unmatched in-window event.
    const scoped = scopeToOverlapPaired(canon.master, canon.analyst, tol, name);

    // 3. Grade over the scoped sets. Both calls re-canonicalise, hit the
    //    idempotency guard (inputs are Home/Away-only), and pass through — so
    //    the labels are the full-set labels, matching the live view. The
    //    summary/byCategory/byTeam result is identical for both sports; only
    //    the player_accuracy computer differs, routed by sport.
    const result = compareInstances(scoped.master, scoped.analyst, tol, name);
    const playerAccuracy =
        sport === "afl"
            ? computeAflPlayerAccuracyByScope(
                  scoped.master,
                  scoped.analyst,
                  tol,
                  name
              )
            : computePlayerAccuracyByScope(
        scoped.master,
        scoped.analyst,
        tol,
        name
    );
    return { result, playerAccuracy };
}

type GradedResult = NonNullable<ReturnType<typeof gradeOverlapScoped>>;

/**
 * The stored grade columns for a graded result (everything derived from the
 * grade; never xml_*, category or labels). Shared by propagate, backfill,
 * regrade-all and the stale-total fixer.
 */
function gradedColumns(graded: GradedResult) {
    const s = graded.result.summary;
    return {
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
    };
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
        input.fileNameMaster,
        input.sport
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
        category: input.category ?? null,

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

    // New active check appears in the meta list.
    invalidateAccuracyChecksMetaCache();

    return data as AccuracyCheck;
}

/**
 * Set ONLY the `category` column on an existing check (the inline editor on the
 * Saved checks table). Deliberately does NOT go through updateAccuracyCheck,
 * which re-grades and rewrites the accuracy columns — a category relabel must
 * never touch the stored accuracy. `category` is a meta column shown in the
 * list, so invalidate the meta cache on success.
 */
export async function setAccuracyCheckCategory(
    id: number,
    category: CheckCategory | null
): Promise<void> {
    const { error } = await supabase
        .from("accuracy_checks")
        .update({ category })
        .eq("id", id);
    if (error) {
        console.error("Failed setting check category:", error);
        throw new Error(error.message || "Failed to set check category.");
    }
    // category is a meta column shown in lists → meta list is stale.
    invalidateAccuracyChecksMetaCache();
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
    // Never overwrite a stored master with an empty/unparsable one.
    if (instancesFromRaw(input.xmlMaster).length === 0) {
        throw new Error("Master has no instances; nothing was changed.");
    }
    // Grade OVERLAP-SCOPED from the (edited) master vs the analyst, NOT from
    // input.result. The sole caller (handleUpdateCheck on the compare page)
    // always passes xmlAnalyst/fileNameMaster/tolerance, so this normally
    // produces a real overlap-scoped grade.
    let graded = gradeOverlapScoped(
        input.xmlMaster,
        input.xmlAnalyst,
        input.tolerance,
        input.fileNameMaster,
        input.sport
    );
    // Defensive: if a FUTURE caller omits xmlAnalyst entirely (partial update),
    // recover the analyst side from the stored row so we never blank a
    // previously-good row. (A null — but provided — analyst XML is a genuine
    // ungradeable row and is NOT recovered here.)
    if (!graded && input.xmlAnalyst === undefined) {
        const { data: cur } = await supabase
            .from("accuracy_checks")
            .select("xml_analyst, file_name_master, tolerance, sport")
            .eq("id", input.id)
            .single();
        if (cur) {
            const c = cur as {
                xml_analyst: string | null;
                file_name_master: string | null;
                tolerance: number | null;
                sport: string | null;
            };
            graded = gradeOverlapScoped(
                input.xmlMaster,
                c.xml_analyst,
                input.tolerance ?? c.tolerance,
                input.fileNameMaster ?? c.file_name_master,
                // An explicitly provided input.sport wins; otherwise fall back
                // to the stored sport so a partial update keeps the right shape.
                input.sport !== undefined ? input.sport : c.sport
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

    // Summary/analyst/label of an active row changed → meta list is stale.
    invalidateAccuracyChecksMetaCache();

    return data as AccuracyCheck;
}

export interface PropagateMasterResult {
    /** How many OTHER checks were updated (the excluded source check is not counted). */
    updated: number;
    /** How many checks could not be re-graded/written (logged, never thrown). */
    failed: number;
    /** Distinct analyst names whose checks were re-graded. */
    analysts: string[];
    /** Distinct raw master names that were matched (spelling variants). */
    matchedNames: string[];
}

/**
 * The master file is a single source of truth: correcting it should apply to
 * EVERY check graded against that same master, not just the one being viewed.
 *
 * Given a corrected master (XML or JSON feed) and the master file name, this
 * rewrites `xml_master` on every active check in the same normalised master
 * group (trim + case-insensitive, same key as History grouping) and RECOMPUTES
 * each one's grade against ITS OWN analyst data with the current grading. The
 * analyst side (`xml_analyst`) is never written.
 *
 * Throws, writing nothing, when the master has no instances. A per-row failure
 * is counted in `failed` and does not stop the remaining rows.
 */
export async function propagateMasterCorrection(
    fileNameMaster: string,
    xmlMaster: string,
    opts?: { excludeId?: number }
): Promise<PropagateMasterResult> {
    if (instancesFromRaw(xmlMaster).length === 0) {
        throw new Error("Master has no instances; nothing was changed.");
    }

    const ids = (await resolveActiveGroupIds(fileNameMaster)).filter(
        (id) => id !== opts?.excludeId
    );

    const analysts = new Set<string>();
    const names = new Set<string>();
    let updated = 0;
    let failed = 0;

    // Clear the meta cache in a `finally` so a throw after committing rows
    // still clears the (now-stale) cache.
    try {
        for (const id of ids) {
            // One row at a time: the xml blobs are large.
            const { data: cur, error: curErr } = await supabase
                .from("accuracy_checks")
                .select("id, analyst_name, tolerance, xml_analyst, file_name_master, sport")
                .eq("id", id)
                .single();
            if (curErr || !cur) {
                console.error(`Failed loading check ${id}:`, curErr);
                failed += 1;
                continue;
            }
            const row = cur as {
                analyst_name: string;
                tolerance: number | null;
                xml_analyst: string | null;
                file_name_master: string | null;
                sport: string | null;
            };

            // Re-grade OVERLAP-SCOPED with the current grader, JSON-aware.
            const graded = gradeOverlapScoped(
                xmlMaster,
                row.xml_analyst,
                row.tolerance,
                fileNameMaster,
                row.sport
            );
            if (!graded) {
                console.warn(`propagateMasterCorrection: check ${id} ungradeable; left unchanged.`);
                failed += 1;
                continue;
            }

            const { error: upErr } = await supabase
                .from("accuracy_checks")
                .update({ ...gradedColumns(graded), xml_master: xmlMaster })
                .eq("id", id);
            if (upErr) {
                console.error(`Failed updating check ${id}:`, upErr);
                failed += 1;
                continue;
            }
            updated += 1;
            if (row.analyst_name) analysts.add(row.analyst_name);
            if (row.file_name_master) names.add(row.file_name_master);
        }
    } finally {
        invalidateAccuracyChecksMetaCache();
    }

    return {
        updated,
        failed,
        analysts: Array.from(analysts),
        matchedNames: Array.from(names),
    };
}

export interface UpdateCheckAndPropagateResult {
    check: AccuracyCheck;
    /** Other checks of the same master that were re-graded. */
    siblingsUpdated: number;
    siblingsFailed: number;
    analysts: string[];
    /** True when the master name was changed, so siblings were NOT touched. */
    nameChanged: boolean;
}

/**
 * "Update check" with the edited master applied to every other check of the
 * same master. When the master file name was changed on this check, only this
 * row is updated (the others belong to the old name).
 */
export async function updateCheckAndPropagateMaster(
    input: UpdateAccuracyCheckInput
): Promise<UpdateCheckAndPropagateResult> {
    if (instancesFromRaw(input.xmlMaster).length === 0) {
        throw new Error("Master has no instances; nothing was changed.");
    }
    const { data: cur } = await supabase
        .from("accuracy_checks")
        .select("file_name_master")
        .eq("id", input.id)
        .single();
    const storedName =
        (cur as { file_name_master: string | null } | null)?.file_name_master ?? null;

    const check = await updateAccuracyCheck(input);

    const newName =
        input.fileNameMaster !== undefined ? input.fileNameMaster : storedName;
    const nameChanged = masterKey(newName) !== masterKey(storedName);
    if (nameChanged || !newName) {
        return { check, siblingsUpdated: 0, siblingsFailed: 0, analysts: [], nameChanged };
    }
    const res = await propagateMasterCorrection(newName, input.xmlMaster, {
        excludeId: input.id,
    });
    return {
        check,
        siblingsUpdated: res.updated,
        siblingsFailed: res.failed,
        analysts: res.analysts,
        nameChanged: false,
    };
}

/**
 * Count how many checks share a master file (for a confirmation prompt before
 * propagating a correction). Uses the same normalised group as propagation, so
 * the count matches what will be touched. Returns the count and the distinct
 * analyst names.
 */
export async function getMasterCheckSiblings(
    fileNameMaster: string
): Promise<{ count: number; analysts: string[] }> {
    let ids: number[];
    try {
        ids = await resolveActiveGroupIds(fileNameMaster);
    } catch {
        return { count: 0, analysts: [] };
    }
    if (ids.length === 0) return { count: 0, analysts: [] };
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("analyst_name")
        .in("id", ids);
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
    return { count: ids.length, analysts };
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
 * The `.ilike("file_name_master", "%name%")` is a deliberately loose
 * SERVER-SIDE prefilter: it is case-insensitive and tolerates leading/trailing
 * whitespace in the stored name, and `_`/`%` in a filename are ILIKE wildcards
 * that may over-match (as does the substring pattern). The JS
 * `sameMasterName` filter afterwards narrows the result to exact normalized
 * equality, so the resolved id set is always correct regardless of what the
 * prefilter returned.
 */
async function resolveActiveGroupIds(fileName: string): Promise<number[]> {
    const key = normalizeMasterName(fileName);
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("id, file_name_master")
        .ilike("file_name_master", `%${key}%`)
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
    // file_name_master is a meta column shown in lists → meta list is stale.
    invalidateAccuracyChecksMetaCache();
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
    // Row leaves active (M) and enters deleted (D); its disputes drop out of
    // GD/OC (both inner-join accuracy_checks.deleted_at IS NULL — cross-table).
    invalidateAccuracyChecksMetaCache();
    invalidateDeletedAccuracyChecksMetaCache();
    invalidateAllDisputesCache();
    invalidateOpenDisputeCountsCache();
    return { deleted: 1 };
}

export interface MergeMastersResult {
    /** Active source rows re-tagged onto the destination. */
    moved: number;
    /** Active destination-group rows successfully re-graded (incl. the moved ones). */
    regraded: number;
    /**
     * Destination-group rows whose per-row re-grade update FAILED and was
     * skipped (resilient loop). `regraded + failed` is the group size the loop
     * attempted; a non-zero `failed` means some rows will reconcile on the next
     * backfill. The source is still genuinely removed regardless.
     */
    failed: number;
    /** Distinct analyst names across the re-graded destination group. */
    analysts: string[];
}

/**
 * Merge a saved master (the SOURCE) into another (the DESTINATION): move every
 * active check attached to the source onto the destination name, then re-grade
 * the WHOLE destination group — overlap-scoped — against the destination
 * master's XML. After this the source name has no active checks and disappears
 * from the dropdown; all its checks live under the destination, graded against
 * the destination master.
 *
 * The real use case is a master accidentally uploaded twice (two dropdown
 * entries for the same fixture): this consolidates the duplicate under one
 * master. Same-analyst checks are NOT deduped — if an analyst had a check under
 * both masters, both survive under the destination.
 *
 * INTENTIONAL COLLISION. Unlike `renameMaster`, which THROWS when the target
 * name already belongs to a different active master, `mergeMasters` DELIBERATELY
 * moves the source ids onto the existing destination name — merging into an
 * existing master is the entire point. There is NO collision guard here on
 * purpose; do NOT "fix" this by adding renameMaster's guard.
 *
 * This MUST live in this module because its re-grade loop reuses the
 * module-private `gradeOverlapScoped` grader, keeping the merge re-grade
 * byte-identical to `propagateMasterCorrection`.
 *
 * Mutation sequence (ordered for the failure guarantee):
 *   0. Normalize `destName` once; throw if source === dest (self-merge).
 *   1. Resolve SOURCE group ids; empty → no-op return.
 *   2. Fetch destination XML (throw on null) and confirm the destination group
 *      is non-empty (throw on empty) — both BEFORE any write.
 *   3. ONE update sets the source ids' file_name_master AND xml_master to the
 *      destination's together, so a moved row never carries the destination
 *      NAME with the source XML.
 *   4. Reload the WHOLE destination group by normalized id-list (NOT a bare
 *      `.eq`, which would miss case/whitespace variants) and re-grade each row
 *      with the same column object `propagateMasterCorrection` writes, in a
 *      RESILIENT loop that collects per-row failures instead of throwing.
 *
 * The bulk move + re-grade runs against the live Supabase table (no
 * transaction/mock layer, matching renameMaster/propagateMasterCorrection); the
 * real execution is an admin in-app action.
 */
export async function mergeMasters(
    sourceFileName: string,
    destFileName: string,
    destCheckId: number
): Promise<MergeMastersResult> {
    // Step 0 — normalize + self-merge guard (pure, pre-DB).
    const destName = normalizeMasterName(destFileName);
    if (sameMasterName(sourceFileName, destFileName)) {
        throw new Error("Source and destination are the same master.");
    }

    // Step 1 — resolve the SOURCE group ids. Empty → idempotent no-op (e.g. a
    // double-click after the first merge already emptied the source).
    const sourceIds = await resolveActiveGroupIds(sourceFileName);
    if (sourceIds.length === 0) {
        return { moved: 0, regraded: 0, failed: 0, analysts: [] };
    }

    // Step 2 — fetch the DESTINATION XML and confirm the destination is real,
    // both BEFORE any write.
    const destXml = await getSavedMasterXml(destCheckId);
    if (destXml == null) {
        throw new Error("Destination master has no stored XML.");
    }
    const destCheckIds = await resolveActiveGroupIds(destFileName);
    if (destCheckIds.length === 0) {
        throw new Error("Destination master has no active checks.");
    }

    // Step 3 — re-tag the source rows onto the destination. Set file_name_master
    // AND xml_master together so there is never an intermediate state where a
    // row carries the destination NAME but the source XML. Targeted by id-list,
    // never a bare `.eq`; soft-deleted source rows were already excluded by
    // resolveActiveGroupIds and stay behind under the old name.
    const { data: movedRows, error } = await supabase
        .from("accuracy_checks")
        .update({ file_name_master: destName, xml_master: destXml })
        .in("id", sourceIds)
        .select("id");
    if (error) {
        console.error("mergeMasters: failed re-tagging source rows:", error);
        throw new Error(error.message || "Failed to move checks.");
    }
    // The source rows are now committed under the destination name/XML. Clear M
    // HERE (not at function end) so a Step-4 loadErr throw can never leave the
    // meta list stale; nothing reads M between here and return, so one clear
    // covers the moved rows AND the subsequent Step-4 re-grades.
    invalidateAccuracyChecksMetaCache();
    const moved = movedRows?.length ?? 0;

    // Step 4 — re-grade the WHOLE destination group, overlap-scoped, resilient.
    // Reload by NORMALIZED id-list (NOT a bare `.eq("file_name_master",
    // destName)`): normalizeMasterName is trim-only, so a bare .eq would miss
    // destination rows stored under a case/whitespace variant. The moved source
    // rows are included because Step 3 set their file_name_master to destName.
    const destGroupIds = await resolveActiveGroupIds(destName);
    const { data: rows, error: loadErr } = await supabase
        .from("accuracy_checks")
        .select("id, analyst_name, tolerance, xml_analyst, file_name_master, sport")
        .in("id", destGroupIds)
        .is("deleted_at", null);
    if (loadErr) {
        console.error("mergeMasters: failed loading destination group:", loadErr);
        throw new Error(loadErr.message || "Failed loading destination checks.");
    }

    const analysts = new Set<string>();
    let regraded = 0;
    let failed = 0;

    for (const row of (rows ?? []) as {
        id: number;
        analyst_name: string;
        tolerance: number | null;
        xml_analyst: string | null;
        file_name_master: string | null;
        sport: string | null;
    }[]) {
        // SAME overlap-scoped grader as save/update/propagate/backfill.
        const graded = gradeOverlapScoped(
            destXml,
            row.xml_analyst,
            row.tolerance,
            destName,
            row.sport
        );
        if (!graded) {
            // Ungradeable row: write the null-accuracy marker and continue,
            // exactly as propagateMasterCorrection does — reconciled by a later
            // backfill.
            console.warn(
                `mergeMasters: check ${row.id} ungradeable; writing null accuracy.`
            );
        }
        const s = graded?.result.summary;

        // Column object copied VERBATIM from propagateMasterCorrection so the
        // two paths cannot drift. xml_master is set to destXml (the whole group
        // adopts the destination master's XML — single source of truth).
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
            // (consistent, just with possibly-stale summary numbers) and is
            // excluded from `regraded` so the summary reports the true total.
            console.error(`mergeMasters: re-grade failed for check ${row.id}:`, upErr);
            failed += 1;
            continue;
        }
        regraded += 1;
        if (row.analyst_name) analysts.add(row.analyst_name);
    }

    return { moved, regraded, failed, analysts: Array.from(analysts) };
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
    /**
     * Instance count of the FULL stored master file (JSON feeds via the JSON
     * adapter, XML via parseInstances). null when nothing could be loaded.
     */
    parsedMasterTotal: number | null;
    /**
     * Master total the CURRENT grading gives for this check (overlap-scoped, so
     * it can legitimately be below the full-file count). null when ungradeable.
     */
    gradedMasterTotal: number | null;
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
     * Check ids whose STORED master_total differs from what the current
     * grading gives for them (a stale column, not a real master difference).
     * Fixed by re-grading the check.
     */
    staleTotalCheckIds: number[];
    /** Check ids with a non-empty master that parsed to 0 instances. */
    unparsableMasterCheckIds: number[];
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
 * master totals. Fetches each check's stored master, counts its instances
 * (JSON feeds and XML both, via instancesFromRaw), grades it with the current
 * grader and hashes the raw text so identical vs edited files are obvious.
 *
 * Read-only: touches no data. Runs client-side (XML parsing needs the browser
 * DOMParser). Fetches one row at a time to avoid statement timeouts on large
 * blobs. Siblings are resolved through the same normalised group key as
 * History and propagation.
 */
export async function diagnoseMasterConsistency(
    fileNameMaster: string
): Promise<MasterConsistencyReport> {
    const ids = await resolveActiveGroupIds(fileNameMaster);

    let rows: {
        id: number;
        analyst_name: string;
        created_at: string;
        master_total: number;
    }[] = [];
    if (ids.length > 0) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select("id, analyst_name, created_at, master_total")
            .in("id", ids)
            .order("created_at", { ascending: true });
        if (error) {
            console.error("Failed loading sibling checks:", error);
            throw new Error(error.message || "Failed loading sibling checks");
        }
        rows = (data ?? []) as typeof rows;
    }

    // First pass: fetch + parse each check's master.
    type Parsed = {
        row: (typeof rows)[number];
        instances: Instance[] | null;
        graded: number | null;
        xmlHash: string | null;
        unparsable: boolean;
    };
    const parsed: Parsed[] = [];
    for (const row of rows) {
        // One row at a time — xml blobs are large.
        const { data: xmlRow, error: xmlErr } = await supabase
            .from("accuracy_checks")
            .select("xml_master, xml_analyst, tolerance, sport, file_name_master")
            .eq("id", row.id)
            .single();

        let instances: Instance[] | null = null;
        let graded: number | null = null;
        let xmlHash: string | null = null;
        let unparsable = false;
        if (!xmlErr && xmlRow) {
            const r = xmlRow as {
                xml_master: string | null;
                xml_analyst: string | null;
                tolerance: number | null;
                sport: string | null;
                file_name_master: string | null;
            };
            if (r.xml_master) {
                try {
                    instances = instancesFromRaw(r.xml_master);
                } catch {
                    instances = null;
                }
                xmlHash = cheapHash(r.xml_master);
                unparsable =
                    r.xml_master.trim().length > 0 &&
                    instances != null &&
                    instances.length === 0;
                try {
                    graded =
                        gradeOverlapScoped(
                            r.xml_master,
                            r.xml_analyst,
                            r.tolerance,
                            r.file_name_master,
                            r.sport
                        )?.result.summary.masterTotal ?? null;
                } catch {
                    graded = null;
                }
            }
        }
        parsed.push({ row, instances, graded, xmlHash, unparsable });
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

    const statOf = (i: Instance) => (i.stat || i.category || "—").trim();

    // Count instances per stat for a master. This is the basis of the diff:
    // comparing per-stat counts (not individual events) cleanly explains a
    // total difference and is immune to re-graded player/timing noise.
    const countByStat = (instances: Instance[] | null): Map<string, number> => {
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
            gradedMasterTotal: p.graded,
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

    // Stale = the stored (overlap-scoped) total differs from what the current
    // grading produces. Never flag ungradeable / unparsable masters.
    const staleTotalCheckIds = checks
        .filter(
            (c) =>
                c.gradedMasterTotal != null &&
                c.gradedMasterTotal !== c.storedMasterTotal
        )
        .map((c) => c.checkId);

    return {
        fileNameMaster,
        checks,
        distinctCounts,
        distinctHashes,
        consistent: distinctCounts.length <= 1,
        staleTotalCheckIds,
        unparsableMasterCheckIds: parsed
            .filter((p) => p.unparsable)
            .map((p) => p.row.id),
    };
}

/**
 * Cheap master-identity probe for the History panel: the distinct parsed
 * instance counts of the full stored masters across a fixture's sibling
 * checks. No grading, no writes; one xml_master fetched at a time.
 */
export async function probeMasterVersions(
    fileNameMaster: string
): Promise<{ distinctCounts: number[]; checks: number }> {
    const ids = await resolveActiveGroupIds(fileNameMaster);
    const counts = new Set<number>();
    for (const id of ids) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select("xml_master")
            .eq("id", id)
            .single();
        if (error || !data) continue;
        const raw = (data as { xml_master: string | null }).xml_master;
        if (!raw) continue;
        try {
            counts.add(instancesFromRaw(raw).length);
        } catch {
            /* unparsable: ignore, as the modal does */
        }
    }
    return {
        distinctCounts: Array.from(counts).sort((a, b) => a - b),
        checks: ids.length,
    };
}

/**
 * Re-grade ONE check from its stored master + analyst data with the current
 * grader and write the grade columns (never xml_*, category or labels).
 * Writes nothing and reports why when the master is empty / parses to 0
 * instances or the grade is null, so a good stored total is never overwritten
 * with 0 or null.
 */
async function regradeCheckById(
    id: number
): Promise<{ status: "updated" } | { status: "skipped"; reason: string }> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select("xml_master, xml_analyst, tolerance, file_name_master, sport")
        .eq("id", id)
        .single();
    if (error || !data) {
        console.error(`Failed loading check ${id}:`, error);
        return { status: "skipped", reason: "could not load the check" };
    }
    const r = data as {
        xml_master: string | null;
        xml_analyst: string | null;
        tolerance: number | null;
        file_name_master: string | null;
        sport: string | null;
    };
    if (!isSafeMasterWrite(r.xml_master, instancesFromRaw(r.xml_master).length)) {
        return {
            status: "skipped",
            reason: "master is empty or parsed to 0 instances, left unchanged",
        };
    }
    const graded = gradeOverlapScoped(
        r.xml_master,
        r.xml_analyst,
        r.tolerance,
        r.file_name_master,
        r.sport
    );
    if (!graded) {
        return { status: "skipped", reason: "could not be graded, left unchanged" };
    }
    const { error: upErr } = await supabase
        .from("accuracy_checks")
        .update(gradedColumns(graded))
        .eq("id", id);
    if (upErr) {
        console.error(`Failed re-grading check ${id}:`, upErr);
        return { status: "skipped", reason: "write failed" };
    }
    return { status: "updated" };
}

/**
 * Re-grade the given checks with the current grader (see regradeCheckById).
 * Used by the consistency modal's "Fix stored totals". Never writes 0 over a
 * stored total: a master that parses to 0 instances is skipped and reported.
 */
export async function fixStaleMasterTotals(
    checkIds: number[]
): Promise<{ fixed: number; skipped: { id: number; reason: string }[] }> {
    let fixed = 0;
    const skipped: { id: number; reason: string }[] = [];
    try {
        for (const id of checkIds) {
            const res = await regradeCheckById(id);
            if (res.status === "updated") fixed += 1;
            else skipped.push({ id, reason: res.reason });
        }
    } finally {
        invalidateAccuracyChecksMetaCache();
    }
    return { fixed, skipped };
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
 * newest first. Blob-free: like getAccuracyChecksMeta, this projects away
 * xml_master/xml_analyst (via ACCURACY_CHECK_META_COLUMNS) so it never pulls
 * the heavy raw-XML columns over the wire.
 */
export async function getAccuracyChecksForAnalyst(
    analystName: string
): Promise<AccuracyCheckMeta[]> {
    const { data, error } = await supabase
        .from("accuracy_checks")
        .select(ACCURACY_CHECK_META_COLUMNS)
        .is("deleted_at", null)
        .ilike("analyst_name", analystName.trim())
        .order("created_at", { ascending: true });

    if (error) {
        console.error("Failed loading accuracy checks:", error);
        throw new Error(error.message || "Failed loading accuracy checks");
    }

    return (data ?? []) as unknown as AccuracyCheckMeta[];
}

/**
 * Every saved accuracy check (used to build leaderboards / summaries).
 * Blob-free: like getAccuracyChecksMeta, this projects away
 * xml_master/xml_analyst (via ACCURACY_CHECK_META_COLUMNS) so it never pulls
 * the heavy raw-XML columns over the wire.
 */
export async function getAllAccuracyChecks(): Promise<AccuracyCheckMeta[]> {
    const rows: AccuracyCheckMeta[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select(ACCURACY_CHECK_META_COLUMNS)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, from + pageSize - 1);

        if (error) {
            console.error("Failed loading accuracy checks:", error);
            throw new Error(error.message || "Failed loading accuracy checks");
        }

        if (!data || data.length === 0) break;
        rows.push(...(data as unknown as AccuracyCheckMeta[]));
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
    "category, player_accuracy, deleted_at, deleted_by";

/**
 * Like getAllAccuracyChecks but WITHOUT the xml_master/xml_analyst blobs.
 * Much lighter over the wire; use when the caller only needs the summary
 * fields (accuracy, breakdowns, sport, labels) and never re-parses XML.
 */
export function getAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
    return metaCached.get();
}

/** Reset the cached active-checks meta list so the next read re-fetches. */
export function invalidateAccuracyChecksMetaCache(): void {
    metaCached.invalidate();
}

async function fetchAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
    const rows: AccuracyCheckMeta[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select(ACCURACY_CHECK_META_COLUMNS)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
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
 * Compute + store the grade for saved checks that have no player_accuracy yet,
 * one row at a time (so it never hits the statement-timeout that batching
 * did). Reports progress via the optional callback. Admin-triggered from the
 * Accuracy History page ("Backfill"). Rows that already have player_accuracy
 * are NOT touched; use regradeAllChecks ("Recompute all") for those.
 *
 * @param force when true, processes every active check (kept for older
 *   callers; the History page uses regradeAllChecks instead).
 */
export async function backfillPlayerAccuracy(
    onProgress?: (p: BackfillProgress) => void,
    force = false
): Promise<{ updated: number; skipped: number }> {
    // Ids to process (small query — no XML pulled here). When forcing, take
    // every check; otherwise only those missing player_accuracy.
    const listQuery = supabase
        .from("accuracy_checks")
        .select("id, tolerance, file_name_master, sport")
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
        sport: string | null;
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
            row.file_name_master,
            row.sport
        );
        if (!graded) {
            skipped += 1; // null grade -> leave row untouched, never partial-write
            onProgress?.({ done: i + 1, total: rows.length });
            continue;
        }

        const { error: upErr } = await supabase
            .from("accuracy_checks")
            .update(gradedColumns(graded))
            .eq("id", row.id);
        if (!upErr) {
            updated += 1;
        } else {
            skipped += 1;
            console.error(`Backfill update failed ${row.id}:`, upErr);
        }

        onProgress?.({ done: i + 1, total: rows.length });
    }

    // The loop always returns normally (per-row errors are counted, never
    // thrown). Clear M on this unconditional return.
    invalidateAccuracyChecksMetaCache();
    return { updated, skipped };
}

// ---- Regrade ALL checks ---------------------------------------------

/** The grade columns a regrade rewrites (and the backup captures). */
const GRADE_COLUMNS = [
    "accuracy",
    "master_total",
    "analyst_total",
    "exact",
    "wrong_stat",
    "wrong_player",
    "wrong_team",
    "missed",
    "extra",
    "avg_time_drift",
    "category_breakdown",
    "team_breakdown",
    "player_accuracy",
] as const;

/** One check's OLD stored grade values, as saved in the pre-regrade backup. */
export type RegradeBackupRow = { id: number } & Record<
    (typeof GRADE_COLUMNS)[number],
    unknown
>;

export interface RegradeProgress {
    done: number;
    total: number;
    /** Rows written. */
    updated: number;
    /** Written rows whose grade values actually differ from the old ones. */
    changed: number;
    skipped: number;
    lastId: number;
}

export interface RegradeAllResult {
    updated: number;
    changed: number;
    skipped: number;
    total: number;
    /** Highest id processed; pass as `afterId` to resume. */
    lastId: number;
    /** True when stopped early via shouldStop. */
    stopped: boolean;
}

/** Key-order-insensitive deep equality (Postgres jsonb reorders object keys). */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (typeof a === "number" && typeof b === "number") {
        return Math.abs(a - b) < 1e-9;
    }
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        return a.every((v, i) => jsonDeepEqual(v, b[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in bo && jsonDeepEqual(ao[k], bo[k]));
}

/**
 * Re-grade EVERY active check with the current grading and rewrite its stored
 * accuracy, summary counts, breakdowns, master_total and player_accuracy from
 * its own stored master + analyst data (XML or JSON, via gradeOverlapScoped).
 *
 * - xml_master / xml_analyst / category / labels are never written; rows are
 *   never deleted. Rows with missing XML, a fetch error, an empty master or a
 *   null grade are skipped (left as they were).
 * - The OLD grade values of every row to be processed are read first (no XML)
 *   and handed to `onBackup` BEFORE any write; if `onBackup` throws, nothing is
 *   written. The backup is skipped when resuming (`afterId` > 0).
 * - Batched (`batchSize`, default 50) with 4 concurrent per-row XML fetches.
 *   Per-row failures are counted as skipped, never thrown.
 * - The accuracy-checks meta cache is invalidated when finished (or on error).
 */
export async function regradeAllChecks(opts: {
    onProgress?: (p: RegradeProgress) => void;
    onBackup?: (rows: RegradeBackupRow[]) => void | Promise<void>;
    afterId?: number;
    batchSize?: number;
    shouldStop?: () => boolean;
} = {}): Promise<RegradeAllResult> {
    const batchSize = Math.max(1, opts.batchSize ?? 50);
    const CONCURRENCY = 4;
    const afterId = opts.afterId ?? 0;

    type OldRow = RegradeBackupRow & {
        tolerance: number | null;
        file_name_master: string | null;
        sport: string | null;
    };

    // Pass 1: ids + OLD grade values (no XML), paged by id.
    const rows: OldRow[] = [];
    const cols = `id, tolerance, file_name_master, sport, ${GRADE_COLUMNS.join(", ")}`;
    let cursor = afterId;
    for (;;) {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select(cols)
            .is("deleted_at", null)
            .gt("id", cursor)
            .order("id", { ascending: true })
            .limit(200);
        if (error) {
            console.error("Failed listing checks to regrade:", error);
            throw new Error(error.message || "Failed listing checks to regrade");
        }
        const page = (data ?? []) as unknown as OldRow[];
        if (page.length === 0) break;
        rows.push(...page);
        cursor = page[page.length - 1].id;
        if (page.length < 200) break;
    }

    if (afterId === 0 && opts.onBackup) {
        await opts.onBackup(
            rows.map((r) => {
                const b = { id: r.id } as RegradeBackupRow;
                for (const c of GRADE_COLUMNS) b[c] = r[c];
                return b;
            })
        );
    }

    const total = rows.length;
    let done = 0;
    let updated = 0;
    let changed = 0;
    let skipped = 0;
    let lastId = afterId;
    let stopped = false;

    const processOne = async (old: OldRow) => {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .select("xml_master, xml_analyst")
            .eq("id", old.id)
            .single();
        if (error || !data) {
            console.error(`Regrade XML fetch failed ${old.id}:`, error);
            skipped += 1;
            return;
        }
        const x = data as { xml_master: string | null; xml_analyst: string | null };
        if (!x.xml_master || !x.xml_analyst) {
            skipped += 1; // missing XML: leave the row as it is
            return;
        }
        const graded = gradeOverlapScoped(
            x.xml_master,
            x.xml_analyst,
            old.tolerance,
            old.file_name_master,
            old.sport
        );
        if (!graded) {
            skipped += 1;
            return;
        }
        const next = gradedColumns(graded);
        const { error: upErr } = await supabase
            .from("accuracy_checks")
            .update(next)
            .eq("id", old.id);
        if (upErr) {
            console.error(`Regrade update failed ${old.id}:`, upErr);
            skipped += 1;
            return;
        }
        updated += 1;
        if (!GRADE_COLUMNS.every((c) => jsonDeepEqual(old[c], next[c]))) {
            changed += 1;
        }
    };

    try {
        for (let i = 0; i < rows.length; i += batchSize) {
            if (opts.shouldStop?.()) {
                stopped = true;
                break;
            }
            const batch = rows.slice(i, i + batchSize);
            for (let j = 0; j < batch.length; j += CONCURRENCY) {
                const slice = batch.slice(j, j + CONCURRENCY);
                await Promise.all(
                    slice.map(async (old) => {
                        try {
                            await processOne(old);
                        } catch (e) {
                            console.error(`Regrade failed ${old.id}:`, e);
                            skipped += 1;
                        }
                    })
                );
                done += slice.length;
                lastId = slice[slice.length - 1].id;
                opts.onProgress?.({ done, total, updated, changed, skipped, lastId });
            }
        }
    } finally {
        invalidateAccuracyChecksMetaCache();
    }

    return { updated, changed, skipped, total, lastId, stopped };
}

/**
 * Re-grade every active check (see regradeAllChecks). Kept for the existing
 * name/signature: it is a FULL regrade, not just player_accuracy.
 */
export async function recomputeAllPlayerAccuracy(
    onProgress?: (p: BackfillProgress) => void
): Promise<{ updated: number; skipped: number }> {
    const res = await regradeAllChecks({
        onProgress: (p) => onProgress?.({ done: p.done, total: p.total }),
    });
    return { updated: res.updated, skipped: res.skipped };
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
    // Row leaves active (M), enters deleted (D), and its disputes drop out of
    // GD/OC (cross-table inner-join on accuracy_checks.deleted_at).
    invalidateAccuracyChecksMetaCache();
    invalidateDeletedAccuracyChecksMetaCache();
    invalidateAllDisputesCache();
    invalidateOpenDisputeCountsCache();
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
    // Row re-enters active (M), leaves deleted (D); its disputes re-appear in
    // GD/OC (cross-table inner-join on accuracy_checks.deleted_at).
    invalidateAccuracyChecksMetaCache();
    invalidateDeletedAccuracyChecksMetaCache();
    invalidateAllDisputesCache();
    invalidateOpenDisputeCountsCache();
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
    // Row removed from the deleted view (D); CASCADE removes its dispute rows
    // (GD/OC). Clearing M too is harmless and keeps the rule uniform.
    invalidateAccuracyChecksMetaCache();
    invalidateDeletedAccuracyChecksMetaCache();
    invalidateAllDisputesCache();
    invalidateOpenDisputeCountsCache();
}

/**
 * All soft-deleted checks (metadata only, newest-deleted first) for the
 * "Deleted checks" review view.
 */
export function getDeletedAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
    return deletedMetaCached.get();
}

/** Reset the cached deleted-checks meta list so the next read re-fetches. */
export function invalidateDeletedAccuracyChecksMetaCache(): void {
    deletedMetaCached.invalidate();
}

async function fetchDeletedAccuracyChecksMeta(): Promise<AccuracyCheckMeta[]> {
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
            // Newest first (list fetch returns desc), so [0] is latest.
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
