// Browser client for the deputy-read Edge Function.
//
// The `deputy` schema is locked to the service_role (migration 001), so the
// browser cannot query deputy.* with the anon key. Instead it calls the
// deputy-read function, which holds the service-role key server-side and
// returns ready-to-render rows (names already resolved, timesheets already
// filtered to approved + non-discarded).
//
// Auth mirrors any other Supabase function call from this app: the anon key as
// both the bearer and the apikey header (the same key in
// NEXT_PUBLIC_SUPABASE_ANON_KEY). That only lets the function run; the
// privileged read happens inside the function.

const FN_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/deputy-read`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type Dataset = "rosters" | "timesheets";

/** sync: ask deputy-read to pull the latest from Deputy first (server-side, throttled). */
export type DeputyReadOptions = {
  sync?: boolean;
  /** Inclusive yyyy-mm-dd lower bound (roster_date / timesheet_date). */
  from?: string;
  /** Inclusive yyyy-mm-dd upper bound. */
  to?: string;
  /**
   * Throw when a 200 response has no `rows` array instead of returning [].
   * Used by the shared shift layer so a malformed body is never shown as "no data".
   */
  strict?: boolean;
};

/** Rows plus whether deputy-read actually ran a sync for this request. */
export type DeputyReadResult<T> = { rows: T[]; synced: boolean };

/** Parses a deputy-read response body. `synced` is true only when literally true. */
export function parseDeputyBody<T>(body: {
  rows?: T[];
  synced?: unknown;
}): DeputyReadResult<T> {
  return {
    rows: Array.isArray(body?.rows) ? body.rows : [],
    synced: body?.synced === true,
  };
}

async function callWithMeta<T>(
  dataset: Dataset,
  opts?: DeputyReadOptions
): Promise<DeputyReadResult<T>> {
  const qs = new URLSearchParams({ dataset });
  if (opts?.sync) qs.set("sync", "1");
  if (opts?.from) qs.set("from", opts.from);
  if (opts?.to) qs.set("to", opts.to);
  const res = await fetch(`${FN_BASE}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`deputy-read ${dataset} failed: ${res.status}`);
  }
  const body = (await res.json()) as { rows?: T[]; synced?: unknown };
  if (opts?.strict && !Array.isArray(body?.rows)) {
    throw new Error(`deputy-read ${dataset} returned no rows array`);
  }
  return parseDeputyBody<T>(body);
}

async function call<T>(
  dataset: Dataset,
  opts?: DeputyReadOptions
): Promise<T[]> {
  return (await callWithMeta<T>(dataset, opts)).rows;
}

/** A rostered shift from deputy.rosters, with names resolved server-side. */
export interface DeputyRosterRow {
  deputy_id: string;
  roster_date: string | null;
  employee_name: string | null;
  operational_unit_name: string | null;
  start_at: string | null;
  end_at: string | null;
  total_time: number | null;
  published: boolean | null;
  open_shift: boolean | null;
}

/** An approved timesheet from deputy.timesheets, with names resolved. */
export interface DeputyTimesheetRow {
  deputy_id: string;
  timesheet_date: string | null;
  employee_name: string | null;
  operational_unit_name: string | null;
  start_at: string | null;
  end_at: string | null;
  total_time: number | null;
  mealbreak_minutes: number | null;
  cost: number | null;
  on_cost: number | null;
  time_approved: boolean | null;
  pay_rule_approved: boolean | null;
  disputed: boolean | null;
  is_leave: boolean | null;
}

export const getDeputyRosters = (opts?: DeputyReadOptions) =>
  call<DeputyRosterRow>("rosters", opts);
/** Like getDeputyRosters, but also returns whether a sync actually ran. */
export const getDeputyRostersWithMeta = (opts?: DeputyReadOptions) =>
  callWithMeta<DeputyRosterRow>("rosters", opts);
export const getDeputyTimesheets = (opts?: DeputyReadOptions) =>
  call<DeputyTimesheetRow>("timesheets", opts);
