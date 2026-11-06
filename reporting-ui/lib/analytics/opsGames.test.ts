import { describe, it, expect } from "vitest";
import {
  type TTGameRow,
  bandForWeekValue,
  buildOpsGamesReport,
  latestSeason,
  normaliseLocation,
  saturdayOfWedTueWeek,
  seasonsFromGames,
  totalScale,
} from "./opsGames";

let n = 0;
function g(p: Partial<TTGameRow>): TTGameRow {
  n += 1;
  return {
    game_key: `k${n}`,
    Date: "2026-03-25",
    Week: "1",
    season: 2026,
    home_allocated: "A",
    away_allocated: "B",
    Location: "AUS",
    ...p,
  };
}

describe("saturdayOfWedTueWeek", () => {
  it("maps Wed..Tue to the Saturday", () => {
    for (const d of ["2026-03-25", "2026-03-26", "2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]) {
      expect(saturdayOfWedTueWeek(d)).toBe("2026-03-28");
    }
  });
  it("keeps Sun/Mon in the preceding Saturday's week", () => {
    expect(saturdayOfWedTueWeek("2026-06-07")).toBe("2026-06-06");
    expect(saturdayOfWedTueWeek("2026-06-08")).toBe("2026-06-06");
    expect(saturdayOfWedTueWeek("2026-06-09")).toBe("2026-06-06");
    expect(saturdayOfWedTueWeek("2026-06-03")).toBe("2026-06-06");
  });
});

describe("buildOpsGamesReport", () => {
  it("counts half games and totals", () => {
    const rows: TTGameRow[] = [];
    for (let i = 0; i < 79; i++) rows.push(g({ home_allocated: "Aaron", away_allocated: "Z1" }));
    for (let i = 0; i < 58; i++) rows.push(g({ home_allocated: "Z2", away_allocated: "Aaron" }));
    const r = buildOpsGamesReport(rows, 2026);
    const a = r.analysts.find((x) => x.name === "Aaron")!;
    expect([a.home, a.away, a.total]).toEqual([79, 58, 68.5]);
  });

  it("gives 1 game when same analyst has both sides", () => {
    const r = buildOpsGamesReport([g({ home_allocated: "A", away_allocated: "A" })], 2026);
    expect(r.analysts[0].weekly[1]).toBe(1);
    expect(r.analysts[0].total).toBe(1);
  });

  it("buckets by Week column and labels by mode Saturday", () => {
    const rows = [
      g({ Week: "0", Date: "2026-01-24" }),
      g({ Week: "0", Date: "2026-03-18" }),
      g({ Week: "0", Date: "2026-03-21" }),
      g({ Week: "1", Date: "2026-03-29" }), // Sunday stays in week 1
    ];
    const r = buildOpsGamesReport(rows, 2026);
    expect(r.weeks[0]).toMatchObject({ week: 0, saturday: "2026-03-21", label: "Sat 21-Mar" });
    expect(r.weeks[1]).toMatchObject({ week: 1, saturday: "2026-03-28" });
    expect(r.totalsByWeek[0]).toBe(3);
  });

  it("fills gaps and starts at the lowest week", () => {
    const r = buildOpsGamesReport(
      [g({ Week: "1", Date: "2026-10-02" }), g({ Week: "4", Date: "2026-10-23" })],
      2026
    );
    expect(r.weeks.map((w) => w.week)).toEqual([1, 2, 3, 4]);
    expect(r.totalsByWeek[2]).toBe(0);
  });

  it("filters by season and handles many rows", () => {
    const rows: TTGameRow[] = [];
    for (let i = 0; i < 2500; i++) rows.push(g({ season: i % 2 ? 2026 : 2027 }));
    expect(buildOpsGamesReport(rows, 2026).totals.all).toBe(1250);
    expect(buildOpsGamesReport(rows, 2027).totals.all).toBe(1250);
    expect(seasonsFromGames(rows)).toEqual([2027, 2026]);
    expect(latestSeason(rows)).toBe(2027);
    expect(latestSeason([])).toBeNull();
  });

  it("excludes placeholders from analysts but not from totals", () => {
    const r = buildOpsGamesReport(
      [g({ home_allocated: "PREMIER DATA", away_allocated: "ZZ" }), g({ home_allocated: "A", away_allocated: "zz" })],
      2026
    );
    expect(r.analysts.map((a) => a.name)).toEqual(["A"]);
    expect(r.excluded.placeholderHalfGames).toBe(3 * 0.5);
    expect(r.totalsByWeek[1]).toBe(2);
  });

  it("splits locations and pct AUS", () => {
    const r = buildOpsGamesReport(
      [g({ Location: "AUS" }), g({ Location: "PHL" }), g({ Location: "PHL/ AUS" }), g({ Location: null })],
      2026
    );
    expect(r.ausByWeek[1]).toBe(1);
    expect(r.phlByWeek[1]).toBe(1);
    expect(r.totals.mixedOrOther).toBe(2);
    expect(r.pctAusByWeek[1]).toBe(0.25);
  });

  it("pct AUS is null for empty weeks", () => {
    const r = buildOpsGamesReport([g({ Week: "1" }), g({ Week: "3" })], 2026);
    expect(r.pctAusByWeek[2]).toBeNull();
  });

  it("sorts alphabetically case-insensitively and skips bad rows", () => {
    const r = buildOpsGamesReport(
      [
        g({ home_allocated: "bob", away_allocated: "Alice" }),
        g({ Week: "x" }),
        g({ Date: null }),
      ],
      2026
    );
    expect(r.analysts.map((a) => a.name)).toEqual(["Alice", "bob"]);
    expect(r.excluded.skippedRows).toBe(2);
  });
});

describe("helpers", () => {
  it("normaliseLocation", () => {
    expect(normaliseLocation("AUS")).toBe("AUS");
    expect(normaliseLocation("aus ")).toBe("AUS");
    expect(normaliseLocation("PHL")).toBe("PHL");
    for (const s of ["PHL/ AUS", "PHL/AUS", "PHL/ Aus"]) expect(normaliseLocation(s)).toBe("MIXED");
    expect(normaliseLocation(null)).toBe("OTHER");
  });
  it("bandForWeekValue", () => {
    expect([0, 2.5].map(bandForWeekValue)).toEqual(["none", "none"]);
    expect([3, 3.4].map(bandForWeekValue)).toEqual(["amber", "amber"]);
    expect([3.5, 3.9].map(bandForWeekValue)).toEqual(["green", "green"]);
    expect([4, 5.5].map(bandForWeekValue)).toEqual(["blue", "blue"]);
  });
  it("totalScale", () => {
    expect(totalScale(0, 0, 10)).toBe(0);
    expect(totalScale(10, 0, 10)).toBe(1);
    expect(totalScale(5, 0, 10)).toBe(0.5);
    expect(totalScale(5, 5, 5)).toBe(1);
  });
});

describe("week boundary end to end", () => {
  it("keeps a Sunday game in the preceding Saturday's week and labels it", () => {
    const rows = [
      g({ Date: "2026-06-03", Week: "11", home_allocated: "A", away_allocated: "A" }),
      g({ Date: "2026-06-07", Week: "11", home_allocated: "A", away_allocated: "A" }),
      g({ Date: "2026-06-10", Week: "12", home_allocated: "A", away_allocated: "A" }),
    ];
    const r = buildOpsGamesReport(rows, 2026);
    const a = r.analysts.find((x) => x.name === "A")!;
    expect(a.weekly[11]).toBe(2);
    expect(a.weekly[12]).toBe(1);
    expect(r.weeks.find((w) => w.week === 11)!.saturday).toBe("2026-06-06");
  });
});