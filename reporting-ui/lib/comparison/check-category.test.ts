// @vitest-environment node
// Unit tests for the pure suggestCheckCategory helper. Covers the fixed
// priority order: golden-by-ratio first (with the analystTotal=0 guard), then
// group-count classification (3+ → full, 1-2 → specific, 0 → full default).
import { describe, it, expect } from "vitest";
import { suggestCheckCategory } from "./check-category";
import type { AccuracyGroup, PlayerAccuracy } from "./player-accuracy";

// Minimal AccuracyGroup — the helper only reads `.master`, so the rest is
// filled with inert placeholders to satisfy the type.
function group(master: number): AccuracyGroup {
  // `extra` added for the over-coding denominator change; 0 here keeps the
  // existing behavior (this helper only exercises `.master`).
  return { master, exact: 0, extra: 0, pct: master === 0 ? null : 0, parts: [] };
}

// Build a PlayerAccuracy whose five scored groups have the given master
// counts. `overall` is derived display-only and not read by the helper.
function accuracy(masters: {
  passing?: number;
  offensive?: number;
  defensive?: number;
  goalkeeper?: number;
  other?: number;
}): PlayerAccuracy {
  return {
    overall: group(0),
    passing: group(masters.passing ?? 0),
    offensive: group(masters.offensive ?? 0),
    defensive: group(masters.defensive ?? 0),
    goalkeeper: group(masters.goalkeeper ?? 0),
    other: group(masters.other ?? 0),
  };
}

describe("suggestCheckCategory", () => {
  it("classifies golden by ratio (master < 60% of analyst)", () => {
    // 50/100 = 0.5 < 0.6. Four groups have master events, proving the ratio
    // rule takes PRIORITY over the group count.
    const result = suggestCheckCategory({
      masterTotal: 50,
      analystTotal: 100,
      playerAccuracy: accuracy({
        passing: 10,
        offensive: 10,
        defensive: 10,
        goalkeeper: 10,
      }),
    });
    expect(result).toBe("golden_accuracy");
  });

  it("does NOT classify golden when analystTotal is 0 (divide-by-zero guard)", () => {
    // 0/0 must not be golden; falls through to group count (3 groups → full).
    const result = suggestCheckCategory({
      masterTotal: 0,
      analystTotal: 0,
      playerAccuracy: accuracy({ passing: 5, offensive: 5, defensive: 5 }),
    });
    expect(result).toBe("full_game");
  });

  it("classifies 3 groups with master events as full_game", () => {
    const result = suggestCheckCategory({
      masterTotal: 100,
      analystTotal: 100,
      playerAccuracy: accuracy({ passing: 5, offensive: 5, other: 5 }),
    });
    expect(result).toBe("full_game");
  });

  it("classifies 2 groups as specific_stats", () => {
    const result = suggestCheckCategory({
      masterTotal: 100,
      analystTotal: 100,
      playerAccuracy: accuracy({ passing: 5, defensive: 5 }),
    });
    expect(result).toBe("specific_stats");
  });

  it("classifies 1 group as specific_stats", () => {
    const result = suggestCheckCategory({
      masterTotal: 100,
      analystTotal: 100,
      playerAccuracy: accuracy({ goalkeeper: 5 }),
    });
    expect(result).toBe("specific_stats");
  });

  it("classifies 0 groups as full_game (default)", () => {
    const result = suggestCheckCategory({
      masterTotal: 100,
      analystTotal: 100,
      playerAccuracy: accuracy({}),
    });
    expect(result).toBe("full_game");
  });
});
