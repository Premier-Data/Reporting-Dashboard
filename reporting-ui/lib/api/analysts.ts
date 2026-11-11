import { supabase } from "@/lib/supabase";
import { getDeputyShiftEmployeeNames } from "@/lib/api/deputyShifts";

const API_URL =
    process.env.NODE_ENV === "development"
        ? "http://localhost:5165"
        : "https://downloads.premierdata-technology.com";


export interface AutoDownloadAnalyst {
    id: number;
    name: string;

    homeComputer: {
        id: number;
        computerName: string;
    } | null;

    officeComputer: {
        id: number;
        computerName: string;
    } | null;
}


export interface Analyst {
    id: number;
    name: string;
    email?: string | null;

    homeComputer: {
        id: number;
        computerName: string;
    } | null;

    officeComputer: {
        id: number;
        computerName: string;
    } | null;
}


export async function getAutoDownloadAnalysts(): Promise<
    AutoDownloadAnalyst[]
> {

    const res = await fetch(
        `${API_URL}/api/analysts`,
        {
            cache: "no-store",
        }
    );

    if (!res.ok) {
        throw new Error(
            "Failed loading AutoDownload analysts"
        );
    }

    return res.json();
}


export async function getAnalysts(): Promise<
    Analyst[]
> {

    const res = await fetch(
        `${API_URL}/api/analysts`,
        {
            cache: "no-store",
        }
    );

    if (!res.ok) {
        throw new Error(
            "Failed loading analysts"
        );
    }

    return res.json();
}


export async function deleteAnalyst(
    id: number
) {

    const res = await fetch(
        `${API_URL}/api/analysts/${id}`,
        {
            method: "DELETE",
        }
    );

    if (!res.ok) {

        const errorText =
            await res.text();

        throw new Error(
            `Failed deleting analyst (${res.status}): ${errorText}`
        );

    }

    return true;
}


export async function renameAnalyst(
    id: number,
    firstName?: string,
    lastName?: string
): Promise<{ id: number; name: string; firstName: string; lastName: string }> {

    const res = await fetch(
        `${API_URL}/api/analysts/${id}/name`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...(firstName ? { firstName } : {}),
                ...(lastName ? { lastName } : {}),
            }),
        }
    );

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(
            `Failed renaming analyst (${res.status}): ${errorText}`
        );
    }

    return res.json();
}
export async function updateHomeComputer(
    analystId: number,
    computerId: number | null,
    force = false
) {

    const id = computerId ?? 0;

    const res = await fetch(
        `${API_URL}/api/analysts/${analystId}/home-computer/${id}?force=${force}`,
        {
            method: "PUT",
        }
    );

    if (!res.ok) {

        const errorText =
            await res.text();

        let errorData: any;

        try {
            errorData =
                JSON.parse(errorText);
        }
        catch {
            errorData = {
                message:
                    "Failed to update Home Computer",
            };
        }

        const error =
            new Error(
                errorData.message ||
                "Failed to update Home Computer"
            );

        Object.assign(
            error,
            errorData
        );

        throw error;
    }

    return res.json().catch(() => null);
}


export async function updateOfficeComputer(
    analystId: number,
    computerId: number | null,
    force = false
) {

    const id = computerId ?? 0;

    const res = await fetch(
        `${API_URL}/api/analysts/${analystId}/office-computer/${id}?force=${force}`,
        {
            method: "PUT",
        }
    );

    if (!res.ok) {

        const errorText =
            await res.text();

        let errorData: any;

        try {
            errorData =
                JSON.parse(errorText);
        }
        catch {
            errorData = {
                message:
                    "Failed to update Office Computer",
            };
        }

        const error =
            new Error(
                errorData.message ||
                "Failed to update Office Computer"
            );

        Object.assign(
            error,
            errorData
        );

        throw error;
    }

    return res.json().catch(() => null);
}


