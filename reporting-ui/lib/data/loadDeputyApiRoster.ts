import { getDeputyRosters, getDeputyRostersWithMeta } from "@/lib/api/deputy";
import { mapApiRosters } from "@/lib/data/deputyApiRoster";
import type { DeputyRoster } from "@/types/deputyRoster";

type LoadDeputyApiRosterOptions = {
    /** Inclusive start date (YYYY-MM-DD). */
    startDate?: string;
    /** Inclusive end date (YYYY-MM-DD). */
    endDate?: string;
};

/**
 * Loads rostered shifts from the Deputy API pipeline (deputy-read ->
 * deputy.rosters), shaped like the legacy Deputy roster rows. Same call shape
 * as loadDeputyRoster. Throws on failure: there is deliberately NO fallback to
 * the legacy table, so the page can show an error instead of stale data.
 */
export async function loadDeputyApiRoster(
    options: LoadDeputyApiRosterOptions = {}
): Promise<DeputyRoster[]> {

    const { startDate, endDate } = options;

    const rows = await getDeputyRosters({
        from: startDate,
        to: endDate,
    });

    return mapApiRosters(rows, { startDate, endDate });

}

/**
 * Same mapping as loadDeputyApiRoster, but asks deputy-read to sync from
 * Deputy first and also reports whether a sync actually ran. Only call this
 * from an explicit user action.
 */
export async function loadDeputyApiRosterWithSync(
    options: LoadDeputyApiRosterOptions = {}
): Promise<{ roster: DeputyRoster[]; synced: boolean }> {

    const { startDate, endDate } = options;

    const { rows, synced } = await getDeputyRostersWithMeta({
        from: startDate,
        to: endDate,
        sync: true,
    });

    return { roster: mapApiRosters(rows, { startDate, endDate }), synced };

}
