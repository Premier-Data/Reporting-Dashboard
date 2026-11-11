import { describe, it, expect } from "vitest";
import {
  DEPUTY_REPORT_START_DATE,
  deputySeasonOf,
  deputyWeekOf,
  deputySeasonWindows,
  toAreaName,
} from "./reportWeeks";

// Shared fixture list: the SQL migration 007 comments carry the same values.
const FIXTURES: Array<[string, number, number]> = [
  ["2026-01-01", 2026, 0],
  ["2026-03-24", 2026, 0],
  ["2026-03-25", 2026, 1],
  ["2026-03-31", 2026, 1],
  ["2026-04-01", 2026, 2],
  ["2026-09-29", 2026, 27],
  ["2026-09-30", 2027, 1],
  ["2026-10-06", 2027, 1],
  ["2026-10-07", 2027, 2],
];

describe("deputySeasonOf / deputyWeekOf", () => {
  it.each(FIXTURES)("%s -> season %i week %i", (d, season, week) => {
    expect(deputySeasonOf(d)).toBe(season);
    expect(deputyWeekOf(d)).toBe(week);
  });

  it("a 2025 date is before the report cutoff", () => {
    expect("2025-12-31" < DEPUTY_REPORT_START_DATE).toBe(true);
    expect(deputySeasonOf("2025-12-31")).toBe(2026);
  });
});

describe("deputySeasonWindows", () => {
  it("starts 2026 at the cutoff and ends at the roll", () => {
    expect(deputySeasonWindows("2026-05-01")).toEqual([
      { season: 2026, from: "2026-01-01", to: "2026-09-29" },
    ]);
  });
  it("adds 2027 once today is in it", () => {
    expect(deputySeasonWindows("2026-11-11")).toEqual([
      { season: 2026, from: "2026-01-01", to: "2026-09-29" },
      { season: 2027, from: "2026-09-30", to: "2027-09-28" },
    ]);
  });
  it("never goes below 2026", () => {
    expect(deputySeasonWindows("2025-06-01")).toHaveLength(1);
  });
});

describe("toAreaName", () => {
  const map = new Map([["Aussie Rules - Training", "Aussie Rules - Supervising"]]);
  it("maps through the area map", () => {
    expect(toAreaName("Aussie Rules - Training", map)).toBe("Aussie Rules - Supervising");
  });
  it("falls back to the unit name", () => {
    expect(toAreaName("  Managers ", map)).toBe("Managers");
  });
  it("uses the unit name when the mapped label is blank", () => {
    expect(toAreaName("X", new Map([["X", "  "]]))).toBe("X");
  });
  it.each([null, undefined, "", "   ", "0", "4821"])("%s -> Unassigned", (v) => {
    expect(toAreaName(v as string | null | undefined, map)).toBe("Unassigned");
  });
});
