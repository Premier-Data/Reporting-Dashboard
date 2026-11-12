import { describe, expect, it } from "vitest";
import { previousWeekWithData, withShiftSeasonWeek } from "./boardReport";
import { buildAnalystMetrics } from "./buildAnalystMetrics";

describe("previousWeekWithData", () => {
  const all = () => true;

  it("steps back within a season", () => {
    expect(previousWeekWithData(2026, 5, all)).toEqual({ season: 2026, week: 4 });
  });

  it("rolls Week 1 into the previous season's last week", () => {
    expect(previousWeekWithData(2026, 1, all)).toEqual({ season: 2025, week: 53 });
    expect(previousWeekWithData(2027, 1, all)).toEqual({ season: 2026, week: 52 });
  });

  it("returns null when the prior week has no data", () => {
    expect(previousWeekWithData(2026, 1, () => false)).toBeNull();
  });
});

describe("withShiftSeasonWeek", () => {
  it("derives season/week from shift_date and keeps rows with bad dates", () => {
    const [a, b] = withShiftSeasonWeek([
      { shift_date: "2025-09-30", season: 2026, week: 1 },
      { shift_date: "nope", season: 2026, week: 7 },
    ]);
    expect(a).toMatchObject({ season: 2025, week: 53 });
    expect(b).toMatchObject({ season: 2026, week: 7 });
  });
});

describe("buildAnalystMetrics week keys", () => {
  it("does not merge the same week number from different seasons", () => {
    const games = [
      { Date: "2025-10-08", home_allocated: "A B", away_allocated: null }, // 2026 W2
      { Date: "2026-10-07", home_allocated: "A B", away_allocated: null }, // 2027 W2
    ] as never[];
    const [a] = buildAnalystMetrics([], games);
    // 1 game over 2 distinct (season, week) buckets = 1 / 2 per week
    expect(a.avgGamesPerWeek).toBe(0.5);
  });
});
