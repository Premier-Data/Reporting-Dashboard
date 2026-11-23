import { describe, it, expect } from "vitest";
import {
  compareInstances,
  buildResultFromRows,
  scopeResultToTeam,
  type Instance,
} from "./xml-compare";

function inst(
  id: string,
  start: number,
  stat: string,
  team: string,
  playerNumber: number
): Instance {
  return {
    id,
    start,
    end: start,
    mid: start,
    team,
    playerNumber,
    playerRaw: `#${playerNumber}`,
    stat,
    category: "Passing",
    code: `${team} - #${playerNumber}. x`,
  };
}

const master = [
  inst("m1", 10, "Pass", "Home", 1),
  inst("m2", 20, "Shot", "Home", 2),
  inst("m3", 30, "Pass", "Home", 3),
  inst("m4", 40, "Pass", "Away", 5),
  inst("m5", 50, "Shot", "Away", 6),
  inst("m6", 60, "Tackle", "Away", 7),
];
const analyst = [
  inst("a1", 10, "Pass", "Home", 1),
  inst("a2", 20, "Pass", "Home", 2),
  inst("a4", 40, "Pass", "Away", 5),
  inst("a5", 50, "Shot", "Away", 6),
  inst("a9", 90, "Pass", "Away", 8),
];
const full = compareInstances(master, analyst, 3, "Home vs Away");

describe("team scoping", () => {
  it("buildResultFromRows reproduces compareInstances output", () => {
    expect(buildResultFromRows(full.rows, full.tolerance)).toEqual(full);
  });

  it("'all' returns the same object", () => {
    expect(scopeResultToTeam(full, "all")).toBe(full);
  });

  it("Home + Away summaries add up to the full summary", () => {
    const h = scopeResultToTeam(full, "Home").summary;
    const a = scopeResultToTeam(full, "Away").summary;
    for (const k of [
      "masterTotal",
      "analystTotal",
      "exact",
      "missed",
      "extra",
      "wrongStat",
      "wrongPlayer",
      "wrongTeam",
    ] as const) {
      expect(h[k] + a[k]).toBe(full.summary[k]);
    }
    expect(h.masterTotal).toBe(3);
    expect(h.exact).toBe(1);
  });

  it("per-stat totals and exacts add up across teams", () => {
    const h = scopeResultToTeam(full, "Home").byStat;
    const a = scopeResultToTeam(full, "Away").byStat;
    for (const s of full.byStat) {
      const get = (arr: typeof h) => arr.find((x) => x.stat === s.stat);
      expect((get(h)?.total ?? 0) + (get(a)?.total ?? 0)).toBe(s.total);
      expect((get(h)?.exact ?? 0) + (get(a)?.exact ?? 0)).toBe(s.exact);
    }
  });
});
