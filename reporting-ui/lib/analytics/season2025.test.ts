// Regression: a Deputy-only season (2025: shifts, no games) must not crash the
// pure analytics helpers.
import { describe, it, expect } from "vitest";
import { buildWeeklyReport } from "./weeklyReportBuild";
import { buildAnalystMetrics } from "./buildAnalystMetrics";
import { calculateKPIs } from "@/lib/analytics";
import { seasonsFromDates, unionSeasons } from "./season";

const shifts = Array.from({ length: 10 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 2, 12 + i * 7)).toISOString().slice(0, 10);
  return {
    shift_key: `k${i}`,
    employee_name: "Alice Smith",
    shift_date: d,
    area_name: i % 2 ? "Aussie Rules Home Analyst" : "Soccer Office Analyst",
    total_hours: 8,
    total_cost: 240,
    hourly_rate: 30,
    week: 24 + i,
    season: 2025,
  };
});

describe("season 2025 (Deputy only, no games)", () => {
  it("season list includes 2025 from Deputy dates", () => {
    expect(unionSeasons(seasonsFromDates([], "Date"), seasonsFromDates(shifts, "shift_date"))).toContain(2025);
  });
  it("buildWeeklyReport does not throw with no games / OS rows", () => {
    const r = buildWeeklyReport({ season: 2025, monthly: false, shifts, tt: [], soccer: [], osTeam: [] } as any);
    expect(r.weeks.length).toBeGreaterThan(0);
    const m = buildWeeklyReport({ season: 2025, monthly: true, shifts, tt: [], soccer: [], osTeam: [] } as any);
    expect(m.weeks.length).toBeGreaterThan(0);
  });
  it("analyst metrics are empty (no games) and KPIs still compute", () => {
    expect(buildAnalystMetrics(shifts as any, [])).toEqual([]);
    expect(calculateKPIs(shifts as any).totalHours).toBe(80);
  });
});
