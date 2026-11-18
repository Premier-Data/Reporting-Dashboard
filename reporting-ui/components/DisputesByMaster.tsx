"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Play, Search } from "lucide-react";
import {
    disputeCategoryLabel,
    resolveDisputeIfOpen,
    type Dispute,
} from "@/lib/api/disputes";
import type { AccuracyCheckMeta } from "@/lib/api/accuracyChecks";
import { resolveMasterVideoUrl } from "@/lib/api/masterGroup";
import {
    buildCheckInfoMap,
    buildMasterSummaries,
    groupByMasterInstance,
    isMultiAnalyst,
    type MasterInstanceGroup,
} from "@/lib/disputes/groupByMasterInstance";
import {
    resolveDisputesBulk,
    type BulkResult,
    type Outcome,
} from "@/lib/disputes/bulkResolve";
import { statusLabel } from "@/components/DisputesPanel";

function fmtTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

const KIND_LABEL = {
    master: "Master instance",
    mixed: "Master + analyst",
    analyst_only: "Analyst events only",
} as const;

export default function DisputesByMaster({
    disputes,
    checks,
    username,
    initialMaster,
    onResolvedLocal,
    onReload,
    onReview,
}: {
    disputes: Dispute[];
    checks: AccuracyCheckMeta[];
    username: string | null;
    initialMaster: string | null;
    onResolvedLocal: (
        ids: number[],
        outcome: Outcome,
        resolvedBy: string | null,
        note: string,
        resolvedAtIso: string
    ) => void;
    onReload: () => Promise<void> | void;
    onReview: (d: Dispute, videoUrlOverride?: string | null) => void;
}) {
    const [masterSel, setMasterSel] = useState<string | null>(initialMaster);
    const [search, setSearch] = useState("");
    const [multiOnly, setMultiOnly] = useState(true);
    const [includeAnalystOnly, setIncludeAnalystOnly] = useState(false);
    const [statusView, setStatusView] = useState<"open" | "all">("open");
    const [selectedRaw, setSelected] = useState<Set<number>>(new Set());
    const [outcome, setOutcome] = useState<Outcome>("denied");
    const [note, setNote] = useState("");
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<{
        res: BulkResult;
        outcome: Outcome;
    } | null>(null);

    const checkMap = useMemo(() => buildCheckInfoMap(checks), [checks]);
    const analystByCheck = useMemo(
        () => new Map(checks.map((c) => [c.id, c.analyst_name?.trim() || "UNASSIGNED"])),
        [checks]
    );
    const groups = useMemo(
        () => groupByMasterInstance(disputes, checkMap),
        [disputes, checkMap]
    );
    const summaries = useMemo(
        () => buildMasterSummaries(groups, checks),
        [groups, checks]
    );

    // Effective master: selection if it still exists, else the first summary.
    const effective =
        masterSel !== null && summaries.some((s) => s.masterKey === masterSel)
            ? masterSel
            : (summaries[0]?.masterKey ?? null);


    const masterGroups = useMemo(
        () => groups.filter((g) => g.masterKey === effective),
        [groups, effective]
    );
    const visible = useMemo(
        () =>
            masterGroups.filter((g) => {
                if (multiOnly && !isMultiAnalyst(g)) return false;
                if (!includeAnalystOnly && g.kind === "analyst_only") return false;
                if (statusView === "open" && g.openCount === 0) return false;
                return true;
            }),
        [masterGroups, multiOnly, includeAnalystOnly, statusView]
    );

    const videoUrl = useMemo(
        () => (effective ? resolveMasterVideoUrl(checks, effective) : null),
        [checks, effective]
    );

    const openIds = useMemo(
        () => new Set(disputes.filter((d) => d.status === "open").map((d) => d.id)),
        [disputes]
    );


    // Selected ids that are no longer open (resolved or vanished) are ignored.
    const selected = useMemo(
        () => new Set([...selectedRaw].filter((id) => openIds.has(id))),
        [selectedRaw, openIds]
    );

    const q = search.trim().toLowerCase();
    const shownSummaries = summaries.filter((s) => !q || s.name.toLowerCase().includes(q));
    const currentSummary = summaries.find((s) => s.masterKey === effective);

    const openInVisible = visible.flatMap((g) =>
        g.disputes.filter((d) => d.status === "open").map((d) => d.id)
    );
    const selectedList = [...selected];
    const selectedDisputes = disputes.filter((d) => selected.has(d.id));
    const selAnalysts = new Set(
        selectedDisputes.map((d) => analystByCheck.get(d.check_id) ?? "")
    ).size;
    const selChecks = new Set(selectedDisputes.map((d) => d.check_id)).size;

    function toggleIds(ids: number[], on: boolean) {
        setSelected((cur) => {
            const next = new Set(cur);
            for (const id of ids) {
                if (on) next.add(id);
                else next.delete(id);
            }
            return next;
        });
    }

    async function runBulk() {
        if (running || selectedDisputes.length === 0) return;
        const label = statusLabel(outcome);
        const skippedAlready = selectedDisputes.filter((d) => d.status !== "open").length;
        const msg =
            `Resolve ${selectedDisputes.length} disputes (${selAnalysts} analysts, ${selChecks} checks) as ${label}?` +
            (skippedAlready > 0
                ? ` ${skippedAlready} already-resolved selected items will be skipped.`
                : "");
        if (!window.confirm(msg)) return;
        setRunning(true);
        try {
            const res = await resolveDisputesBulk({
                items: selectedDisputes.map((d) => ({ id: d.id, status: d.status })),
                outcome,
                resolvedBy: username,
                note,
                resolve: resolveDisputeIfOpen,
            });
            setResult({ res, outcome });
            if (res.resolved.length > 0) {
                onResolvedLocal(res.resolved, outcome, username, note, new Date().toISOString());
            }
            // Resolved and skipped ids leave the selection; failed ones stay.
            const keep = new Set(res.failed.map((f) => f.id));
            setSelected(new Set([...selected].filter((id) => keep.has(id))));
            try {
                await onReload();
            } catch (e) {
                console.error("Reload after bulk resolve failed:", e);
            }
        } finally {
            setRunning(false);
        }
    }

    const noChecks = checks.length === 0 && disputes.length > 0;
    const failedNames = new Map(disputes.map((d) => [d.id, analystByCheck.get(d.check_id) ?? ""]));

    return (
        <div className="flex gap-4">
            <aside className="w-72 shrink-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="relative mb-2">
                    <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search masters"
                        className="w-full rounded-lg border border-slate-300 py-1.5 pl-8 pr-2 text-sm outline-none focus:border-slate-500"
                    />
                </div>
                <ul className="max-h-[70vh] space-y-1 overflow-y-auto">
                    {shownSummaries.map((s) => (
                        <li key={s.masterKey || "unassigned"}>
                            <button
                                type="button"
                                onClick={() => setMasterSel(s.masterKey)}
                                className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs transition ${
                                    s.masterKey === effective
                                        ? "border-slate-900 bg-slate-50"
                                        : "border-transparent hover:bg-slate-50"
                                }`}
                            >
                                <span className="block truncate text-sm font-semibold text-slate-800" title={s.name}>
                                    {s.name}
                                </span>
                                <span className="text-slate-500">
                                    {s.analysts} analysts, {s.checks} checks, {s.openDisputes} open
                                </span>
                                {s.openMultiGroups > 0 && (
                                    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700">
                                        {s.openMultiGroups} multi
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                    {shownSummaries.length === 0 && (
                        <li className="p-2 text-xs text-slate-500">No masters found.</li>
                    )}
                </ul>
            </aside>

            <section className="min-w-0 flex-1">
                {noChecks && (
                    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        Checks failed to load, groups unavailable.
                    </div>
                )}
                {currentSummary && (
                    <p className="mb-3 text-sm text-slate-600">
                        <span className="font-semibold text-slate-800">{currentSummary.name}</span>:{" "}
                        {currentSummary.analysts} analysts, {currentSummary.checks} checks,{" "}
                        <span className="font-semibold text-amber-600">{currentSummary.openDisputes} open</span>,{" "}
                        {currentSummary.openMultiGroups} open multi-analyst groups.
                    </p>
                )}

                <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                    <label className="inline-flex items-center gap-1.5">
                        <input type="checkbox" checked={multiOnly} onChange={(e) => setMultiOnly(e.target.checked)} />
                        Only multi-analyst groups
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                        <input
                            type="checkbox"
                            checked={includeAnalystOnly}
                            onChange={(e) => setIncludeAnalystOnly(e.target.checked)}
                        />
                        Include analyst-only groups
                    </label>
                    <select
                        value={statusView}
                        onChange={(e) => setStatusView(e.target.value as "open" | "all")}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
                        aria-label="Status filter"
                    >
                        <option value="open">Open</option>
                        <option value="all">All</option>
                    </select>
                    <button
                        type="button"
                        onClick={() => toggleIds(openInVisible, true)}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-100"
                    >
                        Select all open in master ({openInVisible.length})
                    </button>
                    <button
                        type="button"
                        onClick={() => setSelected(new Set())}
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-100"
                    >
                        Clear
                    </button>
                </div>

                <div className="sticky top-0 z-10 mb-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="font-semibold">Outcome:</span>
                        {(["confirmed", "denied"] as const).map((o) => (
                            <label key={o} className="inline-flex items-center gap-1.5">
                                <input
                                    type="radio"
                                    name="bulk-outcome"
                                    checked={outcome === o}
                                    onChange={() => setOutcome(o)}
                                />
                                {statusLabel(o)}
                            </label>
                        ))}
                        <input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Shared resolution note (optional)"
                            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:border-slate-500"
                        />
                        <button
                            type="button"
                            onClick={runBulk}
                            disabled={running || selected.size === 0}
                            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                        >
                            {running ? "Resolving..." : `Resolve ${selectedList.length} selected`}
                        </button>
                    </div>
                    {outcome === "confirmed" && (
                        <p className="mt-2 text-xs text-amber-700">
                            Master may need correcting: use Review / correct master per group (resolving does not
                            change the master).
                        </p>
                    )}
                </div>

                {result && (
                    <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
                        <div className="flex items-center justify-between">
                            <span className="font-semibold">
                                Resolved {result.res.resolved.length} as {statusLabel(result.outcome)}, skipped{" "}
                                {result.res.skipped.length}, failed {result.res.failed.length}
                            </span>
                            <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setResult(null)}>
                                Dismiss
                            </button>
                        </div>
                        {result.res.failed.length > 0 && (
                            <ul className="mt-2 list-disc pl-5 text-xs text-red-700">
                                {result.res.failed.map((f) => (
                                    <li key={f.id}>
                                        Dispute {f.id} ({failedNames.get(f.id) || "unknown"}): {f.message}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {result.res.skipped.length > 0 && (
                            <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
                                {result.res.skipped.map((s) => (
                                    <li key={s.id}>
                                        Dispute {s.id}: {s.reason}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                <div className="space-y-3">
                    {visible.map((g) => (
                        <GroupCard
                            key={g.key}
                            g={g}
                            selected={selected}
                            onToggle={toggleIds}
                            analystByCheck={analystByCheck}
                            videoUrl={videoUrl}
                            onReview={onReview}
                        />
                    ))}
                    {visible.length === 0 && (
                        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                            No groups match these filters.
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

function GroupCard({
    g,
    selected,
    onToggle,
    analystByCheck,
    videoUrl,
    onReview,
}: {
    g: MasterInstanceGroup;
    selected: Set<number>;
    onToggle: (ids: number[], on: boolean) => void;
    analystByCheck: Map<number, string>;
    videoUrl: string | null;
    onReview: (d: Dispute, videoUrlOverride?: string | null) => void;
}) {
    const openIds = g.disputes.filter((d) => d.status === "open").map((d) => d.id);
    const nSel = openIds.filter((id) => selected.has(id)).length;
    const boxRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (boxRef.current) boxRef.current.indeterminate = nSel > 0 && nSel < openIds.length;
    }, [nSel, openIds.length]);

    return (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm">
                <input
                    ref={boxRef}
                    type="checkbox"
                    disabled={openIds.length === 0}
                    checked={openIds.length > 0 && nSel === openIds.length}
                    onChange={(e) => onToggle(openIds, e.target.checked)}
                    aria-label="Select all open in group"
                />
                <span
                    className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                        g.kind === "analyst_only" ? "bg-slate-200 text-slate-600" : "bg-indigo-100 text-indigo-700"
                    }`}
                >
                    {KIND_LABEL[g.kind]}
                </span>
                {g.keyable && <span className="font-mono text-xs">{fmtTime(g.time)}</span>}
                {g.keyable && videoUrl && (
                    <button
                        type="button"
                        onClick={() => onReview(g.target, videoUrl)}
                        className="rounded border border-slate-300 p-1 hover:bg-slate-100"
                        title="Play this moment"
                    >
                        <Play size={12} />
                    </button>
                )}
                <span className="font-semibold">{g.stat}</span>
                {g.player && <span className="text-slate-600">{g.player}</span>}
                <span className="text-slate-600">{g.team}</span>
                <span className="text-xs text-slate-500">
                    {g.analystCount} analysts - {g.openCount} open / {g.resolvedCount} resolved
                </span>
                {g.conflicting && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700">
                        Reasons conflict
                    </span>
                )}
                {g.kind !== "analyst_only" && (
                    <button
                        type="button"
                        onClick={() => onReview(g.target, videoUrl)}
                        className="ml-auto rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-slate-100"
                    >
                        Review / correct master
                    </button>
                )}
            </div>
            <table className="w-full table-fixed border-collapse text-xs">
                <thead>
                    <tr className="text-left uppercase tracking-wide text-slate-500">
                        <th className="w-8 px-2 py-1.5" />
                        <th className="w-[12%] px-2 py-1.5">Analyst</th>
                        <th className="w-[8%] px-2 py-1.5">Check</th>
                        <th className="w-[9%] px-2 py-1.5">Side</th>
                        <th className="w-[13%] px-2 py-1.5">Category</th>
                        <th className="px-2 py-1.5">Reason</th>
                        <th className="w-[12%] px-2 py-1.5">Status</th>
                        <th className="w-[22%] px-2 py-1.5">Resolution note</th>
                    </tr>
                </thead>
                <tbody>
                    {g.disputes.map((d) => (
                        <tr key={d.id} className="border-t border-slate-100">
                            <td className="px-2 py-1.5">
                                <input
                                    type="checkbox"
                                    disabled={d.status !== "open"}
                                    checked={selected.has(d.id)}
                                    onChange={(e) => onToggle([d.id], e.target.checked)}
                                    aria-label={`Select dispute ${d.id}`}
                                />
                            </td>
                            <td className="truncate px-2 py-1.5" title={analystByCheck.get(d.check_id)}>
                                {analystByCheck.get(d.check_id) ?? "UNASSIGNED"}
                            </td>
                            <td className="px-2 py-1.5">
                                <Link
                                    href={`/accuracy-compare?check=${d.check_id}`}
                                    className="text-sky-700 underline"
                                >
                                    #{d.check_id}
                                </Link>
                            </td>
                            <td className="px-2 py-1.5">{d.side === "master" ? "Master" : "Analyst"}</td>
                            <td className="truncate px-2 py-1.5" title={disputeCategoryLabel(d.category)}>
                                {disputeCategoryLabel(d.category)}
                            </td>
                            <td className="truncate px-2 py-1.5" title={d.reason ?? ""}>
                                {d.reason ?? ""}
                            </td>
                            <td className="px-2 py-1.5">{statusLabel(d.status)}</td>
                            <td
                                className="truncate px-2 py-1.5"
                                title={d.resolution_note ?? ""}
                            >
                                {d.resolution_note ?? ""}
                                {d.resolved_by ? ` (${d.resolved_by})` : ""}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
