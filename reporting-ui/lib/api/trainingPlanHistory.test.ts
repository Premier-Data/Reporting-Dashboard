import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComparisonRow } from "@/lib/comparison/xml-compare";

const calls: string[] = [];
const getAccuracyChecksMeta = vi.fn();
const getAccuracyChecksXml = vi.fn();
const gradeOverlapScoped = vi.fn();
const getAllDisputes = vi.fn();

vi.mock("@/lib/api/accuracyChecks", () => ({
  getAccuracyChecksMeta: (...a: unknown[]) => getAccuracyChecksMeta(...a),
  getAccuracyChecksXml: (...a: unknown[]) => getAccuracyChecksXml(...a),
  gradeOverlapScoped: (...a: unknown[]) => gradeOverlapScoped(...a),
}));
vi.mock("@/lib/api/disputes", () => ({
  getAllDisputes: (...a: unknown[]) => getAllDisputes(...a),
}));

import { clearTrainingHistoryCache, loadTrainingHistory } from "./trainingPlanHistory";

function meta(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    created_at: `2025-05-${String(id).padStart(2, "0")}T00:00:00Z`,
    analyst_name: "Sam",
    match_label: null,
    file_name_master: "m.xml",
    tolerance: 3,
    accuracy: 0.8,
    master_total: 10,
    analyst_total: 10,
    exact: 8,
    wrong_stat: 1,
    wrong_player: 1,
    wrong_team: 0,
    missed: 0,
    extra: 0,
    avg_time_drift: 1,
    category_breakdown: [{ category: "Defence", total: 10, exact: 8, accuracy: 0.8 }],
    sport: "afl",
    category: null,
    ...over,
  };
}
const inst = (id: string, mid = 2) => ({ id, start: 1, end: 3, mid, team: "Home", playerNumber: 1, playerRaw: "1", stat: "Tackles", category: "Defence", code: "c" });
const gradedRows = (prefix: string): ComparisonRow[] => [
  { status: "missed", master: inst(`${prefix}-a`), analyst: null, timeDelta: null },
  { status: "exact", master: inst(`${prefix}-b`, 50), analyst: inst(`${prefix}-b2`, 50), timeDelta: 0 },
];
const baseArgs = {
  analystName: "Sam",
  sport: "afl" as const,
  category: null,
  excludeCheckId: null,
  referenceDate: new Date("2025-06-01T00:00:00Z"),
  window: { mode: "checks" as const, n: 10 },
  includeStats: true,
};

beforeEach(() => {
  clearTrainingHistoryCache();
  calls.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  getAllDisputes.mockImplementation(async () => {
    calls.push("disputes");
    return [];
  });
  getAccuracyChecksMeta.mockImplementation(async () => Array.from({ length: 6 }, (_, i) => meta(i + 1)));
  getAccuracyChecksXml.mockImplementation(async (ids: number[]) => {
    calls.push(`xml:${ids.join(",")}`);
    return new Map(ids.map((id) => [id, { id, xml_master: "m", xml_analyst: "a" }]));
  });
  gradeOverlapScoped.mockImplementation((xm: string) => {
    calls.push("grade");
    return { result: { rows: gradedRows(String(Math.random())) }, playerAccuracy: null };
  });
});

