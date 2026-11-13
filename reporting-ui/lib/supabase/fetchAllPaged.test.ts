import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
let pages: Array<{ data: unknown[] | null; error: { message: string } | null }> = [];
let pageIdx = 0;

vi.mock("@/lib/supabase", () => {
  const q: Record<string, unknown> = {};
  q.select = (s: string) => (calls.push(`select:${s}`), q);
  q.eq = (c: string, v: unknown) => (calls.push(`eq:${c}=${String(v)}`), q);
  q.order = (c: string, o: { ascending: boolean }) => (calls.push(`order:${c}:${o.ascending ? "asc" : "desc"}`), q);
  q.range = (a: number, b: number) => {
    calls.push(`range:${a}-${b}`);
    return Promise.resolve(pages[pageIdx++] ?? { data: [], error: null });
  };
  return { supabase: { from: (t: string) => (calls.push(`from:${t}`), q) } };
});

import { fetchAllPaged } from "./fetchAllPaged";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

beforeEach(() => {
  calls.length = 0;
  pages = [];
  pageIdx = 0;
});

describe("fetchAllPaged", () => {
  it("applies business order first, then the unique tiebreak last, before range", async () => {
    pages = [{ data: rows(3), error: null }];
    await fetchAllPaged("TT_Games", { select: "a,b", order: ["Date", "Competition"], unique: "game_key" });
    expect(calls).toEqual([
      "from:TT_Games",
      "select:a,b",
      "order:Date:asc",
      "order:Competition:asc",
      "order:game_key:asc",
      "range:0-999",
    ]);
  });

  it("does not duplicate the unique key if listed in order, and applies filters", async () => {
    pages = [{ data: [], error: null }];
    await fetchAllPaged("t", {
      order: ["game_key"],
      unique: "game_key",
      filters: (q) => (q as { eq: (c: string, v: unknown) => unknown }).eq("x", 1) as typeof q,
    });
    expect(calls).toEqual(["from:t", "select:*", "eq:x=1", "order:game_key:asc", "range:0-999"]);
  });

  it("keeps paging on full pages and stops on a short page", async () => {
    pages = [
      { data: rows(1000), error: null },
      { data: rows(1000), error: null },
      { data: rows(5), error: null },
    ];
    const out = await fetchAllPaged("t", { unique: "id" });
    expect(out).toHaveLength(2005);
    expect(calls.filter((c) => c.startsWith("range:"))).toEqual(["range:0-999", "range:1000-1999", "range:2000-2999"]);
  });

  it("throws on error instead of returning a partial set", async () => {
    pages = [
      { data: rows(1000), error: null },
      { data: null, error: { message: "boom" } },
    ];
    await expect(fetchAllPaged("t", { unique: "id" })).rejects.toThrow(/boom/);
  });
});
