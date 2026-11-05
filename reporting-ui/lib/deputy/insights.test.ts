import { describe, it, expect } from "vitest";
import {
  WEEKDAY_ORDER,
  weekdayOf,
  buildEmployeeInsights,
  type EmployeeInsightRow,
} from "./insights";
import type { DeputyTimesheetRow } from "@/lib/api/deputy";

// Build a timesheet row; only the fields the helper reads need setting.
function ts(p: Partial<DeputyTimesheetRow>): DeputyTimesheetRow {
  return {
    deputy_id: "x",
    timesheet_date: null,
    employee_name: null,
    operational_unit_name: null,
    start_at: null,
    end_at: null,
    total_time: null,
    mealbreak_minutes: null,
    cost: null,
    on_cost: null,
    time_approved: true,
    pay_rule_approved: null,
    disputed: null,
    is_leave: null,
    ...p,
  };
}

function rowFor(rows: EmployeeInsightRow[], name: string): EmployeeInsightRow {
  const hit = rows.find((r) => r.employee === name);
  if (!hit) throw new Error(`no insight row for ${name}`);
  return hit;
}

// ── weekdayOf ────────────────────────────────────────────────────────────────
describe("weekdayOf", () => {
  it("maps a known Saturday date correctly", () => {
    expect(weekdayOf("2026-11-07")).toBe("Saturday");
  });

  it("maps the surrounding days to the right Sat-first names", () => {
    expect(weekdayOf("2026-11-08")).toBe("Sunday");
    expect(weekdayOf("2026-11-09")).toBe("Monday");
    expect(weekdayOf("2026-11-10")).toBe("Tuesday");
    expect(weekdayOf("2026-11-11")).toBe("Wednesday");
    expect(weekdayOf("2026-11-12")).toBe("Thursday");
    expect(weekdayOf("2026-11-13")).toBe("Friday");
  });

  it("does not shift the day across the UTC boundary", () => {
    // Local-midnight parse keeps this on its real calendar day.
    expect(weekdayOf("2026-01-01")).toBe("Thursday");
  });

  it("returns null for blank/unparseable dates", () => {
    expect(weekdayOf(null)).toBeNull();
    expect(weekdayOf("")).toBeNull();
    expect(weekdayOf("not-a-date")).toBeNull();
  });
});

