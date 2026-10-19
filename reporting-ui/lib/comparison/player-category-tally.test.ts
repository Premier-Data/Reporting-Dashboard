// @vitest-environment node
// Unit tests for the pure Player Category Volume module. Covers the metric
// rule (categoryAccuracy) and the per-player, per-category tally over small
// synthetic master + analyst Instance[] (no React/DOM, no XML parsing — the
// aggregator takes plain Instance[] directly). See design AC1–AC9.
import { describe, it, expect } from "vitest";
import {
  categoryAccuracy,
  computePlayerCategoryTally,
} from "./player-category-tally";
import type { Instance } from "./xml-compare";

let seq = 0;
// Minimal valid Instance factory — only `team`, `playerNumber` and `stat`
// drive the tally; the rest satisfy the type.
function inst(partial: Partial<Instance>): Instance {
  seq += 1;
  return {
    id: `i${seq}`,
    start: 0,
    end: 2,
    mid: 1,
    team: "Home",
    playerNumber: 10,
    playerRaw: "#10",
    stat: "Touch",
    category: "",
    code: "",
    ...partial,
  };
}

describe("categoryAccuracy", () => {
  it("AC1: 6/6 is 100%", () => {
    expect(categoryAccuracy(6, 6)).toEqual({ a: 6, m: 6, pct: 1, parts: [] });
  });

  it("AC2: 4/6 is ~67%", () => {
    const cell = categoryAccuracy(4, 6);
    expect(cell.a).toBe(4);
    expect(cell.m).toBe(6);
    expect(cell.pct).toBeCloseTo(2 / 3, 10);
  });

  it("AC3: 0/3 is 0%", () => {
    expect(categoryAccuracy(0, 3)).toEqual({ a: 0, m: 3, pct: 0, parts: [] });
  });

  it("AC4: 0/0 is null (no data, strictly null)", () => {
    const cell = categoryAccuracy(0, 0);
    expect(cell.a).toBe(0);
    expect(cell.m).toBe(0);
    expect(cell.pct).toBeNull();
    expect(cell.pct === null).toBe(true);
  });

  it("AC5: over-count 9/6 is 50%", () => {
    expect(categoryAccuracy(9, 6)).toEqual({ a: 9, m: 6, pct: 0.5, parts: [] });
  });

  it("AC6: extreme over-count 20/6 floors at 0 (not negative)", () => {
    expect(categoryAccuracy(20, 6)).toEqual({ a: 20, m: 6, pct: 0, parts: [] });
  });
});

describe("computePlayerCategoryTally", () => {
  it("AC7: Defensive sums tackle+interception+clearance+block regardless of sub-stat split", () => {
    const master = [
      inst({ team: "Home", playerNumber: 7, stat: "Interceptions" }),
      inst({ team: "Home", playerNumber: 7, stat: "Clearances" }),
      inst({ team: "Home", playerNumber: 7, stat: "Blocks" }),
      inst({ team: "Home", playerNumber: 7, stat: "Tackles Successful" }),
    ];
    const analyst = [
      inst({ team: "Home", playerNumber: 7, stat: "Interceptions" }),
      inst({ team: "Home", playerNumber: 7, stat: "Clearances" }),
    ];

    const rows = computePlayerCategoryTally(master, analyst);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Defensive: master 4 (across 4 different sub-stats), analyst 2 ⇒ 50%.
    expect(row.cells.defensive.a).toBe(2);
    expect(row.cells.defensive.m).toBe(4);
    expect(row.cells.defensive.pct).toBe(0.5);

    // Passing: neither side coded a pass ⇒ no data, strictly null.
    expect(row.cells.passing.a).toBe(0);
    expect(row.cells.passing.m).toBe(0);
    expect(row.cells.passing.pct).toBeNull();
  });

  it("AC8: a player present on only one side still appears", () => {
    const master = [
      inst({ team: "Home", playerNumber: 5, stat: "Shot" }),
    ];
    const analyst = [
      inst({ team: "Away", playerNumber: 11, stat: "Shot" }),
    ];

    const rows = computePlayerCategoryTally(master, analyst);
    expect(rows).toHaveLength(2);

    const home5 = rows.find((r) => r.key === "home|5");
    const away11 = rows.find((r) => r.key === "away|11");
    expect(home5).toBeDefined();
    expect(away11).toBeDefined();

    // Master-only player: analyst counts all 0.
    expect(home5!.analystOnly).toBe(false);
    expect(home5!.cells.offensive.a).toBe(0);
    expect(home5!.cells.offensive.m).toBe(1);
    expect(home5!.cells.offensive.pct).toBe(0);

    // Analyst-only player: master counts all 0 (pct null), flagged analystOnly.
    expect(away11!.analystOnly).toBe(true);
    expect(away11!.cells.offensive.a).toBe(1);
    expect(away11!.cells.offensive.m).toBe(0);
    expect(away11!.cells.offensive.pct).toBeNull();
  });

  it("AC8a: a GK-only player is KEPT (Goalkeeper volume)", () => {
    const master = [
      inst({ team: "Home", playerNumber: 1, stat: "Save" }),
      inst({ team: "Home", playerNumber: 1, stat: "Save" }),
      inst({ team: "Home", playerNumber: 1, stat: "Catch" }),
    ];
    const rows = computePlayerCategoryTally(master, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("home|1");
    // Saves (2) + Catch (1) ⇒ Goalkeeper master 3.
    expect(rows[0].cells.goalkeeper.m).toBe(3);
  });

  it("AC8a: a blocks-only player is KEPT (Defensive volume)", () => {
    const master = [inst({ team: "Home", playerNumber: 4, stat: "Blocks" })];
    const rows = computePlayerCategoryTally(master, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.defensive.m).toBe(1);
  });

  it("AC8b: a player coded only in ball recoveries / aerial duels is DROPPED", () => {
    const master = [
      inst({ team: "Home", playerNumber: 8, stat: "Ball Recovery" }),
      inst({ team: "Home", playerNumber: 8, stat: "Aerial Win" }),
    ];
    const rows = computePlayerCategoryTally(master, []);
    // Those stats map to no displayed category ⇒ both sides total 0 ⇒ dropped.
    expect(rows).toHaveLength(0);
  });

  it("AC9: rows sort analystOnly-last, then team, then number", () => {
    const master = [
      inst({ team: "Home", playerNumber: 10, stat: "Shot" }),
      inst({ team: "Home", playerNumber: 2, stat: "Shot" }),
      inst({ team: "Away", playerNumber: 9, stat: "Shot" }),
    ];
    const analyst = [
      // analyst-only player must sort last regardless of team/number.
      inst({ team: "Away", playerNumber: 1, stat: "Shot" }),
    ];

    const rows = computePlayerCategoryTally(master, analyst);
    expect(rows.map((r) => r.key)).toEqual([
      "away|9", // Away before Home (localeCompare), master-side
      "home|2", // Home, number 2 before 10
      "home|10",
      "away|1", // analystOnly ⇒ last
    ]);
  });

  it("empty inputs yield no rows", () => {
    expect(computePlayerCategoryTally([], [])).toEqual([]);
  });
});
