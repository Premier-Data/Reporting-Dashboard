import { describe, it, expect } from "vitest";
import {
  formatAud,
  formatHours2,
  estimatedHourlyRate,
  formatRate,
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
