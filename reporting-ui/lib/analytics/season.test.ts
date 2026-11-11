import { describe, it, expect } from "vitest";
import {
  seasonStart,
  seasonWeekOfIso,
  parseIsoDate,
  prevSeasonWeek,
  absoluteWeekIndex,
  unionSeasons,
  seasonsFromDates,
  withFixtureWeekTT,
  withFixtureWeekSoccer,
  mapFixtureWeekTT,
  mapFixtureWeekSoccer,
} from "./season";

const CASES: Array<[string, number, number]> = [
  ["2024-09-25", 2025, 1],
  ["2025-03-11", 2025, 24],
  ["2025-09-23", 2025, 52],
  ["2025-09-24", 2025, 53],
  ["2025-09-30", 2025, 53],
  ["2025-10-01", 2026, 1],
  ["2026-01-22", 2026, 17],
  ["2026-03-25", 2026, 26],
  ["2026-09-29", 2026, 52],
  ["2026-09-30", 2027, 1],
  ["2026-10-06", 2027, 1],
  ["2026-10-07", 2027, 2],
];

describe("seasonWeekOfIso", () => {
  it.each(CASES)("%s -> %i W%i", (d, season, week) => {
    expect(seasonWeekOfIso(d)).toEqual({ season, week });
  });
  it("accepts an ISO datetime prefix", () => {
    expect(seasonWeekOfIso("2025-10-01T10:00:00Z")).toEqual({ season: 2026, week: 1 });
  });
  it.each([null, undefined, "", "x", "2026-02-31", "2026-13-01", 5])("%s -> null", (v) => {
    expect(seasonWeekOfIso(v)).toBeNull();
  });
  it("season 2025 starts Wed 2024-09-25", () => {
    expect(seasonStart(2025).toISOString().slice(0, 10)).toBe("2024-09-25");
  });
});

describe("parseIsoDate", () => {
  it("rejects impossible dates", () => {
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("2026-02-28")).not.toBeNull();
  });
});

describe("prevSeasonWeek / absoluteWeekIndex", () => {
  it("steps back within a season", () => {
    expect(prevSeasonWeek(2026, 5)).toEqual({ season: 2026, week: 4 });
  });
  it("crosses a season boundary", () => {
    expect(prevSeasonWeek(2026, 1)).toEqual({ season: 2025, week: 53 });
    expect(prevSeasonWeek(2027, 1)).toEqual({ season: 2026, week: 52 });
  });
  it("is continuous across seasons", () => {
    expect(absoluteWeekIndex(2025, 1)).toBe(0);
    expect(absoluteWeekIndex(2025, 53)).toBe(52);
    expect(absoluteWeekIndex(2026, 1)).toBe(53);
    expect(absoluteWeekIndex(2027, 1)).toBe(53 + 52);
  });
});

describe("unionSeasons / seasonsFromDates", () => {
  it("unions descending and ignores junk", () => {
    expect(unionSeasons([2026, 2025, null], [2027, NaN, 2026], [undefined])).toEqual([2027, 2026, 2025]);
  });
  it("derives from dates with stored fallback", () => {
    const rows = [{ Date: "2025-03-11" }, { Date: "2026-10-01" }, { Date: "bad", season: 2024 }, { Date: null }];
    expect(seasonsFromDates(rows, "Date")).toEqual([2027, 2025, 2024]);
  });
});

describe("withFixtureWeek*", () => {
  it("TT derives season, Week string and week number without mutating", () => {
    const row = { Date: "2026-01-22", Week: "0", season: 2026, x: 1 };
    const out = withFixtureWeekTT(row);
    expect(out).toMatchObject({ season: 2026, Week: "17", week: 17, x: 1 });
    expect(row.Week).toBe("0");
  });
  it("TT keeps stored values when Date is unusable", () => {
    expect(withFixtureWeekTT({ Date: null, Week: "7", season: 2026 })).toMatchObject({
      season: 2026,
      Week: "7",
      week: 7,
    });
    expect(withFixtureWeekTT({ Date: null })).toMatchObject({ season: null, Week: null, week: null });
  });
  it("soccer derives season/week and leaves completed_* alone", () => {
    const out = withFixtureWeekSoccer({ Date: "2026-09-30", week: 9, season: 2026, completed_week: 3 });
    expect(out).toMatchObject({ season: 2027, week: 1, completed_week: 3 });
  });
  it("map helpers apply per row", () => {
    expect(mapFixtureWeekTT([{ Date: "2025-10-01" }])[0].Week).toBe("1");
    expect(mapFixtureWeekSoccer([{ Date: "2025-10-01" }])[0].week).toBe(1);
  });
});