describe("loadTrainingHistory", () => {
  it("selects the analyst's checks, re-grades them and returns stats", async () => {
    getAccuracyChecksMeta.mockResolvedValue([meta(1), meta(2, { analyst_name: "Other" }), meta(3, { analyst_name: "sam_" })]);
    const h = await loadTrainingHistory(baseArgs);
    expect(h.checks.map((c) => c.id)).toEqual([1]);
    expect(h.checks[0].stats?.tackles).toMatchObject({ events: 2, errors: 1 });
    expect(h.checks[0].categories).toEqual([{ category: "Defence", total: 10, exact: 8 }]);
    expect(h.allAnalystAverage?.accuracy).toBeCloseTo(0.8);
  });

  it("loads disputes before grading anything", async () => {
    await loadTrainingHistory(baseArgs);
    expect(calls[0]).toBe("disputes");
    expect(calls.indexOf("disputes")).toBeLessThan(calls.indexOf("grade"));
  });

  it("caches graded rows, so a second call downloads nothing", async () => {
    await loadTrainingHistory(baseArgs);
    getAccuracyChecksXml.mockClear();
    gradeOverlapScoped.mockClear();
    const h = await loadTrainingHistory(baseArgs);
    expect(getAccuracyChecksXml).not.toHaveBeenCalled();
    expect(gradeOverlapScoped).not.toHaveBeenCalled();
    expect(h.checks.every((c) => c.stats !== null)).toBe(true);
  });

  it("applies the dispute excludeFn per build, even for cached rows", async () => {
    const fixed = gradedRows("fixed");
    gradeOverlapScoped.mockImplementation(() => ({ result: { rows: fixed }, playerAccuracy: null }));
    getAccuracyChecksMeta.mockResolvedValue([meta(1)]);
    const first = await loadTrainingHistory(baseArgs);
    expect(first.checks[0].stats?.tackles).toMatchObject({ events: 2, errors: 1 });

    // A dispute on the missed row is confirmed after the check was cached.
    getAllDisputes.mockResolvedValue([
      { id: 1, check_id: 1, instance_id: "fixed-a", side: "master", stat: "Tackles", team: "Home", code_time: 2, status: "confirmed", deleted_at: null, reason: null },
    ]);
    getAccuracyChecksXml.mockClear();
    const second = await loadTrainingHistory(baseArgs);
    expect(getAccuracyChecksXml).not.toHaveBeenCalled(); // served from the cache
    expect(second.checks[0].stats?.tackles).toMatchObject({ events: 1, errors: 0 });
    // The cached rows themselves were not mutated.
    expect(fixed).toHaveLength(2);
  });

  it("ignores confirmed disputes that belong to other checks", async () => {
    getAccuracyChecksMeta.mockResolvedValue([meta(1)]);
    gradeOverlapScoped.mockImplementation(() => ({ result: { rows: gradedRows("z") }, playerAccuracy: null }));
    getAllDisputes.mockResolvedValue([
      { id: 1, check_id: 99, instance_id: "z-a", side: "master", stat: "Tackles", team: "Home", code_time: 2, status: "confirmed", deleted_at: null, reason: null },
    ]);
    const h = await loadTrainingHistory(baseArgs);
    expect(h.checks[0].stats?.tackles.events).toBe(2);
  });

  it("warns about a check that fails to download or grade, and still returns it", async () => {
    getAccuracyChecksMeta.mockResolvedValue([meta(1), meta(2), meta(3)]);
    getAccuracyChecksXml.mockImplementation(async (ids: number[]) => new Map(ids.filter((i) => i !== 2).map((id) => [id, { id, xml_master: "m", xml_analyst: "a" }])));
    gradeOverlapScoped.mockImplementation(() => ({ result: { rows: gradedRows("q") }, playerAccuracy: null }));
    const h = await loadTrainingHistory(baseArgs);
    expect(h.checks).toHaveLength(3);
    expect(h.checks.find((c) => c.id === 2)!.stats).toBeNull();
    expect(h.warnings.join(" ")).toContain("Check #2 could not be re-graded");

    clearTrainingHistoryCache();
    gradeOverlapScoped.mockImplementation(() => null);
    getAccuracyChecksXml.mockImplementation(async (ids: number[]) => new Map(ids.map((id) => [id, { id, xml_master: "m", xml_analyst: "a" }])));
    const h2 = await loadTrainingHistory({ ...baseArgs, window: { mode: "checks", n: 1 } });
    expect(h2.checks[0].stats).toBeNull();
    gradeOverlapScoped.mockImplementation(() => {
      throw new Error("boom");
    });
    clearTrainingHistoryCache();
    const h3 = await loadTrainingHistory({ ...baseArgs, window: { mode: "checks", n: 1 } });
    expect(h3.checks[0].stats).toBeNull();
  });

  it("continues with a warning when disputes cannot be loaded", async () => {
    getAllDisputes.mockRejectedValue(new Error("down"));
    const h = await loadTrainingHistory(baseArgs);
    expect(h.checks.length).toBeGreaterThan(0);
    expect(h.warnings.join(" ")).toContain("Dispute data unavailable for history");
  });

  it("never passes more than 4 ids to one download call", async () => {
    getAccuracyChecksMeta.mockResolvedValue(Array.from({ length: 10 }, (_, i) => meta(i + 1)));
    await loadTrainingHistory(baseArgs);
    const sizes = getAccuracyChecksXml.mock.calls.map((c) => (c[0] as number[]).length);
    expect(sizes).toEqual([4, 4, 2]);
  });

  it("reports progress after each check", async () => {
    getAccuracyChecksMeta.mockResolvedValue(Array.from({ length: 5 }, (_, i) => meta(i + 1)));
    const onProgress = vi.fn();
    await loadTrainingHistory({ ...baseArgs, onProgress });
    expect(onProgress.mock.calls).toEqual([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });

  it("aborts between chunks and never requests a later chunk", async () => {
    getAccuracyChecksMeta.mockResolvedValue(Array.from({ length: 10 }, (_, i) => meta(i + 1)));
    const ctrl = new AbortController();
    getAccuracyChecksXml.mockImplementation(async (ids: number[]) => {
      ctrl.abort();
      return new Map(ids.map((id) => [id, { id, xml_master: "m", xml_analyst: "a" }]));
    });
    await expect(loadTrainingHistory({ ...baseArgs, signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(getAccuracyChecksXml).toHaveBeenCalledTimes(1);
  });

  it("does not use the stats path when includeStats is false", async () => {
    const h = await loadTrainingHistory({ ...baseArgs, includeStats: false });
    expect(getAccuracyChecksXml).not.toHaveBeenCalled();
    expect(h.checks.every((c) => c.stats === null)).toBe(true);
  });

  it("treats legacy null category as full_game when selecting", async () => {
    getAccuracyChecksMeta.mockResolvedValue([meta(1, { category: null }), meta(2, { category: "full_game" }), meta(3, { category: "golden_accuracy" })]);
    const h = await loadTrainingHistory({ ...baseArgs, category: "full_game", includeStats: false });
    expect(h.checks.map((c) => c.id)).toEqual([1, 2]);
  });
});
