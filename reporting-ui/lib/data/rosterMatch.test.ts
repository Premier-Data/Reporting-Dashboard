import { describe, it, expect } from "vitest";
import {
  normaliseIdentifier,
  rosterIndexKey,
  analystRosterKeys,
  shiftsForAnalystDay,
} from "./rosterMatch";

describe("normaliseIdentifier", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normaliseIdentifier("  Jane   DOE ")).toBe("jane doe");
  });
  it("strips parenthetical suffixes like (NEW)", () => {
    expect(normaliseIdentifier("Jimmy Dwyer (NEW)")).toBe("jimmy dwyer");
  });
  it("handles null/undefined", () => {
    expect(normaliseIdentifier(null)).toBe("");
    expect(normaliseIdentifier(undefined)).toBe("");
  });
});

describe("rosterIndexKey", () => {
  it("prefers email when present (legacy rows)", () => {
    expect(rosterIndexKey("A@B.com ", "Alice")).toBe("a@b.com");
  });
  it("falls back to name when no email (API rows)", () => {
    expect(rosterIndexKey(null, "Thomas Winneke")).toBe("thomas winneke");
  });
});

describe("analystRosterKeys", () => {
  it("returns email, name then alias, de-duplicated", () => {
    expect(analystRosterKeys("T@x.com", "Tom Winneke")).toEqual([
      "t@x.com",
      "tom winneke",
      "thomas winneke",
    ]);
  });
  it("omits empties", () => {
    expect(analystRosterKeys(null, "Bob")).toEqual(["bob"]);
    expect(analystRosterKeys("", "")).toEqual([]);
  });
});

describe("shiftsForAnalystDay", () => {
  const map = new Map<string, string[]>([
    ["jimmy dwyer|2026-11-10", ["api-jimmy"]],
    ["thomas winneke|2026-11-10", ["api-thomas"]],
    ["legacy@x.com|2026-11-10", ["legacy"]],
  ]);

  it("matches '(NEW)' analyst names to API rows", () => {
    expect(shiftsForAnalystDay(map, "j@x.com", "Jimmy Dwyer (NEW)", "2026-11-10")).toEqual(["api-jimmy"]);
  });
  it("matches Tom to Thomas via alias", () => {
    expect(shiftsForAnalystDay(map, null, "Tom Winneke", "2026-11-10")).toEqual(["api-thomas"]);
  });
  it("still matches legacy rows by email", () => {
    expect(shiftsForAnalystDay(map, "Legacy@x.com", "Someone", "2026-11-10")).toEqual(["legacy"]);
  });
  it("does not match different people or other days", () => {
    expect(shiftsForAnalystDay(map, null, "Jimmy Smith", "2026-11-10")).toEqual([]);
    expect(shiftsForAnalystDay(map, null, "Jimmy Dwyer", "2026-11-11")).toEqual([]);
  });
});