// ── buildEmployeeInsights ─────────────────────────────────────────────────────
describe("buildEmployeeInsights", () => {
  it("returns [] for empty input", () => {
    expect(buildEmployeeInsights([])).toEqual([]);
  });

  it("aggregates one employee across several weekdays (counts, sums, averages)", () => {
    const rows = [
      // Saturday 2026-11-07: two shifts.
      ts({ employee_name: "Dan Jov", timesheet_date: "2026-11-07", cost: 100, total_time: 5 }),
      ts({ employee_name: "Dan Jov", timesheet_date: "2026-11-07", cost: 200, total_time: 7 }),
      // Monday 2026-11-09: one shift.
      ts({ employee_name: "Dan Jov", timesheet_date: "2026-11-09", cost: 150, total_time: 6 }),
    ];

    const [row] = buildEmployeeInsights(rows);
    expect(row.employee).toBe("Dan Jov");

    // Overall: 3 shifts, cost 450, avgCost 150, avgHours (5+7+6)/3 = 6.
    expect(row.overall.shiftCount).toBe(3);
    expect(row.overall.totalCost).toBe(450);
    expect(row.overall.avgCost).toBe(150);
    expect(row.overall.avgHours).toBe(6);

    // Saturday bucket: 2 shifts, cost 300, avgCost 150, avgHours 6.
    const sat = row.byWeekday.Saturday;
    expect(sat.shiftCount).toBe(2);
    expect(sat.totalCost).toBe(300);
    expect(sat.avgCost).toBe(150);
    expect(sat.avgHours).toBe(6);

    // Monday bucket: 1 shift.
    const mon = row.byWeekday.Monday;
    expect(mon.shiftCount).toBe(1);
    expect(mon.totalCost).toBe(150);
    expect(mon.avgCost).toBe(150);
    expect(mon.avgHours).toBe(6);
  });

  it("gives empty weekday buckets shiftCount 0 with null averages", () => {
    const rows = [
      ts({ employee_name: "Krystal", timesheet_date: "2026-11-07", cost: 100, total_time: 5 }),
    ];
    const [row] = buildEmployeeInsights(rows);

    // Only Saturday has a shift; every other day is empty with null averages.
    for (const day of WEEKDAY_ORDER) {
      const bucket = row.byWeekday[day];
      if (day === "Saturday") {
        expect(bucket.shiftCount).toBe(1);
      } else {
        expect(bucket.shiftCount).toBe(0);
        expect(bucket.totalCost).toBe(0);
        expect(bucket.avgCost).toBeNull();
        expect(bucket.avgHours).toBeNull();
      }
    }
  });

  it("averages with non-round precision", () => {
    const rows = [
      ts({ employee_name: "A", timesheet_date: "2026-11-07", cost: 168.542, total_time: 6.52 }),
      ts({ employee_name: "A", timesheet_date: "2026-11-08", cost: 200.2144, total_time: 7.12 }),
      ts({ employee_name: "A", timesheet_date: "2026-11-09", cost: 237.1485, total_time: 7.85 }),
    ];
    const [row] = buildEmployeeInsights(rows);
    expect(row.overall.shiftCount).toBe(3);
    expect(row.overall.totalCost).toBeCloseTo(605.9049, 6);
    expect(row.overall.avgCost).toBeCloseTo(201.9683, 4);
    expect(row.overall.avgHours).toBeCloseTo((6.52 + 7.12 + 7.85) / 3, 6);
  });

  it("treats null cost/total_time as 0 but still counts the shift", () => {
    const rows = [
      ts({ employee_name: "B", timesheet_date: "2026-11-07", cost: null, total_time: null }),
      ts({ employee_name: "B", timesheet_date: "2026-11-07", cost: 100, total_time: 4 }),
    ];
    const [row] = buildEmployeeInsights(rows);
    const sat = row.byWeekday.Saturday;
    expect(sat.shiftCount).toBe(2);
    expect(sat.totalCost).toBe(100);
    // Average over 2 shifts, nulls counted as 0.
    expect(sat.avgCost).toBe(50);
    expect(sat.avgHours).toBe(2);
  });

  it("a row with a blank date counts toward Overall but no weekday", () => {
    const rows = [
      ts({ employee_name: "C", timesheet_date: null, cost: 80, total_time: 3 }),
      ts({ employee_name: "C", timesheet_date: "2026-11-07", cost: 120, total_time: 5 }),
    ];
    const [row] = buildEmployeeInsights(rows);
    expect(row.overall.shiftCount).toBe(2);
    expect(row.overall.totalCost).toBe(200);
    // Only the dated shift lands in a weekday bucket.
    const weekdayShiftTotal = WEEKDAY_ORDER.reduce(
      (sum, day) => sum + row.byWeekday[day].shiftCount,
      0
    );
    expect(weekdayShiftTotal).toBe(1);
    expect(row.byWeekday.Saturday.shiftCount).toBe(1);
  });

  it("sorts rows by employee name ascending", () => {
    const rows = [
      ts({ employee_name: "Tiffany", timesheet_date: "2026-11-07", cost: 1, total_time: 1 }),
      ts({ employee_name: "Angus", timesheet_date: "2026-11-07", cost: 1, total_time: 1 }),
      ts({ employee_name: "Nick", timesheet_date: "2026-11-07", cost: 1, total_time: 1 }),
    ];
    const names = buildEmployeeInsights(rows).map((r) => r.employee);
    expect(names).toEqual(["Angus", "Nick", "Tiffany"]);
  });

  it("buckets blank/missing employee names under (unknown employee)", () => {
    const rows = [
      ts({ employee_name: null, timesheet_date: "2026-11-07", cost: 10, total_time: 1 }),
      ts({ employee_name: "   ", timesheet_date: "2026-11-07", cost: 20, total_time: 2 }),
    ];
    const rowsOut = buildEmployeeInsights(rows);
    expect(rowsOut).toHaveLength(1);
    const unknown = rowFor(rowsOut, "(unknown employee)");
    expect(unknown.overall.shiftCount).toBe(2);
    expect(unknown.overall.totalCost).toBe(30);
  });

  it("keeps employees separate", () => {
    const rows = [
      ts({ employee_name: "Dan Jov", timesheet_date: "2026-11-07", cost: 100, total_time: 5 }),
      ts({ employee_name: "Krystal", timesheet_date: "2026-11-07", cost: 200, total_time: 7 }),
    ];
    const out = buildEmployeeInsights(rows);
    expect(out).toHaveLength(2);
    expect(rowFor(out, "Dan Jov").overall.totalCost).toBe(100);
    expect(rowFor(out, "Krystal").overall.totalCost).toBe(200);
  });
});
