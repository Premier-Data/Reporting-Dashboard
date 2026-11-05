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
  type EmployeeLookup,
  type Json,
  type UnitLookup,
} from "./shape.ts";

// Server-side cap so a huge table can't be dumped in a single response.
const MAX_ROWS = 20000;

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

async function readRosters(supabase: SupabaseClient): Promise<Response> {
  const { data, error } = await supabase
    .schema("deputy")
    .from("rosters")
    .select(
      `deputy_id, roster_date, start_at, end_at, total_time,
       published, open_shift,
       employee_deputy_id, operational_unit_deputy_id`
    )
    .order("roster_date", { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    console.error("deputy-read rosters query failed:", error.message);
    return json({ error: "query_failed" }, 500);
  }

  const rows = await resolveNames(supabase, (data ?? []) as Json[]);
  return json({ rows }, 200);
}

async function readTimesheets(supabase: SupabaseClient): Promise<Response> {
  const { data, error } = await supabase
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
    .limit(MAX_ROWS);

  if (error) {
    console.error("deputy-read timesheets query failed:", error.message);
    return json({ error: "query_failed" }, 500);
  }

  const rows = await resolveNames(supabase, (data ?? []) as Json[]);
  return json({ rows }, 200);
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

  const dataset = new URL(req.url).searchParams.get("dataset");
  if (dataset !== "rosters" && dataset !== "timesheets") {
    return json({ error: "unknown_dataset" }, 400);
  }

  const supabase = createClient(supaUrl, serviceKey, {
    auth: { persistSession: false },
  });

  return dataset === "rosters"
    ? await readRosters(supabase)
    : await readTimesheets(supabase);
});
