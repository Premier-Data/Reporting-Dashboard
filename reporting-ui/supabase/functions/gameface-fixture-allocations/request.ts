// Pure request parsing and error mapping for gameface-fixture-allocations (no Deno imports).
import { parseDateRange } from "../deputy-read/shape.ts";

export type AllocationAction =
  | { action: "list"; from?: string; to?: string }
  | { action: "allocate"; compFixtureId: string; rosterId: string; employeeName: string }
  | { action: "unallocate"; allocationId: number };

export type AllocationRequest = { username: string; password: string } & AllocationAction;

export type ParsedAllocationRequest =
  | { ok: true; value: AllocationRequest }
  | { ok: false; error: "bad_request" | "unknown_action" | "invalid_date" };

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function parseAllocationRequest(body: unknown): ParsedAllocationRequest {
  if (!body || typeof body !== "object") return { ok: false, error: "bad_request" };
  const b = body as Record<string, unknown>;
  if (!nonEmpty(b.username)) return { ok: false, error: "bad_request" };
  if (typeof b.password !== "string" || b.password === "") return { ok: false, error: "bad_request" };
  const creds = { username: b.username, password: b.password };

  if (b.action === "list") {
    const from = b.from == null ? null : typeof b.from === "string" ? b.from : "";
    const to = b.to == null ? null : typeof b.to === "string" ? b.to : "";
    const range = parseDateRange(from, to);
    if (!range.ok) return { ok: false, error: "invalid_date" };
    return {
      ok: true,
      value: {
        ...creds,
        action: "list",
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      },
    };
  }
  if (b.action === "allocate") {
    if (!nonEmpty(b.compFixtureId) || !nonEmpty(b.rosterId) || !nonEmpty(b.employeeName)) {
      return { ok: false, error: "bad_request" };
    }
    return {
      ok: true,
      value: {
        ...creds,
        action: "allocate",
        compFixtureId: b.compFixtureId,
        rosterId: b.rosterId,
        employeeName: b.employeeName,
      },
    };
  }
  if (b.action === "unallocate") {
    if (typeof b.allocationId !== "number" || !Number.isSafeInteger(b.allocationId) || b.allocationId <= 0) {
      return { ok: false, error: "bad_request" };
    }
    return { ok: true, value: { ...creds, action: "unallocate", allocationId: b.allocationId } };
  }
  return { ok: false, error: "unknown_action" };
}

export type RpcError = { message?: string; code?: string } | null | undefined;

export function rpcErrorToResponse(err: RpcError): { status: number; body: { error: string } } {
  const code = err?.code;
  const message = err?.message ?? "";
  if (code === "42501") return { status: 403, body: { error: "forbidden" } };
  if (code === "23505" || message.includes("already_allocated")) {
    return { status: 409, body: { error: "already_allocated" } };
  }
  if (code === "P0002") return { status: 404, body: { error: "not_found" } };
  if (code === "22023") {
    if (message.includes("shift_not_allocatable")) {
      return { status: 422, body: { error: "shift_not_allocatable" } };
    }
    if (message.includes("fixture_not_allocatable")) {
      return { status: 422, body: { error: "fixture_not_allocatable" } };
    }
  }
  return { status: 502, body: { error: "upstream_unavailable" } };
}
