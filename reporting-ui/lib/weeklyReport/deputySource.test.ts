import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { seasonOfDate, seasonStart } from "@/lib/analytics/season";
import {
  fetchAllViewRows,
  pickDeputyRows,
  isViewMissing,
  sqlSeasonOf,
  sqlSeasonWeekOf,
  sqlSeasonRollDay,
} from "./deputySource";

describe("pickDeputyRows", () => {
  const fb = [{ a: 1 }];
  it("uses the view rows when present", () => {
    expect(pickDeputyRows([{ b: 2 }], fb)).toEqual({ rows: [{ b: 2 }], source: "view" });
  });
  it("falls back when the view failed (null) or is empty", () => {
    expect(pickDeputyRows(null, fb)).toEqual({ rows: fb, source: "fallback" });
    expect(pickDeputyRows([], fb)).toEqual({ rows: fb, source: "fallback" });
  });
});

describe("isViewMissing", () => {
  it("detects PGRST205 and 404", () => {
    expect(isViewMissing({ code: "PGRST205" })).toBe(true);
    expect(isViewMissing({ status: 404 })).toBe(true);
    expect(isViewMissing({ code: "42501" })).toBe(false);
    expect(isViewMissing(null)).toBe(false);
  });
});

describe("fetchAllViewRows", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
  it("pages until a short page", async () => {
    const calls: Array<[number, number]> = [];
    const total = 2300;
    const rows = await fetchAllViewRows(async (from, to) => {
      calls.push([from, to]);
      return { data: mk(Math.max(0, Math.min(to + 1, total) - from)), error: null };
    });
    expect(rows).toHaveLength(2300);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("returns null on error (including a later page)", async () => {
    expect(await fetchAllViewRows(async () => ({ data: null, error: { code: "PGRST205" } }))).toBeNull();
    let n = 0;
    const r = await fetchAllViewRows(async () =>
      n++ === 0 ? { data: mk(1000), error: null } : { data: null, error: { message: "boom" } }
    );
    expect(r).toBeNull();
  });
});

// ── Cross-check the SQL season/week port against the source of truth ──
// sync-deputy.js is not exported/modifiable here, so extract the three
// functions from its source text and evaluate them.
function loadSyncDeputyRules() {
  const src = fs.readFileSync(path.resolve(__dirname, "../../sync-deputy.js"), "utf8");
  const grab = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in sync-deputy.js`);
    let i = src.indexOf("{", start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  };
  const dow = /const SEASON_WEEK_START_DOW = \d+;/.exec(src)![0];
  const body = [dow, grab("seasonRollDate"), grab("deputySeasonFromDate"), grab("seasonWeekFromDate")].join("\n");
  return new Function(`${body}; return { season: deputySeasonFromDate, week: seasonWeekFromDate };`)() as {
    season: (d: string) => number | null;
    week: (d: string) => number | null;
  };
}

describe("SQL season/week port matches sync-deputy.js and season.ts", () => {
  const js = loadSyncDeputyRules();
  const dates = [
    "2024-12-31", "2025-01-01", "2025-09-30", "2025-10-01", "2025-10-07",
    "2026-01-07", "2026-03-24", "2026-03-25", "2026-09-23", "2026-09-29", "2026-09-30",
    "2026-10-01", "2026-10-06", "2026-10-07", "2026-11-11", "2026-12-31", "2027-01-01",
    "2027-06-15", "2027-09-28", "2027-09-29", "2027-09-30", "2027-10-01", "2028-12-31",
    // 1 Oct on each weekday: 2024 Tue, 2025 Wed, 2026 Thu, 2027 Fri, 2028 Sun, 2029 Mon, 2030 Tue, 2031 Wed, 2032 Fri, 2033 Sat
    ...[2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033].flatMap((y) => [
      `${y}-09-24`, `${y}-09-25`, `${y}-09-26`, `${y}-09-27`, `${y}-09-28`, `${y}-09-29`, `${y}-09-30`,
      `${y}-10-01`, `${y}-10-02`, `${y}-10-07`,
    ]),
  ];
  it("covers all seven weekdays for 1 Oct", () => {
    const dows = new Set([2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033].map((y) => new Date(Date.UTC(y, 9, 1)).getUTCDay()));
    expect(dows.size).toBe(7);
  });
  it.each(dates)("%s", (d) => {
    expect(sqlSeasonOf(d)).toBe(js.season(d));
    expect(sqlSeasonWeekOf(d)).toBe(js.week(d));
    expect(sqlSeasonOf(d)).toBe(seasonOfDate(new Date(`${d}T00:00:00Z`)));
    // Week 1 starts on seasonStart(season) in season.ts.
    const start = seasonStart(sqlSeasonOf(d)).getTime();
    const days = Math.floor((Date.parse(`${d}T00:00:00Z`) - start) / 86400000);
    expect(sqlSeasonWeekOf(d)).toBe(Math.floor(days / 7) + 1);
  });
  it("2027 season starts Wed 2026-09-30", () => {
    expect(sqlSeasonOf("2026-09-29")).toBe(2026);
    expect(sqlSeasonOf("2026-09-30")).toBe(2027);
    expect(sqlSeasonWeekOf("2026-09-30")).toBe(1);
    expect(sqlSeasonWeekOf("2026-10-06")).toBe(1);
    expect(sqlSeasonWeekOf("2026-10-07")).toBe(2);
    expect(new Date(sqlSeasonRollDay(2026) * 86400000).toISOString().slice(0, 10)).toBe("2026-09-30");
  });
});
