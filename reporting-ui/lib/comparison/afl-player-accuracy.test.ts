import { describe, it, expect } from "vitest";
import {
  computeAflPlayerAccuracy,
  AFL_GROUPS,
} from "./afl-player-accuracy";
import { type Instance, type ComparisonRow, type MatchStatus } from "./xml-compare";

// --- Minimal fixtures -------------------------------------------------------
// computeAflPlayerAccuracy only reads r.master.stat (for classification),
// r.status (exact vs not) and — for the football loose rule, which AFL
// disables — r.analyst. So fixtures can be minimal.

let seq = 0;
function inst(stat: string, opts: Partial<Instance> = {}): Instance {
  seq += 1;
  return {
    id: `i${seq}`,
    start: 0,
    end: 0,
    mid: 0,
    team: "Home",
    playerNumber: 10,
    playerRaw: "10",
    stat,
    category: "",
    code: "",
    ...opts,
  };
}

function row(
  master: Instance | null,
  analyst: Instance | null = null,
  status: MatchStatus = "exact"
): ComparisonRow {
  return { status, master, analyst, timeDelta: null };
}

// One exact master row per stat.
function exactRows(stats: string[]): ComparisonRow[] {
  return stats.map((s) => row(inst(s)));
}

describe("AFL player accuracy — group membership", () => {
  it("each group collects exactly its listed stats", () => {
    const groups = [
      AFL_GROUPS.scoring,
      AFL_GROUPS.defence,
      AFL_GROUPS.possession,
      AFL_GROUPS.disposals,
      AFL_GROUPS.other,
    ] as const;

    for (const g of groups) {
      const rows = exactRows(g.parts.map((p) => p.label));
      const acc = computeAflPlayerAccuracy(rows);
      // Find the matching computed group by label.
      const computed = [
        acc.scoring,
        acc.defence,
        acc.possession,
        acc.disposals,
        acc.other,
      ].find((c) => c.parts.length === g.parts.length && c.master === g.parts.length);
      expect(computed, `group ${g.label}`).toBeTruthy();
      expect(computed!.master).toBe(g.parts.length);
      // Every part got exactly one master event.
      for (const p of computed!.parts) expect(p.master).toBe(1);
    }
  });

  it("group sizes are 9/8/7/11/11", () => {
    expect(AFL_GROUPS.scoring.parts.length).toBe(9);
    expect(AFL_GROUPS.defence.parts.length).toBe(8);
    expect(AFL_GROUPS.possession.parts.length).toBe(7);
    expect(AFL_GROUPS.disposals.parts.length).toBe(11);
    expect(AFL_GROUPS.other.parts.length).toBe(11);
  });
});

// Helper: master count for a single part key in a group.
function partMaster(group: { parts: { label: string; master: number }[] }, label: string) {
  const p = group.parts.find((x) => x.label === label);
  return p ? p.master : -1;
}

