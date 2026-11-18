import { describe, expect, it } from "vitest";
import {
  canonicalCompetition,
  canonicalTeam,
  isExcludedCompetition,
  isPracticeCompetition,
  stripCompetitionYear,
} from "./competitionNames";

describe("isExcludedCompetition", () => {
  it.each([
    ["Grand Finals", true],
    ["Influencer Games 2024", true],
    ["Influencer Games", true],
    ["Intra 2025", true],
    ["NMFC Academy", true],
    ["Perth FL North vs South Colts Clash", true],
    ["Sandringham Dragons", true],
    ["SportVot Test 2025", true],
    ["VAFA C Section 1998", true],
    ["vafa c section", true],
    ["NGA Practice", true],
    ["Intra Club League", false],
    ["Sandringham Dragons Girls", false],
    ["VAFA Prem C", false],
    ["EFNL Premier Division 2023", false],
  ])("%s -> %s", (name, expected) => {
    expect(isExcludedCompetition(name)).toBe(expected);
  });
});
import { buildCompetitionSummary, countExcludedCompetitionGames } from "./competitionSummary";
import { filterExcludedCompetitions } from "./exclusions";

describe("isPracticeCompetition", () => {
  it.each([
    ["NGA Practice", true],
    ["Practice Kilsyth", true],
    ["VAFA Practice 2025", true],
    ["VFL Practice Games", true],
    ["practice  macedon", true],
    ["AGSV Practise", true],
    ["EFNL Premier Division", false],
    ["Practicalities League", false],
    ["", false],
    [null, false],
  ])("%s -> %s", (name, expected) => {
    expect(isPracticeCompetition(name)).toBe(expected);
  });
});

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

