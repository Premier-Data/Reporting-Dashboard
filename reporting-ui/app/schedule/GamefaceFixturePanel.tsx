"use client";

import { useMemo, useState } from "react";
import type { CompFixtureRow } from "@/lib/api/compFixtures";
import type { GamefaceAllocation } from "@/lib/api/gamefaceDeputy";
import { competitionOptions, filterFixtures } from "@/lib/deputy/gamefaceFixtures";
import { GAMEFACE_FIXTURE_DND_TYPE } from "./GamefaceShiftDropZone";

export function sortFixtures<T extends Pick<CompFixtureRow, "fixture_date" | "fixture_time" | "home_team">>(
    fixtures: T[]
): T[] {
    return [...fixtures].sort(
        (a, b) =>
            (a.fixture_date ?? "").localeCompare(b.fixture_date ?? "") ||
            (a.fixture_time ?? "").localeCompare(b.fixture_time ?? "") ||
            a.home_team.localeCompare(b.home_team)
    );
}

/** Formats a yyyy-mm-dd calendar date as dd/mm/yyyy without time zone conversion. */
export function formatFixtureDate(date: string | null | undefined): string {
    if (!date) return "TBC";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : date;
}
type Props = {
    fixtures: CompFixtureRow[];
    byFixtureId: Map<string, GamefaceAllocation>;
    loading?: boolean;
    /** Allow dragging Available fixtures onto shifts. */
    draggable?: boolean;
};

/** Available fixtures can be dragged onto a shift to allocate. */
export default function GamefaceFixturePanel({ fixtures, byFixtureId, loading, draggable }: Props) {
    const [competition, setCompetition] = useState("all");
    const [status, setStatus] = useState<"all" | "available" | "allocated">("all");
    const [query, setQuery] = useState("");
    const options = useMemo(() => competitionOptions(fixtures), [fixtures]);
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sortFixtures(
            filterFixtures(fixtures, competition).filter(
                (f) =>
                    (status === "all" || (status === "allocated") === byFixtureId.has(f.id)) &&
                    (!q ||
                        [f.competition, f.home_team, f.away_team, f.round].some((v) =>
                            (v ?? "").toLowerCase().includes(q)
                        ))
            )
        );
    }, [fixtures, competition, status, query, byFixtureId]);
    const filtering = competition !== "all" || status !== "all" || query.trim() !== "";
    return (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-800">Fixtures this week (AFL)</h2>
                <select
                    aria-label="Competition"
                    value={competition}
                    onChange={(e) => setCompetition(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                >
                    <option value="all">All competitions</option>
                    {options.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <div className="relative min-w-[200px] flex-1">
                    <input
                        type="text"
                        aria-label="Search fixtures"
                        placeholder="Search competition, team or round"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="w-full rounded-md border border-slate-300 bg-white py-1 pl-2 pr-7 text-xs text-slate-700"
                    />
                    {query !== "" && (
                        <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => setQuery("")}
                            className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-slate-400 hover:text-slate-700"
                        >
                            &times;
                        </button>
                    )}
                </div>
                <select
                    aria-label="Status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as "all" | "available" | "allocated")}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                >
                    <option value="all">All statuses</option>
                    <option value="available">Available</option>
                    <option value="allocated">Allocated</option>
                </select>
                <span role="status" className="text-slate-500">
                    {rows.length} of {fixtures.length} fixtures
                </span>
            </div>
            {rows.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                    {loading
                        ? "Loading fixtures..."
                        : fixtures.length > 0 && filtering
                          ? "No fixtures match your search or filters"
                          : "No AFL fixtures synced for this week"}
                </p>
            ) : (
                <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-auto text-xs">
                    {rows.map((f) => {
                        const alloc = byFixtureId.get(f.id);
                        const canDrag = Boolean(draggable) && !alloc;
                        return (
                            <li
                                key={f.id}
                                draggable={canDrag}
                                onDragStart={
                                    canDrag
                                        ? (e) => {
                                              e.dataTransfer.setData(GAMEFACE_FIXTURE_DND_TYPE, f.id);
                                              e.dataTransfer.effectAllowed = "copy";
                                          }
                                        : undefined
                                }
                                className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 ${
                                    canDrag ? "cursor-grab active:cursor-grabbing" : ""
                                }`}
                            >
                                <span className="w-24 shrink-0 text-slate-600">{formatFixtureDate(f.fixture_date)}</span>
                                <span className="w-16 shrink-0 text-slate-600">{f.fixture_time || "TBC"}</span>
                                <span className="min-w-[140px] text-slate-500">
                                    {f.competition}
                                    {f.round ? ` · ${f.round}` : ""}
                                </span>
                                <span className="min-w-[180px] flex-1 font-medium text-slate-800">
                                    {f.home_team} v {f.away_team}
                                </span>
                                <span
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                        alloc ? "bg-blue-100 text-blue-800" : "bg-emerald-100 text-emerald-800"
                                    }`}
                                >
                                    {alloc ? `Allocated: ${alloc.employee_name}` : "Available"}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
