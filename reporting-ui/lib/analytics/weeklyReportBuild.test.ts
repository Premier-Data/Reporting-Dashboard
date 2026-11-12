import { describe, expect, it } from "vitest";
import { buildWeeklyReport, osActive } from "./weeklyReportBuild";
import { seasonWeekRange, unionSeasons, seasonsFromDates } from "./season";

type Row = Record<string, unknown>;

const shift = (week: number, date: string, area = "Aussie Rules - Home Analyst", cost = 100, hours = 5): Row => ({
  season: 2025, week, shift_date: date, area_name: area, total_cost: cost, total_hours: hours,
});

const legacyPhl: Row = { location: "Philippines", kind: "team", weekly_cost: 700, start_season: 2026, start_week: 2 };
const newPhl: Row = { ...legacyPhl, start_date: "2026-04-01", start_week: 27 };
const legacyVn: Row = { location: "Vietnam", kind: "team", weekly_cost: 400, start_season: 2026, start_week: 17 };
const newVn: Row = { ...legacyVn, start_date: "2026-07-15", start_week: 42 };

function noNaN(v: unknown): void {
  if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
  else if (v && typeof v === "object") for (const x of Object.values(v)) noNaN(x);
}

describe("buildWeeklyReport, Deputy-only season 2025", () => {
  const shifts: Row[] = [];
  for (let w = 24; w <= 53; w++) {
    const d = seasonWeekRange(2025, w).start.toISOString().slice(0, 10);
    shifts.push(shift(w, d));
  }
  const base = { season: 2025, shifts, tt: [], soccer: [], osTeam: [legacyPhl, newVn] };

  it("has columns 24..53, zero games, no week 0, no NaN", () => {
    const m = buildWeeklyReport({ ...base, monthly: false });
    expect(m.weeks).toEqual(Array.from({ length: 30 }, (_, i) => 24 + i));
    expect(m.weeks).not.toContain(0);
    expect(m.aflGames.total).toBe(0);
    expect(m.socGames.total).toBe(0);
    expect(m.pureCostPerGame.total).toBe(0);
    expect(m.totalBlendedCostPerGame[30]).toBe(0);
    expect(m.socCostPerGame.total).toBe(0);
    noNaN(m);
  });

  it("labels weeks from the season rule and has no OS cost in 2025", () => {
    const m = buildWeeklyReport({ ...base, monthly: false });
    expect(m.weekDates[24]).toEqual({ min: "2025-03-05", max: "2025-03-11" });
    expect(m.phlCost.total).toBe(0);
    expect(m.vnCost.total).toBe(0);
  });

  it("month view works without anchors", () => {
    const m = buildWeeklyReport({ ...base, monthly: true });
    expect(m.weeks.every((k) => /^\d{4}-\d{2}$/.test(String(k)))).toBe(true);
    expect(m.phlCost.total).toBe(0);
    noNaN(m);
  });
});

describe("buildWeeklyReport, 2026 with games from 2026-01-22", () => {
  it("has Deputy columns from W1 and games from W17; OS monthly reconciles", () => {
    const shifts: Row[] = [];
    for (let w = 1; w <= 30; w++) {
      shifts.push({ ...shift(w, seasonWeekRange(2026, w).start.toISOString().slice(0, 10)), season: 2026 });
    }
    const tt: Row[] = [{ season: 2026, Week: "17", week: 17, Date: "2026-01-22", Location: "AUS" }];
    const osTeam = [legacyPhl];
    const weekly = buildWeeklyReport({ season: 2026, monthly: false, shifts, tt, soccer: [], osTeam });
    expect(weekly.weeks[0]).toBe(1);
    expect(weekly.aflGames[17]).toBe(1);
    expect(weekly.aflGames[16] ?? 0).toBe(0);
    // PHL cost from W27 only (weeks 27..30 present in the data).
    expect(weekly.cost["Philippines"][26] ?? 0).toBe(0);
    expect(weekly.cost["Philippines"][27]).toBe(700);
    expect(weekly.cost["Philippines"].total).toBe(700 * 4);
    const monthly = buildWeeklyReport({ season: 2026, monthly: true, shifts, tt, soccer: [], osTeam });
    expect(monthly.cost["Philippines"].total).toBe(700 * 4);
    const monthSum = Object.entries(monthly.cost["Philippines"])
      .filter(([k]) => k !== "total")
      .reduce((s, [, v]) => s + v, 0);
    expect(monthSum).toBeCloseTo(700 * 4, 6);
  });
});

describe("osActive", () => {
  const weeksActive = (r: Row, season: number) => {
    const out: number[] = [];
    for (let w = 1; w <= 53; w++) if (osActive(r, season, w)) out.push(w);
    return out;
  };

  it("gives identical results for legacy and post-009 rows", () => {
    expect(weeksActive(legacyPhl, 2026)).toEqual(weeksActive(newPhl, 2026));
    expect(weeksActive(legacyVn, 2026)).toEqual(weeksActive(newVn, 2026));
    expect(weeksActive(newPhl, 2026)[0]).toBe(27);
    expect(weeksActive(newVn, 2026)[0]).toBe(42);
    expect(weeksActive(legacyPhl, 2027).length).toBe(53);
  });

  it("is inactive in 2025", () => {
    expect(weeksActive(legacyPhl, 2025)).toEqual([]);
    expect(weeksActive(newVn, 2025)).toEqual([]);
  });

  it("has no limit without start_season", () => {
    expect(osActive({ location: "X" }, 2025, 1)).toBe(true);
  });
});

describe("season union", () => {
  it("includes a Deputy-only 2025 with TT for 2026/2027 only", () => {
    const years = unionSeasons(
      seasonsFromDates([{ shift_date: "2025-04-01" }], "shift_date"),
      seasonsFromDates([{ Date: "2026-01-22" }, { Date: "2026-10-10" }], "Date")
    );
    expect(years).toEqual([2027, 2026, 2025]);
  });
});