describe("buildCompetitionSummary returning / dropped / running", () => {
  // Seasons are Oct-Sep; use mid-year dates. Season 2022..2025.
  // ALWAYS: every season. DROPS: 2022-2023 only. GAP: 2022 and 2024 (revived). N22..N25: one new each.
  const g = (y: number, comp: string, h: string, a: string, alloc = "X") => ({
    Date: `${y}-06-01`,
    Competition: comp,
    home_team: h,
    away_team: a,
    home_allocated: alloc,
  });
  const rows = [
    g(2022, "ALWAYS", "t1", "t2"), g(2022, "DROPS", "t3", "t4"), g(2022, "GAP", "t5", "t6"), g(2022, "N22", "t7", "t8", ""),
    g(2023, "ALWAYS", "t1", "t2"), g(2023, "DROPS", "t3", "t9"), g(2023, "N23", "t10", "t11"),
    g(2024, "ALWAYS", "t1", "t2"), g(2024, "GAP", "t5", "t6"), g(2024, "N24", "t12", "t13"),
    g(2025, "ALWAYS", "t1", "t2"), g(2025, "GAP", "t5", "t12"), g(2025, "N25", "t14", "t15"),
  ];

  it("computes returning, revived, dropped and running", () => {
    const s = buildCompetitionSummary(rows);
    const by = (y: number) => s.seasons.find((x) => x.season === y)!;
    expect(by(2022)).toMatchObject({ competitions: 4, newCompetitions: 4, returningCompetitions: 0, droppedCompetitions: 0, runningCompetitions: 4 });
    expect(by(2023)).toMatchObject({ competitions: 3, newCompetitions: 1, returningCompetitions: 2, revivedCompetitions: 0, droppedCompetitions: 2, runningCompetitions: 5 });
    expect(by(2024)).toMatchObject({ competitions: 3, newCompetitions: 1, returningCompetitions: 2, revivedCompetitions: 1, droppedCompetitions: 2, runningCompetitions: 6 });
    expect(by(2025)).toMatchObject({ competitions: 3, newCompetitions: 1, returningCompetitions: 2, revivedCompetitions: 0, droppedCompetitions: 1, runningCompetitions: 7 });
    expect(by(2024).returningTeams).toBe(by(2024).teams - by(2024).newTeams);
  });

  it("identity holds every season and running total ends at total unique", () => {
    const s = buildCompetitionSummary(rows);
    const asc = [...s.seasons].reverse();
    asc.forEach((cur, i) => {
      expect(cur.competitions).toBe(cur.newCompetitions + cur.returningCompetitions);
      expect(cur.teams).toBe(cur.newTeams + cur.returningTeams);
      if (i === 0) return;
      const p = asc[i - 1];
      expect(cur.competitions).toBe(p.competitions - cur.droppedCompetitions + cur.newCompetitions + cur.revivedCompetitions);
      expect(cur.teams).toBe(p.teams - cur.droppedTeams + cur.newTeams + cur.revivedTeams);
      expect(cur.runningCompetitions).toBe(p.runningCompetitions + cur.newCompetitions);
      expect(cur.runningTeams).toBe(p.runningTeams + cur.newTeams);
    });
    expect(s.seasons[0].runningCompetitions).toBe(s.totalCompetitions);
    expect(s.seasons[0].runningTeams).toBe(s.totalTeams);
  });

  it("onlyAllocated recomputes everything", () => {
    const s = buildCompetitionSummary(rows, { onlyAllocated: true });
    const by = (y: number) => s.seasons.find((x) => x.season === y)!;
    expect(by(2022)).toMatchObject({ competitions: 3, runningCompetitions: 3 });
    expect(by(2023)).toMatchObject({ competitions: 3, newCompetitions: 1, droppedCompetitions: 1, runningCompetitions: 4 });
    expect(s.seasons[0].runningCompetitions).toBe(s.totalCompetitions);
  });

  it("treats a missing season as skipped (prev = nearest earlier present)", () => {
    const s = buildCompetitionSummary([g(2022, "A", "a", "b"), g(2024, "B", "c", "d")]);
    expect(s.seasons[0]).toMatchObject({ season: 2024, droppedCompetitions: 1, newCompetitions: 1, runningCompetitions: 2 });
  });
});
describe("buildCompetitionSummary teams", () => {
  const row = (Date: string, Competition: string, h: string, a: string, alloc = "X") => ({
    Date,
    Competition,
    home_team: h,
    away_team: a,
    home_allocated: alloc,
  });
  const rows = [
    row("2022-05-01", "PSA 2022", "Doncaster", "Box Hill"),
    row("2023-05-01", "PSA", "doncaster  2023", "Box Hill"),
    row("2023-05-08", "Other League", "Box Hill", "Doncaster", ""),
    row("2023-05-15", "Other League", "Solo", "SOLO"),
  ];
  const s = buildCompetitionSummary(rows);
  const team = (k: string) => s.teams.find((t) => t.key === k)!;

  it("merges spelling, case and trailing-year variants", () => {
    expect(s.teams.map((t) => t.key)).toEqual(["box hill", "doncaster", "solo"]);
    const d = team("doncaster");
    expect(d.label).toBe("Doncaster");
    expect(d.rawNames).toEqual(["Doncaster", "doncaster 2023"]);
    expect(s.totalTeams).toBe(s.teams.length);
  });

  it("counts games, home/away, competitions and seasons", () => {
    const d = team("doncaster");
    expect(d).toMatchObject({ games: 3, homeGames: 2, awayGames: 1, competitions: 2, seasons: [2022, 2023] });
    expect(d.competitionLabels).toEqual(["Other League", "PSA"]);
    expect(d.firstDate).toBe("2022-05-01");
    expect(d.lastDate).toBe("2023-05-08");
  });

  it("counts a team playing both sides of one game once", () => {
    expect(team("solo")).toMatchObject({ games: 1, homeGames: 1, awayGames: 1, competitions: 1 });
  });

  it("respects onlyAllocated", () => {
    const a = buildCompetitionSummary(rows, { onlyAllocated: true });
    expect(a.teams.find((t) => t.key === "doncaster")!.games).toBe(2);
    expect(a.teams.find((t) => t.key === "box hill")!.games).toBe(2);
    expect(a.totalTeams).toBe(a.teams.length);
  });
});
describe("buildCompetitionSummary team exclusions", () => {
  const g = (Competition: string, Date: string, home_team: string, away_team: string) => ({
    Competition,
    Date,
    home_team,
    away_team,
  });
  const rows = [
    g("League X", "2024-04-06", "A", "B"),
    g("League X", "2024-04-13", "A 2024", "C"),
    g("League Y", "2025-04-05", "B", "C"),
  ];

  it("removes an excluded team from team stats but keeps games and competitions", () => {
    const base = buildCompetitionSummary(rows);
    const s = buildCompetitionSummary(rows, { excludedTeamKeys: new Set(["a"]) });
    expect(base.totalTeams).toBe(3);
    expect(s.totalTeams).toBe(2);
    expect(s.teams.map((t) => t.key)).toEqual(["b", "c"]);
    expect(s.totalGames).toBe(base.totalGames);
    expect(s.totalCompetitions).toBe(base.totalCompetitions);
    const s24 = s.seasons.find((x) => x.season === 2024)!;
    expect(s24.teams).toBe(2);
    expect(s24.newTeams).toBe(2);
    expect(s24.games).toBe(2);
    expect(s.seasons.find((x) => x.season === 2025)!.runningTeams).toBe(2);
    const x = s.competitions.find((c) => c.key === "league x")!;
    expect(x.games).toBe(2);
    // flagged decision: per-competition team counts drop the excluded team
    expect(x.teams).toBe(2);
    // opponent keeps the game, side and competition
    const b = s.teams.find((t) => t.key === "b")!;
    expect(b.games).toBe(2);
    expect(b.awayGames).toBe(1);
    expect(b.homeGames).toBe(1);
  });

  it("matches year/case/space variants by canonical key", () => {
    const s = buildCompetitionSummary(
      [g("L", "2024-04-06", "Sunbury 1 2024", "Z"), g("L", "2024-04-13", " SUNBURY 1 ", "Z")],
      { excludedTeamKeys: ["sunbury 1"] }
    );
    expect(s.teams.map((t) => t.key)).toEqual(["z"]);
    expect(s.teams[0].games).toBe(2);
  });

  it("accepts Set, array, empty and undefined", () => {
    const n = (o?: any) => buildCompetitionSummary(rows, o).teams.length;
    expect(n({ excludedTeamKeys: ["a"] })).toBe(2);
    expect(n({ excludedTeamKeys: new Set(["a"]) })).toBe(2);
    expect(n({ excludedTeamKeys: [] })).toBe(3);
    expect(n({})).toBe(3);
    expect(n()).toBe(3);
  });

  it("competition exclusion via pre-filter drops teams only found there", () => {
    const all = [
      g("Intra", "2024-04-06", "Only", "Both"),
      g("Real", "2024-04-13", "Both", "Other"),
    ];
    const kept = filterExcludedCompetitions(all, new Set(["intra"]));
    const s = buildCompetitionSummary(kept);
    expect(s.teams.map((t) => t.key)).toEqual(["both", "other"]);
    expect(s.teams.find((t) => t.key === "both")!.games).toBe(1);
  });
});

