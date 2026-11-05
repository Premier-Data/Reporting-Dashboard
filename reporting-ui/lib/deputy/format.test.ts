import { describe, it, expect } from "vitest";
import {
  formatAud,
  formatHours2,
  estimatedHourlyRate,
  formatRate,
  summariseByArea,
} from "./format";

// ── formatAud ────────────────────────────────────────────────────────────────
describe("formatAud", () => {
  it("formats a positive number as AUD currency", () => {
    const out = formatAud(182.55);
    // Tolerant check to avoid locale-byte brittleness across environments.
    expect(out).toContain("$");
    expect(out).toContain("182.55");
  });

  it("formats zero", () => {
    const out = formatAud(0);
    expect(out).toContain("$");
    expect(out).toContain("0.00");
  });

  it("returns '-' for null/undefined/NaN", () => {
    expect(formatAud(null)).toBe("-");
    expect(formatAud(undefined)).toBe("-");
    expect(formatAud(NaN)).toBe("-");
  });
});

// ── formatHours2 ─────────────────────────────────────────────────────────────
describe("formatHours2", () => {
  it("formats to 2 decimal places", () => {
    expect(formatHours2(1.5)).toBe("1.50");
    expect(formatHours2(8)).toBe("8.00");
  });

  it("returns '-' for null/undefined/NaN", () => {
    expect(formatHours2(null)).toBe("-");
    expect(formatHours2(undefined)).toBe("-");
    expect(formatHours2(NaN)).toBe("-");
  });
});

// ── estimatedHourlyRate ──────────────────────────────────────────────────────
describe("estimatedHourlyRate", () => {
  it("derives cost / totalTime when both are valid", () => {
    expect(estimatedHourlyRate(180, 9)).toBe(20);
  });

  it("returns null on division by zero (totalTime 0)", () => {
    expect(estimatedHourlyRate(180, 0)).toBeNull();
  });

  it("returns null when totalTime is null", () => {
    expect(estimatedHourlyRate(180, null)).toBeNull();
  });

  it("returns null when cost is null", () => {
    expect(estimatedHourlyRate(null, 9)).toBeNull();
  });

  it("returns null when totalTime is negative", () => {
    expect(estimatedHourlyRate(180, -2)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(estimatedHourlyRate(NaN, 9)).toBeNull();
    expect(estimatedHourlyRate(180, NaN)).toBeNull();
  });
});

// ── formatRate ───────────────────────────────────────────────────────────────
describe("formatRate", () => {
  it("formats the derived rate as AUD", () => {
    const out = formatRate(180, 9);
    expect(out).toContain("$");
    expect(out).toContain("20.00");
  });

  it("falls back to '-' when not derivable", () => {
    expect(formatRate(180, 0)).toBe("-");
    expect(formatRate(null, 9)).toBe("-");
    expect(formatRate(180, null)).toBe("-");
  });
});

// ── summariseByArea ──────────────────────────────────────────────────────────
describe("summariseByArea", () => {
  it("groups by area and sums hours + cost", () => {
    const { rows, total } = summariseByArea([
      { operational_unit_name: "Soccer - Operations", total_time: 6, cost: 150 },
      { operational_unit_name: "Soccer - Operations", total_time: 7, cost: 175 },
      { operational_unit_name: "Data/ AI", total_time: 7.5, cost: 176 },
    ]);
    const soccer = rows.find((r) => r.area === "Soccer - Operations");
    const data = rows.find((r) => r.area === "Data/ AI");
    expect(soccer).toMatchObject({ hours: 13, cost: 325, shifts: 2 });
    expect(data).toMatchObject({ hours: 7.5, cost: 176, shifts: 1 });
    expect(total).toEqual({ hours: 20.5, cost: 501, shifts: 3 });
  });

  it("sorts per-area rows by cost descending", () => {
    const { rows } = summariseByArea([
      { operational_unit_name: "Low", total_time: 1, cost: 10 },
      { operational_unit_name: "High", total_time: 1, cost: 999 },
      { operational_unit_name: "Mid", total_time: 1, cost: 100 },
    ]);
    expect(rows.map((r) => r.area)).toEqual(["High", "Mid", "Low"]);
  });

  it("treats null hours/cost as 0 but still counts the shift", () => {
    const { rows, total } = summariseByArea([
      { operational_unit_name: "X", total_time: null, cost: null },
      { operational_unit_name: "X", total_time: 5, cost: 100 },
    ]);
    expect(rows[0]).toMatchObject({ area: "X", hours: 5, cost: 100, shifts: 2 });
    expect(total).toEqual({ hours: 5, cost: 100, shifts: 2 });
  });

  it("buckets missing/blank area names under '(unknown area)'", () => {
    const { rows } = summariseByArea([
      { operational_unit_name: null, total_time: 2, cost: 20 },
      { operational_unit_name: "   ", total_time: 3, cost: 30 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ area: "(unknown area)", hours: 5, cost: 50, shifts: 2 });
  });

  it("returns empty rows and zeroed totals for no input", () => {
    expect(summariseByArea([])).toEqual({
      rows: [],
      total: { hours: 0, cost: 0, shifts: 0 },
    });
  });
});
