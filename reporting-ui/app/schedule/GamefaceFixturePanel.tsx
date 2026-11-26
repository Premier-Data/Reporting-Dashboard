"use client";

import { useMemo, useState } from "react";
import type { CompFixtureRow } from "@/lib/api/compFixtures";
import type { GamefaceAllocation } from "@/lib/api/gamefaceDeputy";
import { competitionOptions, filterFixtures } from "@/lib/deputy/gamefaceFixtures";

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

type Props = {
    fixtures: CompFixtureRow[];
    byFixtureId: Map<string, GamefaceAllocation>;
    loading?: boolean;
};

/** Information only: allocation starts from a shift. */
export default function GamefaceFixturePanel({ fixtures, byFixtureId, loading }: Props) {
    const [competition, setCompetition] = useState("all");
    const options = useMemo(() => competitionOptions(fixtures), [fixtures]);
    const rows = useMemo(
        () => sortFixtures(filterFixtures(fixtures, competition)),
        [fixtures, competition]
    );

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

            {rows.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                    {loading ? "Loading fixtures..." : "No AFL fixtures synced for this week"}
                </p>
            ) : (
                <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-auto text-xs">
                    {rows.map((f) => {
                        const alloc = byFixtureId.get(f.id);
                        return (
                            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                                <span className="w-24 shrink-0 text-slate-600">{f.fixture_date ?? "TBC"}</span>
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
