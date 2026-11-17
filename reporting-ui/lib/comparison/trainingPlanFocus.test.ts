import { describe, expect, it } from "vitest";
import type { PlanInstance } from "./trainingPlan";
import type { ComparisonRow, Instance } from "./xml-compare";
import {
  PLAYER_CLOSED,
  buildPlanFocus,
  closePlayer,
  openFromPlan,
  openFromTimeline,
  rowMatchesFocus,
} from "./trainingPlanFocus";

const plan = (over: Partial<PlanInstance> = {}): PlanInstance => ({
  key: "3",
  type: "wrong_player",
  stat: "Tackles",
  codedStat: "Tackles",
  category: "Defence",
  timeSeconds: 125,
  startSeconds: 120,
  timeLabel: "02:05",
  expected: { team: "Home", player: "#7" },
  coded: { team: "Home", player: "#9" },
  alsoWrongPlayer: false,
  alsoWrongTeam: false,
  timeDelta: null,
  dispute: { state: "none", reason: null },
  videoLink: null,
  reviewLink: null,
  ...over,
});

const inst = (start: number, mid: number): Instance => ({
  id: "x",
  start,
  end: start + 10,
  mid,
  team: "Home",
  playerNumber: 7,
  playerRaw: "7",
  stat: "Tackles",
  category: "Defence",
  code: "c",
});

describe("buildPlanFocus", () => {
  it("carries the descriptive fields and a label/badge for the type", () => {
    const f = buildPlanFocus(plan());
    expect(f.typeLabel).toBe("Wrong player");
    expect(f.badgeClass).toContain("bg-");
    expect(f.timeLabel).toBe("02:05");
    expect(f.expected?.player).toBe("#7");
    expect(f.coded?.player).toBe("#9");
  });
  it("uses distinct badges per type", () => {
    const a = buildPlanFocus(plan({ type: "missed" })).badgeClass;
    const b = buildPlanFocus(plan({ type: "extra" })).badgeClass;
    expect(a).not.toBe(b);
  });
});

describe("rowMatchesFocus", () => {
  const f = buildPlanFocus(plan());
  it("matches on master start/mid", () => {
    const row = { master: inst(120, 125), analyst: null } as unknown as ComparisonRow;
    expect(rowMatchesFocus(row, f)).toBe(true);
  });
  it("falls back to analyst for extra rows", () => {
    const row = { master: null, analyst: inst(120, 125) } as unknown as ComparisonRow;
    expect(rowMatchesFocus(row, f)).toBe(true);
  });
  it("rejects other rows and null focus", () => {
    const row = { master: inst(121, 125), analyst: null } as unknown as ComparisonRow;
    expect(rowMatchesFocus(row, f)).toBe(false);
    expect(rowMatchesFocus(row, null)).toBe(false);
    expect(rowMatchesFocus({ master: null, analyst: null } as unknown as ComparisonRow, f)).toBe(false);
  });
});

describe("player origin handling", () => {
  it("timeline open has no focus and closing does not return to the plan", () => {
    const s = openFromTimeline();
    expect(s).toEqual({ open: true, origin: "timeline", focus: null });
    const c = closePlayer(s);
    expect(c.next).toEqual(PLAYER_CLOSED);
    expect(c.returnToPlan).toBe(false);
  });
  it("plan open records origin + focus and closing returns to the plan", () => {
    const s = openFromPlan(plan());
    expect(s.origin).toBe("training-plan");
    expect(s.focus?.key).toBe("3");
    const c = closePlayer(s);
    expect(c.next.open).toBe(false);
    expect(c.next.focus).toBeNull();
    expect(c.returnToPlan).toBe(true);
  });
  it("closing an already closed player is a no-op", () => {
    expect(closePlayer(PLAYER_CLOSED).returnToPlan).toBe(false);
  });
});