describe("AFL player accuracy — collision-safe routing", () => {
  it("intercept mark -> disposals, intercept -> possession", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Intercept Mark")),
      row(inst("Intercept")),
    ]);
    expect(partMaster(acc.disposals, "Intercept Mark")).toBe(1);
    expect(partMaster(acc.possession, "Intercept")).toBe(1);
  });

  it("i50 marks -> disposals, i50 -> scoring", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Shallow i50 Mark")),
      row(inst("Deep i50 Mark")),
      row(inst("Shallow I50")),
      row(inst("Deep I50")),
    ]);
    expect(partMaster(acc.disposals, "Shallow i50 Mark")).toBe(1);
    expect(partMaster(acc.disposals, "Deep i50 Mark")).toBe(1);
    expect(partMaster(acc.scoring, "Shallow I50")).toBe(1);
    expect(partMaster(acc.scoring, "Deep I50")).toBe(1);
  });

  it("ruck gather -> other, contested gather -> possession, gather -> possession", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Ruck Gather")),
      row(inst("Contested Gather")),
      row(inst("Gather")),
    ]);
    expect(partMaster(acc.other, "Ruck Gather")).toBe(1);
    expect(partMaster(acc.possession, "Contested Gather")).toBe(1);
    expect(partMaster(acc.possession, "Gather")).toBe(1);
  });

  it("hit out to advantage and hit out are distinct Other parts", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Hit Out to Advantage")),
      row(inst("Hit Out")),
    ]);
    expect(partMaster(acc.other, "Hit Out to Advantage")).toBe(1);
    expect(partMaster(acc.other, "Hit Out")).toBe(1);
  });

  it("ineffective/effective tackle, kick, handball route distinctly", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Ineffective Tackle")),
      row(inst("Effective Tackle")),
      row(inst("Ineffective Kick")),
      row(inst("Effective Kick")),
      row(inst("Ineffective Handball")),
      row(inst("Effective Handball")),
    ]);
    expect(partMaster(acc.defence, "Ineffective Tackle")).toBe(1);
    expect(partMaster(acc.defence, "Effective Tackle")).toBe(1);
    expect(partMaster(acc.disposals, "Ineffective Kick")).toBe(1);
    expect(partMaster(acc.disposals, "Effective Kick")).toBe(1);
    expect(partMaster(acc.disposals, "Ineffective Handball")).toBe(1);
    expect(partMaster(acc.disposals, "Effective Handball")).toBe(1);
  });

  it("uncontested mark vs contested mark land on distinct parts", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Uncontested Mark")),
      row(inst("Contested Mark")),
    ]);
    expect(partMaster(acc.disposals, "Uncontested Mark")).toBe(1);
    expect(partMaster(acc.disposals, "Contested Mark")).toBe(1);
  });

  it("rushed behind -> rushedBehind, behind -> behind", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Rushed Behind")),
      row(inst("Behind")),
    ]);
    expect(partMaster(acc.scoring, "Rushed Behind")).toBe(1);
    expect(partMaster(acc.scoring, "Behind")).toBe(1);
  });

  it("clearance -> other (not possession/defence)", () => {
    const acc = computeAflPlayerAccuracy([row(inst("Clearance"))]);
    expect(partMaster(acc.other, "Clearance")).toBe(1);
    expect(acc.possession.master).toBe(0);
    expect(acc.defence.master).toBe(0);
  });

  it("specific bounces -> other, bare bounce -> possession", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Around Ground Bounce")),
      row(inst("Centre Bounce")),
      row(inst("Bounce")),
    ]);
    expect(partMaster(acc.other, "Around Ground Bounce")).toBe(1);
    expect(partMaster(acc.other, "Centre Bounce")).toBe(1);
    expect(partMaster(acc.possession, "Bounce")).toBe(1);
  });
});

describe("AFL player accuracy — overall & pct", () => {
  it("overall spans all five groups (master = sum of groups' masters)", () => {
    const rows = [
      row(inst("Goal")), // scoring
      row(inst("Spoil")), // defence
      row(inst("Turnover")), // possession
      row(inst("Effective Kick")), // disposals
      row(inst("Clearance")), // other
    ];
    const acc = computeAflPlayerAccuracy(rows);
    const sum =
      acc.scoring.master +
      acc.defence.master +
      acc.possession.master +
      acc.disposals.master +
      acc.other.master;
    expect(acc.overall.master).toBe(sum);
    expect(acc.overall.master).toBe(5);
  });

  it("zero-master group -> pct null", () => {
    // Feed only a defence stat; scoring group has no master events.
    const acc = computeAflPlayerAccuracy([row(inst("Spoil"))]);
    expect(acc.scoring.master).toBe(0);
    expect(acc.scoring.pct).toBeNull();
    expect(acc.defence.master).toBe(1);
    expect(acc.defence.pct).toBe(1);
  });
});

describe("AFL player accuracy — exact-match counting", () => {
  it("exact rows increment exact; non-exact rows do not (no loose rule)", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Goal"), inst("Goal"), "exact"),
      // same player, pass-like non-exact row: AFL applies NO loose rule, so
      // this must NOT count as exact.
      row(inst("Behind"), inst("Behind", { playerNumber: 10 }), "wrong_stat"),
      row(inst("Set Shot"), null, "missed"),
    ]);
    expect(acc.scoring.master).toBe(3);
    expect(acc.scoring.exact).toBe(1); // only the "exact" Goal row
    expect(acc.scoring.pct).toBeCloseTo(1 / 3, 10);
  });
});
