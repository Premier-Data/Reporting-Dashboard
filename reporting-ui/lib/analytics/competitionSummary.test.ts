import { describe, expect, it } from "vitest";
import {
  canonicalCompetition,
  canonicalTeam,
  stripCompetitionYear,
} from "./competitionNames";
import { buildCompetitionSummary } from "./competitionSummary";

describe("stripCompetitionYear", () => {
  it.each([
    ["PSA 2022", "PSA"],
    ["PSA", "PSA"],
    ["Geelong FNL 2024", "Geelong FNL"],
    ["EFNL Premier Division 2023", "EFNL Premier Division"],
    ["Something (2025)", "Something"],
    ["Something [2025]", "Something"],
    ["Foo - 2022", "Foo"],
    ["Foo, 2022", "Foo"],
    ["Foo 2022-23", "Foo"],
    ["Foo 2022/23", "Foo"],
    ["Foo 2022-2023", "Foo"],
    ["2026-27 TIO NTFL Men Premier League", "TIO NTFL Men Premier League"],
    ["(2026) Foo", "Foo"],
    ["TSL ", "TSL"],
    ["EFNL  Under 19s ", "EFNL Under 19s"],
    ["Under 19s", "Under 19s"],
    ["U18", "U18"],
    ["Division 1", "Division 1"],
    ["Girls 16", "Girls 16"],
    ["Under 19s 2024", "Under 19s"],
    ["Sunraysia FNL2023", "Sunraysia FNL"],
    ["U182023", "U182023"],
    ["2022", "2022"],
  ])("%s -> %s", (input, expected) => {
    expect(stripCompetitionYear(input)).toBe(expected);
  });

  it("groups case-insensitively and merges year variants", () => {
    expect(canonicalCompetition("PSA 2022")).toBe(canonicalCompetition("psa "));
  });
});

describe("canonicalTeam", () => {
  it("collapses whitespace and case but keeps numbers", () => {
    expect(canonicalTeam("  Box  Hill ")).toBe("box hill");
    expect(canonicalTeam("Team 18")).toBe("team 18");
    expect(canonicalTeam("Under 19s")).toBe("under 19s");
  });
  it("strips a literal trailing 20xx year", () => {
    expect(canonicalTeam("Foo 2024")).toBe("foo");
  });
});

describe("buildCompetitionSummary", () => {
  const rows = [
    { Date: "2022-05-01", Competition: "PSA 2022", home_team: "A", away_team: "B", home_allocated: "X" },
    { Date: "2023-05-01", Competition: "PSA", home_team: "a", away_team: "C", away_allocated: " " },
    { Date: "2023-06-01", Competition: "PSA ", home_team: "C", away_team: "D", away_allocated: "Y" },
    { Date: "2025-06-01", Competition: "CMFNL 2025", home_team: "E", away_team: "A" },
  ];

  it("tallies totals, seasons and competitions", () => {
    const s = buildCompetitionSummary(rows);
    expect(s.totalCompetitions).toBe(2);
    expect(s.totalTeams).toBe(5);
    expect(s.totalGames).toBe(4);
    expect(s.seasons.map((x) => x.season)).toEqual([2025, 2023, 2022]);
    const y23 = s.seasons.find((x) => x.season === 2023)!;
    expect(y23).toMatchObject({ competitions: 1, newCompetitions: 0, teams: 3, newTeams: 2, games: 2 });
    const psa = s.competitions.find((c) => c.label === "PSA")!;
    expect(psa.rawNames).toEqual(["PSA", "PSA 2022"]);
    expect(psa.seasons).toEqual([2022, 2023]);
    expect(psa.games).toBe(3);
    expect(psa.firstDate).toBe("2022-05-01");
    expect(psa.lastDate).toBe("2023-06-01");
  });

  it("onlyAllocated drops games with no analyst", () => {
    const s = buildCompetitionSummary(rows, { onlyAllocated: true });
    expect(s.totalGames).toBe(2);
    expect(s.totalCompetitions).toBe(1);
  });
});
