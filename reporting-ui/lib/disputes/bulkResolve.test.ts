import { describe, it, expect, vi } from "vitest";
import type { Dispute } from "@/lib/api/disputes";
import { resolveDisputesBulk, applyResolutionLocal } from "./bulkResolve";

describe("resolveDisputesBulk", () => {
    it("skips non-open snapshots without calling resolve", async () => {
        const resolve = vi.fn().mockResolvedValue(true);
        const r = await resolveDisputesBulk({
            items: [
                { id: 1, status: "open" },
                { id: 2, status: "confirmed" },
            ],
            outcome: "denied",
            resolvedBy: "sup",
            note: "n",
            resolve,
        });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith(1, "denied", "sup", "n");
        expect(r.resolved).toEqual([1]);
        expect(r.skipped).toEqual([{ id: 2, reason: "already resolved" }]);
    });

    it("reports false as skipped (resolved by someone else)", async () => {
        const r = await resolveDisputesBulk({
            items: [{ id: 1, status: "open" }],
            outcome: "confirmed",
            resolvedBy: null,
            resolve: async () => false,
        });
        expect(r.resolved).toEqual([]);
        expect(r.skipped).toEqual([{ id: 1, reason: "resolved by someone else" }]);
    });

    it("collects failures and continues", async () => {
        const resolve = vi.fn(async (id: number) => {
            if (id === 2) throw new Error("boom");
            return true;
        });
        const r = await resolveDisputesBulk({
            items: [1, 2, 3].map((id) => ({ id, status: "open" as const })),
            outcome: "confirmed",
            resolvedBy: "s",
            resolve,
        });
        expect(r.resolved).toEqual([1, 3]);
        expect(r.failed).toEqual([{ id: 2, message: "boom" }]);
    });

    it("never exceeds the concurrency limit", async () => {
        let inFlight = 0;
        let max = 0;
        const resolve = async () => {
            inFlight++;
            max = Math.max(max, inFlight);
            await new Promise((res) => setTimeout(res, 5));
            inFlight--;
            return true;
        };
        const r = await resolveDisputesBulk({
            items: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, status: "open" as const })),
            outcome: "denied",
            resolvedBy: "s",
            resolve,
            concurrency: 3,
        });
        expect(max).toBe(3);
        expect(r.resolved).toHaveLength(12);
    });

    it("dedupes ids, flags invalid ids, keeps input order, handles empty", async () => {
        const resolve = vi.fn().mockResolvedValue(true);
        const r = await resolveDisputesBulk({
            items: [
                { id: 3, status: "open" },
                { id: 3, status: "open" },
                { id: NaN, status: "open" },
                { id: 1, status: "open" },
            ],
            outcome: "denied",
            resolvedBy: "s",
            resolve,
        });
        expect(resolve).toHaveBeenCalledTimes(2);
        expect(r.resolved).toEqual([3, 1]);
        expect(r.skipped).toHaveLength(1);
        expect(r.skipped[0].reason).toBe("invalid id");
        const e = await resolveDisputesBulk({ items: [], outcome: "denied", resolvedBy: null, resolve });
        expect(e).toEqual({ resolved: [], skipped: [], failed: [] });
    });
});

describe("applyResolutionLocal", () => {
    it("patches only open selected disputes and trims the note", () => {
        const base = { status: "open", resolved_by: null, resolved_at: null, resolution_note: null } as Dispute;
        const rows = [
            { ...base, id: 1 },
            { ...base, id: 2 },
            { ...base, id: 3, status: "denied" as const },
        ] as Dispute[];
        const out = applyResolutionLocal(rows, [1, 3], "confirmed", "sup", "  hi ", "T");
        expect(out[0]).toMatchObject({ status: "confirmed", resolved_by: "sup", resolved_at: "T", resolution_note: "hi" });
        expect(out[1].status).toBe("open");
        expect(out[2].status).toBe("denied");
        expect(applyResolutionLocal(rows, [1], "denied", "s", "  ", "T")[0].resolution_note).toBeNull();
    });
});
