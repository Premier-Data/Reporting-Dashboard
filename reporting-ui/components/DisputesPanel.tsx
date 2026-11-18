"use client";

import { useState } from "react";
import { Flag, Check, Clock, Video } from "lucide-react";
import { disputeCategoryLabel, type Dispute } from "@/lib/api/disputes";

// Category badge styling — a soft slate chip so it reads as metadata, not a
// status. Uncategorised (legacy) disputes get a lighter, dashed look.
function categoryBadge(category: Dispute["category"]) {
    return category
        ? "border border-indigo-200 bg-indigo-50 text-indigo-700"
        : "border border-dashed border-slate-300 bg-slate-50 text-slate-400";
}

function statusBadge(status: Dispute["status"]) {
    switch (status) {
        case "confirmed":
            return "bg-emerald-100 text-emerald-700";
        case "denied":
            return "bg-sky-100 text-sky-700";
        default:
            return "bg-amber-100 text-amber-700";
    }
}

// Adjudication labels: "confirmed" = the analyst was right (flag upheld);
// "denied" = the master was right (flag rejected).
// Pass only "confirmed" or "denied" for outcome buttons: any other value
// returns "Open".
export function statusLabel(status: Dispute["status"]): string {
    switch (status) {
        case "confirmed":
            return "Analyst correct";
        case "denied":
            return "Master correct";
        default:
            return "Open";
    }
}

function fmtTime(t: number | null): string {
    if (t == null) return "—";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Shared list of disputes with resolve controls. Used both in the per-check
 * panel (Accuracy History) and the global Disputes page.
 */
export default function DisputesPanel({
    disputes,
    canResolve,
    onResolve,
    showCheckColumn,
    checkLabel,
    onOpen,
}: {
    disputes: Dispute[];
    canResolve: boolean;
    onResolve: (
        disputeId: number,
        status: "confirmed" | "denied",
        note: string | null
    ) => void | Promise<void>;
    /** Show which check each dispute belongs to (global page). */
    showCheckColumn?: boolean;
    /** Resolve a check_id to a human label (global page). */
    checkLabel?: (checkId: number) => string;
    /** When set, a "Review in video" action opens the disputed instance. */
    onOpen?: (dispute: Dispute) => void;
}) {
    if (disputes.length === 0) {
        return (
            <p className="py-3 text-center text-sm text-slate-400">
                No disputes for this check.
            </p>
        );
    }

    return (
        <div className="space-y-2">
            {disputes.map((d) => (
                <DisputeRow
                    key={d.id}
                    dispute={d}
                    canResolve={canResolve}
                    onResolve={onResolve}
                    showCheckColumn={showCheckColumn}
                    checkLabel={checkLabel}
                    onOpen={onOpen}
                />
            ))}
        </div>
    );
}

function DisputeRow({
    dispute: d,
    canResolve,
    onResolve,
    showCheckColumn,
    checkLabel,
    onOpen,
}: {
    dispute: Dispute;
    canResolve: boolean;
    onResolve: (
        disputeId: number,
        status: "confirmed" | "denied",
        note: string | null
    ) => void | Promise<void>;
    showCheckColumn?: boolean;
    checkLabel?: (checkId: number) => string;
    onOpen?: (dispute: Dispute) => void;
}) {
    const [note, setNote] = useState("");
    const open = d.status === "open";

    return (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                    <Flag size={14} className="text-amber-600" />
                    <span className="font-semibold text-slate-800">
                        {d.stat || "—"}
                    </span>
                    <span className="text-slate-500">
                        {d.side === "master" ? "Master" : "Analyst"}
                        {d.team ? ` · ${d.team}` : ""}
                        {d.player ? ` · ${d.player}` : ""}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                        <Clock size={11} /> {fmtTime(d.code_time)}
                    </span>
                    <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${categoryBadge(
                            d.category
                        )}`}
                    >
                        {disputeCategoryLabel(d.category)}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    {onOpen && (
                        <button
                            onClick={() => onOpen(d)}
                            className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700"
                            title="Review this instance in the video"
                        >
                            <Video size={12} /> Review
                        </button>
                    )}
                    <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusBadge(
                            d.status
                        )}`}
                    >
                        {statusLabel(d.status)}
                    </span>
                </div>
            </div>

            {showCheckColumn && checkLabel && (
                <p className="mt-1 text-xs text-slate-400">
                    Check: {checkLabel(d.check_id)}
                </p>
            )}

            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
                {d.raised_by && <span>Raised by {d.raised_by}</span>}
                {d.reason && <span>Reason: {d.reason}</span>}
            </div>

            {d.status !== "open" && (
                <p className="mt-1 text-xs text-slate-500">
                    {statusLabel(d.status)}
                    {d.resolved_by ? ` by ${d.resolved_by}` : ""}
                    {d.resolution_note ? ` · ${d.resolution_note}` : ""}
                </p>
            )}

            {open && canResolve && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Resolution note (optional)"
                        className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-slate-500"
                    />
                    <button
                        onClick={() =>
                            onResolve(d.id, "confirmed", note.trim() || null)
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                        <Check size={13} /> Analyst correct
                    </button>
                    <button
                        onClick={() =>
                            onResolve(d.id, "denied", note.trim() || null)
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
                    >
                        <Check size={13} /> Master correct
                    </button>
                </div>
            )}
        </div>
    );
}
