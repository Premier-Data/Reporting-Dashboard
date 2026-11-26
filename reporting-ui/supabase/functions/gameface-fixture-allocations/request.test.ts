import { describe, it, expect } from "vitest";
import { parseAllocationRequest, rpcErrorToResponse } from "./request";

const creds = { username: "admin", password: "pw" };

describe("parseAllocationRequest", () => {
  it("rejects bad bodies and credentials", () => {
    expect(parseAllocationRequest(null)).toEqual({ ok: false, error: "bad_request" });
    expect(parseAllocationRequest({ password: "x", action: "list" })).toEqual({ ok: false, error: "bad_request" });
    expect(parseAllocationRequest({ username: "a", action: "list" })).toEqual({ ok: false, error: "bad_request" });
  });
  it("rejects unknown actions", () => {
    expect(parseAllocationRequest({ ...creds, action: "nope" })).toEqual({ ok: false, error: "unknown_action" });
  });
  it("parses list with dates and rejects invalid dates", () => {
    const ok = parseAllocationRequest({ ...creds, action: "list", from: "2026-03-05", to: "2026-03-11" });
    expect(ok).toEqual({ ok: true, value: { ...creds, action: "list", from: "2026-03-05", to: "2026-03-11" } });
    expect(parseAllocationRequest({ ...creds, action: "list", from: "2026-02-31" })).toEqual({
      ok: false,
      error: "invalid_date",
    });
  });
  it("parses allocate and requires all fields", () => {
    const body = { ...creds, action: "allocate", compFixtureId: "1:2", rosterId: "r1", employeeName: "A B" };
    expect(parseAllocationRequest(body)).toEqual({ ok: true, value: body });
    expect(parseAllocationRequest({ ...body, rosterId: "" })).toEqual({ ok: false, error: "bad_request" });
    expect(parseAllocationRequest({ ...body, compFixtureId: 5 })).toEqual({ ok: false, error: "bad_request" });
  });
  it("parses unallocate with a positive integer id", () => {
    expect(parseAllocationRequest({ ...creds, action: "unallocate", allocationId: 3 })).toEqual({
      ok: true,
      value: { ...creds, action: "unallocate", allocationId: 3 },
    });
    expect(parseAllocationRequest({ ...creds, action: "unallocate", allocationId: "3" })).toEqual({
      ok: false,
      error: "bad_request",
    });
    expect(parseAllocationRequest({ ...creds, action: "unallocate", allocationId: 0 })).toEqual({
      ok: false,
      error: "bad_request",
    });
  });
});

describe("rpcErrorToResponse", () => {
  it("maps codes", () => {
    expect(rpcErrorToResponse({ code: "42501", message: "forbidden" })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(rpcErrorToResponse({ code: "23505", message: "x" })).toEqual({ status: 409, body: { error: "already_allocated" } });
    expect(rpcErrorToResponse({ message: "already_allocated" })).toEqual({ status: 409, body: { error: "already_allocated" } });
    expect(rpcErrorToResponse({ code: "P0002", message: "not_found" })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(rpcErrorToResponse({ code: "22023", message: "fixture_not_allocatable" })).toEqual({
      status: 422,
      body: { error: "fixture_not_allocatable" },
    });
    expect(rpcErrorToResponse({ code: "22023", message: "shift_not_allocatable" })).toEqual({
      status: 422,
      body: { error: "shift_not_allocatable" },
    });
    expect(rpcErrorToResponse({ code: "XX000", message: "boom" })).toEqual({
      status: 502,
      body: { error: "upstream_unavailable" },
    });
    expect(rpcErrorToResponse(null).status).toBe(502);
  });
});
