// Pure grouping of disputes by the master stat instance they refer to, so a
// supervisor can see every analyst's dispute about the same master event.
//
// Matching key: masterKey | team | player | stat (all normalised), then a time
// cluster inside that bucket. instance_id is NOT used: it is per-file and
// changes when a master is edited.
//
// Clustering rule (anchor based, never chained):
//   1. Master-side disputes are clustered first, sorted by (code_time, id).
//      A master-side dispute joins the first cluster whose anchor (its first
//      member) is within MASTER_EPSILON seconds and which does not already
//      contain a dispute from the same check and side. Otherwise it anchors a
//      new cluster. The same master event has the same code_time for every
//      analyst, so only a tiny epsilon is needed (fractional midpoints); two
//      real events even 1s apart are never merged.
//   2. Analyst-side disputes (sorted the same way) join the NEAREST cluster
//      (master or analyst-only) whose anchor is within min(anchor tolerance,
//      own tolerance) and which has no dispute from the same check and side;
//      otherwise they anchor a new analyst-only cluster. Analyst times are the
//      analyst's own event time, so the check tolerance is the right window.
//   Distance is always measured to the anchor, never to the last member.

import type { Dispute } from "@/lib/api/disputes";
import { masterKey } from "@/lib/api/masterGroup";
import { normaliseAnalyst } from "@/lib/analytics/disputeDashboard";

/** Max seconds between two master-side disputes for the same master event. */
export const MASTER_EPSILON = 0.5;
export const DEFAULT_TOLERANCE = 3;
export const UNASSIGNED_MASTER = "";
export const UNASSIGNED_MASTER_NAME = "Unassigned / cannot be matched";

export interface CheckInfo {
    masterKey: string;
    analyst: string | null;
    tolerance: number | null | undefined;
    masterName?: string | null;
}

export type GroupKind = "master" | "mixed" | "analyst_only";

export interface MasterInstanceGroup {
    key: string;
    masterKey: string;
    kind: GroupKind;
    stat: string;
    player: string;
    team: string;
    time: number;
    target: Dispute;
    disputes: Dispute[];
    analystCount: number;
    checkCount: number;
    openCount: number;
    resolvedCount: number;
    categories: string[];
    conflicting: boolean;
    keyable: boolean;
}

