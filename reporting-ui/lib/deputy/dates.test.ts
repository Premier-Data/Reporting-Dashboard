import { describe, it, expect } from "vitest";
import {
  toLocalISODate,
  currentWeekWedToTue,
  recentWeekPresets,
  recentMonthPresets,
} from "./dates";

// A fixed "today" for deterministic tests: Thu 5 Nov 2026 (local).
const TODAY = new Date("2026-11-05T09:00:00");

describe("currentWeekWedToTue", () => {
  it("returns the Wed→Tue week containing today", () => {
    // Thu 5 Nov 2026 -> week starts Wed 4 Nov, ends Tue 10 Nov.
    expect(currentWeekWedToTue(TODAY)).toEqual({
      from: "2026-11-04",
      to: "2026-11-10",
    });
  });

  it("when today is Wednesday, the week starts today", () => {
    const wed = new Date("2026-11-11T12:00:00"); // Wed 11 Nov 2026
    expect(currentWeekWedToTue(wed)).toEqual({
      from: "2026-11-11",
      to: "2026-11-17",
    });
  });

  it("when today is Tuesday, the week started the prior Wednesday", () => {
    const tue = new Date("2026-11-10T12:00:00"); // Tue 10 Nov 2026
    expect(currentWeekWedToTue(tue)).toEqual({
      from: "2026-11-04",
      to: "2026-11-10",
    });
  });
});

describe("recentWeekPresets", () => {
  const presets = recentWeekPresets(26, TODAY);

  it("returns the requested count, newest first", () => {
    expect(presets).toHaveLength(26);
    expect(presets[0].from).toBe("2026-11-04"); // current week first
    expect(presets[1].from).toBe("2026-10-28"); // prior week
    expect(presets[2].from).toBe("2026-10-21");
  });

  it("each preset is a 7-day Wed→Tue range", () => {
    const p = presets[0];
    expect(p.from).toBe("2026-11-04");
    expect(p.to).toBe("2026-11-10");
    const from = new Date(`${p.from}T00:00:00`);
    const to = new Date(`${p.to}T00:00:00`);
    expect(from.getDay()).toBe(3); // Wednesday
    expect(to.getDay()).toBe(2); // Tuesday
  });

  it("uses the week's from-date as a stable value", () => {
    expect(presets[0].value).toBe(presets[0].from);
  });

  it("labels the range with day/month/year", () => {
    expect(presets[0].label).toBe("Wed 4 Nov – Tue 10 Nov 2026");
  });
});

describe("recentMonthPresets", () => {
  const presets = recentMonthPresets(12, TODAY);

  it("returns the requested count, newest first", () => {
    expect(presets).toHaveLength(12);
    expect(presets[0].value).toBe("2026-11");
    expect(presets[1].value).toBe("2026-10");
    expect(presets[11].value).toBe("2025-12");
  });

  it("spans the 1st to the last day of the month", () => {
    expect(presets[0]).toMatchObject({
      label: "November 2026",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    // February (28 days in 2026)
    const feb = presets.find((p) => p.value === "2026-02");
    expect(feb).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("toLocalISODate", () => {
  it("formats a local date as yyyy-mm-dd without UTC shift", () => {
    expect(toLocalISODate(new Date("2026-11-05T23:30:00"))).toBe("2026-11-05");
  });
});
