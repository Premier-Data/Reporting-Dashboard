"use client";

import { useMemo, useState } from "react";
import type { CompFixtureRow } from "@/lib/api/compFixtures";
import {
    AlreadyAllocatedError,
    type GamefaceAllocation,
    type GamefaceAllocator,
} from "@/lib/api/gamefaceDeputy";
import { competitionOptions, filterFixtures } from "@/lib/deputy/gamefaceFixtures";
import { sortFixtures } from "./GamefaceFixturePanel";

export type GamefaceShift = {
    /** roster_key without the "deputy:" prefix. */
    rosterId: string;
    employeeName: string;
    /** yyyy-mm-dd */
    date: string;
};

type Props = {
    shift: GamefaceShift;
    fixtures: CompFixtureRow[];
    byFixtureId: Map<string, GamefaceAllocation>;
    allocator: GamefaceAllocator;
    onClose: () => void;
    /** Reload fixtures and allocations (after success or a conflict). */
    onChanged: () => void | Promise<void>;
};

export default function GamefaceAllocateModal({
    shift,
    fixtures,
    byFixtureId,
    allocator,
    onClose,
    onChanged,
}: Props) {
    const [wholeWeek, setWholeWeek] = useState(false);
    const [competition, setCompetition] = useState("all");
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState("");

    const available = useMemo(() => fixtures.filter((f) => !byFixtureId.has(f.id)), [fixtures, byFixtureId]);
    const options = useMemo(() => competitionOptions(available), [available]);
    const rows = useMemo(
        () =>
            sortFixtures(
                filterFixtures(available, competition).filter((f) => wholeWeek || f.fixture_date === shift.date)
            ),
        [available, competition, wholeWeek, shift.date]
    );

    async function allocate(f: CompFixtureRow) {
        setBusyId(f.id);
        setError("");
        try {
            await allocator.allocate({
                compFixtureId: f.id,
                rosterId: shift.rosterId,
                employeeName: shift.employeeName,
            });
            await onChanged();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not allocate the fixture");
            if (err instanceof AlreadyAllocatedError) await onChanged();
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl">
                <div className="border-b border-slate-200 p-4">
                    <h3 className="text-base font-semibold text-slate-900">Allocate fixture</h3>
                    <p className="text-xs text-slate-500">
                        {shift.employeeName} · {shift.date}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                        <label className="flex items-center gap-1.5 text-slate-700">
                            <input
                                type="checkbox"
                                checked={wholeWeek}
                                onChange={(e) => setWholeWeek(e.target.checked)}
                            />
                            Whole week
                        </label>
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
                    {error && (
                        <p role="alert" className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">
                            {error}
                        </p>
                    )}
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-2">
                    {rows.length === 0 ? (
                        <p className="p-3 text-xs text-slate-500">
                            No available fixtures {wholeWeek ? "this week" : "on this day"}.
                        </p>
                    ) : (
                        <ul className="divide-y divide-slate-100 text-xs">
                            {rows.map((f) => (
                                <li key={f.id} className="flex items-center gap-3 p-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium text-slate-800">
                                            {f.home_team} v {f.away_team}
                                        </div>
                                        <div className="text-slate-500">
                                            {f.fixture_date ?? "TBC"} {f.fixture_time}
                                            {" · "}
                                            {f.competition}
                                            {f.round ? ` · ${f.round}` : ""}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busyId !== null}
                                        onClick={() => allocate(f)}
                                        className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                                    >
                                        {busyId === f.id ? "Allocating..." : "Allocate"}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="flex justify-end border-t border-slate-200 p-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