// ======================================================================
// PLATFORM ANALYSTS (Supabase `analysts` table)
//
// A shared source of truth for analyst identity across the Supabase-backed
// parts of the app. Analysts added here appear in the Accuracy Comparison
// dropdowns and are merged into the Analyst Management view. Matching is by
// name (no shared id with the .NET analysts API), so names are stored
// trimmed and de-duplicated case-insensitively.
// ======================================================================

// Where an analyst is based. Used for cross-country accuracy comparison.
export type AnalystLocation =
    | "Australia"
    | "Philippines"
    | "Vietnam"
    | "Vietnam - Training";
export const ANALYST_LOCATIONS: AnalystLocation[] = [
    "Australia",
    "Philippines",
    "Vietnam",
    "Vietnam - Training",
];

export interface PlatformAnalyst {
    id: number;
    name: string;
    email: string | null;
    /** Country the analyst is based in (null until set). */
    location: AnalystLocation | null;
    created_at: string;
}

/** A single entry to add (name required, email + location optional). */
export interface NewAnalystEntry {
    name: string;
    email?: string | null;
    location?: AnalystLocation | null;
}

/** Result of a bulk add: how many were inserted vs skipped as duplicates. */
export interface BulkAddResult {
    added: number;
    skipped: number;
    addedNames: string[];
}

/**
 * All analysts recorded in the shared Supabase `analysts` table, name-sorted.
 */
export async function getPlatformAnalysts(): Promise<PlatformAnalyst[]> {
    const { data, error } = await supabase
        .from("analysts")
        .select("id, name, email, location, created_at")
        .order("name", { ascending: true });

    if (error) {
        console.error("Failed loading platform analysts:", error);
        throw new Error(error.message || "Failed loading analysts");
    }

    return (data ?? []) as PlatformAnalyst[];
}

/**
 * Add a single analyst. Throws on a duplicate name (case-insensitive unique
 * index) or other DB error.
 */
export async function createAnalyst(
    name: string,
    email?: string | null,
    location?: AnalystLocation | null
): Promise<PlatformAnalyst> {
    const clean = name.trim();
    if (!clean) throw new Error("Analyst name is required.");

    const { data, error } = await supabase
        .from("analysts")
        .insert({
            name: clean,
            email: email?.trim() || null,
            location: location ?? null,
        })
        .select("id, name, email, location, created_at")
        .single();

    if (error) {
        // Postgres unique-violation code.
        if (error.code === "23505") {
            throw new Error(`"${clean}" already exists.`);
        }
        console.error("Failed creating analyst:", error);
        throw new Error(error.message || "Failed creating analyst");
    }

    return data as PlatformAnalyst;
}

/**
 * Rename a platform analyst (Supabase `analysts` table) by matching the
 * current name (case-insensitive). Used so that renaming in Analyst Management
 * keeps the Supabase name — which is what accuracy checks match on — in sync.
 * If no matching row exists, one is created with the new name so the analyst
 * is present in the shared table. Returns true if a row was updated/created.
 */
export async function updatePlatformAnalystName(
    currentName: string,
    newName: string
): Promise<boolean> {
    const clean = newName.trim();
    if (!clean) return false;

    // Find the existing row by the current name (case-insensitive).
    const { data: existing, error: findErr } = await supabase
        .from("analysts")
        .select("id")
        .ilike("name", currentName.trim())
        .limit(1);

    if (findErr) {
        console.error("Failed finding analyst to rename:", findErr);
        throw new Error(findErr.message || "Failed finding analyst");
    }

    if (existing && existing.length > 0) {
        const id = (existing[0] as { id: number }).id;
        const { error } = await supabase
            .from("analysts")
            .update({ name: clean })
            .eq("id", id);
        if (error) {
            if (error.code === "23505")
                throw new Error(`"${clean}" already exists.`);
            console.error("Failed renaming analyst:", error);
            throw new Error(error.message || "Failed renaming analyst");
        }
        return true;
    }

    // No existing row — create one under the new name so it's in the table.
    await createAnalyst(clean);
    return true;
}

