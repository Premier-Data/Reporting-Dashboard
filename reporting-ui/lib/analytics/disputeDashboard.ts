// Pure aggregation for the Disputes > Dashboard tab: one row per analyst
// (the analyst being graded, who raises the disputes) plus an all-analysts
// totals row. Outcome classification comes from disputeOutcome.ts, the same
// helper the per-check Excel export uses.

import {
  addToTally,
  emptyTally,
  resolvedFraction,
  type OutcomeStatus,
  type OutcomeTally,
} from "@/lib/analytics/disputeOutcome";

export type CheckGroup = "all" | "specific" | "full" | "golden" | "other";

export const CHECK_GROUP_LABELS: Record<CheckGroup, string> = {
  all: "All",
  specific: "Specific check",
  full: "Full game",
  golden: "Golden",
  other: "Other",
};

/** accuracy_checks.category -> dashboard group. Null/unknown -> "other". */
export function groupOfCategory(category: string | null | undefined): Exclude<CheckGroup, "all"> {
  switch (category) {
    case "specific_stats":
      return "specific";
    case "full_game":
      return "full";
    case "golden_accuracy":
      return "golden";
    default:
      return "other";
  }
}

export type SportFilterValue = "all" | "afl" | "football";

export interface DashboardCheck {
  id: number;
  analyst_name: string | null;
  category: string | null;
  sport: string | null;
  deleted_at?: string | null;
}

export interface DashboardDispute {
  check_id: number;
  status: OutcomeStatus;
  deleted_at?: string | null;
}

export interface DashboardFilter {
  sport: SportFilterValue;
  categoryGroup: CheckGroup;
}

export interface AnalystDisputeRow extends OutcomeTally {
  /** Normalised key (trim, collapsed spaces, lower case). */
  key: string;
  /** Display name (most common original spelling). */
  analyst: string;
  /** All active checks of this analyst in the filter, including zero-dispute ones. */
  checks: number;
  /** Checks with at least one dispute. */
  checksWithDisputes: number;
  /** analystCorrect / resolved, null when nothing is resolved. */
  analystPct: number | null;
  /** masterCorrect / resolved, null when nothing is resolved. */
  masterPct: number | null;
  /** disputes / checks, null when the analyst has no checks. */
  avgPerCheck: number | null;
}

export interface DisputeDashboard {
  rows: AnalystDisputeRow[];
  totals: AnalystDisputeRow;
  /** Number of active checks per group for the sport filter (ignores group). */
  groupCounts: Record<CheckGroup, { checks: number; disputes: number }>;
}

export const UNASSIGNED = "(unassigned)";

export function normaliseAnalyst(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Same default as the Disputes page: a check with no stored sport is "afl". */
export function effectiveSport(sport: string | null | undefined): "afl" | "football" {
  return sport === "football" ? "football" : "afl";
}

function finish(
  key: string,
  analyst: string,
  checks: number,
  checksWithDisputes: number,
  t: OutcomeTally
): AnalystDisputeRow {
  return {
    ...t,
    key,
    analyst,
    checks,
    checksWithDisputes,
    analystPct: resolvedFraction(t.analystCorrect, t.resolved),
    masterPct: resolvedFraction(t.masterCorrect, t.resolved),
    avgPerCheck: checks > 0 ? t.total / checks : null,
  };
}

export function buildDisputeDashboard(
  disputes: readonly DashboardDispute[],
  checks: readonly DashboardCheck[],
  filter: DashboardFilter
): DisputeDashboard {
  const active = checks.filter((c) => !c.deleted_at);
  const sportOk = (c: DashboardCheck) =>
    filter.sport === "all" || effectiveSport(c.sport) === filter.sport;
  const groupOk = (c: DashboardCheck) =>
    filter.categoryGroup === "all" || groupOfCategory(c.category) === filter.categoryGroup;

  const checkById = new Map<number, DashboardCheck>();
  for (const c of active) checkById.set(c.id, c);

  const groupCounts: DisputeDashboard["groupCounts"] = {
    all: { checks: 0, disputes: 0 },
    specific: { checks: 0, disputes: 0 },
    full: { checks: 0, disputes: 0 },
    golden: { checks: 0, disputes: 0 },
    other: { checks: 0, disputes: 0 },
  };

  interface Acc {
    names: Map<string, number>;
    checkIds: Set<number>;
    disputedChecks: Set<number>;
    tally: OutcomeTally;
  }
  const accs = new Map<string, Acc>();
  const accFor = (c: DashboardCheck): Acc => {
    const raw = (c.analyst_name ?? "").trim().replace(/\s+/g, " ");
    const key = normaliseAnalyst(raw) || UNASSIGNED;
    let a = accs.get(key);
    if (!a) {
      a = { names: new Map(), checkIds: new Set(), disputedChecks: new Set(), tally: emptyTally() };
      accs.set(key, a);
    }
    if (raw) a.names.set(raw, (a.names.get(raw) ?? 0) + 1);
    return a;
  };

  for (const c of active) {
    if (!sportOk(c)) continue;
    groupCounts.all.checks += 1;
    groupCounts[groupOfCategory(c.category)].checks += 1;
    if (!groupOk(c)) continue;
    accFor(c).checkIds.add(c.id);
  }

  const total = emptyTally();
  const totalDisputedChecks = new Set<number>();
  for (const d of disputes) {
    if (d.deleted_at) continue;
    const c = checkById.get(d.check_id);
    if (!c || !sportOk(c)) continue;
    groupCounts.all.disputes += 1;
    groupCounts[groupOfCategory(c.category)].disputes += 1;
    if (!groupOk(c)) continue;
    const a = accFor(c);
    addToTally(a.tally, d.status);
    a.disputedChecks.add(c.id);
    addToTally(total, d.status);
    totalDisputedChecks.add(c.id);
  }

  const rows: AnalystDisputeRow[] = [];
  let totalChecks = 0;
  for (const [key, a] of accs) {
    // Display the most common spelling; ties resolve to the first seen.
    let best = "";
    let bestN = -1;
    for (const [n, cnt] of a.names) {
      if (cnt > bestN) {
        best = n;
        bestN = cnt;
      }
    }
    const checksN = a.checkIds.size;
    totalChecks += checksN;
    rows.push(finish(key, best || UNASSIGNED, checksN, a.disputedChecks.size, a.tally));
  }
  rows.sort((x, y) => y.total - x.total || x.analyst.localeCompare(y.analyst));

  return {
    rows,
    totals: finish("__all__", "All analysts", totalChecks, totalDisputedChecks.size, total),
    groupCounts,
  };
}
