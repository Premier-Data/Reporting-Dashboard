// Verifies Option A: a bare "Crosses" (master) scores EXACT against an
// outcome-tagged "Crosses Successful/Unsuccesful" (analyst) at the same
// time + player. Uses the real comparison engine on synthetic instances.
import { describe, it, expect } from "vitest";
import {
  compareInstances,
  parseHomeAwayFromFileName,
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

describe("bare vs outcome crosses/through balls", () => {
  it("scores a bare master cross as EXACT vs an outcome analyst cross", () => {
    const master = [inst("m1", 100, "Crosses", "Home", 33)];
    const analyst = [inst("a1", 100, "Crosses Unsuccesful", "Home", 33)];
    const res = compareInstances(master, analyst, 3, "Home vs Away");
    expect(res.rows[0].status).toBe("exact");
  });

  it("scores a bare master through ball as EXACT vs an outcome analyst one", () => {
    const master = [inst("m1", 200, "Through Balls", "Home", 10)];
    const analyst = [inst("a1", 200, "Through Balls Successful", "Home", 10)];
    const res = compareInstances(master, analyst, 3, "Home vs Away");
    expect(res.rows[0].status).toBe("exact");
  });

  it("scores master Catch as EXACT vs analyst Catches (and vice versa)", () => {
    // "Catch" and "Catches" are the same GK action: either timeline showing
    // either form must score as exact at the same time + player.
    const m2a = [inst("m1", 250, "Catch", "Home", 1)];
    const a2a = [inst("a1", 250, "Catches", "Home", 1)];
    expect(
      compareInstances(m2a, a2a, 3, "Home vs Away").rows[0].status
    ).toBe("exact");

    const m2b = [inst("m1", 260, "Catches", "Home", 1)];
    const a2b = [inst("a1", 260, "Catch", "Home", 1)];
    expect(
      compareInstances(m2b, a2b, 3, "Home vs Away").rows[0].status
    ).toBe("exact");
  });

  it("keeps short vs long passes as DIFFERENT (not exact)", () => {
    const master = [inst("m1", 300, "Short Passes Successful", "Home", 7)];
    const analyst = [inst("a1", 300, "Long Passes Successful", "Home", 7)];
    const res = compareInstances(master, analyst, 3, "Home vs Away");
    expect(res.rows[0].status).not.toBe("exact");
  });

  it("pairs SAME player+time across unrelated stats (players-first)", () => {
    // Master "Tackles Successful" vs analyst "Ground Duel Loss" — different
    // actions, but same player (#5) at the same time: must pair as wrong_stat,
    // not drop to missed/extra.
    const master = [inst("m1", 400, "Tackles Successful", "Home", 5)];
    const analyst = [inst("a1", 400, "Ground Duel Losses", "Home", 5)];
    const res = compareInstances(master, analyst, 3, "Home vs Away");
    expect(res.rows[0].status).toBe("wrong_stat");
    expect(res.rows[0].analyst).not.toBeNull();
  });

  it("does NOT pair unrelated stats on DIFFERENT players", () => {
    const master = [inst("m1", 500, "Tackles Successful", "Home", 5)];
    const analyst = [inst("a1", 500, "Ground Duel Losses", "Home", 9)];
    const res = compareInstances(master, analyst, 3, "Home vs Away");
    // Different players + unrelated stats => master is missed (no pairing).
    expect(res.rows[0].status).toBe("missed");
  });

  it("collapses AFL Marks i50 Shallow <-> Deep as EXACT (both directions)", () => {
    const m1 = [inst("m1", 600, "Marks i50 - Shallow", "Home", 12)];
    const a1 = [inst("a1", 600, "Marks i50 - Deep", "Home", 12)];
    expect(
      compareInstances(m1, a1, 3, "Home vs Away").rows[0].status
    ).toBe("exact");

    const m1r = [inst("m1", 601, "Marks i50 - Deep", "Home", 12)];
    const a1r = [inst("a1", 601, "Marks i50 - Shallow", "Home", 12)];
    expect(
      compareInstances(m1r, a1r, 3, "Home vs Away").rows[0].status
    ).toBe("exact");
  });

  it("collapses AFL Rebound 50s Shallow <-> Deep as EXACT (both directions)", () => {
    const m2 = [inst("m1", 610, "Rebound 50s - Shallow", "Home", 8)];
    const a2 = [inst("a1", 610, "Rebound 50s - Deep", "Home", 8)];
    expect(
      compareInstances(m2, a2, 3, "Home vs Away").rows[0].status
    ).toBe("exact");

    const m2r = [inst("m1", 611, "Rebound 50s - Deep", "Home", 8)];
    const a2r = [inst("a1", 611, "Rebound 50s - Shallow", "Home", 8)];
    expect(
      compareInstances(m2r, a2r, 3, "Home vs Away").rows[0].status
    ).toBe("exact");
  });

  it("collapses AFL Shallow I50 <-> Deep I50 as EXACT (both directions)", () => {
    const m3 = [inst("m1", 620, "Shallow I50", "Home", 22)];
    const a3 = [inst("a1", 620, "Deep I50", "Home", 22)];
    expect(
      compareInstances(m3, a3, 3, "Home vs Away").rows[0].status
    ).toBe("exact");

    const m3r = [inst("m1", 621, "Deep I50", "Home", 22)];
    const a3r = [inst("a1", 621, "Shallow I50", "Home", 22)];
    expect(
      compareInstances(m3r, a3r, 3, "Home vs Away").rows[0].status
    ).toBe("exact");
  });

  it("keeps AFL depth pairs DISTINCT across different base stats (not exact)", () => {
    // Cross-pair: a shallow/deep variant must NEVER collapse into a different
    // base stat, even at the same player + time.
    const c1m = [inst("m1", 630, "Marks i50 - Shallow", "Home", 5)];
    const c1a = [inst("a1", 630, "Rebound 50s - Deep", "Home", 5)];
    expect(
      compareInstances(c1m, c1a, 3, "Home vs Away").rows[0].status
    ).not.toBe("exact");

    const c2m = [inst("m1", 631, "Marks i50 - Shallow", "Home", 5)];
    const c2a = [inst("a1", 631, "Deep I50", "Home", 5)];
    expect(
      compareInstances(c2m, c2a, 3, "Home vs Away").rows[0].status
    ).not.toBe("exact");

    const c3m = [inst("m1", 632, "Rebound 50s - Shallow", "Home", 5)];
    const c3a = [inst("a1", 632, "Deep I50", "Home", 5)];
    expect(
      compareInstances(c3m, c3a, 3, "Home vs Away").rows[0].status
    ).not.toBe("exact");
  });

  it("does not newly collapse any football pair (short vs long still differ)", () => {
    // Football regression guard: no football label contains i50/rebound 50s/
    // a standalone shallow|deep, so the depth rules cannot fire. Short vs long
    // passes must still be NON-exact.
    const master = [inst("m1", 640, "Short Passes Successful", "Home", 7)];
    const analyst = [inst("a1", 640, "Long Passes Successful", "Home", 7)];
    expect(
      compareInstances(master, analyst, 3, "Home vs Away").rows[0].status
    ).not.toBe("exact");

    // Short vs Short (success vs unsuccess) still collapses as exact, unchanged.
    const sm = [inst("m1", 641, "Short Passes Successful", "Home", 7)];
    const sa = [inst("a1", 641, "Short Passes Unsuccesful", "Home", 7)];
    expect(
      compareInstances(sm, sa, 3, "Home vs Away").rows[0].status
    ).toBe("exact");
  });

  it('parses "<Home> vs <Away>" filenames with HOME first', () => {
    // JSON fixtures are named "<Home> vs <Away>.json" from the report's
    // authoritative homeTeamName — home must be the first team.
    const parsed = parseHomeAwayFromFileName(
      "Hume City FC vs Malvern FC U13.json"
    );
    expect(parsed).not.toBeNull();
    expect(parsed![0]).toContain("hume city");
    expect(parsed![1]).toContain("malvern");
  });
});
