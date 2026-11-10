import { getDeputyRosters } from "@/lib/api/deputy";
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
 * deputy.rosters), shaped like the legacy deputy_roster rows. Same call shape
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
