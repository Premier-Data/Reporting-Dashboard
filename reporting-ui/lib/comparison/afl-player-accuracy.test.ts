import { describe, it, expect } from "vitest";
import {
  computeAflPlayerAccuracy,
  computeAflPlayerAccuracyByScope,
  AFL_GROUPS,
} from "./afl-player-accuracy";
import { computePlayerAccuracyByScope } from "./player-accuracy";
import {
  compareInstances,
  type Instance,
  type ComparisonRow,
  type MatchStatus,
} from "./xml-compare";

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

    // A few parts carry a DISPLAY label that differs from the master stat
    // string that classifies into them (the card label is friendlier than the
    // raw source label). Map those to a real master label so this test feeds
    // inputs that actually classify. All other parts: label === input.
    const sampleInputFor: Record<string, string> = {
      "Effective Tackle": "Tackles Eff",
      "Ineffective Tackle": "Tackles Ineff",
      "Shallow Rebound": "Rebound 50s - Shallow",
      "Deep Rebound": "Rebound 50s - Deep",
      "Shallow i50 Mark": "Marks i50 - Shallow",
      "Deep i50 Mark": "Marks i50 - Deep",
    };

    for (const g of groups) {
      const rows = exactRows(
        g.parts.map((p) => sampleInputFor[p.label] ?? p.label)
      );
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
      row(inst("Marks i50 - Shallow")),
      row(inst("Marks i50 - Deep")),
      row(inst("Shallow I50")),
      row(inst("Deep I50")),
    ]);
    expect(partMaster(acc.disposals, "Shallow i50 Mark")).toBe(1);
    expect(partMaster(acc.disposals, "Deep i50 Mark")).toBe(1);
    expect(partMaster(acc.scoring, "Shallow I50")).toBe(1);
    expect(partMaster(acc.scoring, "Deep I50")).toBe(1);
  });

  it("real tackle labels 'Tackles Eff' / 'Tackles Ineff' route to Defence", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Tackles Eff")),
      row(inst("Tackles Ineff")),
    ]);
    expect(partMaster(acc.defence, "Effective Tackle")).toBe(1);
    expect(partMaster(acc.defence, "Ineffective Tackle")).toBe(1);
  });

  it("'Rebound 50s - Shallow/Deep' route to Scoring rebounds, NOT the I50 parts", () => {
    const acc = computeAflPlayerAccuracy([
      row(inst("Rebound 50s - Shallow")),
      row(inst("Rebound 50s - Deep")),
    ]);
    expect(partMaster(acc.scoring, "Shallow Rebound")).toBe(1);
    expect(partMaster(acc.scoring, "Deep Rebound")).toBe(1);
    // The rebound labels contain "shallow"/"deep" but must NOT leak into the
    // Shallow I50 / Deep I50 scoring parts.
    expect(partMaster(acc.scoring, "Shallow I50")).toBe(0);
    expect(partMaster(acc.scoring, "Deep I50")).toBe(0);
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
      row(inst("Tackles Ineff")),
      row(inst("Tackles Eff")),
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

// --- By-scope fixtures ------------------------------------------------------
// Build real master + analyst Instance[] with Home/Away teams so the three
// scopes (both/home/away) are actually exercised through canonicalise +
// compareInstances (not just precomputed ComparisonRows).

let evSeq = 0;
function ev(
  stat: string,
  team: "Home" | "Away",
  playerNumber: number,
  mid: number
): Instance {
  evSeq += 1;
  return {
    id: `e${evSeq}`,
    start: mid,
    end: mid,
    mid,
    team,
    playerNumber,
    playerRaw: String(playerNumber),
    stat,
    category: "",
    code: "",
  };
}

describe("AFL player accuracy — by scope", () => {
  // One Home scoring stat + one Away disposal stat, analyst matches both.
  const master: Instance[] = [
    ev("Goal", "Home", 7, 100),
    ev("Effective Kick", "Away", 12, 200),
  ];
  const analyst: Instance[] = [
    ev("Goal", "Home", 7, 100),
    ev("Effective Kick", "Away", 12, 200),
  ];

  it("returns { afl:true, both, home, away } each an AflPlayerAccuracy", () => {
    const stored = computeAflPlayerAccuracyByScope(master, analyst, 3, null);
    expect(stored.afl).toBe(true);
    for (const scope of [stored.both, stored.home, stored.away]) {
      // Every AFL group key present.
      expect(scope).toHaveProperty("overall");
      expect(scope).toHaveProperty("scoring");
      expect(scope).toHaveProperty("defence");
      expect(scope).toHaveProperty("possession");
      expect(scope).toHaveProperty("disposals");
      expect(scope).toHaveProperty("other");
    }
    // Both spans the Home goal + Away kick.
    expect(stored.both.overall.master).toBe(2);
    // Home scope sees only the Home goal; Away scope only the Away kick.
    expect(stored.home.scoring.master).toBe(1);
    expect(stored.home.disposals.master).toBe(0);
    expect(stored.away.disposals.master).toBe(1);
    expect(stored.away.scoring.master).toBe(0);
  });

  it("`both` scope deep-equals computeAflPlayerAccuracy over the same both-scoped rows", () => {
    const stored = computeAflPlayerAccuracyByScope(master, analyst, 3, null);
    // Recreate the both-scope comparison the by-scope function does internally.
    const cmp = compareInstances(master, analyst, 3, null);
    const expected = computeAflPlayerAccuracy(cmp.rows);
    expect(stored.both).toEqual(expected);
  });
});

describe("player accuracy routing shape — AFL vs football", () => {
  it("AFL stored result carries afl:true + AFL groups; football carries football + football groups", () => {
    const master: Instance[] = [
      ev("Goal", "Home", 7, 100),
      ev("Spoil", "Home", 9, 150),
      ev("Turnover", "Away", 4, 200),
      ev("Effective Kick", "Away", 12, 250),
    ];
    const analyst: Instance[] = [
      ev("Goal", "Home", 7, 100),
      ev("Spoil", "Home", 9, 150),
      ev("Turnover", "Away", 4, 200),
      ev("Effective Kick", "Away", 12, 250),
    ];

    const afl = computeAflPlayerAccuracyByScope(master, analyst, 3, null);
    // AFL discriminant + AFL group keys.
    expect(afl.afl).toBe(true);
    expect(afl).not.toHaveProperty("football");
    expect(afl.both).toHaveProperty("scoring");
    expect(afl.both).toHaveProperty("defence");
    expect(afl.both).toHaveProperty("possession");
    expect(afl.both).toHaveProperty("disposals");

    const football = computePlayerAccuracyByScope(master, analyst, 3, null);
    // Football discriminant + football group keys.
    expect(football).toHaveProperty("football");
    expect(football).not.toHaveProperty("afl");
    expect(football.both).toHaveProperty("passing");
    expect(football.both).toHaveProperty("offensive");
    expect(football.both).toHaveProperty("defensive");
    expect(football.both).toHaveProperty("goalkeeper");
  });
});
