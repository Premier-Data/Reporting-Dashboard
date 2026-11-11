import type { DeputyRosterRow } from "@/lib/api/deputy";
import type { DeputyRoster } from "@/types/deputyRoster";

/*
 * Pure mapping from Deputy API rosters (deputy-read?dataset=rosters) into the
 * legacy `DeputyRoster` shape the Schedule page consumes. No network access.
 *
 * Times are converted to Australia/Sydney local time with Intl (never the
 * browser's zone, never a hardcoded offset) and formatted HH:mm:ss to match the
 * legacy Deputy roster display.
 */

const TZ = "Australia/Sydney";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sydney time-of-day as HH:mm:ss, or null for a missing/invalid timestamp. */
export function sydneyTimeOfDay(iso: string | null | undefined): string | null {
  const d = validDate(iso);
  if (!d) return null;
  const parts = timeFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // hourCycle h23 can still yield "24" in some engines at midnight; normalise.
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${hh}:${get("minute")}:${get("second")}`;
}

/** Sydney calendar date as yyyy-mm-dd, or null for a missing/invalid timestamp. */
export function sydneyDateOf(iso: string | null | undefined): string | null {
  const d = validDate(iso);
  if (!d) return null;
  const parts = dateFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Map one API roster to the legacy shape. Returns null when the row has no
 * roster_date or no employee name (nothing the Schedule could attach it to).
 */
export function mapApiRosterToDeputyRoster(
  row: DeputyRosterRow
): DeputyRoster | null {
  const name = (row.employee_name ?? "").trim();
  if (!row.roster_date || !name) return null;

  return {
    roster_key: `deputy:${row.deputy_id}`,
    employee_name: name,
    email: null, // Deputy employees have no email; matching is by name.
    location: null, // Deputy rosters have no location equivalent.
    area_name: row.operational_unit_name ?? null,
    shift_date: row.roster_date,
    start_time: sydneyTimeOfDay(row.start_at),
    end_date: sydneyDateOf(row.end_at),
    end_time: sydneyTimeOfDay(row.end_at),
    total_hours: row.total_time ?? 0,
    status: row.published ? "Published" : "Draft",
    note: null,
    cost: null,
    week: null,
  };
}

/**
 * Map + filter API rosters for the Schedule: published only, open shifts and
 * shifts with no employee dropped, restricted to the inclusive window (defensive
 * in case the server ignores from/to), sorted by date then start time.
 */
export function mapApiRosters(
  rows: DeputyRosterRow[],
  window: { startDate?: string; endDate?: string } = {}
): DeputyRoster[] {
  const { startDate, endDate } = window;
  const out: DeputyRoster[] = [];
  for (const row of rows) {
    if (row.published !== true) continue;
    if (row.open_shift === true) continue;
    if (startDate && row.roster_date && row.roster_date < startDate) continue;
    if (endDate && row.roster_date && row.roster_date > endDate) continue;
    const mapped = mapApiRosterToDeputyRoster(row);
    if (mapped) out.push(mapped);
  }
  return out.sort(
    (a, b) =>
      a.shift_date.localeCompare(b.shift_date) ||
      (a.start_time ?? "").localeCompare(b.start_time ?? "")
  );
}
