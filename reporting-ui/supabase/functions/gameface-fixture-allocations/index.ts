// Supabase Edge Function: gameface-fixture-allocations
//
// List, allocate and unallocate Comp Fixtures against published GameFace roster
// shifts. Each action calls a SECURITY DEFINER SQL function
// (public.gameface_fixture_*) that re-checks the admin username + password
// with public.activity_assert_admin before touching any data. A failed check
// returns 403. The fixture and shift rules (AFL only, published shift, one
// active allocation per fixture) are enforced in SQL, not here.
//
// Deploy WITH JWT verification (the browser sends the anon key as bearer):
//   supabase functions deploy gameface-fixture-allocations
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseAllocationRequest, rpcErrorToResponse } from "./request.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supaUrl || !serviceKey) {
    console.error("gameface-fixture-allocations missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "server_misconfigured" }, 500);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const parsed = parseAllocationRequest(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const v = parsed.value;

  const supabase = createClient(supaUrl, serviceKey, { auth: { persistSession: false } });

  // Credentials are passed to SQL only and never logged.
  const call =
    v.action === "list"
      ? supabase.rpc("gameface_fixture_allocations_list", {
          p_username: v.username,
          p_password: v.password,
          p_from: v.from ?? null,
          p_to: v.to ?? null,
        })
      : v.action === "allocate"
        ? supabase.rpc("gameface_fixture_allocate", {
            p_username: v.username,
            p_password: v.password,
            p_comp_fixture_id: v.compFixtureId,
            p_roster_id: v.rosterId,
            p_employee_name: v.employeeName,
          })
        : supabase.rpc("gameface_fixture_unallocate", {
            p_username: v.username,
            p_password: v.password,
            p_allocation_id: v.allocationId,
          });

  const { data, error } = await call;
  if (error) {
    const mapped = rpcErrorToResponse(error);
    if (mapped.status === 502) {
      console.error("gameface-fixture-allocations rpc failed:", error.code ?? "unknown");
    }
    return json(mapped.body, mapped.status);
  }
  return v.action === "list" ? json({ rows: data ?? [] }, 200) : json({ row: data }, 200);
});
