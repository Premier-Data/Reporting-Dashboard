"use client";

import {
    useEffect,
    useMemo,
    useState,
} from "react";

import type {
    AutoDownloadFixture,
} from "@/lib/api/autodownload";

import {
    getAutoDownloadAnalysts,
    type AutoDownloadAnalyst,
} from "@/lib/api/analysts";

import { assignFixture } from "@/lib/api/assignFixture";
import {
    createDownloadJob,
    retryFailedDownloadJobs,
} from "@/lib/api/downloadJobs";

import {
    getHubConnection,
} from "@/lib/signalr";

import {
    HubConnectionState,
} from "@microsoft/signalr";

import {
    getFixtures,
} from "@/lib/api/fixtures";

import { syncGamesToApi } from "@/lib/api/fixtures";

import { supabase } from "@/lib/supabase";
import { mapFixtureWeekTT } from "@/lib/analytics/season";
import {
    defaultSeasonWeek,
    fixtureSeasons,
    weeksForSeason,
} from "@/lib/analytics/fixtureSeasonWeeks";

import type { TTGame } from "@/types/ttgame";


/*
 * Single source of truth for the composite key used to match a
 * TT_Games row to an AutoDownload API fixture. Both systems assign
 * unrelated game_key formats, so home/away/competition/round is the
 * only identifier consistent across both.
 *
 * This MUST be used everywhere a composite is built (the unmatched-game
 * sync effect AND the mergedFixtures merge). If two call sites normalise
 * differently — e.g. one trims and the other doesn't — a row with a
 * trailing space matches in one place and not the other, so it gets
 * re-synced forever and stays stuck on "Checking..." while the download
 * never advances past Pending.
 *
 * Normalisation: strip zero-width chars, collapse whitespace, trim,
 * lowercase.
 */
function normaliseKeyPart(value: string | null | undefined): string {
    return (value ?? "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function keyFor(f: {
    home_team?: string | null;
    away_team?: string | null;
    Competition?: string | null;
    Round?: string | null;
}): string {
    return [
        normaliseKeyPart(f.home_team),
        normaliseKeyPart(f.away_team),
        normaliseKeyPart(f.Competition),
        normaliseKeyPart(f.Round),
    ].join("|");
}


