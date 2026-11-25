import { describe, it, expect } from "vitest";
import { deriveScheduleEmployees, pickScheduleRows } from "./scheduleEmployees";
describe("deriveScheduleEmployees", () => {
  it("dedupes across roster and timesheets and sorts by name", () => {
    const out = deriveScheduleEmployees(
      [{ employee_name: "Zed Z" }, { employee_name: "amy a" }, { employee_name: null }],
      [{ employee_name: "Amy A (NEW)" }, { employee_name: "  " }, { employee_name: "Bob B" }]
    );
    expect(out.map((e) => e.name)).toEqual(["amy a", "Bob B", "Zed Z"]);
    expect(out.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(out.every((e) => e.email === null)).toBe(true);
  });
  it("returns an empty list with no rows", () => {
    expect(deriveScheduleEmployees([], [])).toEqual([]);
  });
});

describe("pickScheduleRows", () => {
  const analysts = [
    { id: 7, name: "Aaron Finlay", email: "a@x.com" },
    { id: 8, name: "Bea Cole", email: null },
  ];
  it("Premier Data default keeps the analysts list, even with no roster or timesheets", () => {
    expect(pickScheduleRows(false, analysts, [], [])).toBe(analysts);
  });
  it("GameFace ignores the analysts list and derives rows from the week", () => {
    const rows = pickScheduleRows(true, analysts, [{ employee_name: "Zed Z" }], []);
    expect(rows.map((r) => r.name)).toEqual(["Zed Z"]);
  });
});