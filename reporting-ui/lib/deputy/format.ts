// Pure formatting + derivation helpers for the Deputy API page.
//
// Kept free of React/Deno imports so they are unit-testable in isolation and
// reusable by the client page. These are intentionally separate from the loose
// `lib/format.ts` helpers (shared, `any`-typed, no null handling) so existing
// callers stay untouched while the Deputy page gets strict, null-safe money /
// hours formatting and the derived estimated-rate math out of JSX.

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/** Format a number as AUD currency; `"-"` for null/undefined/NaN. */
export function formatAud(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return AUD.format(value);
}

/** Format a number of hours to 2dp; `"-"` for null/undefined/NaN. */
export function formatHours2(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

/**
 * Derived estimated hourly rate = cost / totalTime (hours).
 * Returns null unless both are finite numbers and totalTime > 0, so callers
 * can render a dash for missing/zero hours rather than Infinity/NaN.
 */
export function estimatedHourlyRate(
  cost: number | null | undefined,
  totalTime: number | null | undefined
): number | null {
  if (cost == null || !Number.isFinite(cost)) return null;
  if (totalTime == null || !Number.isFinite(totalTime) || totalTime <= 0) {
    return null;
  }
  return cost / totalTime;
}

/** Convenience: estimated hourly rate formatted as AUD, `"-"` when not derivable. */
export function formatRate(
  cost: number | null | undefined,
  totalTime: number | null | undefined
): string {
  return formatAud(estimatedHourlyRate(cost, totalTime));
}

// ── Per-area summary ─────────────────────────────────────────────────────────

/** Minimal shape needed to summarise a timesheet row by area. */
export interface AreaSummaryInput {
  operational_unit_name: string | null;
  total_time: number | null;
  cost: number | null;
}

/** One area's aggregated totals. */
export interface AreaSummaryRow {
  area: string;
  hours: number;
  cost: number;
  shifts: number;
}

/** The full summary: per-area rows (sorted by cost desc) plus a grand total. */
export interface AreaSummary {
  rows: AreaSummaryRow[];
  total: { hours: number; cost: number; shifts: number };
}

const UNKNOWN_AREA = "(unknown area)";

/**
 * Group timesheet rows by area, summing hours (total_time) and cost. Null
 * hours/cost count as 0 toward the sums (a row with no cost still counts as a
 * shift). Rows with no area name are bucketed under "(unknown area)". Per-area
 * rows are sorted by cost descending; the grand total aggregates every row.
 */
export function summariseByArea(rows: AreaSummaryInput[]): AreaSummary {
  const byArea = new Map<string, AreaSummaryRow>();
  let totalHours = 0;
  let totalCost = 0;

  for (const r of rows) {
    const area = r.operational_unit_name?.trim() || UNKNOWN_AREA;
    const hours = Number.isFinite(r.total_time as number)
      ? (r.total_time as number)
      : 0;
    const cost = Number.isFinite(r.cost as number) ? (r.cost as number) : 0;

    const entry =
      byArea.get(area) ?? { area, hours: 0, cost: 0, shifts: 0 };
    entry.hours += hours;
    entry.cost += cost;
    entry.shifts += 1;
    byArea.set(area, entry);

    totalHours += hours;
    totalCost += cost;
  }

  const summaryRows = [...byArea.values()].sort((a, b) => b.cost - a.cost);
  return {
    rows: summaryRows,
    total: { hours: totalHours, cost: totalCost, shifts: rows.length },
  };
}
