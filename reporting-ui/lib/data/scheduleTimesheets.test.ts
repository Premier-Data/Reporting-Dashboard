import { describe, it, expect } from "vitest";
import {
  aggregateApprovedTimesheets,
  unmatchedLabel,
} from "./scheduleTimesheets";
import { formatAud, formatHours2 } from "@/lib/deputy/format";
import type { DeputyTimesheetRow } from "@/lib/api/deputy";

let seq = 0;
function ts(over: Partial<DeputyTimesheetRow> = {}): DeputyTimesheetRow {
  seq += 1;
  return {
    deputy_id: `t${seq}`,
    timesheet_date: "2026-11-09",
    employee_name: "Angus Molden",
    operational_unit_name: "Soccer - Operations",
    start_at: "2026-11-08T22:00:00Z",
    end_at: "2026-11-09T03:05:00Z",
    total_time: 5.08,
    mealbreak_minutes: 0,
    cost: 169.672,
    on_cost: null,
    time_approved: true,
    pay_rule_approved: true,
    disputed: false,
    is_leave: false,
    ...over,
  };
}

const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
const ANALYSTS = [
  { id: 1, email: "angus@x.com", name: "Angus Molden" },
  { id: 2, email: null, name: "Daniel Jovanoski" },
  { id: 3, email: null, name: "Jessica Hastie" },
  { id: 4, email: null, name: "Tom Winneke" },
];

describe("aggregateApprovedTimesheets", () => {
  it("acceptance: Mon 9 Nov = 3 shifts, 19.19h, $585.21", () => {
    const rows = [
      ts({ employee_name: "Angus Molden", total_time: 5.08, cost: 169.672 }),
      ts({ employee_name: "Daniel Jovanoski", total_time: 6.58, cost: 193.781 }),
      ts({ employee_name: "Jessica Hastie", total_time: 7.53, cost: 221.7585 }),
    ];
    const { dailyTotals, week } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    const d = dailyTotals.get("2026-11-09")!;
    expect(d.count).toBe(3);
    expect(d.hours).toBeCloseTo(19.19, 6);
    expect(d.cost).toBeCloseTo(585.2115, 6);
    expect(formatAud(d.cost)).toBe("$585.21");
    expect(formatHours2(d.hours)).toBe("19.19");
    expect(d.unmatchedCount).toBe(0);
    expect(week.count).toBe(3);
  });

  it("lists split shifts in order and sums them in one cell", () => {
    const rows = [
      ts({ start_at: "2026-11-09T03:00:00Z", end_at: "2026-11-09T06:00:00Z", total_time: 3, cost: 90 }),
      ts({ start_at: "2026-11-08T22:00:00Z", end_at: "2026-11-09T01:00:00Z", total_time: 3, cost: 80 }),
    ];
    const { cells } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    expect(cells.size).toBe(1);
    const c = cells.get("1|2026-11-09")!;
    expect(c.entries.map((e) => e.start)).toEqual(["09:00:00", "14:00:00"]);
    expect(c.hours).toBe(6);
    expect(c.cost).toBe(170);
  });

  it("includes unmatched staff in totals but creates no cell", () => {
    const rows = [
      ts({ employee_name: "Someone Else", total_time: 4, cost: 100 }),
      ts({ employee_name: "Angus Molden", total_time: 2, cost: 50 }),
    ];
    const { cells, dailyTotals } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    const d = dailyTotals.get("2026-11-09")!;
    expect(d.count).toBe(2);
    expect(d.hours).toBe(6);
    expect(d.cost).toBe(150);
    expect(d.unmatchedCount).toBe(1);
    expect(cells.size).toBe(1);
  });

  it("includes leave in sums and flags the cell", () => {
    const rows = [ts({ is_leave: true, total_time: 8, cost: 200 })];
    const { cells, dailyTotals } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    expect(cells.get("1|2026-11-09")!.hasLeave).toBe(true);
    expect(dailyTotals.get("2026-11-09")!.hours).toBe(8);
  });

  it("handles an empty week", () => {
    const { cells, dailyTotals, week } = aggregateApprovedTimesheets([], DAYS, ANALYSTS);
    expect(cells.size).toBe(0);
    expect(dailyTotals.size).toBe(3);
    expect(week).toEqual({ hours: 0, cost: 0, count: 0, unmatchedCount: 0 });
  });

  it("counts null hours/cost as 0 but still counts the shift", () => {
    const rows = [
      ts({ total_time: null, cost: null, start_at: null, end_at: null }),
      ts({ employee_name: "Daniel Jovanoski", total_time: 2, cost: 10 }),
    ];
    const { dailyTotals, cells } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    const d = dailyTotals.get("2026-11-09")!;
    expect(d.count).toBe(2);
    expect(d.hours).toBe(2);
    expect(d.cost).toBe(10);
    const e = cells.get("1|2026-11-09")!.entries[0];
    expect(e.start).toBeNull();
    expect(e.end).toBeNull();
  });

  it("ignores days outside the range and null dates", () => {
    const rows = [
      ts({ timesheet_date: "2026-11-20" }),
      ts({ timesheet_date: null }),
    ];
    const { dailyTotals, week } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    expect(week.count).toBe(0);
    expect(dailyTotals.has("2026-11-20")).toBe(false);
  });

  it("matches names via existing keys (case, suffix, alias, email)", () => {
    const rows = [
      ts({ employee_name: "  ANGUS molden (NEW) " }),
      ts({ employee_name: "Thomas Winneke" }),
    ];
    const { cells } = aggregateApprovedTimesheets(rows, DAYS, ANALYSTS);
    expect(cells.has("1|2026-11-09")).toBe(true);
    expect(cells.has("4|2026-11-09")).toBe(true);
    const byEmail = aggregateApprovedTimesheets(
      [ts({ employee_name: "angus@x.com" })],
      DAYS,
      ANALYSTS
    );
    expect(byEmail.cells.has("1|2026-11-09")).toBe(true);
  });

  it("counts a duplicate deputy_id once", () => {
    const a = ts({ deputy_id: "dup" });
    const { dailyTotals } = aggregateApprovedTimesheets([a, { ...a }], DAYS, ANALYSTS);
    expect(dailyTotals.get("2026-11-09")!.count).toBe(1);
  });

  it("converts times to Sydney (AEDT)", () => {
    const { cells } = aggregateApprovedTimesheets(
      [ts({ start_at: "2026-11-08T22:00:00Z", end_at: "2026-11-09T06:30:00Z" })],
      DAYS,
      ANALYSTS
    );
    const e = cells.get("1|2026-11-09")!.entries[0];
    expect(e.start).toBe("09:00:00");
    expect(e.end).toBe("17:30:00");
  });
});

describe("unmatchedLabel", () => {
  it("pluralises", () => {
    expect(unmatchedLabel(1)).toBe("includes 1 shift for staff not listed above");
    expect(unmatchedLabel(3)).toBe("includes 3 shifts for staff not listed above");
  });
});
