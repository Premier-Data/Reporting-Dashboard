import { describe, it, expect } from "vitest";
import {
  type SoccerGameRow,
  buildSoccerOpsReport,
  soccerLocationKey,
  soccerSeasons,
} from "./opsSoccer";

let n = 0;
function s(p: Partial<SoccerGameRow>): SoccerGameRow {
  n += 1;
  return {
    game_key: `s${n}`,
    Date: "2026-03-25", // season 2026, W26
    season: 2026,
    week: 99,
    home_allocated: "A",
    away_allocated: "B",
    Location: "VN",
    ...p,
  };
}

describe("soccerLocationKey", () => {
  it("keeps clean codes and sends everything else to Mixed", () => {
    expect(soccerLocationKey(" vn ")).toBe("VN");
    expect(soccerLocationKey("AUS")).toBe("AUS");
    expect(soccerLocationKey("AUS/ VN")).toBe("Mixed");
    expect(soccerLocationKey("")).toBe("Mixed");
    expect(soccerLocationKey(null)).toBe("Mixed");
  });
});

describe("buildSoccerOpsReport", () => {
  it("counts half games per side and 1 when same analyst on both", () => {
    const rows = [
      s({ home_allocated: "Aaron", away_allocated: "Z1" }),
      s({ home_allocated: "Z2", away_allocated: "Aaron" }),
      s({ home_allocated: "Bob", away_allocated: "Bob" }),
    ];
    const r = buildSoccerOpsReport(rows, 2026);
    const a = r.analysts.find((x) => x.name === "Aaron")!;
    expect([a.home, a.away, a.total, a.weekly[26]]).toEqual([1, 1, 1, 1]);
    const b = r.analysts.find((x) => x.name === "Bob")!;
    expect([b.home, b.away, b.total, b.weekly[26]]).toEqual([1, 1, 1, 1]);
  });

  it("location rows plus Mixed equal Total for every week, ordered by size", () => {
    const rows = [
      s({ Location: "VN" }),
      s({ Location: "VN" }),
      s({ Location: "VN", Date: "2026-04-01" }),
      s({ Location: "AUS", Date: "2026-04-01" }),
      s({ Location: "AUS/ VN", Date: "2026-04-09" }),
      s({ Location: "PHL", Date: "2026-04-09" }),
      s({ Location: null, Date: "2026-04-09" }),
    ];
    const r = buildSoccerOpsReport(rows, 2026);
    expect(r.locations.map((l) => l.key)).toEqual(["VN", "AUS", "PHL", "Mixed"]);
    for (const w of r.weeks) {
      const sum = r.locations.reduce((t, l) => t + (l.byWeek[w.week] ?? 0), 0);
      expect(sum).toBe(r.totalsByWeek[w.week]);
    }
    expect(r.locations.reduce((t, l) => t + l.total, 0)).toBe(r.totals.all);
    expect(r.totals.all).toBe(rows.length);
  });

  it("buckets weeks by Date and labels by week-ending Saturday", () => {
    const rows = [
      s({ Date: "2026-03-20" }), // W25
      s({ Date: "2026-03-28" }), // W26
      s({ Date: "2026-04-02" }), // W27
    ];
    const r = buildSoccerOpsReport(rows, 2026);
    expect(r.weeks.map((w) => [w.week, w.label])).toEqual([
      [25, "Sat 21-Mar"],
      [26, "Sat 28-Mar"],
      [27, "Sat 04-Apr"],
    ]);
    expect(r.totalsByWeek).toEqual({ 25: 1, 26: 1, 27: 1 });
  });

  it("derives season and week from Date, ignoring wrong stored values", () => {
    // stored season 2030 / week 5 disagree with the date (2030-04-10 is season 2030 W28 by rule)
    const r = buildSoccerOpsReport([s({ season: 2026, week: 5, Date: "2030-04-10" })], 2030);
    expect(r.totals.all).toBe(1);
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].week).not.toBe(5);
  });

  it("runs the 2027 grid from W1 for games after 30 Sep 2026", () => {
    const r = buildSoccerOpsReport(
      [s({ Date: "2026-09-30", season: 2026 }), s({ Date: "2026-10-07", season: 2026 })],
      2027
    );
    expect(r.weeks.map((w) => w.week)).toEqual([1, 2]);
  });

  it("filters by season and lists seasons newest first", () => {
    const rows = [s({}), s({ season: 2025, Date: "2025-04-02" }), s({ season: 2027, Date: "2026-10-07" })];
    expect(soccerSeasons(rows)).toEqual([2027, 2026, 2025]);
    expect(buildSoccerOpsReport(rows, 2026).totals.all).toBe(1);
  });

  it("excludes ZZ from analyst rows but counts it in totals; shows PREMIER DATA", () => {
    const rows = [
      s({ home_allocated: "ZZ", away_allocated: "PREMIER DATA" }),
      s({ home_allocated: " ", away_allocated: "Cat" }),
    ];
    const r = buildSoccerOpsReport(rows, 2026);
    expect(r.analysts.map((a) => a.name).sort()).toEqual(["Cat", "PREMIER DATA"]);
    expect(r.excluded.placeholderHalfGames).toBe(0.5);
    expect(r.totalsByWeek[26]).toBe(2);
  });

  it("skips rows that cannot be bucketed", () => {
    const r = buildSoccerOpsReport([s({ Date: null }), s({})], 2026);
    expect(r.excluded.skippedRows).toBe(1);
    expect(r.totals.all).toBe(1);
  });
});
