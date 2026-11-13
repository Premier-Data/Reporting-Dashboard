"use client";

import {
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import {
    getAnalysts,
    type Analyst as ApiAnalyst,
} from "@/lib/api/analysts";

import {
    getFixtures,
} from "@/lib/api/fixtures";

import {
    assignFixture,
} from "@/lib/api/assignFixture";

import {
    createDownloadJob,
} from "@/lib/api/downloadJobs";

import {
    loadDeputyApiRoster,
    loadDeputyApiRosterWithSync,
} from "@/lib/data/loadDeputyApiRoster";

import { syncMessage } from "@/lib/data/syncMessage";

import {
    getDeputyTimesheets,
    type DeputyTimesheetRow,
} from "@/lib/api/deputy";

import { useAuth } from "@/components/auth/AuthContext";

import {
    formatAud,
    formatHours2,
} from "@/lib/deputy/format";

import {
    aggregateApprovedTimesheets,
    unmatchedLabel,
} from "@/lib/data/scheduleTimesheets";

import { RefreshCw } from "lucide-react";

import {
    analystRosterKeys,
    rosterIndexKey,
    shiftsForAnalystDay,
} from "@/lib/data/rosterMatch";

import type {
    DeputyRoster,
} from "@/types/deputyRoster";

import type { TTGame } from "@/types/ttgame";
import { supabase } from "@/lib/supabase";
import { mapFixtureWeekTT } from "@/lib/analytics/season";

import AllocationModal from "./AllocationModal";

type ScheduleAssignment = {
    id: number;
    fixtureId: number;
    analystId: number;
    location: "Home" | "Office";
    assignedAt?: string;
    scheduledDate: string;

    fixture: {
        id: number;
        date: string;
        leagueName: string;
        round: string;
        homeTeam: string;
        awayTeam: string;
        status: string;
    };
};

type AllocationSlot = {
    analystId: number;
    analystName: string;
    date: string;
};

type ScheduleAnalyst = {
    id: number;
    name: string;
    email: string | null;
};


type Day = {
    date: Date;
    key: string;
    label: string;
};


type SortKey =
    | "analyst"
    | string;


type FilterStatus =
    | "All"
    | "Available"
    | "Assigned"
    | "Not rostered";


type FixtureFilter =
    | "All"
    | "Has Fixture"
    | "No Fixture";


/*
 * ROSTER MATCH KEYS
 *
 * Shifts now come from the Deputy API, which records the employee's legal
 * name and no email. Roster rows are indexed by email when they have one,
 * otherwise by normalised name, and each analyst is looked up by its email,
 * name and a small name alias (e.g. "Tom" vs "Thomas", "(NEW)" suffixes).
 * See lib/data/rosterMatch.ts.
 */

function formatDateKey(
    date: Date
) {

    const year =
        date.getFullYear();

    const month =
        String(
            date.getMonth() + 1
        ).padStart(
            2,
            "0"
        );

    const day =
        String(
            date.getDate()
        ).padStart(
            2,
            "0"
        );

    return `${year}-${month}-${day}`;

}


function getThursday(
    offset = 0
) {

    const today =
        new Date();

    const date =
        new Date(
            today
        );

    const daysSinceThursday =
        (
            today.getDay() -
            4 +
            7
        ) % 7;

    date.setDate(
        today.getDate() -
        daysSinceThursday +
        offset * 7
    );

    date.setHours(
        0,
        0,
        0,
        0
    );

    return date;

}


function buildDays(
    weekOffset: number
): Day[] {

    const start =
        getThursday(
            weekOffset
        );

    return Array.from(
        {
            length: 7,
        },
        (
            _,
            index
        ) => {

            const date =
                new Date(
                    start
                );

            date.setDate(
                start.getDate() +
                index
            );

            return {

                date,

                key:
                    formatDateKey(
                        date
                    ),

                label:
                    date.toLocaleDateString(
                        "en-AU",
                        {
                            weekday:
                                "short",
                            day:
                                "numeric",
                            month:
                                "short",
                        }
                    ),

            };

        }
    );

}


function getSortRank(
    status: FilterStatus
) {

    if (
        status === "Assigned"
    ) {

        return 1;

    }

    if (
        status === "Available"
    ) {

        return 2;

    }

    if (
        status === "Not rostered"
    ) {

        return 3;

    }

    return 4;

}


export default function SchedulePage() {

    const [
        roster,
        setRoster,
    ] =
        useState<
            DeputyRoster[]
        >([]);


    const [
        analysts,
        setAnalysts,
    ] =
        useState<
            ScheduleAnalyst[]
        >([]);

    // Full analyst records (including home/office computer assignments)
    // from the AutoDownload API — kept separately from `analysts` since
    // ScheduleAnalyst only carries id/name/email. Needed to resolve which
    // computer a download job should be queued against on allocation.
    const [
        fullAnalystData,
        setFullAnalystData,
    ] =
        useState<
            ApiAnalyst[]
        >([]);


    const [
        assignments,
        setAssignments,
    ] =
        useState<
            ScheduleAssignment[]
        >([]);

    const [
        fixtures,
        setFixtures,
    ] =
        useState<any[]>([]);

    const [
        allGames,
        setAllGames,
    ] =
        useState<TTGame[]>([]);

    const [
        allocationSlot,
        setAllocationSlot,
    ] =
        useState<AllocationSlot | null>(null);

    const [
        allocating,
        setAllocating,
    ] =
        useState(false);

    const [
        weekOffset,
        setWeekOffset,
    ] =
        useState(0);


    const [
        loading,
        setLoading,
    ] =
        useState(true);


    const [
        error,
        setError,
    ] =
        useState("");


    const [
        search,
        setSearch,
    ] =
        useState("");


    const [
        statusFilter,
        setStatusFilter,
    ] =
        useState<FilterStatus>(
            "All"
        );


    const [
        fixtureFilter,
        setFixtureFilter,
    ] =
        useState<FixtureFilter>(
            "All"
        );


    const [
        locationFilter,
        setLocationFilter,
    ] =
        useState("All");


    const [
        sortKey,
        setSortKey,
    ] =
        useState<SortKey>(
            "analyst"
        );


    const [
        sortDirection,
        setSortDirection,
    ] =
        useState<
            "asc" | "desc"
        >("asc");


    const days =
        useMemo(
            () =>
                buildDays(
                    weekOffset
                ),
            [
                weekOffset,
            ]
        );


    /*
     * ROSTER FOR VISIBLE WEEK
     *
     * Loaded separately from the rest of the schedule data and scoped
     * to the currently visible week's date range. Deputy roster holds
     * 2000+ rows — fetching everything on every load is unnecessary
     * and slow when only one week is ever shown at a time. Re-runs
     * whenever the visible week changes (Previous / Today / Next).
     */

    const [
        rosterLoading,
        setRosterLoading,
    ] =
        useState(true);

    const [
        rosterError,
        setRosterError,
    ] =
        useState(false);

    const [
        rosterReloadKey,
        setRosterReloadKey,
    ] =
        useState(0);

    // Set ONLY by the "Sync from Deputy" button; consumed (and cleared) by
    // the next roster load. Every other load path leaves it false.
    const syncRequestedRef =
        useRef(false);

    const [
        syncing,
        setSyncing,
    ] =
        useState(false);

    const [
        syncNote,
        setSyncNote,
    ] =
        useState("");

    /*
     * APPROVED TIMESHEETS FOR VISIBLE WEEK
     *
     * Separate from the roster load so a failure here never affects rosters
     * or allocation. Never requests sync; after a manual sync the roster
     * effect bumps timesheetReloadKey once its sync request has returned.
     */

    const [
        timesheets,
        setTimesheets,
    ] =
        useState<DeputyTimesheetRow[]>([]);

    const [
        timesheetLoading,
        setTimesheetLoading,
    ] =
        useState(true);

    const [
        timesheetError,
        setTimesheetError,
    ] =
        useState(false);

    const [
        timesheetReloadKey,
        setTimesheetReloadKey,
    ] =
        useState(0);

    // True when the load follows a sync: keep current rows visible.
    const keepTimesheetsRef =
        useRef(false);

    useEffect(
        () => {

            let cancelled = false;

            async function loadTimesheetsForWeek() {

                const keep =
                    keepTimesheetsRef.current;

                keepTimesheetsRef.current = false;

                if (!keep) {
                    setTimesheetLoading(true);
                }

                try {

                    const rows =
                        await getDeputyTimesheets({
                            from: days[0]?.key,
                            to: days[days.length - 1]?.key,
                        });

                    if (!cancelled) {
                        setTimesheets(rows);
                        setTimesheetError(false);
                    }

                }
                catch (err) {

                    console.error(
                        "Failed loading approved timesheets for week:",
                        err
                    );

                    if (!cancelled) {
                        setTimesheets([]);
                        setTimesheetError(true);
                    }

                }
                finally {

                    if (!cancelled) {
                        setTimesheetLoading(false);
                    }

                }

            }

            loadTimesheetsForWeek();

            return () => {
                cancelled = true;
            };

        },
        [days, timesheetReloadKey]
    );

    useEffect(
        () => {

            let cancelled = false;

            async function loadRosterForWeek() {

                const withSync =
                    syncRequestedRef.current;

                syncRequestedRef.current = false;

                // A sync keeps the current shifts on screen until the new
                // rows arrive; a normal load shows the usual loading hint.
                if (!withSync) {
                    setRosterLoading(true);
                }

                try {

                    const startDate =
                        days[0]?.key;

                    const endDate =
                        days[days.length - 1]?.key;

                    if (withSync) {

                        const result =
                            await loadDeputyApiRosterWithSync({
                                startDate,
                                endDate,
                            });

                        if (!cancelled) {
                            setRoster(result.roster);
                            setRosterError(false);
                            setSyncNote(
                                syncMessage(result.synced)
                            );
                        }

                    }
                    else {

                        const rosterData =
                            await loadDeputyApiRoster({
                                startDate,
                                endDate,
                            });

                        if (!cancelled) {
                            setRoster(rosterData);
                            setRosterError(false);
                        }

                    }

                }
                catch (err) {

                    console.error(
                        "Failed loading Deputy roster for week:",
                        err
                    );

                    // No fallback to legacy data: clear stale shifts and flag
                    // the failure so the page can show a Retry banner.
                    if (!cancelled) {
                        setRoster([]);
                        setRosterError(true);
                    }

                }
                finally {

                    if (!cancelled) {
                        setRosterLoading(false);
                    }

                    // Always release the button, even if the week changed
                    // mid-sync (a cancelled load must not leave it disabled).
                    if (withSync) {
                        setSyncing(false);

                        // The sync-carrying roster request has finished (even
                        // if it failed or the week changed): now re-read
                        // approved timesheets WITHOUT sync, for the current
                        // week, keeping existing rows on screen meanwhile.
                        keepTimesheetsRef.current = true;
                        setTimesheetReloadKey(k => k + 1);
                    }

                }

            }

            loadRosterForWeek();

            return () => {
                cancelled = true;
            };

        },
        [days, rosterReloadKey]
    );


    async function loadSchedule() {

        try {

            setLoading(
                true
            );

            setError("");


            console.log(
                "SCHEDULE: loading analysts..."
            );

            const analystData =
                await getAnalysts();

            console.log(
                "SCHEDULE: analysts loaded:",
                analystData.length
            );


            console.log(
                "SCHEDULE: loading fixtures..."
            );

            const fixtureData =
                await getFixtures();

            console.log(
                "SCHEDULE: fixtures loaded:",
                fixtureData.length
            );


            setFixtures(
                fixtureData
            );

            // Load all games from Supabase TT_Games
            console.log(
                "SCHEDULE: loading TT_Games..."
            );

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
                        .order("game_key")
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

            console.log(
                "SCHEDULE: TT_Games loaded:",
                gamesList.length
            );

            setAnalysts(
                analystData.map(
                    (
                        analyst: ApiAnalyst
                    ) => ({

                        id:
                            analyst.id,

                        name:
                            analyst.name,

                        email:
                            analyst.email ??
                            null,

                    })
                )
            );

            setFullAnalystData(
                analystData
            );


            const scheduleAssignments:
                ScheduleAssignment[] = [];


            for (
                const fixture
                of fixtureData
            ) {

                if (
                    !Array.isArray(
                        fixture.assignments
                    )
                ) {

                    continue;

                }


                for (
                    const assignment
                    of fixture.assignments
                ) {

                    const analystId =
                        Number(
                            assignment.analystId
                        );


                    if (
                        !Number.isFinite(
                            analystId
                        )
                    ) {

                        continue;

                    }


                    scheduleAssignments.push({

                        id:
                            Number(
                                assignment.id
                            ),

                        fixtureId:
                            Number(
                                fixture.id
                            ),

                        analystId,

                        location:
                            assignment.location ??
                            "Unknown",

                        scheduledDate:
                            assignment.scheduledDate,

                        assignedAt:
                            assignment.assignedAt,

                        fixture: {

                            id:
                                Number(
                                    fixture.id
                                ),

                            date:
                                fixture.Date,

                            leagueName:
                                fixture.Competition,

                            round:
                                fixture.Round,

                            homeTeam:
                                fixture.home_team,

                            awayTeam:
                                fixture.away_team,

                            status:
                                fixture.status,

                        },

                    });

                }

            }


            setAssignments(
                scheduleAssignments
            );

        }
        catch (err) {

            console.error(
                "Failed loading schedule:",
                err
            );

            setError(
                "Failed to load schedule."
            );

        }
        finally {

            setLoading(
                false
            );

        }

    }

    async function allocateFixture(
        fixtureId: number,
        location: "Home" | "Office"
    ) {

        if (!allocationSlot) {
            return;
        }

        try {

            setAllocating(
                true
            );

            await assignFixture(
                fixtureId,
                allocationSlot.analystId,
                location,
                allocationSlot.date
            );

            // Queue the actual download on the desktop agent. Assigning
            // alone only records who is responsible for the fixture —
            // the agent polls /api/downloadjobs, not fixture assignments,
            // so without this the download never starts and the status
            // never advances past "Pending".
            const fixture =
                fixtures.find(
                    (f: any) =>
                        Number(f.id) === fixtureId
                );

            const fullAnalyst =
                fullAnalystData.find(
                    a =>
                        a.id === allocationSlot.analystId
                );

            const computer =
                location === "Home"
                    ? fullAnalyst?.homeComputer
                    : fullAnalyst?.officeComputer;

            if (fixture?.videoURL && computer) {

                await createDownloadJob({
                    gameKey: fixture.game_key,
                    videoUrl: fixture.videoURL,
                    year: (fixture.Date ?? "").substring(0, 4),
                    leagueName: fixture.Competition,
                    analystId: allocationSlot.analystId,
                    computerId: computer.id,
                    assignmentLocation: location,
                    fileSizeBytes: fixture.fileSizeBytes ?? null,
                });

            }

            await loadSchedule();

            setAllocationSlot(
                null
            );

        }
        catch (err) {

            console.error(
                "Failed to allocate fixture:",
                err
            );

            alert(
                err instanceof Error
                    ? err.message
                    : "Failed to allocate fixture."
            );

        }
        finally {

            setAllocating(
                false
            );

        }

    }

    useEffect(
        () => {

            loadSchedule();

        },
        []
    );

    /*
* FIXTURES BY DAY
*/

    const fixturesByDay =
        useMemo(
            () => {

                const map =
                    new Map<
                        string,
                        any[]
                    >();

                for (
                    const fixture
                    of fixtures
                ) {

                    if (
                        !fixture.Date
                    ) {
                        continue;
                    }

                    const date =
                        new Date(
                            fixture.Date
                        );

                    const key =
                        formatDateKey(
                            date
                        );

                    const existing =
                        map.get(
                            key
                        ) ??
                        [];

                    existing.push(
                        fixture
                    );

                    map.set(
                        key,
                        existing
                    );

                }

                return map;

            },
            [
                fixtures,
            ]
        );

    /*
* ROSTER LOOKUP
*/

    const rosterByAnalystAndDay =
        useMemo(
            () => {

                const map =
                    new Map<
                        string,
                        DeputyRoster[]
                    >();

                for (
                    const shift
                    of roster
                ) {

                    const key =
                        `${rosterIndexKey(shift.email, shift.employee_name)}|${shift.shift_date}`;

                    const existing =
                        map.get(
                            key
                        ) ??
                        [];

                    existing.push(
                        shift
                    );

                    map.set(
                        key,
                        existing
                    );

                }

                return map;

            },
            [
                roster,
            ]
        );


    /*
     * ASSIGNMENT LOOKUP
     */

    const assignmentsByAnalystAndDay =
        useMemo(
            () => {

                const map =
                    new Map<
                        string,
                        ScheduleAssignment[]
                    >();

                for (
                    const assignment
                    of assignments
                ) {

                    if (
                        !assignment.fixture
                    ) {
                        continue;
                    }

                    const date =
                        new Date(
                            assignment.scheduledDate
                        );

                    const key =
                        `${assignment.analystId}|${formatDateKey(date)}`;

                    const existing =
                        map.get(
                            key
                        ) ??
                        [];

                    existing.push(
                        assignment
                    );

                    map.set(
                        key,
                        existing
                    );

                }

                return map;

            },
            [
                assignments,
            ]
        );

    /*
     * AVAILABLE LOCATIONS
     */

    const availableLocations =
        useMemo(
            () => {

                const locations =
                    new Set<string>();


                for (
                    const shift
                    of roster
                ) {

                    if (
                        shift.location
                    ) {

                        locations.add(
                            shift.location
                        );

                    }

                }


                for (
                    const assignment
                    of assignments
                ) {

                    if (
                        assignment.location
                    ) {

                        locations.add(
                            assignment.location
                        );

                    }

                }


                return Array.from(
                    locations
                ).sort();

            },
            [
                roster,
                assignments,
            ]
        );


    /*
     * ANALYST DAY STATUS
     */

    function getDayStatus(
        analyst: ScheduleAnalyst,
        dayKey: string
    ): FilterStatus {

        const shifts =
            shiftsForAnalystDay(
                rosterByAnalystAndDay,
                analyst.email,
                analyst.name,
                dayKey
            );


        const games =
            assignmentsByAnalystAndDay.get(
                `${analyst.id}|${dayKey}`
            ) ??
            [];


        if (
            games.length > 0
        ) {

            return "Assigned";

        }


        if (
            shifts.length > 0
        ) {

            return "Available";

        }


        return "Not rostered";

    }


    /*
     * ANALYST FILTERING + SORTING
     */

    const filteredAnalysts =
        useMemo(
            () => {

                let result =
                    [...analysts];


                const searchValue =
                    search
                        .trim()
                        .toLowerCase();


                if (
                    searchValue
                ) {

                    result =
                        result.filter(
                            analyst =>
                                analyst.name
                                    .toLowerCase()
                                    .includes(
                                        searchValue
                                    ) ||
                                (
                                    analyst.email ??
                                    ""
                                )
                                    .toLowerCase()
                                    .includes(
                                        searchValue
                                    )
                        );

                }


                if (
                    statusFilter !==
                    "All"
                ) {

                    result =
                        result.filter(
                            analyst => {

                                return days.some(
                                    day =>
                                        getDayStatus(
                                            analyst,
                                            day.key
                                        ) ===
                                        statusFilter
                                );

                            }
                        );

                }


                if (
                    fixtureFilter !==
                    "All"
                ) {

                    result =
                        result.filter(
                            analyst => {

                                const hasFixture =
                                    days.some(
                                        day => {

                                            const games =
                                                assignmentsByAnalystAndDay.get(
                                                    `${analyst.id}|${day.key}`
                                                ) ??
                                                [];

                                            return (
                                                games.length >
                                                0
                                            );

                                        }
                                    );


                                return fixtureFilter ===
                                    "Has Fixture"
                                    ? hasFixture
                                    : !hasFixture;

                            }
                        );

                }


                if (
                    locationFilter !==
                    "All"
                ) {

                    result =
                        result.filter(
                            analyst => {

                                const hasRosterLocation =
                                    roster.some(
                                        shift =>
                                            analystRosterKeys(analyst.email, analyst.name).includes(
                                                rosterIndexKey(shift.email, shift.employee_name)
                                            ) &&
                                            shift.location ===
                                            locationFilter
                                    );


                                const hasAssignmentLocation =
                                    assignments.some(
                                        assignment =>
                                            assignment.analystId ===
                                            analyst.id &&
                                            assignment.location ===
                                            locationFilter
                                    );


                                return (
                                    hasRosterLocation ||
                                    hasAssignmentLocation
                                );

                            }
                        );

                }


                result.sort(
                    (
                        a,
                        b
                    ) => {

                        if (
                            sortKey ===
                            "analyst"
                        ) {

                            const comparison =
                                a.name.localeCompare(
                                    b.name
                                );


                            return sortDirection ===
                                "asc"
                                ? comparison
                                : -comparison;

                        }


                        const dayKey =
                            sortKey;


                        const aStatus =
                            getDayStatus(
                                a,
                                dayKey
                            );


                        const bStatus =
                            getDayStatus(
                                b,
                                dayKey
                            );


                        const statusComparison =
                            getSortRank(
                                aStatus
                            ) -
                            getSortRank(
                                bStatus
                            );


                        if (
                            statusComparison !==
                            0
                        ) {

                            return sortDirection ===
                                "asc"
                                ? statusComparison
                                : -statusComparison;

                        }


                        const aGames =
                            assignmentsByAnalystAndDay.get(
                                `${a.id}|${dayKey}`
                            ) ??
                            [];


                        const bGames =
                            assignmentsByAnalystAndDay.get(
                                `${b.id}|${dayKey}`
                            ) ??
                            [];


                        const gameComparison =
                            aGames.length -
                            bGames.length;


                        if (
                            gameComparison !==
                            0
                        ) {

                            return sortDirection ===
                                "asc"
                                ? gameComparison
                                : -gameComparison;

                        }


                        return a.name.localeCompare(
                            b.name
                        );

                    }
                );


                return result;

            },
            [
                analysts,
                search,
                statusFilter,
                fixtureFilter,
                locationFilter,
                sortKey,
                sortDirection,
                days,
                rosterByAnalystAndDay,
                assignmentsByAnalystAndDay,
                roster,
                assignments,
            ]
        );


    /*
     * SUMMARY
     */

    const summary =
        useMemo(
            () => {

                let available = 0;
                let assigned = 0;
                let notRostered = 0;


                for (
                    const analyst
                    of analysts
                ) {

                    const statuses =
                        days.map(
                            day =>
                                getDayStatus(
                                    analyst,
                                    day.key
                                )
                        );


                    if (
                        statuses.includes(
                            "Assigned"
                        )
                    ) {

                        assigned++;

                    }
                    else if (
                        statuses.includes(
                            "Available"
                        )
                    ) {

                        available++;

                    }
                    else {

                        notRostered++;

                    }

                }


                return {

                    analysts:
                        analysts.length,

                    available,

                    assigned,

                    notRostered,

                };

            },
            [
                analysts,
                days,
                rosterByAnalystAndDay,
                assignmentsByAnalystAndDay,
            ]
        );


    /*
     * SORT
     */

    function handleSort(
        key: SortKey
    ) {

        if (
            sortKey ===
            key
        ) {

            setSortDirection(
                current =>
                    current ===
                        "asc"
                        ? "desc"
                        : "asc"
            );

        }
        else {

            setSortKey(
                key
            );

            setSortDirection(
                "asc"
            );

        }

    }


    function sortArrow(
        key: SortKey
    ) {

        if (
            sortKey !==
            key
        ) {

            return "↕";

        }


        return sortDirection ===
            "asc"
            ? "↑"
            : "↓";

    }


    function clearFilters() {

        setSearch("");

        setStatusFilter(
            "All"
        );

        setFixtureFilter(
            "All"
        );

        setLocationFilter(
            "All"
        );

    }


    // Pay is shown only to users who may open the Deputy API page. This is
    // UI-level gating only (false while the session is still loading).
    const { hasAccess } = useAuth();
    const canSeePay = hasAccess("deputy-api");

    const approved = useMemo(
        () => aggregateApprovedTimesheets(
            timesheets,
            days.map(d => d.key),
            analysts
        ),
        [timesheets, days, analysts]
    );

    const hasFilters =
        search !== "" ||
        statusFilter !== "All" ||
        fixtureFilter !== "All" ||
        locationFilter !== "All";


    if (loading) {

        return (

            <div className="
                min-h-screen
                bg-slate-50
                p-8
            ">

                Loading schedule...

            </div>

        );

    }


    return (

        <div className="
            min-h-screen
            bg-slate-50
            p-5
        ">

            {/* HEADER */}

            <div className="
                mb-4
                flex
                items-center
                justify-between
            ">

                <div>

                    <h1 className="
                        text-2xl
                        font-bold
                        text-slate-900
                    ">
                        Schedule
                    </h1>

                    <p className="
                        mt-0.5
                        text-xs
                        text-slate-500
                    ">
                        Analyst roster and fixture allocation
                    </p>

                </div>


                <div className="
                    flex
                    items-center
                    gap-1.5
                ">

                    {rosterLoading && (

                        <span className="
                            mr-1
                            text-xs
                            text-slate-400
                        ">
                            Loading shifts...
                        </span>

                    )}

                    {timesheetLoading && (

                        <span className="
                            mr-1
                            text-xs
                            text-slate-400
                        ">
                            Loading approved shifts...
                        </span>

                    )}

                    {syncNote && (

                        <span
                            role="status"
                            className="
                                mr-1
                                max-w-xs
                                text-xs
                                text-slate-500
                            "
                        >
                            {syncNote}
                        </span>

                    )}

                    <button
                        type="button"
                        disabled={syncing}
                        onClick={() => {
                            if (syncing) return;
                            syncRequestedRef.current = true;
                            setSyncing(true);
                            setSyncNote("");
                            setRosterReloadKey(
                                current =>
                                    current + 1
                            );
                        }}
                        className="
                            mr-2
                            inline-flex
                            items-center
                            gap-1.5
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-1.5
                            text-xs
                            font-medium
                            text-slate-700
                            hover:bg-slate-50
                            disabled:cursor-not-allowed
                            disabled:opacity-60
                        "
                    >
                        <RefreshCw
                            className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`}
                            aria-hidden="true"
                        />
                        {syncing ? "Syncing..." : "Sync from Deputy"}
                    </button>

                    <button
                        type="button"
                        onClick={() =>
                            setWeekOffset(
                                current =>
                                    current - 1
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-1.5
                            text-xs
                            font-medium
                            text-slate-700
                            hover:bg-slate-50
                        "
                    >
                        ← Previous
                    </button>


                    <button
                        type="button"
                        onClick={() =>
                            setWeekOffset(
                                0
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-1.5
                            text-xs
                            font-medium
                            text-slate-700
                            hover:bg-slate-50
                        "
                    >
                        Today
                    </button>


                    <button
                        type="button"
                        onClick={() =>
                            setWeekOffset(
                                current =>
                                    current + 1
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-1.5
                            text-xs
                            font-medium
                            text-slate-700
                            hover:bg-slate-50
                        "
                    >
                        Next →
                    </button>

                </div>

            </div>


            {/* ROSTER LOAD ERROR */}

            {rosterError && (

                <div
                    role="alert"
                    className="
                        mb-4
                        flex
                        items-center
                        justify-between
                        rounded-lg
                        border
                        border-red-200
                        bg-red-50
                        px-3
                        py-2
                        text-xs
                        text-red-700
                    "
                >
                    <span>
                        Could not load shifts from Deputy. Shifts shown as
                        &quot;Not rostered&quot; may be wrong until this loads.
                    </span>

                    <button
                        type="button"
                        onClick={() =>
                            setRosterReloadKey(
                                current =>
                                    current + 1
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-red-300
                            bg-white
                            px-3
                            py-1
                            font-medium
                            text-red-700
                            hover:bg-red-100
                        "
                    >
                        Retry
                    </button>
                </div>

            )}

            {/* APPROVED TIMESHEETS LOAD ERROR (non-blocking) */}

            {timesheetError && (

                <div
                    role="alert"
                    className="
                        mb-4
                        flex
                        items-center
                        justify-between
                        rounded-lg
                        border
                        border-amber-200
                        bg-amber-50
                        px-3
                        py-2
                        text-xs
                        text-amber-800
                    "
                >
                    <span>
                        Could not load approved shifts. Rostered shifts and
                        allocation still work.
                    </span>

                    <button
                        type="button"
                        onClick={() =>
                            setTimesheetReloadKey(
                                current =>
                                    current + 1
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-amber-300
                            bg-white
                            px-3
                            py-1
                            font-medium
                            text-amber-800
                            hover:bg-amber-100
                        "
                    >
                        Retry
                    </button>
                </div>

            )}

            {/* FILTERS */}

            <div className="
                mb-4
                rounded-lg
                border
                border-slate-200
                bg-white
                p-3
            ">

                <div className="
                    flex
                    flex-wrap
                    items-center
                    gap-2
                ">

                    <div className="
                        min-w-[230px]
                        flex-1
                    ">

                        <input
                            value={
                                search
                            }
                            onChange={e =>
                                setSearch(
                                    e.target.value
                                )
                            }
                            placeholder="Search analyst..."
                            className="
                                w-full
                                rounded-md
                                border
                                border-slate-300
                                bg-white
                                px-3
                                py-2
                                text-sm
                                outline-none
                                focus:border-blue-500
                                focus:ring-1
                                focus:ring-blue-500
                            "
                        />

                    </div>


                    <select
                        value={
                            statusFilter
                        }
                        onChange={e =>
                            setStatusFilter(
                                e.target.value as FilterStatus
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-2
                            text-sm
                            text-slate-700
                        "
                    >

                        <option value="All">
                            Status: All
                        </option>

                        <option value="Available">
                            Available
                        </option>

                        <option value="Assigned">
                            Assigned
                        </option>

                        <option value="Not rostered">
                            Not rostered
                        </option>

                    </select>


                    <select
                        value={
                            fixtureFilter
                        }
                        onChange={e =>
                            setFixtureFilter(
                                e.target.value as FixtureFilter
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-2
                            text-sm
                            text-slate-700
                        "
                    >

                        <option value="All">
                            Fixture: All
                        </option>

                        <option value="Has Fixture">
                            Has Fixture
                        </option>

                        <option value="No Fixture">
                            No Fixture
                        </option>

                    </select>


                    <select
                        value={
                            locationFilter
                        }
                        onChange={e =>
                            setLocationFilter(
                                e.target.value
                            )
                        }
                        className="
                            rounded-md
                            border
                            border-slate-300
                            bg-white
                            px-3
                            py-2
                            text-sm
                            text-slate-700
                        "
                    >

                        <option value="All">
                            Location: All
                        </option>


                        {availableLocations.map(
                            location => (

                                <option
                                    key={
                                        location
                                    }
                                    value={
                                        location
                                    }
                                >
                                    {
                                        location
                                    }
                                </option>

                            )
                        )}

                    </select>


                    {hasFilters && (

                        <button
                            type="button"
                            onClick={
                                clearFilters
                            }
                            className="
                                rounded-md
                                px-3
                                py-2
                                text-sm
                                font-medium
                                text-blue-600
                                hover:bg-blue-50
                            "
                        >
                            Clear filters
                        </button>

                    )}

                </div>

            </div>


            {/* SUMMARY */}

            <div className="
                mb-4
                grid
                grid-cols-4
                gap-3
            ">

                <div className="
                    rounded-lg
                    border
                    border-slate-200
                    bg-white
                    px-4
                    py-3
                ">

                    <div className="
                        text-[10px]
                        font-semibold
                        uppercase
                        tracking-wide
                        text-slate-400
                    ">
                        Analysts
                    </div>

                    <div className="
                        mt-0.5
                        text-xl
                        font-bold
                        text-slate-900
                    ">
                        {
                            summary.analysts
                        }
                    </div>

                </div>


                <div className="
                    rounded-lg
                    border
                    border-slate-200
                    bg-white
                    px-4
                    py-3
                ">

                    <div className="
                        text-[10px]
                        font-semibold
                        uppercase
                        tracking-wide
                        text-slate-400
                    ">
                        Available
                    </div>

                    <div className="
                        mt-0.5
                        text-xl
                        font-bold
                        text-emerald-600
                    ">
                        {
                            summary.available
                        }
                    </div>

                </div>


                <div className="
                    rounded-lg
                    border
                    border-slate-200
                    bg-white
                    px-4
                    py-3
                ">

                    <div className="
                        text-[10px]
                        font-semibold
                        uppercase
                        tracking-wide
                        text-slate-400
                    ">
                        Assigned
                    </div>

                    <div className="
                        mt-0.5
                        text-xl
                        font-bold
                        text-blue-600
                    ">
                        {
                            summary.assigned
                        }
                    </div>

                </div>


                <div className="
                    rounded-lg
                    border
                    border-slate-200
                    bg-white
                    px-4
                    py-3
                ">

                    <div className="
                        text-[10px]
                        font-semibold
                        uppercase
                        tracking-wide
                        text-slate-400
                    ">
                        Not Rostered
                    </div>

                    <div className="
                        mt-0.5
                        text-xl
                        font-bold
                        text-slate-400
                    ">
                        {
                            summary.notRostered
                        }
                    </div>

                </div>

            </div>


            {/* RESULTS COUNT */}

            <div className="
                mb-2
                flex
                items-center
                justify-between
                text-xs
                text-slate-500
            ">

                <span>
                    Showing{" "}
                    <strong className="text-slate-700">
                        {
                            filteredAnalysts.length
                        }
                    </strong>{" "}
                    of{" "}
                    <strong className="text-slate-700">
                        {
                            analysts.length
                        }
                    </strong>{" "}
                    analysts
                </span>


                <span>
                    Click a column header to sort
                </span>

            </div>


            {/* SCHEDULE */}

            <div className="
                overflow-auto
                rounded-lg
                border
                border-slate-200
                bg-white
                shadow-sm
            ">

                <table className="
                    w-full
                    min-w-[1300px]
                    border-collapse
                ">

                    <thead>

                        <tr>

                            {/* ANALYST HEADER */}

                            <th className="
                                sticky
                                left-0
                                z-30
                                w-[210px]
                                border-b
                                border-r
                                border-slate-700
                                bg-slate-900
                                p-2
                                text-left
                            ">

                                <button
                                    type="button"
                                    onClick={() =>
                                        handleSort(
                                            "analyst"
                                        )
                                    }
                                    className="
                                        flex
                                        w-full
                                        items-center
                                        justify-between
                                        text-xs
                                        font-semibold
                                        text-white
                                    "
                                >

                                    Analyst

                                    <span className="
                                        ml-2
                                        text-slate-400
                                    ">
                                        {
                                            sortArrow(
                                                "analyst"
                                            )
                                        }
                                    </span>

                                </button>

                            </th>


                            {/* DAY HEADERS */}

                            {days.map(
                                day => (

                                    <th
                                        key={
                                            day.key
                                        }
                                        className="
                                            min-w-[155px]
                                            border-b
                                            border-slate-700
                                            bg-slate-900
                                            p-2
                                            text-center
                                        "
                                    >

                                        <button
                                            type="button"
                                            onClick={() =>
                                                handleSort(
                                                    day.key
                                                )
                                            }
                                            className="
                                                flex
                                                w-full
                                                items-center
                                                justify-center
                                                gap-1
                                                text-xs
                                                font-semibold
                                                text-white
                                            "
                                        >

                                            {
                                                day.label
                                            }

                                            <span className="
                                                text-slate-400
                                            ">
                                                {
                                                    sortArrow(
                                                        day.key
                                                    )
                                                }
                                            </span>

                                        </button>

                                    </th>

                                )
                            )}

                        </tr>

                    </thead>


                    <tbody>

                        {/* DAILY TOTAL (APPROVED) - all approved shifts, unaffected by filters */}

                        <tr className="border-b border-slate-200">

                            <td className="
                                sticky
                                left-0
                                z-20
                                border-r
                                border-slate-200
                                bg-slate-100
                                px-3
                                py-2
                                align-top
                            ">
                                <div className="text-sm font-semibold text-slate-900">
                                    Daily total (approved)
                                </div>

                                <div className="mt-0.5 text-[10px] text-slate-500">
                                    Week: {formatHours2(approved.week.hours)} h
                                    {" · "}
                                    {approved.week.count}{" "}
                                    {approved.week.count === 1 ? "shift" : "shifts"}
                                    {canSeePay && (
                                        <>{" · "}{formatAud(approved.week.cost)}</>
                                    )}
                                </div>
                            </td>

                            {days.map(
                                day => {

                                    const total =
                                        approved.dailyTotals.get(day.key);

                                    return (

                                        <td
                                            key={`total-${day.key}`}
                                            className="
                                                border-r
                                                border-slate-200
                                                bg-slate-100
                                                p-1.5
                                                text-center
                                                align-top
                                            "
                                        >
                                            {total && total.count > 0 ? (
                                                <div
                                                    title={
                                                        total.unmatchedCount > 0
                                                            ? unmatchedLabel(total.unmatchedCount)
                                                            : undefined
                                                    }
                                                >
                                                    <div className="text-xs font-semibold text-slate-800">
                                                        {formatHours2(total.hours)} h
                                                    </div>

                                                    <div className="text-[10px] text-slate-600">
                                                        {total.count}{" "}
                                                        {total.count === 1 ? "shift" : "shifts"}
                                                    </div>

                                                    {canSeePay && (
                                                        <div className="text-[10px] font-semibold text-slate-700">
                                                            {formatAud(total.cost)}
                                                        </div>
                                                    )}

                                                    {total.unmatchedCount > 0 && (
                                                        <div className="mt-0.5 text-[9px] text-slate-400">
                                                            {unmatchedLabel(total.unmatchedCount)}
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-xs text-slate-400">
                                                    —
                                                </span>
                                            )}
                                        </td>

                                    );

                                }
                            )}

                        </tr>

                        {filteredAnalysts.map(
                            analyst => (

                                <tr
                                    key={
                                        analyst.id
                                    }
                                    className="
                                        border-b
                                        border-slate-100
                                        last:border-0
                                    "
                                >

                                    {/* ANALYST */}

                                    <td className="
                                        sticky
                                        left-0
                                        z-20
                                        border-r
                                        border-slate-200
                                        bg-white
                                        px-3
                                        py-2
                                        align-top
                                    ">

                                        <div className="
                                            text-sm
                                            font-semibold
                                            text-slate-900
                                        ">
                                            {
                                                analyst.name
                                            }
                                        </div>


                                        {analyst.email && (

                                            <div className="
                                                mt-0.5
                                                truncate
                                                text-[10px]
                                                text-slate-400
                                            ">
                                                {
                                                    analyst.email
                                                }
                                            </div>

                                        )}

                                    </td>


                                    {/* DAYS */}

                                    {days.map(
                                        day => {

                                            const shifts =
                                                shiftsForAnalystDay(
                                                    rosterByAnalystAndDay,
                                                    analyst.email,
                                                    analyst.name,
                                                    day.key
                                                );


                                            const games =
                                                assignmentsByAnalystAndDay.get(
                                                    `${analyst.id}|${day.key}`
                                                ) ??
                                                [];


                                            const status =
                                                getDayStatus(
                                                    analyst,
                                                    day.key
                                                );


                                            const available =
                                                shifts.length >
                                                0;

                                            const approvedCell =
                                                approved.cells.get(
                                                    `${analyst.id}|${day.key}`
                                                );


                                            return (

                                                <td
                                                    key={`${analyst.id}-${day.key}`}
                                                    className="
        border-r
        border-slate-100
        p-1.5
        align-top
         "
                                                >

                                                    <div
                                                        onClick={() => {

                                                            if (
                                                                available &&
                                                                games.length === 0
                                                            ) {

                                                                setAllocationSlot({
                                                                    analystId:
                                                                        analyst.id,

                                                                    analystName:
                                                                        analyst.name,

                                                                    date:
                                                                        day.key,
                                                                });

                                                            }

                                                        }}
                                                        className={`
        min-h-[72px]
        rounded-md
        p-1.5
        ${status === "Assigned"
                                                                ? "bg-blue-50"
                                                                : status === "Available"
                                                                    ? "cursor-pointer bg-emerald-50 hover:bg-emerald-100"
                                                                    : "bg-slate-50"
                                                            }
         `}
                                                    >

                                                        {/* ASSIGNED FIXTURES */}

                                                        {games.map(
                                                            assignment => (

                                                                <div
                                                                    key={
                                                                        assignment.id
                                                                    }
                                                                    className="
                                                                        mb-1
                                                                        rounded-md
                                                                        border
                                                                        border-blue-200
                                                                        bg-blue-600
                                                                        px-2
                                                                        py-1.5
                                                                        text-white
                                                                    "
                                                                >

                                                                    <div className="
                                                                        truncate
                                                                        text-[10px]
                                                                        font-semibold
                                                                        leading-tight
                                                                    ">

                                                                        {
                                                                            assignment.fixture.homeTeam
                                                                        }

                                                                        {" vs "}

                                                                        {
                                                                            assignment.fixture.awayTeam
                                                                        }

                                                                    </div>


                                                                    <div className="
                                                                        mt-0.5
                                                                        flex
                                                                        items-center
                                                                        justify-between
                                                                        gap-1
                                                                        text-[9px]
                                                                        text-blue-100
                                                                    ">

                                                                        <span>
                                                                            {
                                                                                assignment.location
                                                                            }
                                                                        </span>

                                                                        <span>
                                                                            {
                                                                                assignment.fixture.status
                                                                            }
                                                                        </span>

                                                                    </div>

                                                                </div>

                                                            )
                                                        )}


                                                        {/* APPROVED (ACTUAL) SHIFTS */}

                                                        {approvedCell && (

                                                            <div className="
                                                                mt-1
                                                                rounded-md
                                                                border
                                                                border-emerald-200
                                                                bg-white
                                                                px-2
                                                                py-1
                                                                text-[10px]
                                                                leading-tight
                                                            ">

                                                                <div className="
                                                                    flex
                                                                    items-center
                                                                    gap-1
                                                                    text-[9px]
                                                                    font-semibold
                                                                    text-emerald-700
                                                                ">
                                                                    <span>✓ Approved</span>
                                                                    {approvedCell.hasLeave && (
                                                                        <span className="rounded bg-amber-100 px-1 text-amber-800">
                                                                            Leave
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {approvedCell.entries.map(
                                                                    entry => (

                                                                        <div
                                                                            key={entry.id}
                                                                            className="font-semibold text-slate-700"
                                                                        >
                                                                            {entry.start ?? "—"}
                                                                            {" - "}
                                                                            {entry.end ?? "—"}
                                                                        </div>

                                                                    )
                                                                )}

                                                                <div className="mt-0.5 text-slate-600">
                                                                    {formatHours2(approvedCell.hours)} h
                                                                    {canSeePay && (
                                                                        <>{" · "}{formatAud(approvedCell.cost)}</>
                                                                    )}
                                                                </div>

                                                                {!available && (
                                                                    <div className="mt-0.5 text-[9px] text-slate-400">
                                                                        unrostered
                                                                    </div>
                                                                )}

                                                            </div>

                                                        )}


                                                        {/* ROSTER SHIFT (muted when approved shifts exist) */}

                                                        {available && approvedCell && (

                                                            <div className="mt-1 text-[9px] text-slate-400">
                                                                {shifts.map(
                                                                    (
                                                                        shift,
                                                                        index
                                                                    ) => (

                                                                        <div
                                                                            key={
                                                                                `${shift.roster_key}-${index}`
                                                                            }
                                                                        >
                                                                            Rostered{" "}
                                                                            {shift.start_time ?? "—"}
                                                                            {" - "}
                                                                            {shift.end_time ?? "—"}
                                                                        </div>

                                                                    )
                                                                )}
                                                            </div>

                                                        )}


                                                        {/* ROSTER SHIFT */}

                                                        {available && !approvedCell && (

                                                            <div className="
                                                                mt-1
                                                                rounded-md
                                                                border
                                                                border-slate-200
                                                                bg-white
                                                                px-2
                                                                py-1
                                                            ">

                                                                {shifts.map(
                                                                    (
                                                                        shift,
                                                                        index
                                                                    ) => (

                                                                        <div
                                                                            key={
                                                                                `${shift.roster_key}-${index}`
                                                                            }
                                                                            className="
                                                                                text-[10px]
                                                                                leading-tight
                                                                            "
                                                                        >

                                                                            <div className="
                                                                                font-semibold
                                                                                text-slate-700
                                                                            ">

                                                                                {
                                                                                    shift.start_time ??
                                                                                    "—"
                                                                                }

                                                                                {" - "}

                                                                                {
                                                                                    shift.end_time ??
                                                                                    "—"
                                                                                }

                                                                            </div>


                                                                            <div className="
                                                                                mt-0.5
                                                                                truncate
                                                                                text-[9px]
                                                                                text-slate-400
                                                                            ">

                                                                                {
                                                                                    shift.area_name ??
                                                                                    shift.location ??
                                                                                    "Unknown"
                                                                                }

                                                                            </div>

                                                                        </div>

                                                                    )
                                                                )}

                                                            </div>

                                                        )}


                                                        {/* AVAILABLE / ALLOCATE */}

                                                        {available &&
                                                            games.length === 0 && (

                                                                <div className="
            mt-1
            text-center
            text-[9px]
            font-semibold
            text-emerald-600
        ">
                                                                    Available · Click to Allocate
                                                                </div>

                                                            )}
                                                        {/* NOT ROSTERED */}

                                                        {!available &&
                                                            !approvedCell &&
                                                            games.length === 0 && (

                                                                <div className="
                                                                flex
                                                                min-h-[60px]
                                                                items-center
                                                                justify-center
                                                                text-[9px]
                                                                font-medium
                                                                text-slate-300
                                                            ">
                                                                    Not rostered
                                                                </div>

                                                            )}

                                                    </div>

                                                </td>

                                            );

                                        }
                                    )}

                                </tr>

                            )
                        )}


                        {filteredAnalysts.length ===
                            0 && (

                                <tr>

                                    <td
                                        colSpan={
                                            days.length + 1
                                        }
                                        className="
                                        px-6
                                        py-12
                                        text-center
                                        text-sm
                                        text-slate-400
                                    "
                                    >
                                        No analysts match the current filters.
                                    </td>

                                </tr>

                            )}

                    </tbody>

                </table>

            </div>


            {allocationSlot ? (

                <AllocationModal
                    slot={
                        allocationSlot
                    }

                    games={allGames}

                    fixtures={fixtures}

                    allocating={
                        allocating
                    }

                    onClose={() =>
                        setAllocationSlot(
                            null
                        )
                    }

                    onAllocate={
                        allocateFixture
                    }
                />

            ) : null}


        </div>

    );

}