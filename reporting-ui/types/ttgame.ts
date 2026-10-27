export interface TTGame {
    id: number;

    downloadPercent: number | null;

    fileSizeBytes: number | null;

    Week: string;
    Date: string;
    Competition: string;
    Round: string;
    home_team: string;
    away_team: string;
    home_allocated: string | null;
    away_allocated: string | null;
    expected_day: string | null;
    game_key: string;
    videoURL: string;

    /**
     * Season this fixture belongs to (e.g. 2027), derived from the source
     * sheet name in sync-deputy.js (not from the fixture date). The 2027
     * season runs 1 Oct 2026 – 30 Sep 2027, so date-based bucketing would be
     * wrong; the sheet is the source of truth. Older rows synced before the
     * season column may be null.
     */
    season?: number | null;

    assignments?: {
        id: number;
        analystId: number;
        name: string;
        location: string;
        computerName?: string | null;
    }[];
}