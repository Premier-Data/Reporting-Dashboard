// Supabase Edge Function: gameface-deputy-read
//
// Read-only companion to gameface-deputy-sync. The `gameface_deputy` schema is
// locked to service_role, so the browser cannot read it directly. This function
// first re-checks the caller's admin username + password in SQL
// (public.gameface_deputy_check_admin), and only then reads with the
// service-role key. A failed check returns 403 and no data.
//
// Datasets (POST body `dataset`): rosters (is_deleted = false) and timesheets
// (approved and not discarded, enforced here, not by the client). Response shape
// is identical to deputy-read: { rows, synced }.
//
// Deploy WITH JWT verification (the browser sends the anon key as bearer):
//   supabase functions deploy gameface-deputy-read
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
} from "../deputy-read/shape.ts";
import { describeError, SchemaNotExposedError, withSchemaRetry } from "../_shared/deputySchema.ts";
import { parseReadRequest } from "./request.ts";

const SCHEMA = "gameface_deputy";
const MAX_ROWS = 20000;
const PAGE = 1000;
const SYNC_THROTTLE_SECONDS = 60;
const SYNC_TIMEOUT_MS = 55_000;
const NOT_EXPOSED_MESSAGE =
  "The Supabase Data API is not exposing the 'gameface_deputy' schema. In Supabase: Project Settings -> Data API -> Exposed schemas, add 'gameface_deputy'.";

type PgError = { message: string; code?: string };
type PageResult = { data: unknown; error: PgError | null };
type SupabaseClient = ReturnType<typeof createClient>;
type DateRange = { from?: string; to?: string };

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function fetchAllPages(
  buildQuery: (from: number, to: number) => PromiseLike<PageResult>
): Promise<{ rows: Json[]; error: PgError | null }> {
  const rows: Json[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await withSchemaRetry(() => buildQuery(offset, offset + PAGE - 1));
    if (error) return { rows, error };
    const page = (data ?? []) as Json[];
    rows.push(...page);
    if (!needsAnotherPage(page.length, PAGE, rows.length, MAX_ROWS)) break;
  }
  return { rows, error: null };
}

async function resolveNames(supabase: SupabaseClient, rows: Json[]): Promise<Json[]> {
  const employeeIds = distinctIds(rows, "employee_deputy_id");
  const unitIds = distinctIds(rows, "operational_unit_deputy_id");
  let employeeRows: EmployeeLookup[] = [];
  let unitRows: UnitLookup[] = [];
  if (employeeIds.length > 0) {
    const { data, error } = await withSchemaRetry(() =>
      supabase
        .schema(SCHEMA)
        .from("employees")
        .select("deputy_id, display_name, first_name, last_name")
        .in("deputy_id", employeeIds)
    );
    if (error) console.error("gameface-deputy-read employees lookup failed:", error.message);
    else employeeRows = (data ?? []) as EmployeeLookup[];
  }
  if (unitIds.length > 0) {
    const { data, error } = await withSchemaRetry(() =>
      supabase
        .schema(SCHEMA)
        .from("operational_units")
        .select("deputy_id, operational_unit_name")
        .in("deputy_id", unitIds)
    );
    if (error) console.error("gameface-deputy-read units lookup failed:", error.message);
    else unitRows = (data ?? []) as UnitLookup[];
  }
  return attachNames(rows, buildEmployeeMap(employeeRows), buildUnitMap(unitRows));
}