export interface MergeAnalystsResult {
    checksReassigned: number;
    affiliationsReassigned: number;
}

/**
 * Merge a duplicate analyst (source) into another (target), by name. Used to
 * fix name mismatches (e.g. "Will Purssey" -> "William Purssey"):
 *   - Reassigns accuracy_checks (analyst_name AND master_analyst_name) from
 *     the source name to the target name, so historical checks attribute to
 *     the target.
 *   - Moves team affiliations to the target (skipping ones the target already
 *     has, to avoid duplicates).
 *   - Gives the target the source's location if the target has none.
 *   - Deletes the source row from the `analysts` table.
 * Matching is case-insensitive. `.NET` records are not touched (separate data
 * source); this fixes the Supabase side that checks + location use.
 */
export async function mergeAnalysts(
    sourceName: string,
    targetName: string
): Promise<MergeAnalystsResult> {
    const src = sourceName.trim();
    const tgt = targetName.trim();
    if (!src || !tgt) throw new Error("Both analysts are required.");
    if (src.toLowerCase() === tgt.toLowerCase())
        throw new Error("Source and target are the same analyst.");

    // 1) Reassign accuracy_checks.analyst_name (graded) source -> target.
    let checksReassigned = 0;
    {
        const { data, error } = await supabase
            .from("accuracy_checks")
            .update({ analyst_name: tgt })
            .ilike("analyst_name", src)
            .select("id");
        if (error) {
            console.error("Merge: failed reassigning checks:", error);
            throw new Error(error.message || "Failed reassigning checks");
        }
        checksReassigned = data?.length ?? 0;
    }

    // 1b) Reassign master_analyst_name where the source coded the master.
    {
        const { error } = await supabase
            .from("accuracy_checks")
            .update({ master_analyst_name: tgt })
            .ilike("master_analyst_name", src);
        if (error) {
            console.error("Merge: failed reassigning master names:", error);
            throw new Error(error.message || "Failed reassigning master names");
        }
    }

    // 2) Move team affiliations, skipping any the target already has.
    let affiliationsReassigned = 0;
    {
        const { data: srcAff } = await supabase
            .from("analyst_team_affiliations")
            .select("team_id")
            .ilike("analyst_name", src);
        const { data: tgtAff } = await supabase
            .from("analyst_team_affiliations")
            .select("team_id")
            .ilike("analyst_name", tgt);
        const tgtTeamIds = new Set(
            (tgtAff ?? []).map((r) => (r as { team_id: number }).team_id)
        );
        const toMove = (srcAff ?? [])
            .map((r) => (r as { team_id: number }).team_id)
            .filter((id) => !tgtTeamIds.has(id));

        // Point the non-duplicate ones at the target...
        for (const teamId of toMove) {
            const { error } = await supabase
                .from("analyst_team_affiliations")
                .update({ analyst_name: tgt })
                .ilike("analyst_name", src)
                .eq("team_id", teamId);
            if (!error) affiliationsReassigned += 1;
        }
        // ...then remove any remaining source affiliations (duplicates).
        await supabase
            .from("analyst_team_affiliations")
            .delete()
            .ilike("analyst_name", src);
    }

    // 3) Carry location to the target if it has none.
    {
        const fetchRow = async (name: string) => {
            const { data } = await supabase
                .from("analysts")
                .select("id, name, location")
                .ilike("name", name)
                .limit(1);
            return (data?.[0] as PlatformAnalyst | undefined) ?? undefined;
        };
        const srcRow = await fetchRow(src);
        const tgtRow = await fetchRow(tgt);

        if (tgtRow && !tgtRow.location && srcRow?.location) {
            await supabase
                .from("analysts")
                .update({ location: srcRow.location })
                .eq("id", tgtRow.id);
        }

        // 4) Delete the source analysts row.
        if (srcRow) {
            const { error } = await supabase
                .from("analysts")
                .delete()
                .eq("id", srcRow.id);
            if (error) {
                console.error("Merge: failed deleting source analyst:", error);
                throw new Error(error.message || "Failed deleting source analyst");
            }
        }
    }

    return { checksReassigned, affiliationsReassigned };
}

