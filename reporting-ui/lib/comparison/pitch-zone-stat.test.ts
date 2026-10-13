// Regression for check 478 (SOCCER): when an instance's pitch-zone label
// (e.g. "Penalty Box (a)", "Front Third 116,") is listed BEFORE the real stat
// label, the real stat must still be captured and the instance KEPT. Half /
// substitution markers (and instances that are ONLY a pitch zone) must still
// be dropped. Uses the real parser/comparison engine (vitest + jsdom from
// vitest.config.ts, so parseInstances' DOMParser works).
import { describe, it, expect } from "vitest";
import { parseInstances, compareInstances, type Instance } from "./xml-compare";

// Build a raw SportsCode <instance> block. `labels` is an ordered list of
// [group, text] pairs so tests can place a pitch zone BEFORE the real stat.
function instanceXml(
  id: string,
  start: number,
  end: number,
  code: string,
  labels: [string, string][]
): string {
  const labelXml = labels
    .map(
      ([group, text]) =>
        `    <label><group>${group}</group><text>${text}</text></label>`
    )
    .join("\n");
  return [
    "  <instance>",
    `    <ID>${id}</ID>`,
    `    <start>${start}</start>`,
    `    <end>${end}</end>`,
    `    <code>${code}</code>`,
    labelXml,
    "  </instance>",
  ].join("\n");
}

function wrap(instances: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<file>\n  <ALL_INSTANCES>\n${instances.join(
    "\n"
  )}\n  </ALL_INSTANCES>\n</file>`;
}

describe("parseInstances: pitch-zone label before the real stat (check 478)", () => {
  it("keeps a Penalty Box-first instance with the REAL Claims stat", () => {
    const xml = wrap([
      instanceXml("i1", 50, 54, "Home - #1. Keeper", [
        ["Team", "Home"],
        ["Player", "#1. Keeper"],
        ["Penalty Box", "Penalty Box (a)"],
        ["Goal Keeper", "Claims"],
      ]),
    ]);
    const out = parseInstances(xml);
    expect(out).toHaveLength(1);
    expect(out[0].stat).toBe("Claims");
    expect(out[0].category).toBe("Goal Keeper");
  });

  it('keeps a "Front Third 116," zone-first instance with the REAL Shots Off Target stat', () => {
    const xml = wrap([
      instanceXml("i2", 180, 185, "Home - #9. Striker", [
        ["Team", "Home"],
        ["Player", "#9. Striker"],
        ["Front Third", "Front Third 116,"],
        ["Shooting", "Shots Off Target"],
      ]),
    ]);
    const out = parseInstances(xml);
    expect(out).toHaveLength(1);
    expect(out[0].stat).toBe("Shots Off Target");
    expect(out[0].category).toBe("Shooting");
  });

  it("still DROPS a Start Half 1 marker instance", () => {
    const xml = wrap([
      instanceXml("i3", 0, 1, "Home", [
        ["Team", "Home"],
        ["Start Half", "Start Half 1"],
      ]),
    ]);
    const out = parseInstances(xml);
    expect(out).toHaveLength(0);
  });

  it("still DROPS an instance that is ONLY a pitch-zone label (no real stat)", () => {
    const xml = wrap([
      instanceXml("i4", 300, 304, "Home - #4. Def", [
        ["Team", "Home"],
        ["Player", "#4. Def"],
        ["Penalty Box", "Penalty Box (a)"],
      ]),
    ]);
    const out = parseInstances(xml);
    expect(out).toHaveLength(0);
  });
});

describe("compareInstances: pitch-zone-first stat flows through to the master side", () => {
  function inst(
    id: string,
    start: number,
    stat: string,
    category: string,
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
      category,
      code: `${team} - #${playerNumber}. x`,
    };
  }

  it("keeps the early Claims (pitch-zone-first) instance on the master side (not missing)", () => {
    // Master: early Claims parsed from XML where the Penalty Box label comes
    // first, plus a later Goal Kicks Successful.
    const masterXml = wrap([
      instanceXml("m1", 50, 54, "Home - #1. Keeper", [
        ["Team", "Home"],
        ["Player", "#1. Keeper"],
        ["Penalty Box", "Penalty Box (a)"],
        ["Goal Keeper", "Claims"],
      ]),
      instanceXml("m2", 200, 204, "Home - #2. Def", [
        ["Team", "Home"],
        ["Player", "#2. Def"],
        ["Goal Kicks", "Goal Kicks Successful"],
      ]),
    ]);
    const master = parseInstances(masterXml);
    expect(master.map((m) => m.stat)).toContain("Claims");

    // Analyst: matching instances at the same times/players.
    const analyst = [
      inst("a1", master[0].mid, "Claims", "Goal Keeper", "Home", 1),
      inst("a2", master[1].mid, "Goal Kicks Successful", "Goal Kicks", "Home", 2),
    ];

    const res = compareInstances(master, analyst, 3, "Home vs Away");

    const claimsRow = res.rows.find((r) => r.master?.stat === "Claims");
    expect(claimsRow).toBeDefined();
    expect(claimsRow!.master).not.toBeNull();
  });
});
