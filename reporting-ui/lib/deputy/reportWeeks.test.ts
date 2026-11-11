import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DEPUTY_HISTORY_START,
  deputySeasonOf,
  deputyWeekOf,
  deputySeasonWindows,
  toAreaName,
} from "./reportWeeks";

// Shared fixture list: migration 008's verification query carries the same values.
const FIXTURES: Array<[string, number, number]> = [
  ["2025-03-11", 2025, 24],
  ["2025-09-23", 2025, 52],
  ["2025-09-24", 2025, 53],
  ["2025-09-30", 2025, 53],
  ["2025-10-01", 2026, 1],
  ["2026-03-25", 2026, 26],
  ["2026-09-29", 2026, 52],
  ["2026-09-30", 2027, 1],
  ["2026-10-06", 2027, 1],
  ["2026-10-07", 2027, 2],
];

describe("deputySeasonOf / deputyWeekOf", () => {
  it.each(FIXTURES)("%s -> season %i week %i", (d, season, week) => {
    expect(deputySeasonOf(d)).toBe(season);
    expect(deputyWeekOf(d)).toBe(week);
  });

  it("has no Week 0 and no 2026 special case", () => {
    expect(deputyWeekOf("2026-01-01")).toBe(14);
    expect(deputyWeekOf("2026-03-24")).toBe(25);
  });

  it("returns NaN for an invalid date", () => {
    expect(deputySeasonOf("nope")).toBeNaN();
    expect(deputyWeekOf("2026-02-31")).toBeNaN();
  });
});

describe("cross-checks with the SQL and sync-deputy.js twins", () => {
  const ROOT = path.resolve(__dirname, "../..");

  it("sync-deputy.js gives the same season/week for every fixture", () => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
    process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-key";
    const req = createRequire(import.meta.url);
    const sync = req(path.join(ROOT, "sync-deputy.js"));
    for (const [d, season, week] of FIXTURES) {
      expect(sync.deputySeasonFromDate(d)).toBe(season);
      expect(sync.seasonWeekFromDate(d)).toBe(week);
    }
  });

  it("migration 008 verification list carries the same fixtures", () => {
    const sql = fs.readFileSync(path.join(ROOT, "migrations/008_deputy_all_history_unified_weeks.sql"), "utf8");
    for (const [d, season, week] of FIXTURES) {
      expect(sql).toMatch(new RegExp(`'${d}'[^\\n]*${season}[^\\n]*${week}`));
    }
  });
});

describe("deputySeasonWindows", () => {
  it("starts at the history start and includes 2025", () => {
    expect(DEPUTY_HISTORY_START).toBe("2025-01-01");
    expect(deputySeasonWindows("2025-06-01")).toEqual([
      { season: 2025, from: "2025-01-01", to: "2025-09-30" },
    ]);
  });
  it("adds later seasons as today advances", () => {
    expect(deputySeasonWindows("2026-11-11")).toEqual([
      { season: 2025, from: "2025-01-01", to: "2025-09-30" },
      { season: 2026, from: "2025-10-01", to: "2026-09-29" },
      { season: 2027, from: "2026-09-30", to: "2027-09-28" },
    ]);
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
