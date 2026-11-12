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
    expect(r.analysts[0].weekly[26]).toBe(1);
    expect(r.analysts[0].total).toBe(1);
  });

  it("derives weeks from Date (not the stored Week) and labels by mode Saturday", () => {
    const rows = [
      g({ Week: "0", Date: "2026-01-22" }), // season 2026 W17
      g({ Week: "0", Date: "2026-03-18" }), // W25
      g({ Week: "0", Date: "2026-03-21" }), // W25
      g({ Week: "1", Date: "2026-03-29" }), // Sunday stays in W26
    ];
    const r = buildOpsGamesReport(rows, 2026);
    expect(r.weeks.map((w) => w.week)).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
    expect(r.weeks.find((w) => w.week === 25)).toMatchObject({ saturday: "2026-03-21", label: "Sat 21-Mar" });
    expect(r.weeks.find((w) => w.week === 26)).toMatchObject({ saturday: "2026-03-28" });
    expect(r.totalsByWeek[25]).toBe(2);
    expect(r.totalsByWeek[20]).toBe(0);
  });

  it("a 2026-01-22 game is W17 and the grid runs W17..W52 with zero fill, no week 0", () => {
    const r = buildOpsGamesReport(
      [g({ Date: "2026-01-22", Week: "0" }), g({ Date: "2026-09-29", Week: "52" })],
      2026
    );
    expect(r.weeks[0].week).toBe(17);
    expect(r.weeks[r.weeks.length - 1].week).toBe(52);
    expect(r.weeks).toHaveLength(36);
    expect(r.weeks.some((w) => w.week === 0)).toBe(false);
    expect(r.totalsByWeek[30]).toBe(0);
  });

  it("fills gaps and starts at the lowest week", () => {
    const r = buildOpsGamesReport(
      [g({ Date: "2026-03-25" }), g({ Date: "2026-04-15" })],
      2026
    );
    expect(r.weeks.map((w) => w.week)).toEqual([26, 27, 28, 29]);
    expect(r.totalsByWeek[27]).toBe(0);
  });
  it("filters by season and handles many rows", () => {
    const rows: TTGameRow[] = [];
    for (let i = 0; i < 2500; i++) rows.push(g(i % 2 ? { season: 2026 } : { season: 2027, Date: "2026-10-07" }));
    expect(buildOpsGamesReport(rows, 2026).totals.all).toBe(1250);
    expect(buildOpsGamesReport(rows, 2027).totals.all).toBe(1250);
    expect(seasonsFromGames(rows)).toEqual([2027, 2026]);
    expect(latestSeason(rows)).toBe(2027);
    expect(latestSeason([])).toBeNull();
    // season comes from Date, so a wrong stored season does not matter
    expect(seasonsFromGames([g({ season: 2025, Date: "2026-03-25" })])).toEqual([2026]);
  });

  it("keeps PREMIER DATA as an analyst row but excludes ZZ", () => {
    const r = buildOpsGamesReport(
      [g({ home_allocated: " premier  data ".replace("  ", " "), away_allocated: "ZZ" }), g({ home_allocated: "A", away_allocated: "zz" })],
      2026
    );
    expect(r.analysts.map((a) => a.name.trim())).toEqual(["A", "premier data"]);
    expect(r.analysts.find((a) => a.name.trim() === "premier data")!.total).toBe(0.5);
    expect(r.excluded.placeholderHalfGames).toBe(2 * 0.5);
    expect(r.totalsByWeek[26]).toBe(2);
    expect(r.totals.all).toBe(2);
  });

  it("splits locations and pct AUS", () => {
    const r = buildOpsGamesReport(
      [g({ Location: "AUS" }), g({ Location: "PHL" }), g({ Location: "PHL/ AUS" }), g({ Location: null })],
      2026
    );
    expect(r.ausByWeek[26]).toBe(1);
    expect(r.phlByWeek[26]).toBe(1);
    expect(r.mixedByWeek[26]).toBe(2);
    expect(r.totals.mixed).toBe(2);
    expect(r.pctAusByWeek[26]).toBe(0.25);
  });

  it("AUS + PHL + Mixed equals total per week and overall", () => {
    const r = buildOpsGamesReport(
      [
        g({ Date: "2026-03-25", Location: "AUS" }),
        g({ Date: "2026-03-26", Location: "PHL/ AUS" }),
        g({ Date: "2026-04-01", Location: "PHL" }),
        g({ Date: "2026-04-02", Location: "Elsewhere" }),
        g({ Date: "2026-04-08", Location: "AUS" }),
      ],
      2026
    );
    for (const w of r.weeks.map((x) => x.week))
      expect(r.ausByWeek[w] + r.phlByWeek[w] + r.mixedByWeek[w]).toBe(r.totalsByWeek[w]);
    expect(r.totals.aus + r.totals.phl + r.totals.mixed).toBe(r.totals.all);
  });
  it("pct AUS is null for empty weeks", () => {
    const r = buildOpsGamesReport([g({ Date: "2026-03-25" }), g({ Date: "2026-04-08" })], 2026);
    expect(r.pctAusByWeek[27]).toBeNull();
  });

  it("sorts alphabetically case-insensitively and skips bad rows", () => {
    const r = buildOpsGamesReport(
      [
        g({ home_allocated: "bob", away_allocated: "Alice" }),
        g({ Date: "not-a-date", Week: "x" }),
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
    expect(a.weekly[36]).toBe(2);
    expect(a.weekly[37]).toBe(1);
    expect(r.weeks.find((w) => w.week === 36)!.saturday).toBe("2026-06-06");
  });
});