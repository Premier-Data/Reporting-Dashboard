// Supabase Edge Function: gameface-deputy-sync
//
// Read-only sync of a SECOND company's Deputy install into the `gameface_deputy`
// schema. Separate from deputy-sync (the user's own company): own secrets, own
// schema, own sync secret. Only Deputy QUERY (read) calls are made; the URL is
// built by buildQueryUrl, which cannot produce anything else.
//
// Auth: `x-sync-secret` header, constant-time compared to
// GAMEFACE_DEPUTY_SYNC_SECRET. Deploy with --no-verify-jwt.
// Secrets (names only): GAMEFACE_DEPUTY_BASE_URL, GAMEFACE_DEPUTY_API_TOKEN,
// GAMEFACE_DEPUTY_SYNC_SECRET. Nothing secret is logged or returned.
//
// dryRun: true performs the same Deputy reads but writes nothing (no sync_runs
// row either) and returns counts and field NAMES only.
//
// Deploy:  supabase functions deploy gameface-deputy-sync --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  backoffMs,
  isRetryable,
  nextDay,
  toRecordArray,
  type DeputyQuery,
} from "../deputy-sync/query.ts";
import { RESOURCE_MAP, type Json } from "../deputy-sync/mappers.ts";
import { planRosterReconcile } from "../deputy-sync/reconcile.ts";
import { sydneySyncWindow } from "../deputy-read/shape.ts";
import { describeError, SchemaNotExposedError, withSchemaRetry } from "../_shared/deputySchema.ts";
import { buildQueryUrl, validateBaseUrl } from "./deputyHttp.ts";
import { pullResource } from "./engine.ts";

const SCHEMA = "gameface_deputy";
const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const BATCH_SIZE = 500;
const RECONCILE_PAGE = 1000;
const RECONCILE_BATCH = 200;
const NOT_EXPOSED_MESSAGE =
  "The Supabase Data API is not exposing the 'gameface_deputy' schema. In Supabase: Project Settings -> Data API -> Exposed schemas, add 'gameface_deputy'.";

