// Pure, framework-free row-shaping helpers for the deputy-read function.
//
// Deliberately free of Deno/Supabase imports so they can be unit-tested under
// vitest in Node (the same approach as deputy-sync/mappers.ts, which
// lib/deputy/deputySync.test.ts imports directly).
//
// The deputy.rosters / deputy.timesheets rows carry SOFT text FKs
// (employee_deputy_id, operational_unit_deputy_id) to deputy.employees.deputy_id
// and deputy.operational_units.deputy_id. These are not enforced FKs, so the
// join is resolved here in code (not via a PostgREST embed): the function looks
// up names into two Maps and this helper attaches human-readable
// employee_name / operational_unit_name onto each row. A missing lookup degrades
// to the raw id rather than throwing.

export type Json = Record<string, unknown>;

/** An employee lookup row as selected from deputy.employees. */
export interface EmployeeLookup {
  deputy_id?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

/** An operational-unit lookup row as selected from deputy.operational_units. */
export interface UnitLookup {
  deputy_id?: string | null;
  operational_unit_name?: string | null;
}

/**
 * Resolve an employee's human name: the actual/legal "first last" name, then
 * display_name (Deputy's preferred/display name) as a fallback, then the raw
 * deputy id as a last resort. We prefer the legal name over the preferred name
 * (e.g. "Daniel Jovanoski" rather than "Dan Jov"). Never returns an empty
 * string when any of those are present; falls back to null only when nothing
 * at all is known.
 */
export function resolveEmployeeName(
  emp: EmployeeLookup | null | undefined,
  fallbackId: string | null | undefined
): string | null {
  const full = `${emp?.first_name ?? ""} ${emp?.last_name ?? ""}`.trim();
  if (full) return full;

  const display = (emp?.display_name ?? "").trim();
  if (display) return display;

  const id = (fallbackId ?? "").trim();
  return id || null;
}

/** Build a Map<deputy_id, EmployeeLookup> from a list of employee rows. */
export function buildEmployeeMap(
  rows: EmployeeLookup[] | null | undefined
): Map<string, EmployeeLookup> {
  const map = new Map<string, EmployeeLookup>();
  for (const r of rows ?? []) {
    const id = (r.deputy_id ?? "").trim();
    if (id) map.set(id, r);
  }
  return map;
}

/** Build a Map<deputy_id, unit name> from a list of operational-unit rows. */
export function buildUnitMap(
  rows: UnitLookup[] | null | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows ?? []) {
    const id = (r.deputy_id ?? "").trim();
    if (id) map.set(id, (r.operational_unit_name ?? "").trim());
  }
  return map;
}

/**
 * Attach employee_name + operational_unit_name onto each row, resolving the
 * soft FKs through the supplied lookup maps. Missing lookups degrade to the raw
 * id (employee) / raw id (unit) so the caller always gets a renderable value
 * and the request never fails because a reference row is absent.
 */
export function attachNames<T extends Json>(
  rows: T[] | null | undefined,
  employeeMap: Map<string, EmployeeLookup>,
  unitMap: Map<string, string>
): (T & { employee_name: string | null; operational_unit_name: string | null })[] {
  return (rows ?? []).map((row) => {
    const empId =
      row.employee_deputy_id != null ? String(row.employee_deputy_id) : null;
    const unitId =
      row.operational_unit_deputy_id != null
        ? String(row.operational_unit_deputy_id)
        : null;

    const emp = empId ? employeeMap.get(empId) ?? null : null;
    const employee_name = resolveEmployeeName(emp, empId);

    const unitName = unitId ? unitMap.get(unitId) : null;
    const operational_unit_name =
      unitName && unitName.length > 0 ? unitName : unitId;

    return { ...row, employee_name, operational_unit_name };
  });
}

/**
 * Drives the deputy-read pagination loop. PostgREST clamps every response to
 * its server-side `db-max-rows` (1000), so each dataset read pages through
 * `.range(offset, offset + pageSize - 1)` and accumulates rows. This predicate
 * decides whether to fetch another page: keep going only when the last page
 * came back full (`lastPageCount === pageSize`, i.e. more rows likely remain)
 * AND we are still under the safety ceiling (`accumulated < maxRows`). A short
 * or empty last page, or hitting `maxRows`, stops the loop.
 */
export function needsAnotherPage(
  lastPageCount: number,
  pageSize: number,
  accumulated: number,
  maxRows: number
): boolean {
  return lastPageCount === pageSize && accumulated < maxRows;
}

/** Collect the distinct non-null values of a key across rows. */
export function distinctIds<T extends Json>(rows: T[], key: string): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (v != null && String(v).trim() !== "") set.add(String(v));
  }
  return Array.from(set);
}