describe("TeamEntry primary competition", () => {
  const g = (Competition: string | null, Date: string, home_team: string, away_team = "Opp") => ({
    Competition,
    Date,
    home_team,
    away_team,
  });
  const team = (rows: any[], key: string) =>
    buildCompetitionSummary(rows).teams.find((t) => t.key === key)!;

  it("most games wins and the list is sorted desc with merged year variants", () => {
    const t = team(
      [
        g("PSA", "2023-04-01", "T"),
        g("PSA 2022", "2022-04-01", "T"),
        g("Other", "2024-04-01", "T"),
      ],
      "t"
    );
    expect(t.primaryCompetition).toBe("PSA");
    expect(t.competitionsWithGames).toEqual([
      { label: "PSA", games: 2 },
      { label: "Other", games: 1 },
    ]);
  });

  it("tie goes to the most recent game", () => {
    const t = team([g("Old", "2023-04-01", "T"), g("New", "2024-04-01", "T")], "t");
    expect(t.primaryCompetition).toBe("New");
  });

  it("full tie goes to label A-Z", () => {
    const t = team([g("Beta", "2024-04-01", "T"), g("Alpha", "2024-04-01", "T")], "t");
    expect(t.primaryCompetition).toBe("Alpha");
  });

  it("no competition name gives an empty primary competition", () => {
    const t = team([g(null, "2024-04-01", "T")], "t");
    expect(t.primaryCompetition).toBe("");
    expect(t.competitionsWithGames).toEqual([]);
  });
});

