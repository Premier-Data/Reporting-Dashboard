import { pageKeysForPath } from "@/lib/api/auth";

// Shared rules for user activity tracking (client + viewer).

/** No interaction for this long ends a stretch of activity (it's a break). */
export const BREAK_MS = 5 * 60_000;

/** How often the browser reports in while the dashboard is open. */
export const HEARTBEAT_MS = 30_000;

/**
 * Presence older than this means the user has closed the dashboard. Generous
 * because browsers slow timers in background tabs to about once a minute.
 */
export const ONLINE_WINDOW_MS = 150_000;

export type PresenceStatus = "active" | "idle" | "offline";

export function presenceStatus(
    lastSeenAt: string | null | undefined,
    lastActiveAt: string | null | undefined,
    now = Date.now()
): PresenceStatus {
    if (!lastSeenAt || now - Date.parse(lastSeenAt) > ONLINE_WINDOW_MS) return "offline";
    if (lastActiveAt && now - Date.parse(lastActiveAt) < BREAK_MS) return "active";
    return "idle";
}

/**
 * Section (page key) for a pathname: the first permission key of the route,
 * else its first path segment; "dashboard" for "/".
 */
export function sectionFromPath(pathname: string): string {
    const first = pathname.split("/").filter(Boolean)[0];
    if (!first) return "dashboard";
    return pageKeysForPath(pathname)[0] ?? first;
}

export type Segment = {
    id: string;
    started_at: string;
    ended_at: string;
    section: string | null;
};

export type DaySummary = {
    /** local midnight (ms) of the day */
    day: number;
    first: number | null;
    last: number | null;
    /** first-to-last active span, ms */
    usedMs: number;
    /** sum of active stretches, ms */
    workedMs: number;
    segments: { start: number; end: number; section: string | null }[];
};

/**
 * Split segments into local calendar days (a stretch crossing midnight is cut
 * in two). Days are returned newest first, including days with no activity.
 */
export function summariseDays(
    segments: Segment[],
    fromDay: Date,
    toDay: Date
): DaySummary[] {
    const days: DaySummary[] = [];
    const start = new Date(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate());
    const end = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate());
    for (let d = new Date(end); d >= start; d.setDate(d.getDate() - 1)) {
        const dayStart = d.getTime();
        const next = new Date(d);
        next.setDate(next.getDate() + 1);
        const dayEnd = next.getTime();
        const parts = segments
            .map((s) => ({
                start: Math.max(Date.parse(s.started_at), dayStart),
                end: Math.min(Date.parse(s.ended_at), dayEnd),
                section: s.section,
            }))
            .filter(
                (p) =>
                    p.end > p.start ||
                    (p.end === p.start && p.start >= dayStart && p.start < dayEnd)
            )
            .sort((a, b) => a.start - b.start);
        const first = parts.length ? parts[0].start : null;
        const last = parts.length ? Math.max(...parts.map((p) => p.end)) : null;
        days.push({
            day: dayStart,
            first,
            last,
            usedMs: first !== null && last !== null ? last - first : 0,
            workedMs: mergedLength(parts),
            segments: parts,
        });
    }
    return days;
}

/** Total length of possibly-overlapping intervals (two tabs open, etc.). */
export function mergedLength(parts: { start: number; end: number }[]): number {
    const s = [...parts].sort((a, b) => a.start - b.start);
    let total = 0;
    let curS = -1;
    let curE = -1;
    for (const p of s) {
        if (p.start > curE) {
            if (curE > curS) total += curE - curS;
            curS = p.start;
            curE = p.end;
        } else {
            curE = Math.max(curE, p.end);
        }
    }
    if (curE > curS) total += curE - curS;
    return total;
}

export function formatDuration(ms: number): string {
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