type SyncBody = {
  resources?: string[];
  mode?: "initial" | "incremental" | "reconcile" | "manual";
  startDate?: string;
  endDate?: string;
  dryRun?: boolean;
};

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// One Deputy QUERY page with bounded retry. The status code is the only thing
// put in an error; headers, token and body are never logged.
async function fetchPage(
  base: string,
  token: string,
  resource: string,
  query: DeputyQuery
): Promise<Json[]> {
  const url = buildQueryUrl(base, resource);
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST", // Deputy's QUERY endpoint is a POST that only reads
      headers: {
        Authorization: `OAuth ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return toRecordArray(await res.json());
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      throw new Error(`deputy_${res.status}`);
    }
    if (isRetryable(res.status) && attempt < maxAttempts - 1) {
      const ra = Number(res.headers.get("Retry-After"));
      await new Promise((r) => setTimeout(r, backoffMs(attempt, Number.isFinite(ra) ? ra : null)));
      continue;
    }
    throw new Error(`deputy_${res.status}`);
  }
  throw new Error("deputy_retry_exhausted");
}

async function syncResource(
  supabase: ReturnType<typeof createClient>,
  base: string,
  token: string,
  resourceName: string,
  body: SyncBody,
  window: { startDate: string; endDate: string }
): Promise<Json> {
  const cfg = RESOURCE_MAP[resourceName];
  const dryRun = body.dryRun === true;
  const mode = body.mode ?? "manual";
  const pullOpts = {
    fetchPage: (r: string, q: DeputyQuery) => fetchPage(base, token, r, q),
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  };

  if (dryRun) {
    try {
      const pulled = await pullResource(pullOpts, resourceName, window);
      return {
        resource: resourceName,
        status: "succeeded",
        dryRun: true,
        read: pulled.read,
        skipped: pulled.skipped,
        ...pulled.summary,
      };
    } catch (e) {
      return {
        resource: resourceName,
        status: "failed",
        dryRun: true,
        error: e instanceof Error ? e.message : "error",
      };
    }
  }

  const { data: runRow } = await withSchemaRetry(() =>
    supabase
      .schema(SCHEMA)
      .from("sync_runs")
      .insert({
        resource: resourceName,
        mode,
        status: "running",
        requested_from: body.startDate ?? null,
        requested_to: body.endDate ?? null,
        metadata: { dryRun: false },
      })
      .select("id")
      .single()
  );
  const runId = (runRow as { id: number } | null)?.id ?? null;
  let read = 0;
  let written = 0;
  let skipped = 0;
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let errorMessage: string | null = null;
  let returnedIds = new Set<string>();
  let reconcileMeta: Json | null = null;
  let softDeleted = 0;

  try {
    const pulled = await pullResource(pullOpts, resourceName, window);
    read = pulled.read;
    skipped = pulled.skipped;
    returnedIds = pulled.returnedIds;
    for (let i = 0; i < pulled.rows.length; i += BATCH_SIZE) {
      const batch = pulled.rows.slice(i, i + BATCH_SIZE);
      const { error } = await withSchemaRetry(() =>
        supabase.schema(SCHEMA).from(cfg.table).upsert(batch, { onConflict: "deputy_id" })
      );
      if (error) throw new Error(`db_upsert: ${error.message}`);
      written += batch.length;
    }
  } catch (e) {
    if (e instanceof SchemaNotExposedError && written === 0) throw e;
    status = written > 0 ? "partial" : "failed";
    errorMessage = e instanceof Error ? e.message : "error";
  }

  // Roster soft-delete reconcile, same guards as deputy-sync (reconcile.ts).
  if (resourceName === "Roster" && status === "succeeded") {
    try {
      const existingIds: string[] = [];
      for (let from = 0; ; from += RECONCILE_PAGE) {
        const { data, error } = await withSchemaRetry(() =>
          supabase
            .schema(SCHEMA)
            .from("rosters")
            .select("deputy_id")
            .gte("roster_date", window.startDate)
            .lte("roster_date", window.endDate)
            .eq("is_deleted", false)
            .order("deputy_id", { ascending: true })
            .range(from, from + RECONCILE_PAGE - 1)
        );
        if (error) throw new Error(`reconcile_read: ${error.message}`);
        const page = (data ?? []) as { deputy_id: string }[];
        for (const p of page) existingIds.push(String(p.deputy_id));
        if (page.length < RECONCILE_PAGE) break;
      }
      const plan = planRosterReconcile({
        resource: resourceName,
        status,
        dryRun: false,
        startDate: window.startDate,
        endDate: window.endDate,
        readCount: read,
        returnedIds,
        existingIds,
      });
      if (plan.action === "apply") {
        for (let i = 0; i < plan.idsToDelete.length; i += RECONCILE_BATCH) {
          const batch = plan.idsToDelete.slice(i, i + RECONCILE_BATCH);
          const { error } = await withSchemaRetry(() =>
            supabase
              .schema(SCHEMA)
              .from("rosters")
              .update({ is_deleted: true })
              .in("deputy_id", batch)
              .gte("roster_date", window.startDate)
              .lte("roster_date", window.endDate)
              .eq("is_deleted", false)
          );
          if (error) throw new Error(`reconcile_update: ${error.message}`);
          softDeleted += batch.length;
        }
      } else if (plan.reason === "empty_read_guard" || plan.reason === "mass_delete_guard") {
        console.error(`gameface-deputy-sync roster reconcile refused: ${plan.reason}`);
      }
      reconcileMeta = { action: plan.action, softDeleted, reason: plan.reason };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      console.error("gameface-deputy-sync roster reconcile failed:", msg);
      reconcileMeta = { action: "error", softDeleted, reason: msg };
    }
  }

  if (runId != null) {
    try {
      await withSchemaRetry(() =>
        supabase
          .schema(SCHEMA)
          .from("sync_runs")
          .update({
            status,
            finished_at: new Date().toISOString(),
            records_read: read,
            records_inserted: written,
            records_updated: 0,
            records_skipped: skipped,
            error_message: errorMessage,
            ...(reconcileMeta ? { metadata: { dryRun: false, reconcile: reconcileMeta } } : {}),
          })
          .eq("id", runId)
      );
      if (status === "succeeded") {
        await withSchemaRetry(() =>
          supabase
            .schema(SCHEMA)
            .from("sync_checkpoints")
            .upsert(
              {
                resource: resourceName,
                last_successful_run_id: runId,
                last_successful_modified_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "resource" }
            )
        );
      }
    } catch (e) {
      if (!(e instanceof SchemaNotExposedError)) throw e;
      status = status === "succeeded" ? "partial" : status;
      errorMessage = errorMessage ?? "gameface_deputy_schema_not_exposed";
    }
  }
  return {
    resource: resourceName,
    status,
    dryRun: false,
    read,
    written,
    skipped,
    error: errorMessage,
    ...(reconcileMeta ? { reconcile: reconcileMeta } : {}),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const expected = Deno.env.get("GAMEFACE_DEPUTY_SYNC_SECRET") ?? "";
  const supplied = req.headers.get("x-sync-secret") ?? "";
  if (!expected || !supplied || !safeEqual(supplied, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  const base = validateBaseUrl(Deno.env.get("GAMEFACE_DEPUTY_BASE_URL") ?? "");
  const token = Deno.env.get("GAMEFACE_DEPUTY_API_TOKEN") ?? "";
  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !token || !supaUrl || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }

  let body: SyncBody;
  try {
    body = (await req.json()) as SyncBody;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const order = ["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"];
  const requested = body.resources ?? order;
  const unknown = requested.filter((r) => !order.includes(r));
  if (unknown.length) return json({ error: "unknown_resources", unknown }, 400);

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const d of [body.startDate, body.endDate]) {
    if (d != null && (!dateRe.test(d) || nextDay(d) === null)) {
      return json({ error: "invalid_date", value: d }, 400);
    }
  }
  // Missing dates fall back to the standard window so a run never pulls all history.
  const def = sydneySyncWindow(Date.now(), 14, 28);
  const window = {
    startDate: body.startDate ?? def.startDate,
    endDate: body.endDate ?? def.endDate,
  };

  const supabase = createClient(supaUrl, serviceKey, { auth: { persistSession: false } });
  const dryRun = body.dryRun === true;
  const results: Json[] = [];
  try {
    for (const r of order.filter((x) => requested.includes(x))) {
      // One resource failing (e.g. Leave forbidden for the token) must not stop the rest.
      results.push(await syncResource(supabase, base, token, r, body, window));
    }
  } catch (e) {
    if (!(e instanceof SchemaNotExposedError)) {
      console.error("gameface-deputy-sync unexpected error:", describeError(e));
      return json({ ok: false, error: "sync_failed", results }, 500);
    }
    console.error(`gameface-deputy-sync: schema not exposed (${e.detail}).`);
    return json(
      { ok: false, error: "gameface_deputy_schema_not_exposed", message: NOT_EXPOSED_MESSAGE, results },
      503
    );
  }
  const anyFailed = results.some((r) => r.status === "failed");
  return json({ ok: !anyFailed, mode: body.mode ?? "manual", dryRun, results }, anyFailed ? 207 : 200);
});
