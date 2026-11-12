import { describe, it, expect } from "vitest";
import { soccerSeasonFor, soccerWeekFor } from "./soccerWeeks";

describe("soccerWeekFor / soccerSeasonFor", () => {
  it("derives season and week from the Date", () => {
    expect(soccerSeasonFor({ Date: "2026-01-22" })).toBe(2026);
    expect(soccerWeekFor({ Date: "2026-01-22" })).toBe(17);
    expect(soccerWeekFor({ Date: "2025-10-01" })).toBe(1);
    expect(soccerWeekFor({ Date: "2026-03-25" })).toBe(26);
  });

  it("rolls over on the Wednesday on/before 1 Oct", () => {
    expect(soccerWeekFor({ Date: "2026-09-29" })).toBe(52);
    expect(soccerSeasonFor({ Date: "2026-09-29" })).toBe(2026);
    expect(soccerWeekFor({ Date: "2026-09-30" })).toBe(1);
    expect(soccerSeasonFor({ Date: "2026-09-30" })).toBe(2027);
  });

  it("handles 53-week season 2025 and has no week 0", () => {
    expect(soccerWeekFor({ Date: "2025-09-30" })).toBe(53);
    expect(soccerWeekFor({ Date: "2025-03-11" })).toBe(24);
    expect(soccerWeekFor({ Date: "2025-10-01" })).not.toBe(0);
  });

  it("ignores stored values when the Date is valid", () => {
    expect(soccerWeekFor({ Date: "2026-03-25", week: 3 })).toBe(26);
    expect(soccerSeasonFor({ Date: "2026-03-25", season: 2099 })).toBe(2026);
  });

  it("falls back to stored values only when the Date is unusable", () => {
    expect(soccerWeekFor({ Date: null, week: 7 })).toBe(7);
    expect(soccerWeekFor({ Date: "nope", week: "9" })).toBe(9);
    expect(soccerSeasonFor({ Date: null, season: 2026 })).toBe(2026);
    expect(soccerWeekFor({ Date: null, week: "x" })).toBeNull();
    expect(soccerSeasonFor({})).toBeNull();
  });
});