const norm = (s: string | null | undefined) =>
    (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function normPlayer(p: string | null | undefined): string {
    return norm(p).replace(/^#/, "").trim().replace(/^0+(?=\d)/, "");
}

/** Analyst identity used to count distinct analysts. */
export function analystIdentity(
    check: CheckInfo | undefined,
    checkId: number
): string {
    const n = normaliseAnalyst(check?.analyst);
    return n || `unassigned:${checkId}`;
}

interface Cluster {
    anchor: Dispute;
    anchorTol: number;
    members: Dispute[];
    has: Set<string>;
}

function tolOf(checks: Map<number, CheckInfo>, d: Dispute): number {
    const t = checks.get(d.check_id)?.tolerance;
    return typeof t === "number" && Number.isFinite(t) && t >= 0
        ? t
        : DEFAULT_TOLERANCE;
}

function isKeyable(d: Dispute, checks: Map<number, CheckInfo>): boolean {
    const c = checks.get(d.check_id);
    return (
        !!c &&
        !!c.masterKey &&
        typeof d.code_time === "number" &&
        Number.isFinite(d.code_time) &&
        !!norm(d.stat) &&
        !!norm(d.team)
    );
}

function byTimeThenId(a: Dispute, b: Dispute): number {
    return (a.code_time as number) - (b.code_time as number) || a.id - b.id;
}

function pickTarget(ds: Dispute[]): Dispute {
    const t = (d: Dispute) => (Number.isFinite(d.code_time) ? (d.code_time as number) : Infinity);
    const cmp = (a: Dispute, b: Dispute) => t(a) - t(b) || a.id - b.id;
    const best = (list: Dispute[]) => [...list].sort(cmp)[0];
    const masters = ds.filter((d) => d.side === "master");
    const openMasters = masters.filter((d) => d.status === "open");
    if (openMasters.length) return best(openMasters);
    if (masters.length) return best(masters);
    const open = ds.filter((d) => d.status === "open");
    if (open.length) return best(open);
    return best(ds);
}

function buildGroup(
    key: string,
    mk: string,
    ds: Dispute[],
    checks: Map<number, CheckInfo>,
    keyable: boolean
): MasterInstanceGroup {
    const hasMaster = ds.some((d) => d.side === "master");
    const hasAnalyst = ds.some((d) => d.side === "analyst");
    const kind: GroupKind = hasMaster
        ? hasAnalyst
            ? "mixed"
            : "master"
        : "analyst_only";
    const target = pickTarget(ds);
    const times = ds.map((d) => d.code_time).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    const time =
        kind === "analyst_only"
            ? times.length
                ? Math.min(...times)
                : 0
            : Number.isFinite(target.code_time)
              ? (target.code_time as number)
              : 0;
    const categories = Array.from(
        new Set(ds.map((d) => d.category).filter((c): c is NonNullable<typeof c> => !!c))
    );
    const sorted = [...ds].sort((a, b) => a.id - b.id);
    return {
        key,
        masterKey: mk,
        kind,
        stat: (target.stat ?? "").trim(),
        player: (target.player ?? "").trim(),
        team: (target.team ?? "").trim(),
        time,
        target,
        disputes: sorted,
        analystCount: new Set(ds.map((d) => analystIdentity(checks.get(d.check_id), d.check_id))).size,
        checkCount: new Set(ds.map((d) => d.check_id)).size,
        openCount: ds.filter((d) => d.status === "open").length,
        resolvedCount: ds.filter((d) => d.status !== "open").length,
        categories,
        conflicting: categories.length >= 2,
        keyable,
    };
}

function clusterBucket(bucket: Dispute[], checks: Map<number, CheckInfo>): Dispute[][] {
    const clusters: Cluster[] = [];
    const slot = (d: Dispute) => `${d.check_id}|${d.side}`;
    const sorted = [...bucket].sort(byTimeThenId);

    for (const d of sorted.filter((x) => x.side === "master")) {
        const t = d.code_time as number;
        const hit = clusters.find(
            (c) => Math.abs(t - (c.anchor.code_time as number)) <= MASTER_EPSILON && !c.has.has(slot(d))
        );
        if (hit) {
            hit.members.push(d);
            hit.has.add(slot(d));
        } else {
            clusters.push({ anchor: d, anchorTol: tolOf(checks, d), members: [d], has: new Set([slot(d)]) });
        }
    }

    for (const d of sorted.filter((x) => x.side !== "master")) {
        const t = d.code_time as number;
        const tol = tolOf(checks, d);
        let best: Cluster | null = null;
        let bestDist = Infinity;
        for (const c of clusters) {
            const dist = Math.abs(t - (c.anchor.code_time as number));
            if (dist <= Math.min(c.anchorTol, tol) && !c.has.has(slot(d)) && dist < bestDist) {
                best = c;
                bestDist = dist;
            }
        }
        if (best) {
            best.members.push(d);
            best.has.add(slot(d));
        } else {
            clusters.push({ anchor: d, anchorTol: tol, members: [d], has: new Set([slot(d)]) });
        }
    }
    return clusters.map((c) => c.members);
}

export function groupByMasterInstance(
    disputes: readonly Dispute[],
    checks: Map<number, CheckInfo>
): MasterInstanceGroup[] {
    const buckets = new Map<string, { mk: string; items: Dispute[] }>();
    const out: MasterInstanceGroup[] = [];

    for (const d of disputes) {
        if (!isKeyable(d, checks)) {
            out.push(buildGroup(`single:${d.id}`, UNASSIGNED_MASTER, [d], checks, false));
            continue;
        }
        const mk = checks.get(d.check_id)!.masterKey;
        const bk = [mk, norm(d.team), normPlayer(d.player), norm(d.stat)].join("|");
        const b = buckets.get(bk);
        if (b) b.items.push(d);
        else buckets.set(bk, { mk, items: [d] });
    }

    for (const [bk, { mk, items }] of buckets) {
        for (const members of clusterBucket(items, checks)) {
            const first = [...members].sort(byTimeThenId)[0];
            out.push(buildGroup(`${bk}@${first.id}`, mk, members, checks, true));
        }
    }

    out.sort(
        (a, b) =>
            b.analystCount - a.analystCount ||
            a.time - b.time ||
            a.disputes[0].id - b.disputes[0].id
    );
    return out;
}

/** Multi-analyst: a master/mixed group disputed by 2+ distinct analysts. */
export function isMultiAnalyst(g: MasterInstanceGroup): boolean {
    return g.kind !== "analyst_only" && g.analystCount >= 2;
}

export interface MasterSummary {
    masterKey: string;
    name: string;
    analysts: number;
    checks: number;
    openDisputes: number;
    openMultiGroups: number;
}

export function buildMasterSummaries(
    groups: readonly MasterInstanceGroup[],
    checkRows: readonly {
        id: number;
        file_name_master: string | null;
        analyst_name: string | null;
        deleted_at?: string | null;
    }[]
): MasterSummary[] {
    const map = new Map<
        string,
        { name: string; analysts: Set<string>; checks: Set<number>; open: number; multi: number }
    >();
    const get = (mk: string, name: string) => {
        let e = map.get(mk);
        if (!e) {
            e = { name, analysts: new Set(), checks: new Set(), open: 0, multi: 0 };
            map.set(mk, e);
        }
        return e;
    };
    for (const c of checkRows) {
        if (c.deleted_at) continue;
        const mk = masterKey(c.file_name_master);
        if (!mk) continue;
        const e = get(mk, (c.file_name_master ?? "").trim());
        e.checks.add(c.id);
        e.analysts.add(analystIdentity({ masterKey: mk, analyst: c.analyst_name, tolerance: null }, c.id));
    }
    let hasUnkeyed = false;
    for (const g of groups) {
        if (!g.keyable) {
            hasUnkeyed = true;
            continue;
        }
        const e = get(g.masterKey, g.masterKey);
        e.open += g.openCount;
        if (isMultiAnalyst(g) && g.openCount > 0) e.multi += 1;
    }
    const list: MasterSummary[] = Array.from(map.entries()).map(([mk, e]) => ({
        masterKey: mk,
        name: e.name,
        analysts: e.analysts.size,
        checks: e.checks.size,
        openDisputes: e.open,
        openMultiGroups: e.multi,
    }));
    list.sort(
        (a, b) =>
            b.openMultiGroups - a.openMultiGroups ||
            b.openDisputes - a.openDisputes ||
            a.name.localeCompare(b.name)
    );
    if (hasUnkeyed) {
        const un = groups.filter((g) => !g.keyable);
        list.push({
            masterKey: UNASSIGNED_MASTER,
            name: UNASSIGNED_MASTER_NAME,
            analysts: new Set(un.flatMap((g) => g.disputes.map((d) => d.check_id))).size,
            checks: new Set(un.flatMap((g) => g.disputes.map((d) => d.check_id))).size,
            openDisputes: un.reduce((n, g) => n + g.openCount, 0),
            openMultiGroups: 0,
        });
    }
    return list;
}

/** Build the check lookup used by groupByMasterInstance. */
export function buildCheckInfoMap(
    checkRows: readonly {
        id: number;
        file_name_master: string | null;
        analyst_name: string | null;
        tolerance?: number | null;
    }[]
): Map<number, CheckInfo> {
    const m = new Map<number, CheckInfo>();
    for (const c of checkRows) {
        m.set(c.id, {
            masterKey: masterKey(c.file_name_master),
            analyst: c.analyst_name,
            tolerance: c.tolerance,
            masterName: c.file_name_master,
        });
    }
    return m;
}
