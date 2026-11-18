// Pure orchestration for resolving many disputes with one decision. The write
// itself is injected (defaults to the real conditional resolve) so this module
// can be tested without a database.

import type { Dispute, DisputeStatus } from "@/lib/api/disputes";

export type Outcome = "confirmed" | "denied";
export type ResolveFn = (
    id: number,
    status: Outcome,
    resolvedBy: string | null,
    note?: string | null
) => Promise<boolean>;

export interface BulkItem {
    id: number;
    status: DisputeStatus;
}

export interface BulkResult {
    resolved: number[];
    skipped: { id: number; reason: string }[];
    failed: { id: number; message: string }[];
}

export async function resolveDisputesBulk(opts: {
    items: BulkItem[];
    outcome: Outcome;
    resolvedBy: string | null;
    note?: string | null;
    /** Pass resolveDisputeIfOpen from lib/api/disputes. */
    resolve: ResolveFn;
    concurrency?: number;
}): Promise<BulkResult> {
    const { items, outcome, resolvedBy, note } = opts;
    const resolve = opts.resolve;
    const limit = Math.max(1, Math.floor(opts.concurrency ?? 4) || 1);

    const state = new Map<number | string, "resolved" | { skip: string } | { fail: string }>();
    const order: { key: number | string; id: number }[] = [];
    const seen = new Set<number>();
    const todo: { key: number; id: number }[] = [];

    items.forEach((it, i) => {
        if (!Number.isInteger(it.id)) {
            const key = `invalid:${i}`;
            order.push({ key, id: it.id });
            state.set(key, { skip: "invalid id" });
            return;
        }
        if (seen.has(it.id)) return;
        seen.add(it.id);
        order.push({ key: it.id, id: it.id });
        if (it.status !== "open") {
            state.set(it.id, { skip: "already resolved" });
            return;
        }
        todo.push({ key: it.id, id: it.id });
    });

    let next = 0;
    async function worker() {
        while (next < todo.length) {
            const job = todo[next++];
            try {
                const ok = await resolve(job.id, outcome, resolvedBy, note);
                state.set(job.key, ok ? "resolved" : { skip: "resolved by someone else" });
            } catch (e) {
                state.set(job.key, {
                    fail: e instanceof Error ? e.message : String(e),
                });
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, worker));

    const result: BulkResult = { resolved: [], skipped: [], failed: [] };
    for (const { key, id } of order) {
        const s = state.get(key);
        if (s === "resolved") result.resolved.push(id);
        else if (s && "skip" in s) result.skipped.push({ id, reason: s.skip });
        else if (s && "fail" in s) result.failed.push({ id, message: s.fail });
    }
    return result;
}

/** Optimistically patch disputes in memory the same way the DB write does. */
export function applyResolutionLocal(
    disputes: Dispute[],
    ids: readonly number[],
    outcome: Outcome,
    resolvedBy: string | null,
    note: string | null | undefined,
    resolvedAtIso: string
): Dispute[] {
    const set = new Set(ids);
    const trimmed = note?.trim() || null;
    return disputes.map((d) =>
        set.has(d.id) && d.status === "open"
            ? {
                  ...d,
                  status: outcome,
                  resolved_by: resolvedBy,
                  resolved_at: resolvedAtIso,
                  resolution_note: trimmed,
              }
            : d
    );
}
