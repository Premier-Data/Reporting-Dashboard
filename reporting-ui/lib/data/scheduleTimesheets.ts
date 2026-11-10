/*
 * SCHEDULE: APPROVED TIMESHEET AGGREGATION (pure)
 *
 * Turns approved Deputy timesheet rows into (a) per analyst/day cells for the
 * Schedule grid and (b) per-day totals over ALL approved rows in the visible
 * week, whether or not the staff member is in the analyst list.
 *
 * Cost is always computed here; whether it is rendered is a UI decision.
 */

import type { DeputyTimesheetRow } from "@/lib/api/deputy";
import { analystRosterKeys, rosterIndexKey } from "./rosterMatch";
import { sydneyTimeOfDay } from "./deputyApiRoster";

export type ScheduleTimesheetEntry = {
  id: string;
  /** Sydney HH:mm:ss, or null when missing/invalid. */
  start: string | null;
  end: string | null;
  hours: number;
  cost: number;
  area: string | null;
  isLeave: boolean;
};

export type ApprovedCell = {
  entries: ScheduleTimesheetEntry[];
  hours: number;
  cost: number;
  hasLeave: boolean;
};

export type DayTotal = {
  hours: number;
  cost: number;
  count: number;
  /** Shifts in this total for staff not matched to any listed analyst. */
  unmatchedCount: number;
};

export type ScheduleAnalystRef = {
  id: number;
  email: string | null;
  name: string;
};

export type ApprovedAggregation = {
  /** Keyed `${analyst.id}|${yyyy-mm-dd}`. */
  cells: Map<string, ApprovedCell>;
  /** Keyed by day key; every visible day is present. */
  dailyTotals: Map<string, DayTotal>;
  week: DayTotal;
};

const num = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

const emptyTotal = (): DayTotal => ({
  hours: 0,
  cost: 0,
  count: 0,
  unmatchedCount: 0,
});

export function aggregateApprovedTimesheets(
  rows: DeputyTimesheetRow[],
  dayKeys: string[],
  analysts: ScheduleAnalystRef[]
): ApprovedAggregation {
  const visible = new Set(dayKeys);

  // First analyst (list order) wins for any shared key.
  const analystByKey = new Map<string, number>();
  for (const a of analysts) {
    for (const k of analystRosterKeys(a.email, a.name)) {
      if (!analystByKey.has(k)) analystByKey.set(k, a.id);
    }
  }

  const dailyTotals = new Map<string, DayTotal>();
  for (const k of dayKeys) dailyTotals.set(k, emptyTotal());

  const seen = new Set<string>();
  const cellRows = new Map<
    string,
    { entry: ScheduleTimesheetEntry; startAt: string }[]
  >();

  for (const r of rows) {
    const date = r.timesheet_date;
    if (!date || !visible.has(date)) continue;
    if (seen.has(r.deputy_id)) continue;
    seen.add(r.deputy_id);

    const hours = num(r.total_time);
    const cost = num(r.cost);

    const total = dailyTotals.get(date)!;
    total.hours += hours;
    total.cost += cost;
    total.count += 1;

    const analystId = analystByKey.get(rosterIndexKey(null, r.employee_name));
    if (analystId === undefined) {
      total.unmatchedCount += 1;
      continue;
    }

    const key = `${analystId}|${date}`;
    const list = cellRows.get(key) ?? [];
    list.push({
      startAt: r.start_at ?? "",
      entry: {
        id: r.deputy_id,
        start: sydneyTimeOfDay(r.start_at),
        end: sydneyTimeOfDay(r.end_at),
        hours,
        cost,
        area: r.operational_unit_name ?? null,
        isLeave: r.is_leave === true,
      },
    });
    cellRows.set(key, list);
  }

  const cells = new Map<string, ApprovedCell>();
  for (const [key, list] of cellRows) {
    list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    const entries = list.map((x) => x.entry);
    cells.set(key, {
      entries,
      hours: entries.reduce((s, e) => s + e.hours, 0),
      cost: entries.reduce((s, e) => s + e.cost, 0),
      hasLeave: entries.some((e) => e.isLeave),
    });
  }

  const week = emptyTotal();
  for (const t of dailyTotals.values()) {
    week.hours += t.hours;
    week.cost += t.cost;
    week.count += t.count;
    week.unmatchedCount += t.unmatchedCount;
  }

  return { cells, dailyTotals, week };
}

/** Hint shown when a total includes shifts for staff not in the grid. */
export function unmatchedLabel(n: number): string {
  return `includes ${n} ${n === 1 ? "shift" : "shifts"} for staff not listed above`;
}
