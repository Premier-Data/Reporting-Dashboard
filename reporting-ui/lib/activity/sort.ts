import type { PresenceStatus } from "./activity";

export type SortKey = "user" | "status" | "section" | "first" | "last" | "worked" | "actions";
export type SortDir = "asc" | "desc";
export type SortState = { key: SortKey; dir: SortDir } | null;

export interface SortableRow {
    name: string;
    username: string;
    status: PresenceStatus;
    /** Text shown in "Currently in", null when not shown. */
    sectionText: string | null;
    firstActive: number | null;
    lastActive: number | null;
    workedMs: number;
    eventCount: number;
}

const STATUS_ORDER: Record<PresenceStatus, number> = { active: 0, idle: 1, offline: 2 };

/** Page default order: status, then most active time, most actions, then name. */
export function compareDefault(x: SortableRow, y: SortableRow): number {
    return (
        STATUS_ORDER[x.status] - STATUS_ORDER[y.status] ||
        y.workedMs - x.workedMs ||
        y.eventCount - x.eventCount ||
        x.username.localeCompare(y.username)
    );
}

/** Direction used the first time a column header is clicked. */
export function firstDir(key: SortKey): SortDir {
    return key === "user" || key === "status" || key === "section" ? "asc" : "desc";
}

/** Next sort state after clicking a header. */
export function nextSort(current: SortState, key: SortKey): SortState {
    if (current?.key !== key) return { key, dir: firstDir(key) };
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** Comparator for a sort state; null gives the default order. Empty values always sort last. */
export function rowComparator(sort: SortState): (x: SortableRow, y: SortableRow) => number {
    if (!sort) return compareDefault;
    const sign = sort.dir === "asc" ? 1 : -1;
    return (x, y) => {
        let a: string | number | null;
        let b: string | number | null;
        switch (sort.key) {
            case "user":
                a = x.name.toLowerCase();
                b = y.name.toLowerCase();
                break;
            case "status":
                a = STATUS_ORDER[x.status];
                b = STATUS_ORDER[y.status];
                break;
            case "section":
                a = x.sectionText?.toLowerCase() ?? null;
                b = y.sectionText?.toLowerCase() ?? null;
                break;
            case "first":
                a = x.firstActive;
                b = y.firstActive;
                break;
            case "last":
                a = x.lastActive;
                b = y.lastActive;
                break;
            case "worked":
                a = x.workedMs;
                b = y.workedMs;
                break;
            default:
                a = x.eventCount;
                b = y.eventCount;
        }
        if (a === null || b === null) {
            if (a === b) return compareDefault(x, y);
            return a === null ? 1 : -1;
        }
        const c = typeof a === "string" ? a.localeCompare(b as string) : a - (b as number);
        return c * sign || compareDefault(x, y);
    };
}
