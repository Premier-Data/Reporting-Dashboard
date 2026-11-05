// Supabase Edge Function: deputy-read
//
// Read-only companion to deputy-sync. The `deputy` schema is locked to the
// service_role (migration 001 revokes it from anon/authenticated), so a browser
// anon query of deputy.* fails. This function holds the service-role key as an
// Edge Function secret and performs the privileged read server-side, returning
// ready-to-render rows (names already resolved) to the static front end.
//
// Datasets (selected via ?dataset=):
//   - rosters     → all rows from deputy.rosters
//   - timesheets  → deputy.timesheets filtered to time_approved = true AND
//                   coalesce(discarded, false) = false (approved, non-discarded)
//
// The "approved timesheets only" invariant lives HERE (the server-side filter),
// never on the client — there is no request param that can relax it.
//
// Auth: deploy with JWT verification ON (default). The browser sends the
// Supabase anon key as the bearer (same key already shipped in
// NEXT_PUBLIC_SUPABASE_ANON_KEY). Because the schema is locked to service_role,
// that anon JWT only lets the function RUN; the service-role client inside does
// the actual read.
//
// Optional ?sync=1: before reading, trigger a fixed-scope deputy-sync (Timesheet +
// Roster, trailing 14 Sydney days, manual, not dry-run). Nothing but sync=1 is
// read from the request. A server-side throttle (deputy.sync_runs, 60s) skips
// redundant syncs and FAILS SAFE (no sync) if it cannot be checked. Any sync
// failure is logged and the read still returns. DEPUTY_SYNC_SECRET stays
// server-side and is never logged or returned.
//
// Deploy:  supabase functions deploy deputy-read
// Secrets: supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-jwt>
//          (the value is the same JWT stored as SUPABASE_SERVICE_KEY in .env;
//           SUPABASE_URL is provided to functions by the platform.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  attachNames,
  buildEmployeeMap,
  buildUnitMap,
  distinctIds,
  needsAnotherPage,
  shouldSync,
  sydneySyncWindow,
  type EmployeeLookup,
  type Json,
  type UnitLookup,
} from "./shape.ts";

// Server-side cap so a huge table can't be dumped in a single response.
const MAX_ROWS = 20000;

// PostgREST clamps every response to its server-side `db-max-rows` (1000),
// overriding any larger `.limit(...)`. So each dataset read pages through
// `.range(...)` in PAGE-sized chunks and accumulates until a short page or the
// MAX_ROWS ceiling. PAGE matches the PostgREST cap so a full page is the signal
// that more rows may remain.
const PAGE = 1000;

const SYNC_THROTTLE_SECONDS = 60;
const SYNC_TIMEOUT_MS = 55_000;

// Shape of a single PostgREST ranged response (data + error), narrowed to what
// the pagination loop needs.
type PageResult = { data: unknown; error: { message: string } | null };

// Fetch ALL matching rows for a dataset by paging through `.range(from, to)`.
// `buildQuery` reproduces the exact per-dataset query (schema/table/select/
// filter/order) and applies `.range(from, to)` for the given page. On the first
// page error we stop and surface the error so the caller can return
// `query_failed`; otherwise we accumulate and consult `needsAnotherPage` to
// decide whether to request the next page. The name joins are intentionally NOT
// done here — the caller runs them once on the full accumulated set.
async function fetchAllPages(
  buildQuery: (from: number, to: number) => PromiseLike<PageResult>
): Promise<{ rows: Json[]; error: { message: string } | null }> {
  const rows: Json[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await buildQuery(offset, offset + PAGE - 1);
    if (error) {
      return { rows, error };
    }
    const page = (data ?? []) as Json[];
    rows.push(...page);
    if (!needsAnotherPage(page.length, PAGE, rows.length, MAX_ROWS)) {
      break;
    }
  }
  return { rows, error: null };
}

// Permissive CORS so the statically-exported site can call the function.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type SupabaseClient = ReturnType<typeof createClient>;

// Resolve employee + operational-unit names for a set of rows by fetching the
// two lookup tables with `.in(...)` and attaching the names in code (the FKs
// are soft text ids, so no PostgREST embed). A lookup error degrades to the raw
// id rather than failing the whole request.
async function resolveNames(
  supabase: SupabaseClient,
  rows: Json[]
): Promise<Json[]> {
  const employeeIds = distinctIds(rows, "employee_deputy_id");
  const unitIds = distinctIds(rows, "operational_unit_deputy_id");

  let employeeRows: EmployeeLookup[] = [];
  let unitRows: UnitLookup[] = [];

  if (employeeIds.length > 0) {
    const { data, error } = await supabase
      .schema("deputy")
      .from("employees")
      .select("deputy_id, display_name, first_name, last_name")
      .in("deputy_id", employeeIds);
    if (error) {
      console.error("deputy-read employees lookup failed:", error.message);
    } else {
      employeeRows = (data ?? []) as EmployeeLookup[];
    }
  }

  if (unitIds.length > 0) {
    const { data, error } = await supabase
      .schema("deputy")
      .from("operational_units")
      .select("deputy_id, operational_unit_name")
      .in("deputy_id", unitIds);
    if (error) {
      console.error("deputy-read units lookup failed:", error.message);
    } else {
      unitRows = (data ?? []) as UnitLookup[];
    }
  }

  return attachNames(
    rows,
    buildEmployeeMap(employeeRows),
    buildUnitMap(unitRows)
  );
}