export default function FixturesPage() {

    const [
        allGames,
        setAllGames,
    ] = useState<TTGame[]>([]);


    const [
        fixtures,
        setFixtures,
    ] = useState<TTGame[]>([]);


    const [
        autoFixtures,
        setAutoFixtures,
    ] = useState<AutoDownloadFixture[]>([]);


    const [
        analysts,
        setAnalysts,
    ] = useState<AutoDownloadAnalyst[]>([]);


    const [
        loading,
        setLoading,
    ] = useState(true);


    const [
        connected,
        setConnected,
    ] = useState(true);


    const [
        error,
        setError,
    ] = useState("");


    const [
        search,
        setSearch,
    ] = useState("");


    const [
        updating,
        setUpdating,
    ] = useState<number | null>(null);


    const [
        retrying,
        setRetrying,
    ] = useState(false);


    const [
        sortField,
        setSortField,
    ] = useState("date");


    const [
        sortDirection,
        setSortDirection,
    ] = useState<"asc" | "desc">("asc");


    const [
        addingFixture,
        setAddingFixture,
    ] = useState<string | null>(null);


    const [
        selectedWeek,
        setSelectedWeek,
    ] = useState<string>("All");

    const [selectedSeason, setSelectedSeason] =
        useState<number | null>(null);


    const [
        lastRefresh,
        setLastRefresh,
    ] = useState(new Date());

    /*
     * LOAD ALL GAMES FROM SUPABASE + API STATUS
     */

    async function load() {

        try {

            setError("");

            // Load TT_Games from Supabase (all weeks)
            const gamesList: TTGame[] = [];
            let from = 0;
            const pageSize = 1000;

            while (true) {
                const { data, error: gamesError } =
                    await supabase
                        .from("TT_Games")
                        .select("*")
                        .order("Date")
                        .order("Competition")
                        .range(from, from + pageSize - 1);

                if (gamesError) {
                    console.error("Failed loading TT_Games:", gamesError);
                    break;
                }

                if (!data?.length) break;

                gamesList.push(...mapFixtureWeekTT(data as TTGame[]));

                if (data.length < pageSize) break;

                from += pageSize;
            }

            setAllGames(gamesList);

            // Load API fixtures for live status overlay
            const [
                fixtureData,
                analystData,
            ] = await Promise.all([
                getFixtures(),
                getAutoDownloadAnalysts(),
            ]);


            const safeFixtures =
                Array.isArray(fixtureData)
                    ? fixtureData
                    : [];


            setFixtures(
                safeFixtures
            );


            setAnalysts(
                Array.isArray(analystData)
                    ? analystData
                    : []
            );


            /*
             * Build the existing autoFixture shape
             * from the live /api/fixtures response.
             */

            const liveAutoFixtures:
                AutoDownloadFixture[] =
                safeFixtures.map(
                    fixture => {

                        const assignment =
                            fixture.assignments?.[0] ??
                            null;


                        return {

                            id:
                                fixture.id,

                            fixtureId:
                                fixture.game_key,

                            gameKey:
                                fixture.game_key,

                            status:
                                fixture.status ??
                                "Pending",

                            analyst:
                                assignment?.name ??
                                null,

                            analystId:
                                assignment?.analystId ??
                                null,

                            computer:
                                assignment?.computerName ??
                                null,

                            assignmentLocation:
                                assignment?.location ??
                                null,

                            downloadPercent:
                                fixture.downloadPercent ??
                                null,

                            downloadSpeedMbps:
                                fixture.downloadSpeedMbps ??
                                null,

                            fileSizeBytes:
                                fixture.fileSizeBytes ??
                                null,

                            downloadCompletedAt:
                                fixture.downloadCompletedAt ??
                                null,

                        };

                    }
                );


            setAutoFixtures(
                liveAutoFixtures
            );


            setLastRefresh(
                new Date()
            );

            setConnected(true);

        }
        catch (err) {

            console.error(
                "Failed loading fixtures:",
                err
            );

            setError(
                "Unable to load fixtures."
            );

            setConnected(false);

        }
        finally {

            setLoading(false);

        }

    }

    /*
     * REFRESH FIXTURES
     *
     * /api/fixtures already contains:
     *
     * analyst
     * analystId
     * computer
     * assignmentLocation
     * status
     * progress
     * speed
     * file size
     */

    async function refreshFixtures() {

        try {

            const fixtureData =
                await getFixtures();


            const safeFixtures =
                Array.isArray(fixtureData)
                    ? fixtureData
                    : [];


            setFixtures(
                safeFixtures
            );


            /*
             * Build the existing autoFixture shape
             * from the same live fixture response.
             */

            const liveAutoFixtures:
                AutoDownloadFixture[] =
                safeFixtures.map(
                    fixture => {

                        const assignment =
                            fixture.assignments?.[0] ??
                            null;


                        return {

                            id:
                                fixture.id,

                            fixtureId:
                                fixture.game_key,

                            gameKey:
                                fixture.game_key,

                            status:
                                fixture.status ??
                                "Pending",

                            analyst:
                                assignment?.name ??
                                null,

                            analystId:
                                assignment?.analystId ??
                                null,

                            computer:
                                assignment?.computerName ??
                                null,

                            assignmentLocation:
                                assignment?.location ??
                                null,

                            downloadPercent:
                                fixture.downloadPercent ??
                                null,

                            downloadSpeedMbps:
                                fixture.downloadSpeedMbps ??
                                null,

                            fileSizeBytes:
                                fixture.fileSizeBytes ??
                                null,

                            downloadCompletedAt:
                                fixture.downloadCompletedAt ??
                                null,

                        };

                    }
                );


            setAutoFixtures(
                liveAutoFixtures
            );


            setLastRefresh(
                new Date()
            );

            setConnected(true);

        }
        catch (err) {

            console.error(
                "Failed refreshing fixtures:",
                err
            );

            setConnected(false);

        }

    }
    /*
     * INITIAL LOAD
     */

    useEffect(() => {

        document.title =
            "Fixtures | Premier Data Downloads";

        load();

    }, []);


    /*
     * AUTO REFRESH
     *
     * This is important because the API is
     * receiving DownloadJob progress updates.
     */

    useEffect(() => {

        const interval =
            setInterval(
                async () => {

                    await refreshFixtures();

                },
                5000
            );


        /*
         * SignalR
         */

        const connection =
            getHubConnection();


        const handleRefresh =
            async () => {

                console.log(
                    "Fixtures: RefreshOperations received"
                );

                await refreshFixtures();

            };


        /*
         * IMPORTANT:
         * Only remove THIS page's handler.
         * Do not remove every RefreshOperations
         * handler from the shared connection.
         */

        connection.off(
            "RefreshOperations",
            handleRefresh
        );


        connection.on(
            "RefreshOperations",
            handleRefresh
        );


        const startSignalR =
            async () => {

                try {

                    if (
                        connection.state ===
                        HubConnectionState.Disconnected
                    ) {

                        await connection.start();

                        console.log(
                            "Fixtures SignalR connected:",
                            connection.state
                        );

                    }
                    else {

                        console.log(
                            "Fixtures SignalR already connected:",
                            connection.state
                        );

                    }

                }
                catch (err) {

                    console.error(
                        "Fixtures SignalR connection failed:",
                        err
                    );

                }

            };


        startSignalR();


        return () => {

            clearInterval(
                interval
            );


            connection.off(
                "RefreshOperations",
                handleRefresh
            );

        };

    }, []);
    /*
     * AVAILABLE WEEKS (from TT_Games)
     */

    const seasons = useMemo(() => fixtureSeasons(allGames), [allGames]);

    const availableWeeks = useMemo(() => {
        if (selectedSeason == null) return [] as string[];
        return weeksForSeason(allGames, selectedSeason).map(String);
    }, [allGames, selectedSeason]);

    // Default to the newest season's last week once data loads
    useEffect(() => {
        if (selectedSeason == null) {
            const def = defaultSeasonWeek(allGames);
            if (def) {
                setSelectedSeason(def.season);
                setSelectedWeek(String(def.week));
            }
        }
    }, [allGames, selectedSeason]);

    // Sync TT_Games that have videoURLs but aren't in the API yet.
    // Once synced, the API's FileMetadataService will check their sizes
    // automatically (same process as previously imported fixtures).
    useEffect(() => {
        if (allGames.length === 0 || fixtures.length === 0) return;

        let cancelled = false;

        async function syncUnmatchedGames() {
            // Build a set of composites that already exist in the API.
            // Use the SAME normalisation as keyFor() in mergedFixtures
            // (trim + lowercase + strip zero-width chars). If this differs
            // from keyFor(), a game that IS already in the API but has a
            // trailing space on one side gets mis-classified as "unmatched"
            // and re-synced forever, while the merged view (which trims)
            // disagrees — leaving fixtures stuck on "Checking..." and the
            // download never advancing past Pending.
            const apiComposites = new Set(
                fixtures.map(f => keyFor(f))
            );

            // Find TT_Games with videoURL that aren't in the API
            const unmatched = allGames.filter(g => {
                if (!g.videoURL || g.videoURL.trim() === "") return false;
                return !apiComposites.has(keyFor(g));
            });

            if (unmatched.length === 0 || cancelled) return;

            // Sync in batches of 50
            const batch = unmatched.slice(0, 50);

            const synced = await syncGamesToApi(
                batch.map(g => ({
                    gameKey: g.game_key,
                    date: g.Date,
                    year: g.Date?.substring(0, 4),
                    leagueName: g.Competition,
                    round: g.Round,
                    homeTeam: g.home_team,
                    awayTeam: g.away_team,
                    videoUrl: g.videoURL,
                }))
            );

            if (synced > 0 && !cancelled) {
                console.log(`Synced ${synced} games to API for file size checking`);
                // Refresh API fixtures to pick up the new records
                await refreshFixtures();
            }
        }

        syncUnmatchedGames();

        return () => { cancelled = true; };
    }, [allGames.length, fixtures.length]);

    /*
     * MERGED FIXTURES
     *
     * Use TT_Games as the master list,
     * overlay AutoDownload API status.
     * Match by home_team + away_team + competition + round
     * since game_key may differ between systems.
     */

    const mergedFixtures = useMemo(() => {

        // Match API fixtures to Supabase TT_Games rows on a
        // home/away/competition/round composite key — NOT on game_key.
        // The two systems assign completely different game_key formats
        // (verified: zero overlap between TT_Games.game_key and the
        // API's GameKey), so keying by game_key here matches nothing and
        // leaves file size / status / assignment unmerged — every row
        // then shows "Checking..." even though the API already has the
        // size. The composite is the only identifier consistent across
        // both systems.
        //
        // `autoFixtures` is built as a 1:1, index-aligned .map() over
        // `fixtures` (see load()/refreshFixtures() above), so we pair
        // them by index while building the lookups rather than
        // re-resolving via .find(). When two API rows collapse onto the
        // same composite key (rare now that the DB is de-duplicated and
        // has a unique GameKey constraint) we keep whichever row has
        // actually progressed (non-Pending status or an assigned
        // analyst) instead of last-wins, so a blank duplicate can't
        // clobber the real one.
        const autoByKey = new Map<string, AutoDownloadFixture>();
        const fixtureByKey = new Map<string, TTGame>();

        fixtures.forEach((f, index) => {

            const key = keyFor(f);

            const af = autoFixtures[index] ?? null;

            const existingAuto = autoByKey.get(key);

            const isBetter =
                !existingAuto ||
                (
                    af?.status &&
                    af.status !== "Pending" &&
                    existingAuto.status === "Pending"
                ) ||
                (
                    !!af?.analyst &&
                    !existingAuto.analyst
                );

            if (isBetter) {

                fixtureByKey.set(key, f);

                if (af) {
                    autoByKey.set(key, af);
                }

            }

        });

        return allGames.map(
            game => {

                const key = keyFor(game);

                const autoFixture =
                    autoByKey.get(key) ?? null;

                const apiFixture =
                    fixtureByKey.get(key) ?? null;

                // Use file size from API (Cloudflare HEAD check),
                // fall back to TT_Games value
                const mergedGame: TTGame = {
                    ...game,
                    fileSizeBytes:
                        autoFixture?.fileSizeBytes ??
                        apiFixture?.fileSizeBytes ??
                        game.fileSizeBytes ??
                        null,
                    // Also carry over the API fixture id for assignment
                    id: apiFixture?.id ?? game.id,
                    assignments: apiFixture?.assignments ?? game.assignments,
                };

                return {
                    fixture: mergedGame,
                    autoFixture,
                };

            }
        );

    }, [
        allGames,
        fixtures,
        autoFixtures,
    ]);
    /*
     * SEARCH + SORT
     */

    const filteredFixtures =
        useMemo(() => {

            const result =
                mergedFixtures.filter(
                    ({ fixture, autoFixture }) => {

                        const searchText = `
    ${fixture.home_team}
    ${fixture.away_team}
    ${fixture.Competition}
    ${fixture.Round}
    ${fixture.game_key}
    ${fixture.fileSizeBytes ?? ""}
    ${formatSize(fixture.fileSizeBytes)}
    ${autoFixture?.analyst ?? ""}
    ${autoFixture?.computer ?? ""}
    ${autoFixture?.status ?? ""}
`.toLowerCase();

                        const matchesSearch =
                            searchText.includes(
                                search.toLowerCase()
                            );

                        const matchesWeek =
                            (selectedSeason == null ||
                                Number(fixture.season) === selectedSeason) &&
                            (selectedWeek === "All" ||
                                fixture.Week === selectedWeek);

                        return (
                            matchesSearch &&
                            matchesWeek
                        );

                    }
                );


            result.sort(
                (a, b) => {

                    let valueA:
                        string | number = "";

                    let valueB:
                        string | number = "";


                    switch (sortField) {

                        case "date":

                            valueA =
                                a.fixture.Date ?? "";

                            valueB =
                                b.fixture.Date ?? "";

                            break;

                        case "round":

                            valueA =
                                Number(a.fixture.Round) || 0;

                            valueB =
                                Number(b.fixture.Round) || 0;

                            break;

                        case "league":

                            valueA =
                                a.fixture.Competition ?? "";

                            valueB =
                                b.fixture.Competition ?? "";

                            break;


                        case "match":

                            valueA =
                                `${a.fixture.home_team} ${a.fixture.away_team}`;

                            valueB =
                                `${b.fixture.home_team} ${b.fixture.away_team}`;

                            break;


                        case "status":

                            valueA =
                                a.autoFixture?.status ??
                                "Pending";

                            valueB =
                                b.autoFixture?.status ??
                                "Pending";

                            break;


                        case "progress":

                            valueA =
                                a.autoFixture?.downloadPercent ??
                                0;

                            valueB =
                                b.autoFixture?.downloadPercent ??
                                0;

                            break;


                        case "speed":

                            valueA =
                                a.autoFixture?.downloadSpeedMbps ??
                                0;

                            valueB =
                                b.autoFixture?.downloadSpeedMbps ??
                                0;

                            break;


                        case "size":

                            valueA =
                                a.fixture.fileSizeBytes ??
                                0;

                            valueB =
                                b.fixture.fileSizeBytes ??
                                0;

                            break;

                        case "completed":

                            valueA =
                                a.autoFixture?.downloadCompletedAt ??
                                "";

                            valueB =
                                b.autoFixture?.downloadCompletedAt ??
                                "";

                            break;


                        case "analyst":

                            valueA =
                                a.autoFixture?.analyst ??
                                "";

                            valueB =
                                b.autoFixture?.analyst ??
                                "";

                            break;

                    }


                    if (
                        valueA < valueB
                    ) {
                        return sortDirection ===
                            "asc"
                            ? -1
                            : 1;
                    }


                    if (
                        valueA > valueB
                    ) {
                        return sortDirection ===
                            "asc"
                            ? 1
                            : -1;
                    }


                    return 0;

                }
            );


            return result;

        }, [
            mergedFixtures,
            search,
            selectedWeek,
            sortField,
            sortDirection,
        ]);

    /*
     * SORT
     */

    function sortBy(
        field: string
    ) {

        if (
            sortField === field
        ) {

            setSortDirection(
                current =>
                    current === "asc"
                        ? "desc"
                        : "asc"
            );

        }
        else {

            setSortField(
                field
            );

            setSortDirection(
                "asc"
            );

        }

    }


    /*
     * FORMAT FILE SIZE
     */

    function formatSize(
        bytes:
            number |
            null |
            undefined
    ) {

        if (
            bytes == null ||
            bytes <= 0
        ) {

            return "Checking...";

        }


        const gb =
            bytes /
            1024 /
            1024 /
            1024;


        if (
            gb >= 1
        ) {

            return `${gb.toFixed(2)} GB`;

        }


        const mb =
            bytes /
            1024 /
            1024;


        return `${mb.toFixed(0)} MB`;

    }
    /*
     * GET ANALYST OBJECT
     */

    function getAnalyst(
        fixture:
            AutoDownloadFixture |
            null |
            undefined
    ) {

        if (
            fixture?.analystId == null
        ) {
            return null;
        }

        return analysts.find(
            analyst =>
                analyst.id ===
                fixture.analystId
        ) ?? null;

    }

    /*
     * MANUAL ASSIGN
     */
    async function allocate({
        fixture,
        analystId,
        location,
    }: {
        fixture: TTGame;
        analystId: number;
        location: "Home" | "Office";
    }) {

        const analyst =
            analysts.find(
                analyst =>
                    analyst.id === analystId
            );

        if (!analyst) {

            alert(
                "Analyst not found."
            );

            return;

        }


        const computer =
            location === "Home"
                ? analyst.homeComputer
                : analyst.officeComputer;


        if (!computer) {

            alert(
                `${analyst.name} does not have a ${location} computer assigned.`
            );

            return;

        }


        try {

            setUpdating(
                fixture.id
            );


            await assignFixture(
                fixture.id,
                analystId,
                location
            );


            // Queue the actual download on the desktop agent. Assigning
            // alone only records who is responsible for the fixture —
            // the agent polls /api/downloadjobs, not fixture assignments,
            // so without this the download never starts and the status
            // never advances past "Pending".
            if (fixture.videoURL) {

                await createDownloadJob({
                    gameKey: fixture.game_key,
                    videoUrl: fixture.videoURL,
                    year: (fixture.Date ?? "").substring(0, 4),
                    leagueName: fixture.Competition,
                    analystId,
                    computerId: computer.id,
                    assignmentLocation: location,
                    fileSizeBytes: fixture.fileSizeBytes ?? null,
                });

            }


            await refreshFixtures();


            setAddingFixture(
                null
            );

        }
        catch (err) {

            console.error(
                "Assignment failed:",
                err
            );

            alert(
                err instanceof Error
                    ? err.message
                    : "Assignment failed."
            );

        }
        finally {

            setUpdating(
                null
            );

        }

    }


    /*
     * RETRY FAILED DOWNLOADS
     *
     * A failed download job sits at status "Failed" and the desktop
     * agent only ever polls for "Queued" jobs, so it never retries on
     * its own. This asks the API to flip every failed job back to
     * "Queued" (clearing the old error/progress); the agent then picks
     * them up on its next poll. We refresh afterwards so the UI reflects
     * the requeued state.
     */
    async function handleRetryFailed() {

        try {

            setRetrying(true);

            const result = await retryFailedDownloadJobs();

            await refreshFixtures();

            if (result.requeued === 0) {
                alert("No failed downloads to retry.");
            } else {
                alert(
                    `Requeued ${result.requeued} failed download` +
                    `${result.requeued === 1 ? "" : "s"}. ` +
                    `The agent will retry ${result.requeued === 1 ? "it" : "them"} shortly.`
                );
            }

        }
        catch (err) {

            console.error("Retry failed downloads failed:", err);

            alert(
                err instanceof Error
                    ? err.message
                    : "Retry failed."
            );

        }
        finally {

            setRetrying(false);

        }

    }


    /*
     * LOADING
     */

    if (loading) {

        return (

            <div
                className="
                    min-h-screen
                    bg-slate-50
                    p-10
                "
            >

                Loading fixtures...

            </div>

        );

    }
    /*
     * SUMMARY
     */

    const assignedCount =
        filteredFixtures.filter(
            ({ autoFixture }) =>
                autoFixture?.analystId != null ||
                !!autoFixture?.analyst
        ).length;


    const downloadedCount =
        filteredFixtures.filter(
            ({ autoFixture }) =>
                autoFixture?.status ===
                "Downloaded"
        ).length;


    const downloadingCount =
        filteredFixtures.filter(
            ({ autoFixture }) =>
                autoFixture?.status ===
                "Downloading"
        ).length;


    const failedCount =
        filteredFixtures.filter(
            ({ autoFixture }) =>
                autoFixture?.status ===
                "Failed"
        ).length;


    /*
     * SORT ARROW
     */

    const SortArrow = ({
        field
    }: {
        field: string
    }) => {

        if (
            sortField !== field
        ) {

            return null;

        }


        return (
            sortDirection === "asc"
                ? " ↑"
                : " ↓"
        );

    };


    return (

        <div
            className="
            min-h-screen
            bg-slate-50
            p-4
            "
        >

            {/* HEADER */}

            <div
                className="
                mb-6
                flex
                items-center
                justify-between
                "
            >

                <div>

                    <h1
                        className="
                        text-3xl
                        font-bold
                        tracking-tight
                        text-slate-900
                        "
                    >
                        Match Video Auto Download Dashboard
                    </h1>

                </div>


                <div
                    className="
                    text-right
                    "
                >

                    <div
                        className="
                        text-xs
                        uppercase
                        tracking-wide
                        text-slate-400
                        "
                    >
                        Last Updated
                    </div>

                    <div
                        className="
                        text-sm
                        font-medium
                        text-slate-700
                        "
                    >
                        {lastRefresh.toLocaleString(
                            "en-AU",
                            {
                                day: "2-digit",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                            }
                        )}
                    </div>

                </div>

            </div>


            {/* CONNECTION WARNING */}

            {!connected && (

                <div
                    className="
                    mb-4
                    rounded-lg
                    bg-yellow-100
                    p-4
                    text-yellow-800
                    "
                >
                    ⚠ Unable to reach the AutoDownload API.
                </div>

            )}


            {error && (

                <div
                    className="
                    mb-4
                    rounded-lg
                    bg-red-100
                    p-4
                    text-red-700
                    "
                >
                    {error}
                </div>

            )}


            {/* FILTERS */}

            <div
                className="
                mb-4
                flex
                flex-wrap
                items-end
                gap-3
                "
            >

                <div>

                    <label
                        className="
                        mb-1
                        block
                        text-sm
                        text-gray-600
                        "
                    >
                        Search Fixtures
                    </label>

                    <input
                        placeholder="
                            Search by Team, League or Analyst ...
                        "
                        value={search}
                        onChange={
                            e =>
                                setSearch(
                                    e.target.value
                                )
                        }
                        className="
                        w-96
                        rounded-xl
                        border
                        border-slate-300
                        bg-white
                        px-4
                        py-3
                        text-sm
                        outline-none
                        focus:border-blue-500
                        focus:ring-4
                        focus:ring-blue-100
                        "
                    />

                </div>


                {/* SEASON */}

                {seasons.length > 1 && (
                    <div>
                        <label
                            className="
                            mb-1
                            block
                            text-sm
                            text-gray-600
                            "
                        >
                            Season
                        </label>

                        <select
                            value={selectedSeason ?? ""}
                            onChange={e => {
                                const s = Number(e.target.value);
                                const wks = weeksForSeason(allGames, s);
                                setSelectedSeason(s);
                                setSelectedWeek(
                                    wks.length ? String(wks[wks.length - 1]) : "All"
                                );
                            }}
                            className="
                            min-w-[120px]
                            rounded-xl
                            border
                            border-slate-300
                            bg-white
                            px-4
                            py-3
                            text-sm
                            outline-none
                            focus:border-blue-500
                            focus:ring-4
                            focus:ring-blue-100
                            "
                        >
                            {seasons.map(s => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                    </div>
                )}


                {/* WEEK */}

                <div>

                    <label
                        className="
                        mb-1
                        block
                        text-sm
                        text-gray-600
                        "
                    >
                        Week
                    </label>

                    <select
                        value={selectedWeek}
                        onChange={e =>
                            setSelectedWeek(e.target.value)
                        }
                        className="
                        min-w-[200px]
                        rounded-xl
                        border
                        border-slate-300
                        bg-white
                        px-4
                        py-3
                        text-sm
                        outline-none
                        focus:border-blue-500
                        focus:ring-4
                        focus:ring-blue-100
                        "
                    >
                        <option value="All">All Weeks</option>
                        {availableWeeks.map(week => (
                            <option key={week} value={week}>
                                Week {week}
                            </option>
                        ))}
                    </select>

                </div>

            </div>


            {/* SUMMARY */}

            <div
                className="
                mb-6
                grid
                grid-cols-1
                gap-4
                md:grid-cols-5
                "
            >

                <Card
                    title="Total Fixtures"
                    value={
                        filteredFixtures.length
                    }
                />


                <Card
                    title="Assigned"
                    value={
                        assignedCount
                    }
                    colour="text-green-600"
                />


                <Card
                    title="Downloading"
                    value={
                        downloadingCount
                    }
                    colour="text-blue-600"
                />


                <Card
                    title="Downloaded"
                    value={
                        downloadedCount
                    }
                    colour="text-green-600"
                />


                {/* FAILED + RETRY */}
                <div
                    className="
                    rounded-2xl
                    border
                    border-slate-200
                    bg-white
                    p-5
                    shadow-sm
                    flex
                    flex-col
                    justify-between
                    "
                >
                    <div>
                        <div className="text-sm font-medium text-slate-500">
                            Failed
                        </div>
                        <div
                            className={`mt-1 text-3xl font-bold ${
                                failedCount > 0
                                    ? "text-red-600"
                                    : "text-slate-900"
                            }`}
                        >
                            {failedCount}
                        </div>
                    </div>

                    <button
                        onClick={handleRetryFailed}
                        disabled={retrying || failedCount === 0}
                        className="
                            mt-3
                            w-full
                            rounded-lg
                            bg-red-600
                            px-3
                            py-2
                            text-sm
                            font-semibold
                            text-white
                            transition
                            hover:bg-red-500
                            disabled:cursor-not-allowed
                            disabled:bg-slate-300
                        "
                        title={
                            failedCount === 0
                                ? "No failed downloads"
                                : "Requeue all failed downloads"
                        }
                    >
                        {retrying ? "Retrying..." : "Retry failed"}
                    </button>
                </div>

            </div>


            {/* TABLE */}

            <div
                className="
                overflow-hidden
                rounded-2xl
                border
                border-slate-200
                bg-white
                shadow-sm
                "
            >

                <div
                    className="
                    overflow-x-auto
                    "
                >

                    <table
                        className="
                        w-full
                        table-fixed
                        border-collapse
                        text-left
                        text-sm
                        "
                    >
                        <colgroup>
                            <col className="w-[8%]" />   {/* Date */}
                            <col className="w-[5%]" />   {/* Round */}
                            <col className="w-[14%]" />  {/* League */}
                            <col className="w-[20%]" />  {/* Match */}
                            <col className="w-[8%]" />   {/* Status */}
                            <col className="w-[7%]" />   {/* Progress */}
                            <col className="w-[6%]" />   {/* Speed */}
                            <col className="w-[6%]" />   {/* Size */}
                            <col className="w-[11%]" />  {/* Downloaded At */}
                            <col className="w-[15%]" />  {/* Assignments */}
                        </colgroup>

                        <thead
                            className="
                            bg-slate-800
                            text-white
                            "
                        >

                            <tr>

                                <th
                                    onClick={() =>
                                        sortBy(
                                            "date"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Date
                                    <SortArrow
                                        field="date"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "round"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Round
                                    <SortArrow
                                        field="round"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "league"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    League
                                    <SortArrow
                                        field="league"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "match"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Match
                                    <SortArrow
                                        field="match"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "status"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Status
                                    <SortArrow
                                        field="status"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "progress"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Progress
                                    <SortArrow
                                        field="progress"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "speed"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Speed
                                    <SortArrow
                                        field="speed"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "size"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Size
                                    <SortArrow
                                        field="size"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "completed"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Downloaded At
                                    <SortArrow
                                        field="completed"
                                    />
                                </th>


                                <th
                                    onClick={() =>
                                        sortBy(
                                            "analyst"
                                        )
                                    }
                                    className="
                                    cursor-pointer
                                    whitespace-nowrap
                                    px-3
                                    py-3
                                    hover:bg-slate-700
                                    "
                                >
                                    Assignments
                                    <SortArrow
                                        field="analyst"
                                    />
                                </th>

                            </tr>

                        </thead>


                        <tbody>

                            {filteredFixtures.map(
                                ({ fixture, autoFixture }, index) => {

                                    const analyst =
                                        getAnalyst(
                                            autoFixture
                                        );

                                    const progress =
                                        autoFixture?.downloadPercent ??
                                        null;

                                    const status =
                                        autoFixture?.status ??
                                        "Pending";


                                    return (

                                        <tr
                                            key={`${fixture.game_key}_${index}`}
                                            className={`
                                            border-b
                                            border-slate-100
                                            transition
                                            ${status ===
                                                    "Downloaded"
                                                    ? "bg-emerald-50"
                                                    : ""
                                                }
                                            hover:bg-slate-50
                                            `}
                                        >

                                            {/* DATE */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                "
                                            >

                                                {fixture.Date
                                                    ? new Date(
                                                        fixture.Date
                                                    ).toLocaleDateString(
                                                        "en-AU"
                                                    )
                                                    : "-"}

                                            </td>


                                            {/* ROUND */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                "
                                            >
                                                {fixture.Round || "-"}
                                            </td>


                                            {/* LEAGUE */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                "
                                            >
                                                {fixture.Competition}
                                            </td>


                                            {/* MATCH */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                font-medium
                                                text-slate-900
                                                "
                                            >

                                                {fixture.home_team}
                                                {" vs "}
                                                {fixture.away_team}

                                            </td>


                                            {/* STATUS */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                "
                                            >

                                                <StatusBadge
                                                    status={
                                                        status
                                                    }
                                                />

                                            </td>


                                            {/* PROGRESS */}

                                            <td
                                                className="
                                                px-3
                                                py-3
                                                "
                                            >

                                                {status ===
                                                    "Downloading" && (

                                                        <div
                                                            className="
                                                        w-32
                                                        "
                                                        >

                                                            <div
                                                                className="
                                                            mb-1
                                                            flex
                                                            justify-between
                                                            text-xs
                                                            text-slate-500
                                                            "
                                                            >

                                                                <span>
                                                                    {progress !=
                                                                        null
                                                                        ? `${progress.toFixed(
                                                                            1
                                                                        )}%`
                                                                        : "—"}
                                                                </span>

                                                            </div>


                                                            <div
                                                                className="
                                                            h-2
                                                            w-full
                                                            overflow-hidden
                                                            rounded-full
                                                            bg-slate-200
                                                            "
                                                            >

                                                                <div
                                                                    className="
                                                                h-full
                                                                rounded-full
                                                                bg-blue-500
                                                                transition-all
                                                                duration-500
                                                                "
                                                                    style={{
                                                                        width:
                                                                            `${progress ?? 0}%`,
                                                                    }}
                                                                />

                                                            </div>

                                                        </div>

                                                    )}


                                                {status ===
                                                    "Downloaded" && (

                                                        <span
                                                            className="
                                                        font-semibold
                                                        text-green-600
                                                        "
                                                        >
                                                            100%
                                                        </span>

                                                    )}


                                                {status !==
                                                    "Downloading" &&
                                                    status !==
                                                    "Downloaded" && (
                                                        <span className="text-slate-400">
                                                            —
                                                        </span>
                                                    )}

                                            </td>


                                            {/* SPEED */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                "
                                            >

                                                {status ===
                                                    "Downloading" &&
                                                    autoFixture?.downloadSpeedMbps !=
                                                    null
                                                    ? `${autoFixture.downloadSpeedMbps.toFixed(
                                                        1
                                                    )} MB/s`
                                                    : "—"}

                                            </td>


                                            {/* SIZE */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                font-medium
                                                "
                                            >

                                                {formatSize(
                                                    fixture.fileSizeBytes
                                                )}

                                            </td>


                                            {/* DOWNLOADED AT */}

                                            <td
                                                className="
                                                truncate
                                                px-3
                                                py-3
                                                text-slate-600
                                                "
                                            >

                                                {autoFixture?.downloadCompletedAt
                                                    ? new Date(
                                                        autoFixture?.downloadCompletedAt
                                                    ).toLocaleString(
                                                        "en-AU",
                                                        {
                                                            day: "2-digit",
                                                            month: "2-digit",
                                                            year: "2-digit",
                                                            hour: "2-digit",
                                                            minute: "2-digit",
                                                        }
                                                    )
                                                    : "—"}

                                            </td>

                                            {/* ASSIGNMENTS */}

                                            <td
                                                className="
        min-w-[250px]
        px-3
        py-3
    "
                                            >

                                                {fixture.assignments &&
                                                    fixture.assignments.length > 0 ? (

                                                    <div>

                                                        {fixture.assignments.map(
                                                            assignment => (

                                                                <div
                                                                    key={
                                                                        assignment.id
                                                                    }
                                                                    className="mb-2 last:mb-0"
                                                                >

                                                                    <div className="
                            font-semibold
                            text-slate-900
                        ">
                                                                        {
                                                                            assignment.name
                                                                        }
                                                                    </div>

                                                                    <div className="
                            text-xs
                            text-slate-500
                        ">

                                                                        {
                                                                            assignment.computerName ??
                                                                            "No computer"
                                                                        }

                                                                        {" • "}

                                                                        {
                                                                            assignment.location ??
                                                                            "Unknown"
                                                                        }

                                                                    </div>

                                                                </div>

                                                            )
                                                        )}

                                                    </div>

                                                ) : (

                                                    <span
                                                        className="
                inline-flex
                rounded-full
                bg-red-50
                px-3
                py-1
                text-xs
                font-medium
                text-red-600
            "
                                                    >
                                                        No Assignments
                                                    </span>

                                                )}


                                                {/* ADD ANALYST */}

                                                {addingFixture ===
                                                    fixture.game_key
                                                    ? (

                                                        <select
                                                            autoFocus
                                                            value=""
                                                            disabled={
                                                                updating ===
                                                                fixture.id
                                                            }
                                                            onChange={(e) => {

                                                                if (
                                                                    !e.target.value
                                                                ) {
                                                                    return;
                                                                }


                                                                const [
                                                                    analystId,
                                                                    location,
                                                                ] =
                                                                    e.target.value.split(
                                                                        "|"
                                                                    );


                                                                allocate({
                                                                    fixture,
                                                                    analystId:
                                                                        Number(
                                                                            analystId
                                                                        ),
                                                                    location:
                                                                        location ===
                                                                            "Home"
                                                                            ? "Home"
                                                                            : "Office",
                                                                });


                                                                e.target.value =
                                                                    "";

                                                                setAddingFixture(
                                                                    null
                                                                );

                                                            }}
                                                            className="
                    mt-2
                    w-full
                    rounded-lg
                    border
                    border-slate-300
                    bg-white
                    px-2
                    py-1.5
                    text-sm
                "
                                                        >

                                                            <option value="">
                                                                Select Analyst...
                                                            </option>


                                                            {analysts.flatMap(
                                                                analyst => {

                                                                    // Skip analysts already assigned to this fixture
                                                                    const alreadyAssigned =
                                                                        fixture.assignments?.some(
                                                                            a => a.analystId === analyst.id
                                                                        );

                                                                    if (alreadyAssigned) return [];

                                                                    const options =
                                                                        [];


                                                                    if (
                                                                        analyst.homeComputer
                                                                    ) {

                                                                        options.push(

                                                                            <option
                                                                                key={`${analyst.id}-home`}
                                                                                value={`${analyst.id}|Home`}
                                                                            >
                                                                                {
                                                                                    analyst.name
                                                                                }
                                                                                {" "}
                                                                                (Home)
                                                                            </option>

                                                                        );

                                                                    }


                                                                    if (
                                                                        analyst.officeComputer
                                                                    ) {

                                                                        options.push(

                                                                            <option
                                                                                key={`${analyst.id}-office`}
                                                                                value={`${analyst.id}|Office`}
                                                                            >
                                                                                {
                                                                                    analyst.name
                                                                                }
                                                                                {" "}
                                                                                (Office)
                                                                            </option>

                                                                        );

                                                                    }


                                                                    return options;

                                                                }
                                                            )}

                                                        </select>

                                                    )
                                                    : (

                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setAddingFixture(
                                                                    fixture.game_key
                                                                )
                                                            }
                                                            className="
                    mt-2
                    text-sm
                    font-semibold
                    text-blue-600
                    hover:text-blue-700
                    hover:underline
                "
                                                        >
                                                            + Add Analyst
                                                        </button>

                                                    )}

                                            </td>

                                        </tr>

                                    );

                                }
                            )}

                        </tbody>

                    </table>

                </div>

            </div>

        </div>

    );

}


/*
 * STATUS BADGE
 */

function StatusBadge({
    status,
}: {
    status: string;
}) {

    let classes =
        "bg-slate-100 text-slate-700";


    if (
        status ===
        "Downloaded"
    ) {

        classes =
            "bg-green-100 text-green-700";

    }
    else if (
        status ===
        "Downloading"
    ) {

        classes =
            "bg-blue-100 text-blue-700";

    }
    else if (
        status ===
        "Queued"
    ) {

        classes =
            "bg-yellow-100 text-yellow-700";

    }
    else if (
        status ===
        "Failed"
    ) {

        classes =
            "bg-red-100 text-red-700";

    }
    else if (
        status ===
        "Assigned"
    ) {

        classes =
            "bg-purple-100 text-purple-700";

    }


    return (

        <span
            className={`
            inline-flex
            rounded-full
            px-3
            py-1.5
            text-xs
            font-semibold
            ${classes}
            `}
        >
            {status}
        </span>

    );

}


/*
 * SUMMARY CARD
 */

function Card({
    title,
    value,
    colour = "text-slate-900",
}: {
    title: string;
    value: number;
    colour?: string;
}) {

    return (

        <div
            className="
            rounded-xl
            border
            border-slate-200
            bg-white
            p-4
            shadow-sm
            "
        >

            <div
                className="
                text-xs
                uppercase
                tracking-wide
                text-slate-400
                "
            >
                {title}
            </div>


            <div
                className={`
                mt-1
                text-2xl
                font-bold
                ${colour}
                `}
            >
                {value}
            </div>

        </div>

    );

}