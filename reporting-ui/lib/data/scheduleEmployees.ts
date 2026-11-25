// Rows for a roster-driven Schedule (GameFace): one row per distinct employee
// found in the visible week's roster and approved timesheets, sorted by name.
import { normaliseIdentifier } from "./rosterMatch";
type Named = { employee_name: string | null };
export type ScheduleEmployee = { id: number; name: string; email: string | null };
export function deriveScheduleEmployees(
  roster: Named[],
  timesheets: Named[]
): ScheduleEmployee[] {
  const byKey = new Map<string, string>();
  for (const r of [...roster, ...timesheets]) {
    const name = (r.employee_name ?? "").trim();
    const key = normaliseIdentifier(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, name], i) => ({ id: i + 1, name, email: null }));
}

/**
 * Rows for the Schedule grid. Premier Data (not read-only) uses the
 * AutoDownload analysts list as is; GameFace derives them from the week's data.
 */
export function pickScheduleRows<A>(
  readOnly: boolean,
  ownAnalysts: A[],
  roster: Named[],
  timesheets: Named[]
): A[] | ScheduleEmployee[] {
  return readOnly ? deriveScheduleEmployees(roster, timesheets) : ownAnalysts;
}