// Returns true only when a sync was attempted and deputy-sync answered HTTP 200.
// Never throws. Never logs the secret, headers, or response body.
// Note: if the project moves to non-JWT API keys, the Authorization header
// sent to deputy-sync may need review.
async function maybeSync(
  supabase: SupabaseClient,
  supaUrl: string,
  serviceKey: string
): Promise<boolean> {
  const secret = Deno.env.get("DEPUTY_SYNC_SECRET") ?? "";
  if (!secret) {
    console.error("deputy-read sync skipped: DEPUTY_SYNC_SECRET not set");
    return false;
  }

  let last: string | null = null;
  try {
    const { data, error } = await supabase
      .schema("deputy")
      .from("sync_runs")
      .select("started_at")
      // ANY recent run counts (succeeded, running, failed or partial). Counting
      // only successes would let an anon-key caller trigger a fresh sync attempt
      // on every request while Deputy is failing, hammering its API.
      .order("started_at", { ascending: false })
      .limit(1);
    if (error) {
      console.error("deputy-read sync throttle query failed:", error.message);
      return false; // fail safe: just read
    }
    last = (data?.[0]?.started_at as string | undefined) ?? null;
  } catch (err) {
    console.error(
      "deputy-read sync throttle query threw:",
      err instanceof Error ? err.message : "unknown"
    );
    return false;
  }

  const now = Date.now();
  if (!shouldSync(last, now, SYNC_THROTTLE_SECONDS)) return false;

  const { startDate, endDate } = sydneySyncWindow(now);
  try {
    const res = await fetch(`${supaUrl}/functions/v1/deputy-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sync-secret": secret,
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({
        resources: ["Timesheet", "Roster"],
        mode: "manual",
        startDate,
        endDate,
        dryRun: false,
      }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      console.error("deputy-read sync failed: HTTP", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "deputy-read sync request failed:",
      err instanceof Error ? err.name : "unknown"
    );
    return false;
  }
}

async function readRosters(
  supabase: SupabaseClient,
  synced: boolean
): Promise<Response> {
  const { rows: data, error } = await fetchAllPages((from, to) =>
    supabase
      .schema("deputy")
      .from("rosters")
      .select(
        `deputy_id, roster_date, start_at, end_at, total_time,
       published, open_shift,
       employee_deputy_id, operational_unit_deputy_id`
      )
      .order("roster_date", { ascending: false })
      .range(from, to)
  );

  if (error) {
    console.error("deputy-read rosters query failed:", error.message);
    return json({ error: "query_failed" }, 500);
  }

  const rows = await resolveNames(supabase, data);
  return json({ rows, synced }, 200);
}

async function readTimesheets(
  supabase: SupabaseClient,
  synced: boolean
): Promise<Response> {
  const { rows: data, error } = await fetchAllPages((from, to) =>
    supabase
      .schema("deputy")
      .from("timesheets")
      .select(
        `deputy_id, timesheet_date, start_at, end_at, total_time,
       mealbreak_minutes, cost, on_cost,
       time_approved, pay_rule_approved, disputed, is_leave,
       employee_deputy_id, operational_unit_deputy_id`
      )
      // Approved + non-discarded. `.or` expresses coalesce(discarded,false)=false
      // as "discarded IS NULL OR discarded = false".
      .eq("time_approved", true)
      .or("discarded.is.null,discarded.eq.false")
      .order("timesheet_date", { ascending: false })
      .range(from, to)
  );

  if (error) {
    console.error("deputy-read timesheets query failed:", error.message);
    return json({ error: "query_failed" }, 500);
  }

  const rows = await resolveNames(supabase, data);
  return json({ rows, synced }, 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supaUrl || !serviceKey) {
    console.error("deputy-read missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "server_misconfigured" }, 500);
  }

  const url = new URL(req.url);
  const dataset = url.searchParams.get("dataset");
  if (dataset !== "rosters" && dataset !== "timesheets") {
    return json({ error: "unknown_dataset" }, 400);
  }

  const supabase = createClient(supaUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const synced =
    url.searchParams.get("sync") === "1"
      ? await maybeSync(supabase, supaUrl, serviceKey)
      : false;

  return dataset === "rosters"
    ? await readRosters(supabase, synced)
    : await readTimesheets(supabase, synced);
});