/**
 * Update an existing platform analyst's location. Used from Analyst
 * Management to set/change where an analyst is based.
 */
export async function updateAnalystLocation(
    id: number,
    location: AnalystLocation | null
): Promise<void> {
    const { error } = await supabase
        .from("analysts")
        .update({ location })
        .eq("id", id);

    if (error) {
        console.error("Failed updating analyst location:", error);
        throw new Error(error.message || "Failed updating analyst location");
    }
}

/**
 * Set/clear an analyst's email in the shared `analysts` table, keyed BY NAME
 * (case-insensitive). Creates the row if the analyst isn't in the table yet
 * (e.g. .NET-only analysts). Returns the resolved/updated platform analyst.
 */
export async function updateAnalystEmail(
    name: string,
    email: string | null
): Promise<PlatformAnalyst> {
    const clean = name.trim();
    if (!clean) throw new Error("Analyst name is required.");
    const cleanEmail = email?.trim() || null;

    const { data: existing, error: findErr } = await supabase
        .from("analysts")
        .select("id, name, email, location, created_at")
        .ilike("name", clean)
        .limit(1)
        .maybeSingle();
    if (findErr) {
        console.error("Failed looking up analyst:", findErr);
        throw new Error(findErr.message || "Failed updating email");
    }

    if (existing) {
        const { data, error } = await supabase
            .from("analysts")
            .update({ email: cleanEmail })
            .eq("id", (existing as PlatformAnalyst).id)
            .select("id, name, email, location, created_at")
            .single();
        if (error) {
            console.error("Failed updating analyst email:", error);
            throw new Error(error.message || "Failed updating email");
        }
        return data as PlatformAnalyst;
    }

    // No row yet — create one with the email.
    return createAnalyst(clean, cleanEmail, null);
}

/**
 * Map of analyst name (lowercased) -> location, from the shared `analysts`
 * table. Used to attribute name-only accuracy checks to a country.
 */
export async function getAnalystLocationMap(): Promise<
    Map<string, AnalystLocation>
> {
    const map = new Map<string, AnalystLocation>();
    try {
        const analysts = await getPlatformAnalysts();
        for (const a of analysts) {
            if (a.location) map.set(a.name.trim().toLowerCase(), a.location);
        }
    } catch (err) {
        console.error("Failed building analyst location map:", err);
    }
    return map;
}

/**
 * Add many analysts at once, skipping any whose name already exists (either
 * already in the table, or duplicated within the input). De-duplication is
 * case-insensitive.
 */
export async function createAnalystsBulk(
    entries: NewAnalystEntry[]
): Promise<BulkAddResult> {
    // Normalise + de-dupe the input by lowercased name (first email wins).
    const byLower = new Map<string, NewAnalystEntry>();
    for (const e of entries) {
        const name = e.name.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!byLower.has(key)) {
            byLower.set(key, {
                name,
                email: e.email?.trim() || null,
                location: e.location ?? null,
            });
        }
    }

    const requested = Array.from(byLower.values());
    if (requested.length === 0) {
        return { added: 0, skipped: 0, addedNames: [] };
    }

    // Skip names that already exist in the table (case-insensitive).
    const existing = await getPlatformAnalysts();
    const existingLower = new Set(
        existing.map((a) => a.name.trim().toLowerCase())
    );

    const toInsert = requested.filter(
        (e) => !existingLower.has(e.name.toLowerCase())
    );
    const skipped = requested.length - toInsert.length;

    if (toInsert.length === 0) {
        return { added: 0, skipped, addedNames: [] };
    }

    const { data, error } = await supabase
        .from("analysts")
        .insert(
            toInsert.map((e) => ({
                name: e.name,
                email: e.email ?? null,
                location: e.location ?? null,
            }))
        )
        .select("name");

    if (error) {
        console.error("Failed bulk-adding analysts:", error);
        throw new Error(error.message || "Failed bulk-adding analysts");
    }

    const addedNames = (data ?? []).map((r) => (r as { name: string }).name);
    return { added: addedNames.length, skipped, addedNames };
}

