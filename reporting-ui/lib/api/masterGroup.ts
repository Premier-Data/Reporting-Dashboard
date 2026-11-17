// Pure helpers for treating several accuracy checks as "the same master".
// No supabase import, so these are unit-testable and safe to use anywhere.

/**
 * The ONE "same master" key: trim + lowercase. Extensions are NOT stripped
 * (`x.json` and `x.xml` are different masters). Matches getSavedMasters and
 * sameMasterName in accuracyChecks.ts.
 */
export function masterKey(name: string | null | undefined): string {
    return (name ?? "").trim().toLowerCase();
}

/** Group rows by masterKey(file_name_master). Rows with no name are skipped. */
export function groupByMasterKey<T extends { file_name_master: string | null }>(
    rows: readonly T[]
): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const r of rows) {
        const k = masterKey(r.file_name_master);
        if (!k) continue;
        const list = out.get(k);
        if (list) list.push(r);
        else out.set(k, [r]);
    }
    return out;
}

/** Minimal check row needed to resolve a master's original analyst. */
export interface MasterCoderRow {
    id: number;
    created_at: string;
    master_analyst_name: string | null;
    file_name_master: string | null;
    deleted_at?: string | null;
    video_url?: string | null;
}

/**
 * The game video URL for a master. A non-empty saved-master URL wins; otherwise
 * the most recent (created_at, then highest id) non-deleted check with the same
 * masterKey that has a non-empty video_url. Null when none.
 */
export function resolveMasterVideoUrl(
    rows: readonly MasterCoderRow[],
    masterName: string | null | undefined,
    savedVideoUrl?: string | null
): string | null {
    const saved = savedVideoUrl?.trim();
    if (saved) return saved;
    const key = masterKey(masterName);
    if (!key) return null;
    let best: MasterCoderRow | null = null;
    let bestTime = 0;
    for (const r of rows) {
        if (r.deleted_at) continue;
        if (masterKey(r.file_name_master) !== key) continue;
        if (!r.video_url?.trim()) continue;
        const t = Date.parse(r.created_at);
        const time = Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
        if (!best || time > bestTime || (time === bestTime && r.id > best.id)) {
            best = r;
            bestTime = time;
        }
    }
    return best?.video_url?.trim() ?? null;
}

/**
 * The analyst who ORIGINALLY CODED a master (master_analyst_name): the master coder on the earliest
 * (created_at, then lowest id) non-deleted check whose master matches by
 * masterKey. Checks with a blank master coder are skipped. Null when none found.
 */
export function resolveMasterCoder(
    rows: readonly MasterCoderRow[],
    masterName: string | null | undefined
): string | null {
    const key = masterKey(masterName);
    if (!key) return null;
    let best: MasterCoderRow | null = null;
    let bestTime = 0;
    for (const r of rows) {
        if (r.deleted_at) continue;
        if (masterKey(r.file_name_master) !== key) continue;
        if (!r.master_analyst_name?.trim()) continue;
        const t = Date.parse(r.created_at);
        const time = Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
        if (!best || time < bestTime || (time === bestTime && r.id < best.id)) {
            best = r;
            bestTime = time;
        }
    }
    return best?.master_analyst_name?.trim() ?? null;
}

/**
 * Guard for writing a master-derived total: never write 0 (or anything when the
 * source is blank) over a stored value. Returns false when the count is 0, which
 * covers both an empty master and a non-empty one that failed to parse.
 */
export function isSafeMasterWrite(
    raw: string | null | undefined,
    count: number
): boolean {
    if (!raw || raw.trim().length === 0) return false;
    return Number.isFinite(count) && count > 0;
}

/**
 * True when sibling checks genuinely use DIFFERENT master files, judged by the
 * parsed instance count of each check's full master (same rule as the Master
 * consistency modal). Stored master_total is overlap-scoped per analyst, so it
 * must NOT be used for this.
 */
export function mastersGenuinelyDiffer(
    parsedCounts: readonly (number | null | undefined)[]
): boolean {
    return masterTotalsDiffer(parsedCounts);
}

/** True when the non-null totals are not all identical. */
export function masterTotalsDiffer(
    totals: readonly (number | null | undefined)[]
): boolean {
    const set = new Set(totals.filter((t): t is number => t != null));
    return set.size > 1;
}
