import { describe, it, expect } from "vitest";
import {
  resolveEmployeeName,
  buildEmployeeMap,
  buildUnitMap,
  attachNames,
  distinctIds,
} from "../../supabase/functions/deputy-read/shape";

// ── Employee name resolution ─────────────────────────────────────────────────
describe("resolveEmployeeName (display_name → first last → raw id)", () => {
  it("prefers display_name when present", () => {
    expect(
      resolveEmployeeName(
        { display_name: "Jane Doe", first_name: "Jane", last_name: "Doe" },
        "100"
      )
    ).toBe("Jane Doe");
  });

  it("falls back to 'first last' when display_name is blank", () => {
    expect(
      resolveEmployeeName({ display_name: "  ", first_name: "Jane", last_name: "Doe" }, "100")
    ).toBe("Jane Doe");
  });

  it("falls back to the raw id when no name fields are set", () => {
    expect(resolveEmployeeName({}, "100")).toBe("100");
    expect(resolveEmployeeName(null, "100")).toBe("100");
  });

  it("returns null when nothing at all is known", () => {
    expect(resolveEmployeeName(null, null)).toBeNull();
    expect(resolveEmployeeName({}, "")).toBeNull();
  });
});

// ── Lookup map builders ──────────────────────────────────────────────────────
describe("map builders", () => {
  it("buildEmployeeMap keys by deputy_id and skips blank ids", () => {
    const map = buildEmployeeMap([
      { deputy_id: "1", display_name: "A" },
      { deputy_id: "", display_name: "skip" },
    ]);
    expect(map.size).toBe(1);
    expect(map.get("1")?.display_name).toBe("A");
  });

  it("buildUnitMap keys id → unit name", () => {
    const map = buildUnitMap([
      { deputy_id: "7", operational_unit_name: "Kitchen" },
    ]);
    expect(map.get("7")).toBe("Kitchen");
  });
});

// ── attachNames ──────────────────────────────────────────────────────────────
describe("attachNames (resolves soft FKs, degrades to raw id)", () => {
  const employeeMap = buildEmployeeMap([
    { deputy_id: "100", display_name: "Jane Doe" },
    { deputy_id: "200", first_name: "Sam", last_name: "Lee" },
  ]);
  const unitMap = buildUnitMap([
    { deputy_id: "7", operational_unit_name: "Kitchen" },
  ]);

  it("attaches resolved employee + unit names", () => {
    const [row] = attachNames(
      [{ employee_deputy_id: "100", operational_unit_deputy_id: "7" }],
      employeeMap,
      unitMap
    );
    expect(row.employee_name).toBe("Jane Doe");
    expect(row.operational_unit_name).toBe("Kitchen");
  });

  it("builds the name from first/last when there is no display_name", () => {
    const [row] = attachNames(
      [{ employee_deputy_id: "200", operational_unit_deputy_id: "7" }],
      employeeMap,
      unitMap
    );
    expect(row.employee_name).toBe("Sam Lee");
  });

  it("degrades to the raw id when a lookup is missing (never throws)", () => {
    const [row] = attachNames(
      [{ employee_deputy_id: "999", operational_unit_deputy_id: "888" }],
      employeeMap,
      unitMap
    );
    expect(row.employee_name).toBe("999");
    expect(row.operational_unit_name).toBe("888");
  });

  it("handles null ids (open shift / no unit) without throwing", () => {
    const [row] = attachNames(
      [{ employee_deputy_id: null, operational_unit_deputy_id: null }],
      employeeMap,
      unitMap
    );
    expect(row.employee_name).toBeNull();
    expect(row.operational_unit_name).toBeNull();
  });
});

// ── distinctIds ──────────────────────────────────────────────────────────────
describe("distinctIds", () => {
  it("collects distinct non-null string ids", () => {
    const ids = distinctIds(
      [
        { employee_deputy_id: "1" },
        { employee_deputy_id: "1" },
        { employee_deputy_id: "2" },
        { employee_deputy_id: null },
        { employee_deputy_id: "" },
      ],
      "employee_deputy_id"
    );
    expect(ids.sort()).toEqual(["1", "2"]);
  });
});
