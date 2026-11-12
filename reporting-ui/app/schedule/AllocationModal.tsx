"use client";

import { useEffect, useMemo, useState } from "react";
import type { TTGame } from "@/types/ttgame";
import {
    defaultSeasonWeek,
    fixtureSeasons,
    matchesSeasonWeek,
    weeksForSeason,
} from "@/lib/analytics/fixtureSeasonWeeks";
import { seasonWeekOfRow } from "@/lib/analytics/gameWeekIndex";

type AllocationSlot = {
    analystId: number;
    analystName: string;
    date: string;
};

type ApiFixture = {
    id: number;
    game_key: string;
    assignments?: any[];
};

interface AllocationModalProps {
    slot: AllocationSlot;
    games: TTGame[];
    fixtures: ApiFixture[];
    allocating: boolean;
    onClose: () => void;
    onAllocate: (
        fixtureId: number,
        location: "Home" | "Office"
    ) => void;
}

export default function AllocationModal({
    slot,
    games,
    fixtures,
    allocating,
    onClose,
    onAllocate,
}: AllocationModalProps) {

    const [location, setLocation] =
        useState<"Home" | "Office">("Office");

    const [search, setSearch] = useState("");

    const [selectedWeek, setSelectedWeek] = useState<string>("All");

    const [selectedSeason, setSelectedSeason] =
        useState<number | null>(null);

    const dateLabel =
        new Date(
            `${slot.date}T00:00:00`
        ).toLocaleDateString(
            "en-AU",
            {
                weekday: "long",
                day: "numeric",
                month: "long",
            }
        );

    function formatFixtureDate(
        date: string | null | undefined
    ): string {

        if (!date) return "Date TBC";

        const parsed =
            new Date(`${date}T00:00:00`);

        if (isNaN(parsed.getTime())) return "Date TBC";

        return parsed.toLocaleDateString(
            "en-AU",
            {
                weekday: "short",
                day: "numeric",
                month: "short",
            }
        );

    }

    // Map API fixtures by game_key for quick lookup
    const fixturesByGameKey = useMemo(() => {
        const map = new Map<string, ApiFixture>();
        fixtures.forEach(f => {
            if (f.game_key) map.set(f.game_key, f);
        });
        return map;
    }, [fixtures]);

    const seasons = useMemo(() => fixtureSeasons(games), [games]);

    const availableWeeks = useMemo(() => {
        if (selectedSeason == null) return [] as string[];
        return weeksForSeason(games, selectedSeason).map(String);
    }, [games, selectedSeason]);

    // Default to the newest season's last week
    useEffect(() => {
        if (selectedSeason == null) {
            const def = defaultSeasonWeek(games);
            if (def) {
                setSelectedSeason(def.season);
                setSelectedWeek(String(def.week));
            }
        }
    }, [games, selectedSeason]);

    const filteredGames = useMemo(() => {
        let result = games;

        // Season + week filter
        if (selectedSeason != null) {
            result = result.filter(
                g =>
                    selectedWeek === "All"
                        ? seasonWeekOfRow(g)?.season === selectedSeason
                        : matchesSeasonWeek(
                              g,
                              selectedSeason,
                              Number(selectedWeek)
                          )
            );
        }

        // Search filter
        if (search.trim()) {
            const term = search.trim().toLowerCase();
            result = result.filter(g => {
                const home = (g.home_team ?? "").toLowerCase();
                const away = (g.away_team ?? "").toLowerCase();
                const comp = (g.Competition ?? "").toLowerCase();
                const round = (g.Round ?? "").toLowerCase();
                return (
                    home.includes(term) ||
                    away.includes(term) ||
                    comp.includes(term) ||
                    round.includes(term)
                );
            });
        }

        return result;
    }, [games, search, selectedWeek, selectedSeason]);

    return (

        <div
            className="
                fixed
                inset-0
                z-[9999]
                flex
                items-center
                justify-center
                bg-black/50
                p-6
            "
            onClick={onClose}
        >

            <div
                className="
                    w-full
                    max-w-2xl
                    overflow-hidden
                    rounded-xl
                    bg-white
                    shadow-2xl
                "
                onClick={event =>
                    event.stopPropagation()
                }
            >

                {/* HEADER */}

                <div className="
                    flex
                    items-center
                    justify-between
                    border-b
                    border-slate-200
                    px-5
                    py-4
                ">

                    <div>

                        <h2 className="
                            text-lg
                            font-bold
                            text-slate-900
                        ">
                            Allocate Fixture
                        </h2>

                        <p className="
                            mt-1
                            text-sm
                            text-slate-500
                        ">
                            {slot.analystName}
                            {" • "}
                            {dateLabel}
                        </p>

                    </div>


                    <button
                        type="button"
                        onClick={onClose}
                        className="
                            rounded-md
                            px-2
                            py-1
                            text-lg
                            text-slate-400
                            hover:bg-slate-100
                            hover:text-slate-700
                        "
                    >
                        ×
                    </button>

                </div>


                {/* LOCATION */}

                <div className="
                    border-b
                    border-slate-200
                    bg-slate-50
                    px-5
                    py-4
                ">

                    <div className="
                        mb-2
                        text-xs
                        font-semibold
                        uppercase
                        tracking-wide
                        text-slate-500
                    ">
                        Allocation Location
                    </div>


                    <div className="
                        flex
                        gap-2
                    ">

                        <button
                            type="button"
                            onClick={() =>
                                setLocation("Home")
                            }
                            className={`
                                rounded-lg
                                border
                                px-4
                                py-2
                                text-sm
                                font-semibold
                                ${
                                    location === "Home"
                                        ? "border-blue-600 bg-blue-600 text-white"
                                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                                }
                            `}
                        >
                            Home
                        </button>


                        <button
                            type="button"
                            onClick={() =>
                                setLocation("Office")
                            }
                            className={`
                                rounded-lg
                                border
                                px-4
                                py-2
                                text-sm
                                font-semibold
                                ${
                                    location === "Office"
                                        ? "border-blue-600 bg-blue-600 text-white"
                                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                                }
                            `}
                        >
                            Office
                        </button>

                    </div>

                </div>


                {/* SEARCH & WEEK FILTER */}

                <div className="
                    border-b
                    border-slate-200
                    bg-slate-50
                    px-5
                    py-4
                    space-y-3
                ">

                    {/* Search */}
                    <div>
                        <label className="
                            mb-1
                            block
                            text-xs
                            font-semibold
                            uppercase
                            tracking-wide
                            text-slate-500
                        ">
                            Search
                        </label>

                        <input
                            type="text"
                            value={search}
                            onChange={e =>
                                setSearch(e.target.value)
                            }
                            placeholder="Search by team, competition, or round..."
                            className="
                                w-full
                                rounded-lg
                                border
                                border-slate-300
                                bg-white
                                px-3
                                py-2
                                text-sm
                                text-slate-900
                                placeholder:text-slate-400
                                focus:border-blue-500
                                focus:outline-none
                                focus:ring-1
                                focus:ring-blue-500
                            "
                        />
                    </div>

                    {/* Season Selector (only when more than one season) */}
                    {seasons.length > 1 && (
                        <div>
                            <label className="
                                mb-1
                                block
                                text-xs
                                font-semibold
                                uppercase
                                tracking-wide
                                text-slate-500
                            ">
                                Season
                            </label>

                            <select
                                value={selectedSeason ?? ""}
                                onChange={e => {
                                    const s = Number(e.target.value);
                                    const wks = weeksForSeason(games, s);
                                    setSelectedSeason(s);
                                    setSelectedWeek(
                                        wks.length
                                            ? String(wks[wks.length - 1])
                                            : "All"
                                    );
                                }}
                                className="
                                    w-full
                                    rounded-lg
                                    border
                                    border-slate-300
                                    bg-white
                                    px-3
                                    py-2
                                    text-sm
                                    text-slate-900
                                    focus:border-blue-500
                                    focus:outline-none
                                    focus:ring-1
                                    focus:ring-blue-500
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

                    {/* Week Selector */}
                    <div>
                        <label className="
                            mb-1
                            block
                            text-xs
                            font-semibold
                            uppercase
                            tracking-wide
                            text-slate-500
                        ">
                            Week
                        </label>

                        <select
                            value={selectedWeek}
                            onChange={e =>
                                setSelectedWeek(e.target.value)
                            }
                            className="
                                w-full
                                rounded-lg
                                border
                                border-slate-300
                                bg-white
                                px-3
                                py-2
                                text-sm
                                text-slate-900
                                focus:border-blue-500
                                focus:outline-none
                                focus:ring-1
                                focus:ring-blue-500
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


                {/* FIXTURES */}

                <div className="
                    max-h-[400px]
                    overflow-y-auto
                    p-5
                ">

                    {filteredGames.length === 0 ? (

                        <div className="
                            rounded-lg
                            bg-slate-50
                            px-5
                            py-10
                            text-center
                            text-sm
                            text-slate-500
                        ">
                            No fixtures found.
                            {search || selectedWeek !== "All"
                                ? " Try adjusting your search or week filter."
                                : ""}
                        </div>

                    ) : (

                        <div className="space-y-2">

                            <div className="
                                mb-2
                                text-xs
                                text-slate-400
                            ">
                                {filteredGames.length} fixture{filteredGames.length !== 1 ? "s" : ""}
                            </div>

                            {filteredGames.map(
                                (game, index) => {

                                    const apiFixture =
                                        fixturesByGameKey.get(game.game_key);

                                    const alreadyAssigned =
                                        apiFixture
                                            ? Array.isArray(apiFixture.assignments) &&
                                              apiFixture.assignments.length > 0
                                            : false;

                                    const canAllocate = !!apiFixture;

                                    return (

                                        <div
                                            key={game.game_key || index}
                                            className="
                                                flex
                                                items-center
                                                justify-between
                                                gap-4
                                                rounded-lg
                                                border
                                                border-slate-200
                                                px-4
                                                py-3
                                                hover:bg-slate-50
                                            "
                                        >

                                            <div className="min-w-0">

                                                <div className="
                                                    text-[10px]
                                                    font-semibold
                                                    uppercase
                                                    tracking-wide
                                                    text-slate-400
                                                ">
                                                    {game.Competition ?? ""}
                                                    {" • Round "}
                                                    {game.Round ?? ""}
                                                    {" • Week "}
                                                    {game.Week ?? ""}
                                                    {game.expected_day && (
                                                        <>
                                                            {" • "}
                                                            {game.expected_day}
                                                        </>
                                                    )}
                                                </div>


                                                <div className="
                                                    mt-1
                                                    truncate
                                                    text-sm
                                                    font-semibold
                                                    text-slate-900
                                                ">
                                                    {game.home_team ?? ""}
                                                    {" vs "}
                                                    {game.away_team ?? ""}
                                                </div>


                                                <div className="
                                                    mt-1
                                                    text-[11px]
                                                    font-medium
                                                    text-blue-600
                                                ">
                                                    {formatFixtureDate(game.Date)}
                                                </div>


                                                {alreadyAssigned && (
                                                    <div className="
                                                        mt-1
                                                        text-[10px]
                                                        text-slate-500
                                                    ">
                                                        Already assigned
                                                    </div>
                                                )}

                                                {!canAllocate && !alreadyAssigned && (
                                                    <div className="
                                                        mt-1
                                                        text-[10px]
                                                        text-amber-600
                                                    ">
                                                        Not yet imported
                                                    </div>
                                                )}

                                            </div>


                                            <button
                                                type="button"
                                                disabled={
                                                    allocating ||
                                                    alreadyAssigned ||
                                                    !canAllocate
                                                }
                                                onClick={() => {
                                                    if (apiFixture) {
                                                        onAllocate(
                                                            apiFixture.id,
                                                            location
                                                        );
                                                    }
                                                }}
                                                className="
                                                    shrink-0
                                                    rounded-md
                                                    bg-blue-600
                                                    px-4
                                                    py-2
                                                    text-xs
                                                    font-semibold
                                                    text-white
                                                    hover:bg-blue-700
                                                    disabled:cursor-not-allowed
                                                    disabled:bg-slate-300
                                                "
                                            >
                                                {allocating
                                                    ? "Allocating..."
                                                    : alreadyAssigned
                                                        ? "Assigned"
                                                        : !canAllocate
                                                            ? "Not Imported"
                                                            : "Allocate"}
                                            </button>

                                        </div>

                                    );

                                }
                            )}

                        </div>

                    )}

                </div>

            </div>

        </div>

    );
}