// True only when a sync was attempted and answered HTTP 200. Never throws and
// never logs the secret, headers or body.
async function maybeSync(supabase: SupabaseClient, supaUrl: string): Promise<boolean> {
  const secret = Deno.env.get("GAMEFACE_DEPUTY_SYNC_SECRET") ?? "";
  if (!secret) {
    console.error("gameface-deputy-read sync skipped: GAMEFACE_DEPUTY_SYNC_SECRET not set");
    return false;
  }
  let last: string | null = null;
  try {
    const { data, error } = await withSchemaRetry(() =>
      supabase
        .schema(SCHEMA)
        .from("sync_runs")
        .select("started_at")
        .order("started_at", { ascending: false })
        .limit(1)
    );
    if (error) {
      console.error("gameface-deputy-read sync throttle query failed:", error.message);
      return false;
    }
    last = (data?.[0]?.started_at as string | undefined) ?? null;
  } catch (err) {
    console.error(
      "gameface-deputy-read sync throttle query threw:",
      err instanceof Error ? err.message : "unknown"
    );
    return false;
  }
  const now = Date.now();
  if (!shouldSync(last, now, SYNC_THROTTLE_SECONDS)) return false;
  const { startDate, endDate } = sydneySyncWindow(now, 14, 28);
  try {
    const res = await fetch(`${supaUrl}/functions/v1/gameface-deputy-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sync-secret": secret },
      body: JSON.stringify({
        resources: ["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"],
        mode: "manual",
        startDate,
        endDate,
        dryRun: false,
      }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      console.error("gameface-deputy-read sync failed: HTTP", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("gameface-deputy-read sync request failed:", err instanceof Error ? err.name : "unknown");
    return false;
  }
}

async function readRosters(supabase: SupabaseClient, synced: boolean, range: DateRange): Promise<Response> {
  const { rows: data, error } = await fetchAllPages((from, to) => {
    let q = supabase
      .schema(SCHEMA)
      .from("rosters")
      .select(
        `deputy_id, roster_date, start_at, end_at, total_time,
       published, open_shift,
       employee_deputy_id, operational_unit_deputy_id`
      )
      .eq("is_deleted", false);
    if (range.from) q = q.gte("roster_date", range.from);
    if (range.to) q = q.lte("roster_date", range.to);
    return q.order("roster_date", { ascending: false }).range(from, to);
  });
  if (error) {
    console.error("gameface-deputy-read rosters query failed:", describeError(error));
    return json({ error: "query_failed" }, 500);
  }
  return json({ rows: await resolveNames(supabase, data), synced }, 200);
}

async function readTimesheets(supabase: SupabaseClient, synced: boolean, range: DateRange): Promise<Response> {
  const { rows: data, error } = await fetchAllPages((from, to) => {
    let q = supabase
      .schema(SCHEMA)
      .from("timesheets")
      .select(
        `deputy_id, timesheet_date, start_at, end_at, total_time,
       mealbreak_minutes, cost, on_cost,
       time_approved, pay_rule_approved, disputed, is_leave,
       employee_deputy_id, operational_unit_deputy_id`
      )
      .eq("time_approved", true)
      .or("discarded.is.null,discarded.eq.false");
    if (range.from) q = q.gte("timesheet_date", range.from);
    if (range.to) q = q.lte("timesheet_date", range.to);
    return q.order("timesheet_date", { ascending: false }).range(from, to);
  });
  if (error) {
    console.error("gameface-deputy-read timesheets query failed:", describeError(error));
    return json({ error: "query_failed" }, 500);
  }
  return json({ rows: await resolveNames(supabase, data), synced }, 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supaUrl || !serviceKey) {
    console.error("gameface-deputy-read missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "server_misconfigured" }, 500);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const parsed = parseReadRequest(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { username, password, dataset, from, to, sync } = parsed.value;

  const supabase = createClient(supaUrl, serviceKey, { auth: { persistSession: false } });

  // Admin check first. Nothing is read until it passes. Credentials are never logged.
  const { data: ok, error: checkErr } = await supabase.rpc("gameface_deputy_check_admin", {
    p_username: username,
    p_password: password,
  });
  if (checkErr) {
    if (checkErr.code === "42501") return json({ error: "forbidden" }, 403);
    console.error("gameface-deputy-read admin check failed:", checkErr.code ?? "unknown");
    return json({ error: "upstream_unavailable" }, 502);
  }
  if (ok !== true) return json({ error: "forbidden" }, 403);

  const synced = sync ? await maybeSync(supabase, supaUrl) : false;
  const range: DateRange = { from, to };
  try {
    return dataset === "rosters"
      ? await readRosters(supabase, synced, range)
      : await readTimesheets(supabase, synced, range);
  } catch (err) {
    if (err instanceof SchemaNotExposedError) {
      console.error(`gameface-deputy-read: schema not exposed (${err.detail}).`);
      return json({ error: "gameface_deputy_schema_not_exposed", message: NOT_EXPOSED_MESSAGE }, 503);
    }
    console.error("gameface-deputy-read unexpected error:", describeError(err));
    return json({ error: "query_failed" }, 500);
  }
});
