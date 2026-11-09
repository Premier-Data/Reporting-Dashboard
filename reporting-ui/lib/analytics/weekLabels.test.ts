import { describe, it, expect } from "vitest";
import { buildWeekRanges, formatWeekRange, weekOptionLabel } from "./weekLabels";

describe("formatWeekRange", () => {
  it("formats same-month and cross-month ranges with one trailing year", () => {
    expect(formatWeekRange("2026-10-14", "2026-10-20")).toBe("14 Oct – 20 Oct 2026");
    expect(formatWeekRange("2026-09-30", "2026-10-06")).toBe("30 Sep – 6 Oct 2026");
  });
  it("shows both years when the range crosses a year end", () => {
    expect(formatWeekRange("2026-12-30", "2027-01-05")).toBe("30 Dec 2026 – 5 Jan 2027");
  });
  it("collapses a single day and rejects bad input", () => {
    expect(formatWeekRange("2026-10-14", "2026-10-14")).toBe("14 Oct 2026");
    expect(formatWeekRange("", "2026-10-14")).toBe("");
  });
});

describe("weekOptionLabel", () => {
  it("falls back to the plain label with no range", () => {
    expect(weekOptionLabel("Week 3")).toBe("Week 3");
    expect(weekOptionLabel("Week 3", null)).toBe("Week 3");
  });
  it("appends the range", () => {
    expect(weekOptionLabel("Week 3", { start: "2026-10-14", end: "2026-10-20" })).toBe(
      "Week 3 · 14 Oct – 20 Oct 2026"
    );
  });
});

describe("buildWeekRanges", () => {
  it("snaps a week's rows to their Wed→Tue block (Fri-Sun games only)", () => {
    const m = buildWeekRanges([
      { week: "1", season: 2027, date: "2026-10-02" },
      { week: "1", season: 2027, date: "2026-10-04" },
    ]);
    expect(m.get("1")).toEqual({ start: "2026-09-30", end: "2026-10-06" });
    expect(m.get("3")).toBeUndefined();
  });
  it("follows the data, not an October formula (season 2026 Week 1 = 25 Mar)", () => {
    const m = buildWeekRanges([{ week: 1, season: 2026, date: "2026-03-28" }]);
    expect(m.get("1")).toEqual({ start: "2026-03-25", end: "2026-03-31" });
  });
  it("derives season from the date when the row has none (deputy shifts)", () => {
    const m = buildWeekRanges([{ week: 2, date: "2026-10-08T00:00:00+11:00" }]);
    expect(m.get("2")).toEqual({ start: "2026-10-07", end: "2026-10-13" });
  });
  it("is not shifted by dates near midnight / DST changes", () => {
    // AU DST starts first Sunday of Oct (2026-10-04); date-only strings stay put.
    const m = buildWeekRanges([{ week: 1, season: 2027, date: "2026-10-04" }]);
    expect(m.get("1")).toEqual({ start: "2026-09-30", end: "2026-10-06" });
    // Wednesday itself and the following Tuesday stay in the same block.
    const n = buildWeekRanges([
      { week: 1, season: 2027, date: "2026-09-30" },
      { week: 1, season: 2027, date: "2026-10-06" },
    ]);
    expect(n.get("1")).toEqual({ start: "2026-09-30", end: "2026-10-06" });
  });
  it("ignores a stray mis-weeked row (majority wins)", () => {
    const m = buildWeekRanges([
      { week: 4, season: 2027, date: "2026-10-23" },
      { week: 4, season: 2027, date: "2026-10-24" },
      { week: 4, season: 2027, date: "2026-10-17" },
    ]);
    expect(m.get("4")).toEqual({ start: "2026-10-21", end: "2026-10-27" });
  });
  it("omits weeks that span several seasons or have no dates", () => {
    const m = buildWeekRanges([
      { week: 1, season: 2026, date: "2026-03-25" },
      { week: 1, season: 2027, date: "2026-10-01" },
      { week: 5, season: undefined, date: null },
    ]);
    expect(m.has("1")).toBe(false);
    expect(m.has("5")).toBe(false);
  });
  it("uses min/max row dates for week 0 (pre-season)", () => {
    const m = buildWeekRanges([
      { week: 0, season: 2026, date: "2026-01-22" },
      { week: 0, season: 2026, date: "2026-03-22" },
    ]);
    expect(m.get("0")).toEqual({ start: "2026-01-22", end: "2026-03-22" });
  });
});