describe("countExcludedCompetitionGames", () => {
  const g = (Competition: string, home_team = "H", away_team = "A", home_allocated = "X") => ({
    Date: "2024-05-01",
    Competition,
    home_team,
    away_team,
    home_allocated,
  });
  const rows = [
    g("PSA 2022"),
    g("PSA"),
    g("Keep League"),
    g("Keep League", "TeamX", "B"),
    g("NGA Practice"),
    g("Practise Kilsyth 2025"),
    g("Intra", "H", "A", ""),
  ];
  const keys = new Set(["psa", "intra"]);

  it("counts manual (normalised names) and practice separately", () => {
    expect(countExcludedCompetitionGames(rows, keys)).toEqual({
      excludedGames: 5,
      manualGames: 3,
      practiceGames: 2,
    });
  });

  it("does not count team exclusions", () => {
    const s = buildCompetitionSummary(filterExcludedCompetitions(rows, keys), { excludedTeamKeys: ["teamx"] });
    expect(s.totalGames).toBe(2);
    expect(countExcludedCompetitionGames(rows, keys).excludedGames).toBe(5);
  });

  it("included + excluded = all rows", () => {
    const inc = buildCompetitionSummary(filterExcludedCompetitions(rows, keys)).totalGames;
    expect(inc + countExcludedCompetitionGames(rows, keys).excludedGames).toBe(rows.length);
  });

  it("restoring a competition lowers the excluded count; onlyAllocated applies", () => {
    expect(countExcludedCompetitionGames(rows, new Set(["psa"])).excludedGames).toBe(4);
    expect(countExcludedCompetitionGames(rows, keys, { onlyAllocated: true }).excludedGames).toBe(4);
  });
});

import { countExcludedEntities } from "./competitionSummary";

describe("countExcludedEntities", () => {
  const g = (Competition: string, home_team: string, away_team: string, home_allocated = "X") => ({
    Date: "2024-05-01",
    Competition,
    home_team,
    away_team,
    home_allocated,
  });
  const rows = [
    g("PSA 2022", "Alpha 2022", "Beta"),
    g("PSA", "Alpha", "Gamma"),
    g("Keep League", "Delta", "Epsilon"),
    g("Keep League", "Both", "Delta"),
    g("PSA", "Both", "Zeta"),
    g("NGA Practice", "Prac FC", "Beta"),
    g("Practise Kilsyth 2025", "Prac FC", "Other", ""),
    g("Keep League", "Expl", "Delta"),
  ];
  const comps = new Set(["psa"]);
  const teams = new Set(["expl"]);
  const all = (r = rows, o = {}) => countExcludedEntities(r, new Set<string>(), [], o);

  it("counts normalised PSA / PSA 2022 once, manual and practice separately", () => {
    const c = countExcludedEntities(rows, comps, teams);
    expect(c.manualCompetitions).toBe(1);
    expect(c.practiceCompetitions).toBe(2);
    expect(c.excludedCompetitions).toBe(3);
  });

  it("teams: explicit, only-in-excluded, and in-both stays included", () => {
    const c = countExcludedEntities(rows, comps, teams);
    expect(c.explicitTeams).toBe(1); // expl
    // alpha, gamma, zeta, beta? (beta only in excluded comps), prac fc, other
    expect(c.teamsOnlyInExcludedCompetitions).toBe(6);
    expect(c.excludedTeams).toBe(7);
    // "both" plays in Keep League so stays included
    const s = buildCompetitionSummary(filterExcludedCompetitions(rows, comps), { excludedTeamKeys: teams });
    expect(s.teams.map((t) => t.key)).toContain("both");
  });

  it("included + excluded = unique total with no exclusions", () => {
    const inc = buildCompetitionSummary(filterExcludedCompetitions(rows, comps), { excludedTeamKeys: teams });
    const none = buildCompetitionSummary(rows);
    const c = countExcludedEntities(rows, comps, teams);
    expect(inc.totalTeams + c.excludedTeams).toBe(none.totalTeams);
    expect(inc.totalCompetitions + c.excludedCompetitions).toBe(none.totalCompetitions);
  });

  it("no exclusions -> practice only; restoring lowers counts; onlyAllocated applies", () => {
    expect(all().excludedCompetitions).toBe(2);
    expect(countExcludedEntities(rows, comps, teams, { onlyAllocated: true }).practiceCompetitions).toBe(1);
  });
});
