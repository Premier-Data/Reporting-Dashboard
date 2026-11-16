import { describe, expect, it } from "vitest";
import {
  FALLBACK_EXCLUDED_COMPETITIONS,
  canonicalCompetition,
} from "./competitionNames";
import {
  canManageExclusions,
  exclusionImpact,
  exclusionKeySets,
  fallbackExclusionRows,
  filterExcludedCompetitions,
  type ExclusionRow,
} from "./exclusions";

const row = (kind: "competition" | "team", key: string): ExclusionRow => ({
  id: 1,
  kind,
  key,
  label: key,
  reason: null,
  created_by: null,
  created_at: null,
});

describe("fallbackExclusionRows", () => {
  it("has the 8 competitions with canonical keys", () => {
    const rows = fallbackExclusionRows();
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.key)).toEqual(
      FALLBACK_EXCLUDED_COMPETITIONS.map((n) => canonicalCompetition(n))
    );
    expect(rows.map((r) => r.key)).toEqual([
      "grand finals",
      "influencer games",
      "intra",
      "nmfc academy",
      "perth fl north vs south colts clash",
      "sandringham dragons",
      "sportvot test",
      "vafa c section",
    ]);
    expect(rows.every((r) => r.id === null && r.kind === "competition")).toBe(true);
  });
});

describe("exclusionKeySets", () => {
  it("splits kinds", () => {
    const { competitionKeys, teamKeys } = exclusionKeySets([
      row("competition", "psa"),
      row("team", "sunbury 1"),
    ]);
    expect([...competitionKeys]).toEqual(["psa"]);
    expect([...teamKeys]).toEqual(["sunbury 1"]);
  });
});

describe("filterExcludedCompetitions", () => {
  const games = [
    { Competition: "Intra 2024" },
    { Competition: " intra " },
    { Competition: "VAFA C Section" },
    { Competition: "NGA Practice" },
    { Competition: "AGSV Practise" },
    { Competition: "PSA 2022" },
    { Competition: "Intra Club League" },
  ];
  it("removes listed variants and practice, keeps others", () => {
    const keys = new Set(["intra", "vafa c section"]);
    expect(filterExcludedCompetitions(games, keys).map((g) => g.Competition)).toEqual([
      "PSA 2022",
      "Intra Club League",
    ]);
  });
  it("still excludes practice with an empty key set", () => {
    expect(filterExcludedCompetitions(games, new Set()).map((g) => g.Competition)).toEqual([
      "Intra 2024",
      " intra ",
      "VAFA C Section",
      "PSA 2022",
      "Intra Club League",
    ]);
  });
});

describe("exclusionImpact", () => {
  const games = [
    { Competition: "PSA 2022", home_team: "A", away_team: "B" },
    { Competition: "PSA", home_team: "A", away_team: "C 2024" },
    { Competition: "Other", home_team: "A", away_team: "D" },
  ];
  it("counts competition games and distinct teams", () => {
    expect(exclusionImpact(games, "competition", "psa")).toEqual({ games: 2, teams: 3 });
  });
  it("counts team games", () => {
    expect(exclusionImpact(games, "team", "a")).toEqual({ games: 3, teams: 1 });
    expect(exclusionImpact(games, "team", "c")).toEqual({ games: 1, teams: 1 });
    expect(exclusionImpact(games, "team", "zzz")).toEqual({ games: 0, teams: 0 });
  });
});

describe("canManageExclusions", () => {
  it("allows admin and super_admin only", () => {
    expect(canManageExclusions("admin")).toBe(true);
    expect(canManageExclusions("super_admin")).toBe(true);
    expect(canManageExclusions("analyst")).toBe(false);
    expect(canManageExclusions(null)).toBe(false);
    expect(canManageExclusions(undefined)).toBe(false);
  });
});