/**
 * Distinct analyst names for pickers. Unions the shared `analysts` table with
 * the employee names in approved Deputy API timesheets so both manually-added
 * analysts and rostered staff appear. Case-insensitively de-duplicated,
 * name-sorted.
 */
export async function getPlatformAnalystNames(): Promise<string[]> {
    const seenLower = new Set<string>();
    const names: string[] = [];

    const add = (raw?: string | null) => {
        const n = raw?.trim();
        if (!n) return;
        const key = n.toLowerCase();
        if (seenLower.has(key)) return;
        seenLower.add(key);
        names.push(n);
    };

    // Shared analysts table.
    try {
        const platform = await getPlatformAnalysts();
        for (const a of platform) add(a.name);
    } catch (err) {
        console.error("getPlatformAnalystNames: analysts table failed", err);
    }

    // Deputy API timesheets. This is the one deliberate degraded path: pickers
    // must not break because Deputy is down, so on failure only the analysts
    // table names are returned (a subset, never another Deputy source).
    try {
        for (const n of await getDeputyShiftEmployeeNames()) add(n);
    } catch (err) {
        console.error(
            "getPlatformAnalystNames: deputy names unavailable",
            (err as { code?: string })?.code ?? err
        );
    }
    return names.sort((a, b) => a.localeCompare(b));
}


/**
 * A single, consolidated analyst identity used across the platform. `id` is the
 * .NET AutoDownload analyst id when known (else null); `name` is the canonical
 * display name and the stable key used for matching everywhere else.
 */
export interface ConsolidatedAnalyst {
    /** .NET AutoDownload analyst id, when this name exists there; else null. */
    id: number | null;
    name: string;
}

/**
 * The consolidated analyst list — the SAME set Analyst Management shows: the
 * .NET AutoDownload analysts merged with the shared Supabase `analysts` table,
 * de-duplicated by (lowercased) name. This is the platform's single source of
 * truth for "who are the analysts" and should be used anywhere the app needs to
 * pick an analyst (e.g. allocating a fixture).
 *
 * Each source is caught independently: if the .NET API is unreachable (as in
 * local dev), the Supabase analysts still return — mirroring how Analyst
 * Management degrades. Names are returned sorted.
 */
export async function getAllAnalysts(): Promise<ConsolidatedAnalyst[]> {
    const byLower = new Map<string, ConsolidatedAnalyst>();

    const add = (name: string | null | undefined, id: number | null) => {
        const clean = (name ?? "").trim();
        if (!clean) return;
        const key = clean.toLowerCase();
        const existing = byLower.get(key);
        if (!existing) {
            byLower.set(key, { id, name: clean });
        } else if (existing.id == null && id != null) {
            // Prefer the entry that carries a .NET id (so allocation can use it).
            existing.id = id;
        }
    };

    // .NET AutoDownload analysts (may be unreachable in dev — caught).
    try {
        const dotnet = await getAnalysts();
        for (const a of dotnet) add(a.name, a.id);
    } catch (err) {
        console.error("getAllAnalysts: .NET analysts failed", err);
    }

    // Shared Supabase analysts table (platform source of truth).
    try {
        const platform = await getPlatformAnalysts();
        for (const a of platform) add(a.name, null);
    } catch (err) {
        console.error("getAllAnalysts: platform analysts failed", err);
    }

    return Array.from(byLower.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
    );
}
