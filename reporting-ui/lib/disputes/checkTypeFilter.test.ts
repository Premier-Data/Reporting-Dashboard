import { describe, it, expect } from "vitest";
import { countByCheckType, matchesCheckType, checkTypeLabel } from "./checkTypeFilter";

describe("matchesCheckType", () => {
  it("all matches everything including null", () => {
    expect(matchesCheckType(null, "all")).toBe(true);
    expect(matchesCheckType("full_game", "all")).toBe(true);
  });
  it("maps each group", () => {
    expect(matchesCheckType("specific_stats", "specific")).toBe(true);
    expect(matchesCheckType("full_game", "full")).toBe(true);
    expect(matchesCheckType("golden_accuracy", "golden")).toBe(true);
    expect(matchesCheckType("full_game", "golden")).toBe(false);
  });
  it("null/unknown fall in other", () => {
    expect(matchesCheckType(null, "other")).toBe(true);
    expect(matchesCheckType(undefined, "other")).toBe(true);
    expect(matchesCheckType("weird", "other")).toBe(true);
    expect(matchesCheckType(null, "specific")).toBe(false);
  });
});

describe("countByCheckType", () => {
  it("counts sum to total", () => {
    const c = countByCheckType(
      ["specific_stats", "full_game", "full_game", "golden_accuracy", null],
      (x) => x
    );
    expect(c).toEqual({ all: 5, specific: 1, full: 2, golden: 1, other: 1 });
  });
});

describe("checkTypeLabel", () => {
  it("labels other as Uncategorised", () => {
    expect(checkTypeLabel("other")).toBe("Uncategorised");
    expect(checkTypeLabel("full")).toBe("Full game");
  });
});
