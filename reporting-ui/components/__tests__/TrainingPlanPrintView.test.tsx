import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import TrainingPlanPrintView from "../accuracy/TrainingPlanPrintView";
import { buildTrainingPlan } from "@/lib/comparison/trainingPlan";
import type { ComparisonResult, ComparisonRow, Instance } from "@/lib/comparison/xml-compare";

let n = 0;
const inst = (stat: string): Instance => {
  n += 1;
  return { id: `p${n}`, start: 10 + n, end: 14 + n, mid: 12 + n, team: "Home", playerNumber: 4, playerRaw: "4", stat, category: "Defence", code: "c" };
};
const rows: ComparisonRow[] = [
  ...Array.from({ length: 5 }, (): ComparisonRow => ({ status: "missed", master: inst("Tackles"), analyst: null, timeDelta: null })),
  ...Array.from({ length: 5 }, (): ComparisonRow => ({ status: "exact", master: inst("Tackles"), analyst: inst("Tackles"), timeDelta: 0 })),
  ...Array.from({ length: 12 }, (): ComparisonRow => ({ status: "exact", master: inst("Kick"), analyst: inst("Kick"), timeDelta: 0 })),
];
const result: ComparisonResult = {
  rows,
  tolerance: 3,
  summary: { masterTotal: 22, analystTotal: 17, exact: 17, wrongStat: 0, wrongPlayer: 0, wrongTeam: 0, missed: 5, extra: 0, accuracy: 17 / 22, avgTimeDrift: 0 },
  byCategory: [{ category: "Defence", total: 22, exact: 17, accuracy: 17 / 22 }],
  byStat: [
    { stat: "Tackles", total: 10, exact: 5, accuracy: 0.5 },
    { stat: "Kick", total: 12, exact: 12, accuracy: 1 },
  ],
  byTeam: [],
};
const plan = buildTrainingPlan(
  { result, scopeRows: rows },
  null,
  {
    analystName: "Sam", checkId: 5, checkCreatedAt: "2025-06-01T00:00:00Z", sport: "afl", matchLabel: null, masterFileName: null,
    videoUrl: null, checkCategory: null, teamLabel: (t) => t, scopeFilters: { team: "all", category: "all", stat: "all" },
    reviewBaseUrl: null, disputes: [],
  },
  { scope: "filters", window: { mode: "checks", n: 10 }, now: new Date("2025-06-02T00:00:00Z") }
);

let root: Root | null = null;
let el: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  el = null;
});

describe("TrainingPlanPrintView", () => {
  it("prints summary, strengths and focus but not the full instance list", async () => {
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(<TrainingPlanPrintView plan={plan} />);
    });
    const printRoot = document.getElementById("training-plan-print-root")!;
    const text = printRoot.textContent ?? "";
    expect(text).toContain("Strengths (95-100% accuracy)");
    expect(text).toContain("Kick");
    expect(text).toContain("Key focus areas");
    expect(text).toContain("Tackles: coverage (5 missed)");
    expect(text).not.toContain("All instances");
    expect(text).not.toContain("Instances");
    expect(text).not.toContain("Trending stats");
    expect(printRoot.querySelector("table")).toBeNull();
    expect(printRoot.querySelectorAll("li").length).toBeLessThanOrEqual(5 + 3 * 3);
  });
});