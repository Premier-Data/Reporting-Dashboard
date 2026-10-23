// Pure field mappers: Deputy source records -> deputy.* table rows.
//
// These are deliberately framework-free (no Deno, no Supabase imports) so they
// can be unit-tested under vitest in Node. Each mapper maps the VERIFIED source
// fields onto the REAL columns from migrations/001_deputy_integration.sql, and
// always preserves the full source record in `source_data`.
//
// Conventions:
//  - deputy_id is the Deputy `Id`, stored as text (the table's unique key).
//  - Reference ids (Company, OperationalUnit, Employee, Roster, Leave) are the
//    raw Deputy ids as text; FKs are intentionally soft (text, not enforced) so
//    a child can import before its parent.
//  - Never invent a default for a field the source didn't supply — use null.
//  - synced_at is set by the DB default; we never set it here.

export type Json = Record<string, unknown>;

/** Deputy ids come through as numbers; store as text, null-safe. */
export function idToText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

/** A Deputy boolean-ish value (1/0/true/false) -> boolean | null. */
export function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (v === "1" || v.toLowerCase() === "true") return true;
    if (v === "0" || v.toLowerCase() === "false") return false;
  }
  return null;
}

/** A numeric-ish value -> number | null (never NaN, never a silent 0). */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A Deputy date/time string or epoch -> ISO timestamp string | null. */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  // Deputy epoch seconds (StartTime/EndTime on rosters/timesheets).
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs ms heuristic
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Epoch seconds as a bigint-compatible number | null (store raw). */
export function toEpoch(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** A yyyy-mm-dd date string from a Deputy Date value | null. */
export function toDate(v: unknown): string | null {
  const iso = toIso(v);
  return iso ? iso.slice(0, 10) : null;
}

// ── Resource mappers ─────────────────────────────────────────────────────────

export function mapCompany(r: Json): Json {
  return {
    deputy_id: idToText(r.Id),
    company_name: r.CompanyName ?? r.TradingName ?? null,
    code: r.Code ?? null,
    active: toBool(r.Active),
    is_workplace: toBool(r.IsWorkplace),
    is_payroll_entity: toBool(r.IsPayrollEntity),
    parent_company_id: idToText(r.ParentCompany),
    source_created_at: toIso(r.Created),
    source_modified_at: toIso(r.Modified),
    source_data: r,
  };
}

export function mapOperationalUnit(r: Json): Json {
  return {
    deputy_id: idToText(r.Id),
    operational_unit_name: r.OperationalUnitName ?? null,
    company_id: idToText(r.Company),
    parent_operational_unit_id: idToText(r.ParentOperationalUnit),
    work_type: r.WorkType != null ? String(r.WorkType) : null,
    operational_unit_type: r.OperationalUnitType != null ? String(r.OperationalUnitType) : null,
    active: toBool(r.Active),
    show_on_roster: toBool(r.ShowOnRoster),
    source_created_at: toIso(r.Created),
    source_modified_at: toIso(r.Modified),
    source_data: r,
  };
}

export function mapEmployee(r: Json): Json {
  return {
    deputy_id: idToText(r.Id),
    display_name: r.DisplayName ?? null,
    first_name: r.FirstName ?? null,
    last_name: r.LastName ?? null,
    email: r.Email ?? r.PrimaryEmail ?? null,
    active: toBool(r.Active),
    company_id: idToText(r.Company),
    operational_unit_id: idToText(r.OperationalUnit),
    source_created_at: toIso(r.Created),
    source_modified_at: toIso(r.Modified),
    source_data: r,
  };
}

export function mapRoster(r: Json): Json {
  return {
    deputy_id: idToText(r.Id),
    roster_date: toDate(r.Date),
    employee_deputy_id: idToText(r.Employee),
    operational_unit_deputy_id: idToText(r.OperationalUnit),
    start_time_epoch: toEpoch(r.StartTime),
    end_time_epoch: toEpoch(r.EndTime),
    start_at: toIso(r.StartTime),
    end_at: toIso(r.EndTime),
    mealbreak_minutes: toNum(r.Mealbreak),
    total_time: toNum(r.TotalTime),
    cost: toNum(r.Cost),
    on_cost: toNum(r.OnCost),
    published: toBool(r.Published),
    open_shift: toBool(r.Open),
    matched_by_timesheet: toBool(r.MatchedByTimesheet),
    shift_template_id: idToText(r.ShiftTemplate),
    external_id: r.ExternalId != null ? String(r.ExternalId) : null,
    source_created_at: toIso(r.Created),
    source_modified_at: toIso(r.Modified),
    source_data: r,
  };
}

export function mapTimesheet(r: Json): Json {
  return {
    deputy_id: idToText(r.Id),
    timesheet_date: toDate(r.Date),
    employee_deputy_id: idToText(r.Employee),
    roster_deputy_id: idToText(r.Roster),
    operational_unit_deputy_id: idToText(r.OperationalUnit),
    start_time_epoch: toEpoch(r.StartTime),
    end_time_epoch: toEpoch(r.EndTime),
    start_at: toIso(r.StartTime),
    end_at: toIso(r.EndTime),
    mealbreak_minutes: toNum(r.Mealbreak),
    total_time: toNum(r.TotalTime),
    total_time_inv: toNum(r.TotalTimeInv),
    cost: toNum(r.Cost),
    on_cost: toNum(r.OnCost),
    time_approved: toBool(r.TimeApproved),
    pay_rule_approved: toBool(r.PayRuleApproved),
    discarded: toBool(r.Discarded),
    disputed: toBool(r.Disputed),
    is_leave: toBool(r.IsLeave),
    leave_deputy_id: idToText(r.LeaveId),
    supervisor_deputy_id: idToText(r.Supervisor),
    exported: toBool(r.Exported),
    external_id: r.ExternalId != null ? String(r.ExternalId) : null,
    source_created_at: toIso(r.Created),
    source_modified_at: toIso(r.Modified),
    source_data: r,
  };
}

export function mapLeave(r: Json): Json {
  return {
    deputy_id: idToText(r.Id),
    employee_deputy_id: idToText(r.Employee),
    company_deputy_id: idToText(r.Company),
    leave_rule_id: idToText(r.LeaveRule),
    start_at: toIso(r.Start),
    end_at: toIso(r.End),
    date_start: toDate(r.DateStart),
    date_end: toDate(r.DateEnd),
    days: toNum(r.Days),
    total_hours: toNum(r.TotalHours),
    status: r.Status != null ? String(r.Status) : null,
    all_day: toBool(r.AllDay),
    approver_time: r.ApproverTime != null ? String(r.ApproverTime) : null,
    approver_pay: r.ApproverPay != null ? String(r.ApproverPay) : null,
    external_id: r.ExternalId != null ? String(r.ExternalId) : null,
    source_created_at: toIso(r.Created),
    source_modified_at: toIso(r.Modified),
    source_data: r,
  };
}

// Registry: resource name -> { table, mapper }. Drives the orchestrator.
export const RESOURCE_MAP: Record<
  string,
  { deputyResource: string; table: string; mapper: (r: Json) => Json; dateField?: string }
> = {
  Company: { deputyResource: "Company", table: "companies", mapper: mapCompany },
  OperationalUnit: { deputyResource: "OperationalUnit", table: "operational_units", mapper: mapOperationalUnit },
  Employee: { deputyResource: "Employee", table: "employees", mapper: mapEmployee },
  Roster: { deputyResource: "Roster", table: "rosters", mapper: mapRoster, dateField: "Date" },
  Timesheet: { deputyResource: "Timesheet", table: "timesheets", mapper: mapTimesheet, dateField: "Date" },
  Leave: { deputyResource: "Leave", table: "leave_records", mapper: mapLeave, dateField: "DateStart" },
};
