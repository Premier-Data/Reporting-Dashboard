import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { op: string; args: unknown[] }[] = [];
let result: { data: unknown; error: { message: string } | null } = { data: [], error: null };

vi.mock("@/lib/supabase", () => {
    const chain: Record<string, unknown> = {};
    const rec = (op: string) => (...args: unknown[]) => {
        calls.push({ op, args });
        return chain;
    };
    for (const op of ["update", "eq", "is", "select"]) chain[op] = rec(op);
    chain.then = (res: (v: unknown) => unknown) => res(result);
    return { supabase: { from: () => chain } };
});

const invalidations = { all: 0, counts: 0 };
vi.mock("@/lib/api/cache", () => ({
    createCache: (_fn: unknown) => ({
        get: () => Promise.resolve(null),
        invalidate: () => {
            // distinguish by call order: first cache is all-disputes
            invalidations.all++;
        },
    }),
}));

import { buildResolvePatch, resolveDisputeIfOpen } from "./disputes";

beforeEach(() => {
    calls.length = 0;
    invalidations.all = 0;
    result = { data: [], error: null };
});

describe("buildResolvePatch", () => {
    it("sets the four fields, trims, nulls empty note", () => {
        const p = buildResolvePatch("denied", "sup", "  hi ");
        expect(Object.keys(p).sort()).toEqual(["resolution_note", "resolved_at", "resolved_by", "status"]);
        expect(p.resolution_note).toBe("hi");
        expect(buildResolvePatch("confirmed", null, "  ").resolution_note).toBeNull();
    });
});

describe("resolveDisputeIfOpen", () => {
    it("returns false when no row updated, still invalidates caches, filters open+not deleted", async () => {
        result = { data: [], error: null };
        expect(await resolveDisputeIfOpen(5, "denied", "s")).toBe(false);
        expect(invalidations.all).toBe(2); // both caches
        expect(calls.some((c) => c.op === "eq" && c.args[0] === "status" && c.args[1] === "open")).toBe(true);
        expect(calls.some((c) => c.op === "is" && c.args[0] === "deleted_at" && c.args[1] === null)).toBe(true);
    });

    it("returns true when a row was updated", async () => {
        result = { data: [{ id: 5 }], error: null };
        expect(await resolveDisputeIfOpen(5, "confirmed", "s", "n")).toBe(true);
    });

    it("throws on DB error and still invalidates", async () => {
        result = { data: null, error: { message: "bad" } };
        await expect(resolveDisputeIfOpen(5, "denied", "s")).rejects.toThrow("bad");
        expect(invalidations.all).toBe(2);
    });
});
