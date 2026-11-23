"use client";

import type { PresenceStatus } from "@/lib/activity/activity";

export function timeAgo(iso: string | null): string {
    if (!iso) return "never";
    const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function StatusBadge({
    status,
    lastSeen,
    lastActive,
}: {
    status: PresenceStatus;
    lastSeen: string | null;
    lastActive: string | null;
}) {
    if (status === "active")
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                Active now
            </span>
        );
    if (status === "idle")
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Online · idle {timeAgo(lastActive).replace(" ago", "")}
            </span>
        );
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
            <span className="h-2 w-2 rounded-full bg-slate-400" />
            Offline{lastSeen ? ` · last seen ${timeAgo(lastSeen)}` : ""}
        </span>
    );
}
