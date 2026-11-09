import { describe, it, expect } from "vitest";
import {
  completedGradeIds,
  nextRemainingIndex,
  remainingGradeIndexes,
  summarizeResume,
} from "./sweepResume";

const grades = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `g${i + 1}` }));

describe("remainingGradeIndexes", () => {
  it("none done -> all remain", () => {
    expect(remainingGradeIndexes(grades(4), new Set())).toEqual([0, 1, 2, 3]);
  });
  it("3 of 10 done -> other 7 remain in original order", () => {
    const done = new Set(["g1", "g2", "g3"]);
    expect(remainingGradeIndexes(grades(10), done)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });
  it("keeps original order when completed grades are not a prefix", () => {
    expect(remainingGradeIndexes(grades(5), new Set(["g2", "g4"]))).toEqual([0, 2, 4]);
  });
  it("all done -> none remain", () => {
    expect(remainingGradeIndexes(grades(3), new Set(["g1", "g2", "g3"]))).toEqual([]);
  });
  it("unknown/extra completed ids are ignored", () => {
    expect(remainingGradeIndexes(grades(2), new Set(["zzz", "g1"]))).toEqual([1]);
  });
  it("empty grade list", () => {
    expect(remainingGradeIndexes([], new Set(["g1"]))).toEqual([]);
  });
});

describe("completedGradeIds", () => {
  const entries = [
    { seasonId: "ce93ea21", gradeId: "g1", completedAt: "2026-01-01T00:00:00Z" },
    { seasonId: "ce93ea21", gradeId: "g2", completedAt: "2026-01-01T00:00:00Z" },
    { seasonId: "ce93ea21", gradeId: "g3", completedAt: "2026-01-01T00:00:00Z" },
    { seasonId: "ce93ea21", gradeId: "g4", completedAt: null }, // partial
    { seasonId: "ce93ea21", gradeId: "g5", completedAt: "" }, // incomplete
    { seasonId: "ce93ea21", gradeId: "g6" }, // failed / no marker
    { seasonId: "other", gradeId: "g7", completedAt: "2026-01-01T00:00:00Z" },
  ];
  it("only counts completed entries of the given season", () => {
    expect([...completedGradeIds(entries, "ce93ea21")].sort()).toEqual(["g1", "g2", "g3"]);
  });
  it("failed/partial/incomplete grades remain", () => {
    const done = completedGradeIds(entries, "ce93ea21");
    expect(remainingGradeIndexes(grades(10), done)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });
  it("ce93ea21: 3 completed of 10 -> exactly 7 remain", () => {
    const done = completedGradeIds(entries, "ce93ea21");
    expect(done.size).toBe(3);
    expect(remainingGradeIndexes(grades(10), done)).toHaveLength(7);
  });
});

describe("nextRemainingIndex", () => {
  it("skips completed grades in the middle", () => {
    expect(nextRemainingIndex(grades(5), new Set(["g2", "g3"]), 1)).toBe(3);
  });
  it("returns the index itself when remaining", () => {
    expect(nextRemainingIndex(grades(3), new Set(), 1)).toBe(1);
  });
  it("returns null at the end", () => {
    expect(nextRemainingIndex(grades(3), new Set(["g3"]), 2)).toBeNull();
    expect(nextRemainingIndex([], new Set(), 0)).toBeNull();
  });
});

describe("summarizeResume", () => {
  it("formats the resume summary", () => {
    expect(summarizeResume(10, 7)).toBe(
      "3 of 10 grades already swept - will continue with the remaining 7"
    );
  });
  it("formats the all-done summary", () => {
    expect(summarizeResume(3, 0)).toBe("All 3 grades already swept.");
  });
});
