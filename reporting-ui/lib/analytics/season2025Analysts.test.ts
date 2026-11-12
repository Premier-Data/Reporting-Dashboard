// Season 2025 in the analyst builders: games + Deputy API hours, a 2025-only
// analyst (not in the analysts table), placeholders, and the season list.
import { describe, it, expect } from "vitest";
import { buildAnalystMetrics } from "./buildAnalystMetrics";
import { isExcludedAnalystName } from "./excludedAnalysts";
import { mapFixtureWeekTT, seasonsFromDates, seasonsFromTT, unionSeasons } from "./season";
import { weekBucket } from "./gameWeekIndex";
import { buildOpsGamesReport, seasonsFromGames, type TTGameRow } from "./opsGames";

const game = (i: number, date: string, home: string | null, away: string | null) => ({
  id: i,
  game_key: `k${i}`,
  Date: date,
  Week: "0",
  season: 2026, // stale stored value: the date must win
  Competition: "EDFL Div 2 2025",
  home_team: "H",
  away_team: "A",
  home_allocated: home,
  away_allocated: away,
});

const shift = (name: string, date: string) => ({
  shift_key: `${name}-${date}`,
  employee_name: name,
  shift_date: date,
  area_name: "Aussie Rules Home Analyst",
  total_hours: 8,
  total_cost: 240,
});

const games2025 = mapFixtureWeekTT([
  game(1, "2025-05-10", "Gone Analyst", "William Purssey"),
  game(2, "2025-05-17", "Gone Analyst", "PH1"),
  game(3, "2025-06-14", "AUS", "William Purssey"),
]);
const shifts2025 = [shift("William Purssey", "2025-05-12"), shift("William Purssey", "2025-06-16")];

describe("analyst metrics for season 2025", () => {
  const m = buildAnalystMetrics(shifts2025 as any, games2025 as any);
  const by = (n: string) => m.find((x) => x.name === n)!;

  it("derives season 2025 from the fixture date", () => {
    expect(games2025.every((g: any) => g.season === 2025)).toBe(true);
    expect(weekBucket(games2025[0] as any)).toMatchObject({ season: 2025, week: 33 });
  });

  it("counts 2025 games and Deputy API hours", () => {
    expect(by("William Purssey").totalGames).toBe(1);
    expect(by("William Purssey").totalHours).toBe(16);
    expect(by("William Purssey").avgHoursPerWeek).toBe(8);
  });

  it("a 2025-only analyst with no Deputy shifts still builds a profile", () => {
    const a = by("Gone Analyst");
    expect(a.totalGames).toBe(1);
    expect(a.totalHours).toBe(0);
    expect(a.avgHoursPerWeek).toBe(0);
    expect(a.avgGamesPerWeek).toBeGreaterThan(0);
  });

  it("excludes the PH*/AUS placeholders", () => {
    expect(m.map((x) => x.name).sort()).toEqual(["Gone Analyst", "William Purssey"]);
    for (const n of ["PH1", "ph8", " AUS ", "Premier Data"]) expect(isExcludedAnalystName(n)).toBe(true);
    for (const n of ["Phil", "Ausra", "Ph", "Ganesha C"]) expect(isExcludedAnalystName(n)).toBe(false);
  });
});

describe("season lists include 2025 from TT data", () => {
  it("unions TT dates with Deputy dates and TT season column", () => {
    expect(unionSeasons(seasonsFromDates(games2025, "Date"), seasonsFromDates([], "shift_date"))).toEqual([2025]);
    expect(
      unionSeasons(seasonsFromDates(games2025, "Date"), seasonsFromDates([{ Date: "2026-04-01" }], "Date"))
    ).toEqual([2026, 2025]);
    expect(seasonsFromTT(games2025).years).toEqual([2025]);
  });

  it("Ops Games tab offers and builds season 2025", () => {
    const rows: TTGameRow[] = games2025.map((g: any) => ({
      game_key: g.game_key,
      Date: g.Date,
      Week: g.Week,
      season: g.season,
      home_allocated: g.home_allocated,
      away_allocated: g.away_allocated,
      Location: "AUS",
    })) as TTGameRow[];
    expect(seasonsFromGames(rows)).toContain(2025);
    const r = buildOpsGamesReport(rows, 2025);
    expect(r.analysts.find((a) => a.name === "Gone Analyst")).toBeTruthy();
    expect(r.analysts.find((a) => a.name === "PH1")).toBeUndefined();
    expect(r.analysts.find((a) => a.name === "AUS")).toBeUndefined();
  });
});
