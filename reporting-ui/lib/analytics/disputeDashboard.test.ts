import { describe, expect, it } from "vitest";
import {
  buildDisputeDashboard,
  groupOfCategory,
  type DashboardCheck,
  type DashboardDispute,
} from "@/lib/analytics/disputeDashboard";

const chk = (
  id: number,
  analyst: string | null,
  category: string | null = "full_game",
  sport: string | null = "afl",
  deleted_at: string | null = null
): DashboardCheck => ({ id, analyst_name: analyst, category, sport, deleted_at });
const dis = (
  check_id: number,
  status: DashboardDispute["status"],
  deleted_at: string | null = null
): DashboardDispute => ({ check_id, status, deleted_at });
const ALL = { sport: "all", categoryGroup: "all" } as const;

describe("buildDisputeDashboard", () => {
  it("counts per analyst with resolved-only percentages", () => {
    const checks = [chk(1, "Ann"), chk(2, "Bob")];
    const disputes = [
      dis(1, "confirmed"),
      dis(1, "confirmed"),
      dis(1, "denied"),
      dis(1, "open"),
      dis(2, "denied"),
    ];
    const r = buildDisputeDashboard(disputes, checks, ALL);
    const ann = r.rows.find((x) => x.analyst === "Ann")!;
    expect(ann).toMatchObject({ total: 4, resolved: 3, open: 1, analystCorrect: 2, masterCorrect: 1 });
    expect(ann.analystPct).toBeCloseTo(2 / 3);
    expect(ann.masterPct).toBeCloseTo(1 / 3);
    expect(r.totals).toMatchObject({ total: 5, resolved: 4, open: 1, analystCorrect: 2, masterCorrect: 2 });
    expect(r.totals.analystPct).toBeCloseTo(0.5);
    expect(r.rows[0].analyst).toBe("Ann"); // sorted by disputes desc
  });

  it("averages over all checks including zero-dispute ones", () => {
    const checks = Array.from({ length: 10 }, (_, i) => chk(i + 1, "Ann"));
    const disputes = [1, 2, 3, 4, 5].map((id) => dis(id, "open"));
    const r = buildDisputeDashboard(disputes, checks, ALL);
    expect(r.rows[0].checks).toBe(10);
    expect(r.rows[0].checksWithDisputes).toBe(5);
    expect(r.rows[0].avgPerCheck).toBe(0.5);
    expect(r.totals.avgPerCheck).toBe(0.5);
  });

  it("lists analysts with checks but no disputes", () => {
    const r = buildDisputeDashboard([], [chk(1, "Ann")], ALL);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].total).toBe(0);
    expect(r.rows[0].avgPerCheck).toBe(0);
  });

  it("gives null percentages when only open disputes exist", () => {
    const r = buildDisputeDashboard([dis(1, "open")], [chk(1, "Ann")], ALL);
    expect(r.rows[0].analystPct).toBeNull();
    expect(r.rows[0].masterPct).toBeNull();
    expect(r.totals.analystPct).toBeNull();
  });

  it("maps categories to groups", () => {
    expect(groupOfCategory("specific_stats")).toBe("specific");
    expect(groupOfCategory("full_game")).toBe("full");
    expect(groupOfCategory("golden_accuracy")).toBe("golden");
    expect(groupOfCategory(null)).toBe("other");
    expect(groupOfCategory("weird")).toBe("other");
  });

  it("filters by category group and reports group counts", () => {
    const checks = [
      chk(1, "Ann", "specific_stats"),
      chk(2, "Ann", "full_game"),
      chk(3, "Ann", "golden_accuracy"),
      chk(4, "Ann", null),
    ];
    const disputes = [dis(1, "open"), dis(2, "open"), dis(2, "confirmed"), dis(3, "denied"), dis(4, "open")];
    const full = buildDisputeDashboard(disputes, checks, { sport: "all", categoryGroup: "full" });
    expect(full.totals.total).toBe(2);
    expect(full.rows[0].checks).toBe(1);
    const golden = buildDisputeDashboard(disputes, checks, { sport: "all", categoryGroup: "golden" });
    expect(golden.totals).toMatchObject({ total: 1, masterCorrect: 1 });
    expect(full.groupCounts.all).toEqual({ checks: 4, disputes: 5 });
    expect(full.groupCounts.specific).toEqual({ checks: 1, disputes: 1 });
    expect(full.groupCounts.other).toEqual({ checks: 1, disputes: 1 });
  });

  it("filters by sport, defaulting null sport to afl", () => {
    const checks = [chk(1, "Ann", "full_game", "football"), chk(2, "Ann", "full_game", null)];
    const disputes = [dis(1, "open"), dis(2, "open"), dis(2, "open")];
    expect(buildDisputeDashboard(disputes, checks, { sport: "football", categoryGroup: "all" }).totals.total).toBe(1);
    expect(buildDisputeDashboard(disputes, checks, { sport: "afl", categoryGroup: "all" }).totals.total).toBe(2);
  });

  it("merges analyst names that differ by case and whitespace", () => {
    const checks = [chk(1, "Ann Lee"), chk(2, "  ann  lee "), chk(3, "ANN LEE")];
    const r = buildDisputeDashboard([dis(1, "open"), dis(2, "open")], checks, ALL);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].checks).toBe(3);
    expect(r.rows[0].total).toBe(2);
  });

  it("ignores soft-deleted checks and disputes", () => {
    const checks = [chk(1, "Ann"), chk(2, "Ann", "full_game", "afl", "2025-01-01")];
    const disputes = [dis(1, "open"), dis(2, "open"), dis(1, "open", "2025-01-01")];
    const r = buildDisputeDashboard(disputes, checks, ALL);
    expect(r.totals.total).toBe(1);
    expect(r.rows[0].checks).toBe(1);
  });

  it("ignores disputes whose check is unknown", () => {
    const r = buildDisputeDashboard([dis(99, "open")], [chk(1, "Ann")], ALL);
    expect(r.totals.total).toBe(0);
  });
});
