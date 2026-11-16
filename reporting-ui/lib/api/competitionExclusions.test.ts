import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = [string, unknown[]];
const state = vi.hoisted(() => ({
  calls: [] as Call[],
  result: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase", () => {
  // Chainable, awaitable stub that records every call.
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(state.result).then(res, rej);
        }
        return (...args: unknown[]) => {
          state.calls.push([prop, args]);
          return chain;
        };
      },
    }
  );
  return { supabase: { from: (...a: unknown[]) => (state.calls.push(["from", a]), chain) } };
});

import {
  EXCLUSIONS_NOT_SET_UP,
  ExclusionsTableMissingError,
  addExclusions,
  isMissingTableError,
  listExclusions,
  removeExclusions,
} from "./competitionExclusions";

beforeEach(() => {
  state.calls = [];
  state.result = { data: [], error: null };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("addExclusions", () => {
  it("bulk upserts with onConflict kind,key and de-dupes", async () => {
    state.result = { data: [{ id: 1 }], error: null };
    await addExclusions([
      { kind: "competition", key: "psa", label: "PSA", reason: "  test ", created_by: "me" },
      { kind: "competition", key: "psa", label: "PSA" },
      { kind: "team", key: "psa", label: "PSA" },
    ]);
    expect(state.calls[0]).toEqual(["from", ["competition_exclusions"]]);
    const up = state.calls.find((c) => c[0] === "upsert")!;
    expect(up[1][1]).toEqual({ onConflict: "kind,key", ignoreDuplicates: true });
    expect(up[1][0]).toEqual([
      { kind: "competition", key: "psa", label: "PSA", reason: "test", created_by: "me" },
      { kind: "team", key: "psa", label: "PSA", reason: null, created_by: null },
    ]);
  });

  it("does not call supabase for an empty list", async () => {
    expect(await addExclusions([])).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("throws the Supabase message on failure", async () => {
    state.result = { data: null, error: { message: "boom" } };
    await expect(addExclusions([{ kind: "team", key: "a", label: "A" }])).rejects.toThrow("boom");
  });
});

describe("removeExclusions", () => {
  it("deletes by ids", async () => {
    await removeExclusions({ ids: [1, 2] });
    expect(state.calls.map((c) => c[0])).toEqual(["from", "delete", "in"]);
    expect(state.calls[2][1]).toEqual(["id", [1, 2]]);
  });

  it("deletes by kind and keys", async () => {
    await removeExclusions({ kind: "team", keys: ["a"] });
    expect(state.calls.map((c) => c[0])).toEqual(["from", "delete", "eq", "in"]);
    expect(state.calls[2][1]).toEqual(["kind", "team"]);
    expect(state.calls[3][1]).toEqual(["key", ["a"]]);
  });

  it("is a no-op for empty input", async () => {
    await removeExclusions({ ids: [] });
    await removeExclusions({ kind: "team", keys: [] });
    expect(state.calls).toEqual([]);
  });
});

describe("listExclusions", () => {
  it("returns rows", async () => {
    state.result = { data: [{ id: 1, kind: "team", key: "a" }], error: null };
    expect(await listExclusions()).toEqual([{ id: 1, kind: "team", key: "a" }]);
  });

  it.each([
    [{ code: "PGRST205", message: "x" }],
    [{ status: 404, message: "x" }],
    [{ message: "Could not find the table 'public.competition_exclusions' in the schema cache" }],
  ])("throws ExclusionsTableMissingError for %j", async (error) => {
    state.result = { data: null, error };
    const p = listExclusions();
    await expect(p).rejects.toBeInstanceOf(ExclusionsTableMissingError);
    await expect(p).rejects.toThrow(EXCLUSIONS_NOT_SET_UP);
  });

  it("throws a plain Error for other failures", async () => {
    state.result = { data: null, error: { message: "network down" } };
    const p = listExclusions();
    await expect(p).rejects.toThrow("network down");
    await expect(p).rejects.not.toBeInstanceOf(ExclusionsTableMissingError);
  });
});

describe("isMissingTableError", () => {
  it("is false for null and unrelated errors", () => {
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError({ message: "permission denied" })).toBe(false);
  });
});
