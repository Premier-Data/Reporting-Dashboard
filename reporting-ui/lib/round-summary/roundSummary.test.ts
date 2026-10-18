// Unit tests for the Round-Summary pure helpers — the TESTED REFERENCE the
// Worker's inline copies are checked against. No network, no env. Covers the
// two correctness-critical rules (latest-round selection, latest-push join)
// plus the supporting helpers. See design §1.7 / §1.8 / §1.9.
import { describe, it, expect } from "vitest";
import {
  roundNumOf,
  shortRound,
  displayStatus,
  stripGradeName,
  statusChip,
  compareRounds,
  selectLatestRound,
  indexLatestPushes,
  scheduledKickoffMs,
  type RoundInputGame,
} from "./roundSummary";
import type { PushLogEntry } from "@/lib/api/playhq";

// Darwin (+09:30) epoch for a given local date/time, matching
// scheduledKickoffMs. Used to place fixtures relative to `now` in the tests.
function dwn(date: string, time = "00:00:00"): number {
  return scheduledKickoffMs({ date, time }) as number;
}

function game(roundName: string, date: string | null, time = "14:00:00"): RoundInputGame {
  return {
    round: { name: roundName },
    schedule: date ? { date, time } : null,
  };
}

describe("roundNumOf", () => {
  it("parses the first integer", () => {
    expect(roundNumOf("Round 3")).toBe(3);
    expect(roundNumOf("Round 12")).toBe(12);
  });
  it("returns null when there is no number", () => {
    expect(roundNumOf("Grand Final")).toBeNull();
    expect(roundNumOf("")).toBeNull();
    expect(roundNumOf(null)).toBeNull();
  });
});

describe("shortRound", () => {
  it("abbreviates numbered rounds", () => {
    expect(shortRound("Round 3")).toBe("R3");
    expect(shortRound("round 10")).toBe("R10");
  });
  it("abbreviates finals with the correct branch order", () => {
    expect(shortRound("Grand Final")).toBe("GF");
    expect(shortRound("Preliminary Final")).toBe("PF");
    expect(shortRound("Semi Final")).toBe("SF");
    expect(shortRound("Qualifying Final")).toBe("QF");
    expect(shortRound("Elimination Final")).toBe("EF");
  });
  it("passes through an unknown name and empty", () => {
    expect(shortRound("Play-off")).toBe("Play-off");
    expect(shortRound("")).toBe("");
    expect(shortRound(undefined)).toBe("");
  });
});

describe("displayStatus", () => {
  it("maps empty / NULL to UPCOMING", () => {
    expect(displayStatus("")).toBe("UPCOMING");
    expect(displayStatus("NULL")).toBe("UPCOMING");
    expect(displayStatus(null)).toBe("UPCOMING");
    expect(displayStatus(undefined)).toBe("UPCOMING");
  });
  it("passes other statuses through (uppercased)", () => {
    expect(displayStatus("final")).toBe("FINAL");
    expect(displayStatus("UPCOMING")).toBe("UPCOMING");
  });
});

describe("stripGradeName", () => {
  it("strips the grade suffix", () => {
    expect(stripGradeName("Waratah Men Premier League")).toBe("Waratah");
    expect(stripGradeName("Nightcliff Women Premier")).toBe("Nightcliff");
  });
  it("leaves a plain name unchanged and falls back to ?", () => {
    expect(stripGradeName("Waratah")).toBe("Waratah");
    expect(stripGradeName(null)).toBe("?");
  });
});

describe("statusChip", () => {
  it("maps FINAL to emerald", () => {
    expect(statusChip("FINAL")).toContain("emerald");
  });
  it("maps UPCOMING / unknown to slate", () => {
    expect(statusChip("UPCOMING")).toContain("slate");
    expect(statusChip("ANYTHING")).toContain("slate");
  });
  it("maps IN_PROGRESS / LIVE to the amber/pulse defensive branch", () => {
    expect(statusChip("IN_PROGRESS")).toContain("amber");
    expect(statusChip("IN_PROGRESS")).toContain("animate-pulse");
    expect(statusChip("LIVE")).toContain("amber");
  });
});

describe("compareRounds", () => {
  it("orders numbered before unnumbered", () => {
    const num = { roundName: "Round 1", roundNum: 1 };
    const fin = { roundName: "Grand Final", roundNum: null };
    expect(compareRounds(num, fin)).toBeLessThan(0);
    expect(compareRounds(fin, num)).toBeGreaterThan(0);
  });
  it("orders two numbered rounds by number", () => {
    expect(
      compareRounds({ roundName: "Round 2", roundNum: 2 }, { roundName: "Round 5", roundNum: 5 })
    ).toBeLessThan(0);
  });
  it("orders two unnumbered rounds by name", () => {
    const a = { roundName: "Grand Final", roundNum: null };
    const b = { roundName: "Semi Final", roundNum: null };
    expect(Math.sign(compareRounds(a, b))).toBe(Math.sign("Grand Final".localeCompare("Semi Final")));
  });
  it("flips sign on swap", () => {
    const a = { roundName: "Round 2", roundNum: 2 };
    const b = { roundName: "Round 7", roundNum: 7 };
    expect(Math.sign(compareRounds(a, b))).toBe(-Math.sign(compareRounds(b, a)));
  });
});

