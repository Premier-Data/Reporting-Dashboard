import type { FolderRow } from "../../../playhq-worker/src/r2Report";

export type VisibleRow = {
    prefix: string;
    name: string;
    depth: number;
    files: number;
    bytes: number;
    hasChildren: boolean;
    pctOfParent: number | null;
};

const GB = 1024 ** 3;
const TB = 1024 ** 4;

/** GB below 1 TB, otherwise TB, 2 decimal places. */
export function formatBytes(bytes: number): string {
    if (bytes >= TB) return `${(bytes / TB).toFixed(2)} TB`;
    return `${(bytes / GB).toFixed(2)} GB`;
}

function parentOf(prefix: string): string {
    const i = prefix.slice(0, -1).lastIndexOf("/");
    return i < 0 ? "" : prefix.slice(0, i + 1);
}

function nameOf(prefix: string): string {
    const trimmed = prefix.slice(0, -1);
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Flattens the folder list into the rows to show. Siblings are sorted largest
 * first. With a search term, only folders whose prefix contains it (case-
 * insensitive) and their ancestors are shown, and those ancestors are open.
 */
export function buildVisibleRows(
    folders: FolderRow[],
    expanded: Set<string>,
    search: string
): VisibleRow[] {
    const byPrefix = new Map<string, FolderRow>();
    for (const f of folders) byPrefix.set(f.prefix, f);

    const children = new Map<string, FolderRow[]>();
    for (const f of folders) {
        const p = parentOf(f.prefix);
        const list = children.get(p);
        if (list) list.push(f);
        else children.set(p, [f]);
    }
    for (const list of children.values()) {
        list.sort((a, b) => b.bytes - a.bytes || a.prefix.localeCompare(b.prefix));
    }

    const term = search.trim().toLowerCase();
    let shown: Set<string> | null = null;
    if (term) {
        shown = new Set<string>();
        for (const f of folders) {
            if (!f.prefix.toLowerCase().includes(term)) continue;
            let p = f.prefix;
            while (p) {
                shown.add(p);
                p = parentOf(p);
            }
        }
    }

    const rows: VisibleRow[] = [];
    const walk = (parent: string, depth: number) => {
        for (const f of children.get(parent) ?? []) {
            if (shown && !shown.has(f.prefix)) continue;
            const kids = (children.get(f.prefix) ?? []).filter((k) => !shown || shown.has(k.prefix));
            const parentRow = parent ? byPrefix.get(parent) : undefined;
            rows.push({
                prefix: f.prefix,
                name: nameOf(f.prefix),
                depth,
                files: f.files,
                bytes: f.bytes,
                hasChildren: kids.length > 0,
                pctOfParent: parentRow && parentRow.bytes > 0 ? (f.bytes / parentRow.bytes) * 100 : null,
            });
            if (kids.length > 0 && (shown !== null || expanded.has(f.prefix))) walk(f.prefix, depth + 1);
        }
    };
    walk("", 0);
    return rows;
}
