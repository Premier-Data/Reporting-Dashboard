// Supabase Edge Function: deputy-sync
//
// Single secured orchestration function that syncs Deputy resources into the
// `deputy` schema. Phase 1 resources (Company, OperationalUnit, Employee) are
// implemented and tested; Roster/Timesheet/Leave reuse the same engine via the
// RESOURCE_MAP + dateField and are enabled here too.
//
// Auth: a dedicated `x-sync-secret` header, constant-time compared to
// DEPUTY_SYNC_SECRET. JWT verification can be disabled for this function since
// the custom secret guards every request. The Deputy token and service role
// key are read from Edge Function secrets and never logged or returned.
//
// Deputy auth: a PERMANENT token (DEPUTY_API_TOKEN), sent as
// `Authorization: OAuth <token>`. For a single Deputy install this is Deputy's
// recommended server-to-server method — it does not expire, so there is no
// refresh flow. (Generating a new token via "Get An Access Token" in the
// install's OAuth client page invalidates the previous one, so keep it stable.)
//
// Deploy:  supabase functions deploy deputy-sync --no-verify-jwt
// Secrets: supabase secrets set DEPUTY_BASE_URL=... DEPUTY_API_TOKEN=... \
//          DEPUTY_SYNC_SECRET=... SUPABASE_SERVICE_ROLE_KEY=...
//
// STATUS: Phase 1 (Company, OperationalUnit, Employee) validated live against
// the 6ac52f24123110 Deputy tenant and the Supabase `deputy` schema — a real
// round-trip synced 2 companies + 124 employees, idempotent on re-run. The pure
// logic (mapping/pagination/dedupe/retry) is also unit-tested; see mappers.test.ts.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildQuery,
  hasMorePages,
  toRecordArray,
  dedupeByDeputyId,
  isRetryable,
  backoffMs,
} from "./query.ts";
import { RESOURCE_MAP, type Json } from "./mappers.ts";

const PAGE_SIZE = 500;
const MAX_PAGES = 200; // runaway guard (200 * 500 = 100k records/resource)
const BATCH_SIZE = 500; // DB upsert batch

type SyncBody = {
  resources?: string[];
  mode?: "initial" | "incremental" | "reconcile" | "manual";
  startDate?: string;
  endDate?: string;
  dryRun?: boolean;
};

// Constant-time string compare (avoids timing leaks on the secret).
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

// One Deputy QUERY page, with bounded retry/backoff.
async function fetchPage(
  base: string,
  token: string,
  resource: string,
  query: unknown
): Promise<Record<string, unknown>[]> {
  const url = `${base.replace(/\/$/, "")}/resource/${resource}/QUERY`;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return toRecordArray(await res.json());
    // Never retry auth/permanent failures.
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

// Sync one resource end-to-end: page the Deputy API, map, dedupe, batch-upsert,
// and track a sync_runs row + checkpoint. Returns per-resource counts.
async function syncResource(
  supabase: ReturnType<typeof createClient>,
  base: string,
  token: string,
  resourceName: string,
  body: SyncBody
): Promise<Json> {
  const cfg = RESOURCE_MAP[resourceName];
  const mode = body.mode ?? "manual";
  const dryRun = body.dryRun === true;

  // Open a sync_runs row.
  const { data: runRow } = await supabase
    .schema("deputy")
    .from("sync_runs")
    .insert({
      resource: resourceName,
      mode,
      status: "running",
      requested_from: body.startDate ?? null,
      requested_to: body.endDate ?? null,
      metadata: { dryRun },
    })
    .select("id")
    .single();
  const runId = (runRow as { id: number } | null)?.id ?? null;

  let read = 0;
  let written = 0;
  let skipped = 0;
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let errorMessage: string | null = null;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = buildQuery({
        start: page * PAGE_SIZE,
        max: PAGE_SIZE,
        dateField: cfg.dateField,
        from: cfg.dateField ? body.startDate : undefined,
        to: cfg.dateField ? body.endDate : undefined,
      });
      const raw = await fetchPage(base, token, cfg.deputyResource, q);
      read += raw.length;

      const mapped = raw.map((r) => cfg.mapper(r));
      const { unique, duplicates } = dedupeByDeputyId(mapped);
      skipped += duplicates + (mapped.length - unique.length - duplicates);

      if (!dryRun && unique.length > 0) {
        for (let i = 0; i < unique.length; i += BATCH_SIZE) {
          const batch = unique.slice(i, i + BATCH_SIZE);
          const { error } = await supabase
            .schema("deputy")
            .from(cfg.table)
            .upsert(batch, { onConflict: "deputy_id" });
          if (error) throw new Error(`db_upsert: ${error.message}`);
          written += batch.length;
        }
      }

      if (!hasMorePages(raw.length, PAGE_SIZE)) break;
    }
  } catch (e) {
    status = written > 0 ? "partial" : "failed";
    errorMessage = e instanceof Error ? e.message : "error";
  }

  // Close the run.
  if (runId != null) {
    await supabase
      .schema("deputy")
      .from("sync_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        records_read: read,
        records_inserted: dryRun ? 0 : written, // can't distinguish ins/upd via upsert
        records_updated: 0,
        records_skipped: skipped,
        error_message: errorMessage,
      })
      .eq("id", runId);

    // Advance the checkpoint ONLY on full success (never past unstored records).
    if (status === "succeeded" && !dryRun) {
      await supabase
        .schema("deputy")
        .from("sync_checkpoints")
        .upsert(
          {
            resource: resourceName,
            last_successful_run_id: runId,
            last_successful_modified_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "resource" }
        );
    }
  }

  return { resource: resourceName, status, read, written, skipped, dryRun, error: errorMessage };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ── Custom secret auth (constant-time) ──
  const expected = Deno.env.get("DEPUTY_SYNC_SECRET") ?? "";
  const supplied = req.headers.get("x-sync-secret") ?? "";
  if (!expected || !supplied || !safeEqual(supplied, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  const base = Deno.env.get("DEPUTY_BASE_URL") ?? "";
  const token = Deno.env.get("DEPUTY_API_TOKEN") ?? "";
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

  // Validate resources against the known registry.
  const requested = body.resources ?? ["Company", "OperationalUnit", "Employee"];
  const unknown = requested.filter((r) => !RESOURCE_MAP[r]);
  if (unknown.length) return json({ error: "unknown_resources", unknown }, 400);

  // Validate dates (yyyy-mm-dd) if supplied.
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const d of [body.startDate, body.endDate]) {
    if (d != null && !dateRe.test(d)) return json({ error: "invalid_date", value: d }, 400);
  }

  const supabase = createClient(supaUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Reference resources first (so time-based resources can reference them),
  // then the rest, in the requested order.
  const order = ["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"];
  const toRun = order.filter((r) => requested.includes(r));

  const results: Json[] = [];
  for (const r of toRun) {
    results.push(await syncResource(supabase, base, token, r, body));
  }

  const anyFailed = results.some((r) => r.status === "failed");
  return json({ ok: !anyFailed, mode: body.mode ?? "manual", dryRun: body.dryRun === true, results }, anyFailed ? 207 : 200);
});
