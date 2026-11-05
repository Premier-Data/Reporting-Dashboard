// Pure aggregation helper for the Deputy Insights page.
//
// Takes already-date-filtered timesheet rows and produces a per-employee
// matrix of shift metrics bucketed into an Overall total plus one bucket per
// weekday. Kept free of React/Deno imports so it is unit-testable in isolation
// and reusable by the client page; it returns raw numbers/nulls (no
// formatting) — the JSX formats with formatAud/formatHours2.

import type { DeputyTimesheetRow } from "@/lib/api/deputy";

// Saturday-first column order, matching the user's spreadsheet layout.
export const WEEKDAY_ORDER = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
] as const;
export type Weekday = (typeof WEEKDAY_ORDER)[number];

// JS getDay() (Sun=0 .. Sat=6) -> column name.
const DAY_INDEX_TO_NAME: Record<number, Weekday> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

/** One aggregated bucket (Overall, or a single weekday). */
export interface InsightBucket {
  shiftCount: number; // count of timesheets
  totalCost: number; // sum of cost (nulls treated as 0)
  avgCost: number | null; // totalCost / shiftCount, null when count 0
  avgHours: number | null; // sum(total_time) / shiftCount, null when count 0
}

/** A per-employee row: the Overall bucket plus a bucket per weekday. */
export interface EmployeeInsightRow {
  employee: string; // employee_name (fallback "(unknown employee)")
  overall: InsightBucket;
  byWeekday: Record<Weekday, InsightBucket>;
}

const UNKNOWN_EMPLOYEE = "(unknown employee)";

/**
 * Map a "yyyy-mm-dd" timesheet date to its Saturday-first weekday name.
 * Parses at local midnight (`new Date(\`${d}T00:00:00\`)`) so the day cannot
 * shift across the UTC boundary. Returns null for a blank/unparseable date.
 */
export function weekdayOf(timesheetDate: string | null): Weekday | null {
  if (!timesheetDate) return null;
  const d = new Date(`${timesheetDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return DAY_INDEX_TO_NAME[d.getDay()] ?? null;
}

// Internal mutable accumulator (sums only; averages derived at the end).
interface BucketAccumulator {
  shiftCount: number;
  totalCost: number;
  totalHours: number;
}

function emptyAccumulator(): BucketAccumulator {
  return { shiftCount: 0, totalCost: 0, totalHours: 0 };
}

function addToAccumulator(acc: BucketAccumulator, row: DeputyTimesheetRow): void {
  const cost = Number.isFinite(row.cost as number) ? (row.cost as number) : 0;
  const hours = Number.isFinite(row.total_time as number)
    ? (row.total_time as number)
    : 0;
  acc.shiftCount += 1;
  acc.totalCost += cost;
  acc.totalHours += hours;
}

// Finalise an accumulator into a public bucket: averages are null when the
// bucket has no shifts (so the JSX renders "–" rather than NaN/#DIV/0!).
function finaliseBucket(acc: BucketAccumulator): InsightBucket {
  const hasShifts = acc.shiftCount > 0;
  return {
    shiftCount: acc.shiftCount,
    totalCost: acc.totalCost,
    avgCost: hasShifts ? acc.totalCost / acc.shiftCount : null,
    avgHours: hasShifts ? acc.totalHours / acc.shiftCount : null,
  };
}

interface EmployeeAccumulator {
  employee: string;
  overall: BucketAccumulator;
  byWeekday: Record<Weekday, BucketAccumulator>;
}

function emptyEmployeeAccumulator(employee: string): EmployeeAccumulator {
  const byWeekday = {} as Record<Weekday, BucketAccumulator>;
  for (const day of WEEKDAY_ORDER) {
    byWeekday[day] = emptyAccumulator();
  }
  return { employee, overall: emptyAccumulator(), byWeekday };
}

/**
 * Build the per-employee insights matrix. Rows are assumed already
 * date-filtered by the caller. Null cost/total_time count as 0 toward the sums
 * but the shift still counts (matches summariseBy in format.ts). A row with a
 * blank/unparseable timesheet_date contributes to Overall but to no weekday
 * bucket. Rows are returned sorted by employee name ascending.
 */
export function buildEmployeeInsights(
  rows: DeputyTimesheetRow[]
): EmployeeInsightRow[] {
  const byEmployee = new Map<string, EmployeeAccumulator>();

  for (const row of rows) {
    const employee = row.employee_name?.trim() || UNKNOWN_EMPLOYEE;
    let acc = byEmployee.get(employee);
    if (!acc) {
      acc = emptyEmployeeAccumulator(employee);
      byEmployee.set(employee, acc);
    }
    addToAccumulator(acc.overall, row);
    const day = weekdayOf(row.timesheet_date);
    if (day) addToAccumulator(acc.byWeekday[day], row);
  }

  const result: EmployeeInsightRow[] = [...byEmployee.values()].map((acc) => {
    const byWeekday = {} as Record<Weekday, InsightBucket>;
    for (const day of WEEKDAY_ORDER) {
      byWeekday[day] = finaliseBucket(acc.byWeekday[day]);
    }
    return {
      employee: acc.employee,
      overall: finaliseBucket(acc.overall),
      byWeekday,
    };
  });

  result.sort((a, b) =>
    a.employee.localeCompare(b.employee, undefined, { sensitivity: "base" })
  );
  return result;
}
