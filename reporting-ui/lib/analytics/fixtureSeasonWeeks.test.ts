import { describe, expect, it } from "vitest";
import {
  defaultSeasonWeek,
  fixtureSeasons,
  matchesSeasonWeek,
  weeksForSeason,
} from "./fixtureSeasonWeeks";
import { absoluteWeekIndex } from "./season";
import { rowAbsoluteWeek, seasonWeekKey } from "./gameWeekIndex";

const games = [
  { Date: "2026-03-25", Week: "0" }, // stored week is ignored: 2026 W26
  { Date: "2026-04-01" }, // 2026 W27
  { Date: "2026-10-07" }, // 2027 W2
  { Date: "2026-10-01" }, // 2027 W1
  { Date: "bad", season: 2026, Week: "5" }, // fallback to stored
];

describe("fixtureSeasonWeeks", () => {
  it("lists seasons newest first", () => {
    expect(fixtureSeasons(games)).toEqual([2027, 2026]);
  });

  it("lists weeks of a season ascending", () => {
    expect(weeksForSeason(games, 2026)).toEqual([5, 26, 27]);
    expect(weeksForSeason(games, 2027)).toEqual([1, 2]);
  });

  it("defaults to the newest season's last week", () => {
    expect(defaultSeasonWeek(games)).toEqual({ season: 2027, week: 2 });
    expect(defaultSeasonWeek([])).toBeNull();
  });

  it("matches by derived season and week", () => {
    expect(matchesSeasonWeek(games[0], 2026, 26)).toBe(true);
    expect(matchesSeasonWeek(games[0], 2027, 26)).toBe(false);
  });
});

describe("gameWeekIndex", () => {
  it("is continuous across the season boundary", () => {
    const lastOf2025 = rowAbsoluteWeek({ Date: "2025-09-30" }); // 2025 W53
    const firstOf2026 = rowAbsoluteWeek({ Date: "2025-10-01" }); // 2026 W1
    expect(firstOf2026 - lastOf2025).toBe(1);
    expect(firstOf2026).toBe(absoluteWeekIndex(2026, 1));
  });

  it("keys by season and week", () => {
    expect(seasonWeekKey({ Date: "2026-10-01" })).toBe("2027-1");
    expect(seasonWeekKey({})).toBeNull();
  });

  it("5-week window crosses seasons correctly", () => {
    const fixture = rowAbsoluteWeek({ Date: "2025-10-08" }); // 2026 W2
    const game = rowAbsoluteWeek({ Date: "2025-09-24" }); // 2025 W53
    expect(game >= fixture - 5 && game < fixture).toBe(true);
  });
});
