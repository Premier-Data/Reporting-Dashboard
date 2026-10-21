import { describe, it, expect } from "vitest";
import {
  buildGroup,
  computePlayerAccuracy,
  FOOTBALL_GROUPS,
} from "./player-accuracy";
import {
  type Instance,
  type ComparisonRow,
  type MatchStatus,
} from "./xml-compare";

// --- Minimal fixtures -------------------------------------------------------
// buildGroup reads r.master.stat / r.analyst.stat (classification), r.status
// (exact vs not, and the "extra" discriminant) and — for the football loose
// pass rule — r.analyst.playerNumber. Fixtures can be minimal.

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

// An analyst-only over-code: no master, analyst present, status "extra".
function extraRow(stat: string): ComparisonRow {
  return row(null, inst(stat), "extra");
}

describe("football player accuracy — extras lower the score", () => {
  it("569 case: 4 exact master intercepts + 6 analyst-only extras -> 4/(4+6) = 0.4", () => {
    const rows: ComparisonRow[] = [
      // 4 master "Interception" events, all matched exactly.
      ...Array.from({ length: 4 }, () =>
        row(inst("Interception"), inst("Interception"), "exact")
      ),
      // 6 analyst-only intercepts with NO master match.
      ...Array.from({ length: 6 }, () => extraRow("Interception")),
    ];
    const g = buildGroup(FOOTBALL_GROUPS.defensive, rows);
    expect(g.master).toBe(4);
    expect(g.exact).toBe(4);
    expect(g.extra).toBe(6);
    expect(g.pct).toBeCloseTo(0.4, 10); // 4 / (4 + 6)

    // Same via computePlayerAccuracy (defensive group).
    const acc = computePlayerAccuracy(rows);
    expect(acc.defensive.pct).toBeCloseTo(0.4, 10);
    expect(acc.defensive.extra).toBe(6);
    const interceptions = acc.defensive.parts.find(
      (p) => p.label === "Interceptions"
    )!;
    expect(interceptions.master).toBe(4);
    expect(interceptions.exact).toBe(4);
    expect(interceptions.extra).toBe(6);
  });

  it("extras classifying into a DIFFERENT group do not affect this group", () => {
    const rows: ComparisonRow[] = [
      row(inst("Interception"), inst("Interception"), "exact"),
      // analyst-only "Shot" -> offensive group, NOT defensive.
      extraRow("Shot"),
    ];
    const defensive = buildGroup(FOOTBALL_GROUPS.defensive, rows);
    // Defensive unchanged: 1 master, 1 exact, 0 extras -> 100%.
    expect(defensive.master).toBe(1);
    expect(defensive.exact).toBe(1);
    expect(defensive.extra).toBe(0);
    expect(defensive.pct).toBe(1);

    // The extra Shot lands in offensive as an extra (master 0 there).
    const offensive = buildGroup(FOOTBALL_GROUPS.offensive, rows);
    expect(offensive.master).toBe(0);
    expect(offensive.extra).toBe(1);
  });

  it("a wrong_stat paired row (HAS a master) is NOT counted as an extra", () => {
    // wrong_stat row: master + analyst both present, status "wrong_stat".
    // It is already in `master` and must NEVER be double-counted as an extra.
    const rows: ComparisonRow[] = [
      row(inst("Interception"), inst("Clearance"), "wrong_stat"),
    ];
    const g = buildGroup(FOOTBALL_GROUPS.defensive, rows);
    expect(g.master).toBe(1); // the master interception counts once
    expect(g.exact).toBe(0); // not an exact match
    expect(g.extra).toBe(0); // NOT treated as an extra (no double-count)
    expect(g.pct).toBe(0); // 0 / (1 + 0)
  });

  it("master 0 with extras > 0 -> pct 0 (NOT null)", () => {
    // "Tackles Successful" classifies into the defensive Tackles part; a bare
    // "Tackle" would not (the football classifier needs the outcome word).
    const rows: ComparisonRow[] = [
      extraRow("Interception"),
      extraRow("Tackles Successful"),
    ];
    const g = buildGroup(FOOTBALL_GROUPS.defensive, rows);
    expect(g.master).toBe(0);
    expect(g.extra).toBe(2);
    expect(g.pct).toBe(0); // intended: analyst coded events the master didn't
  });

  it("master 0 with extras 0 -> pct null (no data)", () => {
    const rows: ComparisonRow[] = [
      // only an offensive stat; defensive group sees nothing.
      row(inst("Shot"), inst("Shot"), "exact"),
    ];
    const g = buildGroup(FOOTBALL_GROUPS.defensive, rows);
    expect(g.master).toBe(0);
    expect(g.extra).toBe(0);
    expect(g.pct).toBeNull();
  });

  it("all-exact group with no extras still yields pct 1 (regression)", () => {
    const rows: ComparisonRow[] = [
      row(inst("Interception"), inst("Interception"), "exact"),
      row(inst("Tackles Successful"), inst("Tackles Successful"), "exact"),
    ];
    const g = buildGroup(FOOTBALL_GROUPS.defensive, rows);
    expect(g.master).toBe(2);
    expect(g.exact).toBe(2);
    expect(g.extra).toBe(0);
    expect(g.pct).toBe(1);
  });

  it("looser pass rule still applies to master rows and extras add to passing", () => {
    const rows: ComparisonRow[] = [
      // master short pass, analyst a long pass by the SAME player -> loose
      // rule counts this as exact (wrong_stat pair, has a master).
      row(
        inst("Short Passes Successful", { playerNumber: 7 }),
        inst("Long Passes Successful", { playerNumber: 7 }),
        "wrong_stat"
      ),
      // analyst-only pass extra -> lowers passing pct.
      extraRow("Short Passes Successful"),
    ];
    const g = buildGroup(FOOTBALL_GROUPS.passing, rows);
    expect(g.master).toBe(1);
    expect(g.exact).toBe(1); // loose pass rule still credited the master row
    expect(g.extra).toBe(1); // the analyst-only pass
    expect(g.pct).toBeCloseTo(1 / 2, 10); // 1 / (1 + 1)
  });
});