describe("selectLatestRound", () => {
  it("all-future season → tier C first upcoming round", () => {
    const now = dwn("2026-10-01", "08:00:00");
    const games = [
      game("Round 1", "2026-10-10"),
      game("Round 2", "2026-10-17"),
      game("Round 3", "2026-10-24"),
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Round 1", roundNum: 1 });
  });

  it("mid-round, every game UPCOMING, earliest kickoff <= now → that round via tier A (NTFL quirk, not last week)", () => {
    const now = dwn("2026-10-17", "16:00:00"); // during Round 2's day
    const games = [
      game("Round 1", "2026-10-10"), // started last week
      game("Round 2", "2026-10-17", "14:00:00"), // started today
      game("Round 3", "2026-10-31"), // far future
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Round 2", roundNum: 2 });
  });

  it("between rounds, next round >6h away → tier A returns the just-finished started round", () => {
    const now = dwn("2026-10-20", "12:00:00"); // days after R2, R3 still far off
    const games = [
      game("Round 1", "2026-10-10"),
      game("Round 2", "2026-10-17"),
      game("Round 3", "2026-10-31"),
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Round 2", roundNum: 2 });
  });

  it("morning of a new round, nothing started but next round <= now + 6h → tier B rolls forward", () => {
    // Pre-season / season opener morning: no round has started yet, but the
    // first round's first bounce (14:00) is within 6h of now (10:00). Tier A is
    // empty (nothing <= now), tier B rolls forward to that imminent round.
    const now = dwn("2026-10-24", "10:00:00");
    const games = [
      game("Round 3", "2026-10-24", "14:00:00"),
      game("Round 4", "2026-10-31"),
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Round 3", roundNum: 3 });
  });

  it("split weekend: N started AND N+1 within 6h but not started → tier A selects N, not N+1", () => {
    // now = 15:00. R3's early game started at 14:00 (<=now); R4's first game at
    // 20:00 is within 6h but has NOT started → must pick R3.
    const now = dwn("2026-10-24", "15:00:00");
    const games = [
      game("Round 3", "2026-10-24", "14:00:00"),
      game("Round 4", "2026-10-24", "20:00:00"),
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Round 3", roundNum: 3 });
  });

  it("finals name (Grand Final) → roundNum null, selected when it is the started/highest round", () => {
    const now = dwn("2026-12-05", "16:00:00");
    const games = [
      game("Round 18", "2026-09-01"),
      game("Grand Final", "2026-12-05", "14:00:00"),
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Grand Final", roundNum: null });
  });

  it("all fixtures date-less → step-5 fallback to highest by compareRounds", () => {
    const now = Date.now();
    const games = [
      game("Round 1", null),
      game("Round 4", null),
      game("Round 2", null),
    ];
    expect(selectLatestRound(games, now)).toEqual({ roundName: "Round 4", roundNum: 4 });
  });

  it("empty array → null", () => {
    expect(selectLatestRound([], Date.now())).toBeNull();
  });
});

describe("indexLatestPushes", () => {
  const mk = (playhqId: string, ts: string, score: string): PushLogEntry => ({
    ts,
    id: playhqId.slice(0, 8),
    playhqId,
    ttId: null,
    competition: "C",
    round: "Round 1",
    match: "A vs B",
    score,
    endpoint: "e",
    scoreReply: "ok",
    teamReply: "-",
    ok: true,
  });

  it("multiple entries for one id → max-ts wins", () => {
    const entries = [
      mk("id-1", "2026-10-17T10:00:00.000Z", "early"),
      mk("id-1", "2026-10-17T12:00:00.000Z", "late"),
      mk("id-1", "2026-10-17T11:00:00.000Z", "mid"),
    ];
    expect(indexLatestPushes(entries).get("id-1")?.score).toBe("late");
  });

  it("several fixtures keyed correctly", () => {
    const entries = [
      mk("id-1", "2026-10-17T10:00:00.000Z", "one"),
      mk("id-2", "2026-10-17T10:00:00.000Z", "two"),
    ];
    const idx = indexLatestPushes(entries);
    expect(idx.get("id-1")?.score).toBe("one");
    expect(idx.get("id-2")?.score).toBe("two");
    expect(idx.size).toBe(2);
  });

  it("empty / absent playhqId skipped", () => {
    const entries = [
      { ...mk("", "2026-10-17T10:00:00.000Z", "x"), playhqId: "" },
      { ...mk("y", "2026-10-17T10:00:00.000Z", "y"), playhqId: undefined } as unknown as PushLogEntry,
    ];
    expect(indexLatestPushes(entries).size).toBe(0);
  });

  it("empty input → empty map", () => {
    expect(indexLatestPushes([]).size).toBe(0);
  });

  it("out-of-order timestamps → latest still chosen", () => {
    const entries = [
      mk("id-1", "2026-10-17T15:00:00.000Z", "latest"),
      mk("id-1", "2026-10-17T09:00:00.000Z", "oldest"),
    ];
    expect(indexLatestPushes(entries).get("id-1")?.score).toBe("latest");
  });
});
