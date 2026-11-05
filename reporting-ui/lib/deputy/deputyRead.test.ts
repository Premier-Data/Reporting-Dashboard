import { describe, it, expect } from "vitest";
import {
  resolveEmployeeName,
  buildEmployeeMap,
  buildUnitMap,
  attachNames,
  distinctIds,
  needsAnotherPage,
  shouldSync,
  sydneySyncWindow,
} from "../../supabase/functions/deputy-read/shape";

// ── Employee name resolution ─────────────────────────────────────────────────
describe("resolveEmployeeName (actual 'first last' → display_name → raw id)", () => {
  it("prefers the actual 'first last' name over the preferred display_name", () => {
    // e.g. Deputy display_name "Dan Jov" but legal name Daniel Jovanoski.
    expect(
      resolveEmployeeName(
        { display_name: "Dan Jov", first_name: "Daniel", last_name: "Jovanoski" },
        "12"
      )
    ).toBe("Daniel Jovanoski");
  });

  it("falls back to display_name when first/last are blank", () => {
    expect(
      resolveEmployeeName(
        { display_name: "Dan Jov", first_name: "  ", last_name: "" },
        "12"
      )
    ).toBe("Dan Jov");
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

// ── needsAnotherPage ─────────────────────────────────────────────────────────
describe("needsAnotherPage (deputy-read pagination stop predicate)", () => {
  it("returns true when the last page was full and under the ceiling", () => {
    // First full page, more rows likely remain.
    expect(needsAnotherPage(1000, 1000, 1000, 20000)).toBe(true);
  });

  it("returns true mid-loop when a full page keeps us under the ceiling", () => {
    expect(needsAnotherPage(1000, 1000, 5000, 20000)).toBe(true);
  });

  it("returns false when the last page was short (fewer than pageSize)", () => {
    expect(needsAnotherPage(342, 1000, 1342, 20000)).toBe(false);
  });

  it("returns false when the last page was empty", () => {
    expect(needsAnotherPage(0, 1000, 1000, 20000)).toBe(false);
  });

  it("returns false when the ceiling is reached even on a full page", () => {
    expect(needsAnotherPage(1000, 1000, 20000, 20000)).toBe(false);
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

// ── On-demand sync helpers ───────────────────────────────────────────────────
describe("shouldSync", () => {
  const NOW = Date.parse("2026-06-10T00:00:00Z");
  const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

  it("syncs when there is no previous run", () => {
    expect(shouldSync(null, NOW, 60)).toBe(true);
    expect(shouldSync("", NOW, 60)).toBe(true);
  });
  it("syncs when the timestamp is unparseable", () => {
    expect(shouldSync("not-a-date", NOW, 60)).toBe(true);
  });
  it("skips when the last run is recent", () => {
    expect(shouldSync(ago(10), NOW, 60)).toBe(false);
    expect(shouldSync(ago(59), NOW, 60)).toBe(false);
  });
  it("syncs exactly at the boundary and beyond", () => {
    expect(shouldSync(ago(60), NOW, 60)).toBe(true);
    expect(shouldSync(ago(61), NOW, 60)).toBe(true);
    expect(shouldSync(ago(86400), NOW, 60)).toBe(true);
  });
  it("treats slightly future-dated runs as recent (clock skew)", () => {
    expect(shouldSync(ago(-30), NOW, 60)).toBe(false);
  });
  it("treats far-future-dated runs as bogus and syncs", () => {
    expect(shouldSync(ago(-600), NOW, 60)).toBe(true);
  });
});

describe("sydneySyncWindow", () => {
  const span = (w: { startDate: string; endDate: string }) =>
    (Date.parse(w.endDate) - Date.parse(w.startDate)) / 86400000;

  it("uses the Sydney date, not the UTC date (AEDT)", () => {
    const w = sydneySyncWindow(Date.parse("2026-11-04T20:00:00Z"));
    expect(w).toEqual({ startDate: "2026-10-23", endDate: "2026-11-05" });
    expect(span(w)).toBe(13);
  });
  it("control: 23:00 Sydney is still the same date", () => {
    const w = sydneySyncWindow(Date.parse("2026-11-04T12:00:00Z"));
    expect(w.endDate).toBe("2026-11-04");
    expect(span(w)).toBe(13);
  });
  it("handles AEST winter offset", () => {
    const w = sydneySyncWindow(Date.parse("2026-06-30T14:30:00Z"));
    expect(w).toEqual({ startDate: "2026-06-18", endDate: "2026-07-01" });
    expect(span(w)).toBe(13);
    expect(sydneySyncWindow(Date.parse("2026-06-30T13:59:00Z")).endDate).toBe(
      "2026-06-30"
    );
  });
  it("handles DST start (2026-10-04 02:00 AEST -> 03:00 AEDT)", () => {
    expect(sydneySyncWindow(Date.parse("2026-10-03T13:59:00Z")).endDate).toBe(
      "2026-10-03"
    );
    expect(sydneySyncWindow(Date.parse("2026-10-03T15:59:00Z")).endDate).toBe(
      "2026-10-04"
    );
    const w = sydneySyncWindow(Date.parse("2026-10-03T16:00:00Z"));
    expect(w.endDate).toBe("2026-10-04");
    expect(span(w)).toBe(13);
  });
  it("handles DST end (2027-04-04 03:00 AEDT -> 02:00 AEST)", () => {
    const w = sydneySyncWindow(Date.parse("2027-04-03T15:30:00Z"));
    expect(w.endDate).toBe("2027-04-04");
    expect(span(w)).toBe(13);
  });
  it("rolls over month/year", () => {
    const w = sydneySyncWindow(Date.parse("2026-01-05T00:00:00Z"));
    expect(w.startDate).toBe("2025-12-23");
    expect(span(w)).toBe(13);
  });
  it("trailingDays=1 gives a single day", () => {
    const w = sydneySyncWindow(Date.parse("2026-01-05T00:00:00Z"), 1);
    expect(w.startDate).toBe(w.endDate);
  });
});
