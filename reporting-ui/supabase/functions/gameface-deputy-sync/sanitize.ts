// Pure sanitising + dry-run summary helpers for gameface-deputy-sync.
//
// No Deno/Supabase imports so vitest can load this file. The second company's
// raw Deputy records are unknown, so personal and pay-rate fields are dropped
// by key NAME (case-insensitive, at any depth) before anything is stored, and
// the dry run reports which names were dropped and which were kept (names only,
// never values) so the owner can check the list.
import { toDate, type Json } from "../deputy-sync/mappers.ts";

const SENSITIVE_KEY =
  /tax|tfn|bank|bsb|superann|superfund|salary|payrate|hourlyrate|baserate|password|token|secret|dob|birth|address|street|phone|mobile|emergency|passport|licen[cs]e|photo|email|nextofkin/i;
const SENSITIVE_EXACT = /^(pin|pincode)$/i;
// Exact Deputy names (case as Deputy returns them). Comment fields are kept on
// purpose. Employee personal fields and CustomFieldData are dropped at any depth
// (so an embedded Employee is covered); File only on Roster and Timesheet.
const DROPPED_NAMES = new Set([
  "Gender", "Sex", "Pronouns", "CustomPronouns", "Salutation",
  "EmploymentEndComment", "EmploymentEndReason", "EmploymentEndSentiment",
  "CustomFieldData",
]);
const FILE_RESOURCES = new Set(["Roster", "Timesheet"]);

/**
 * True when a field name looks personal, a credential, or a pay rate. Pass the
 * resource name to also apply the resource-specific `File` drop.
 */
export function isSensitiveKey(key: string, resource?: string): boolean {
  if (DROPPED_NAMES.has(key)) return true;
  if (key === "File" && resource !== undefined && FILE_RESOURCES.has(resource)) return true;
  return SENSITIVE_KEY.test(key) || SENSITIVE_EXACT.test(key);
}

/**
 * Recursively copies `v`, dropping every object key that isSensitiveKey()
 * matches. `dropped` lists the distinct dropped key names (no values).
 */
export function scrubValue(v: unknown, resource?: string): { value: unknown; dropped: string[] } {
  const dropped = new Set<string>();
  const walk = (x: unknown, top = false): unknown => {
    if (Array.isArray(x)) return x.map((i) => walk(i));
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (isSensitiveKey(k, top ? resource : undefined)) {
          dropped.add(k);
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return x;
  };
  const value = walk(v, true);
  return { value, dropped: [...dropped].sort() };
}

/**
 * Takes the output of a deputy-sync mapper and the raw Deputy record it came
 * from. Replaces source_data with the scrubbed record and nulls the Employee
 * email column.
 */
export function prepareRow(
  resource: string,
  mapped: Json,
  source: Json
): { row: Json; dropped: string[] } {
  const { value, dropped } = scrubValue(source, resource);
  const row: Json = { ...mapped, source_data: value };
  if (resource === "Employee") row.email = null;
  return { row, dropped };
}

export type DryRunSummary = {
  resource: string;
  read: number;
  minDate: string | null;
  maxDate: string | null;
  dateMismatches: number;
  droppedFieldNames: string[];
  keptFieldNames: string[];
};

// Deputy's own `Date` is a local calendar date such as "2026-05-04T00:00:00+10:00".
// Take the literal date part (no time zone conversion) so it is comparable.
function deputyDate(v: unknown): string | null {
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (m) return m[1];
  }
  return toDate(v);
}

/**
 * Counts and field names for a dry run (no values). `source` and `mapped` are
 * index-aligned. dateMismatches counts Roster/Timesheet rows whose mapped date
 * (Sydney bucketing) differs from Deputy's own `Date`, so a wrong time zone
 * assumption is visible before real data is written.
 */
export function summariseDryRun(
  resource: string,
  source: Json[],
  mapped: Json[],
  dropped: string[]
): DryRunSummary {
  const dateKey =
    resource === "Roster"
      ? "roster_date"
      : resource === "Timesheet"
        ? "timesheet_date"
        : resource === "Leave"
          ? "date_start"
          : null;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let dateMismatches = 0;
  const kept = new Set<string>();
  const droppedSet = new Set(dropped);
  for (let i = 0; i < source.length; i++) {
    const s = source[i];
    for (const k of Object.keys(s)) {
      if (!isSensitiveKey(k, resource)) kept.add(k);
      else droppedSet.add(k);
    }
    if (!dateKey) continue;
    const d = mapped[i]?.[dateKey];
    if (typeof d === "string") {
      if (minDate === null || d < minDate) minDate = d;
      if (maxDate === null || d > maxDate) maxDate = d;
    }
    if (resource === "Roster" || resource === "Timesheet") {
      const own = deputyDate(s.Date);
      if (own !== null && own !== d) dateMismatches++;
    }
  }
  return {
    resource,
    read: source.length,
    minDate,
    maxDate,
    dateMismatches,
    droppedFieldNames: [...droppedSet].sort(),
    keptFieldNames: [...kept].sort(),
  };
}
