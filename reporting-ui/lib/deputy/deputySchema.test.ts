import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SchemaNotExposedError,
  isSchemaNotExposed,
  withSchemaRetry,
} from "../../supabase/functions/_shared/deputySchema";
import { deputyReadError } from "../api/deputy";

const schemaErr = {
  code: "PGRST106",
  message: "Invalid schema: deputy",
  hint: "Only the following schemas are exposed: public, graphql_public",
};

describe("isSchemaNotExposed", () => {
  it("matches PGRST106", () => {
    expect(isSchemaNotExposed({ code: "PGRST106", message: "x" })).toBe(true);
  });
  it("matches the message without a code", () => {
    expect(isSchemaNotExposed({ message: "Invalid schema: deputy" })).toBe(true);
  });
  it("matches a 406 with the schema body", () => {
    expect(isSchemaNotExposed({ status: 406, message: "Invalid schema: deputy" })).toBe(true);
  });
  it("rejects other errors and non-errors", () => {
    expect(isSchemaNotExposed({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isSchemaNotExposed({ status: 406, message: "Not Acceptable" })).toBe(false);
    expect(isSchemaNotExposed(null)).toBe(false);
    expect(isSchemaNotExposed("Invalid schema: deputy")).toBe(false);
  });
});

describe("withSchemaRetry", () => {
  const sleep = vi.fn(async (_ms: number) => {});
  afterEach(() => sleep.mockClear());

  it("returns immediately on success", async () => {
    const fn = vi.fn(async () => ({ data: [1], error: null }));
    await expect(withSchemaRetry(fn, { sleep })).resolves.toEqual({ data: [1], error: null });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a returned PGRST106 error and recovers", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: schemaErr })
      .mockResolvedValueOnce({ data: [2], error: null });
    await expect(withSchemaRetry(fn, { sleep })).resolves.toEqual({ data: [2], error: null });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("retries a thrown schema error", async () => {
    const fn = vi.fn().mockRejectedValueOnce(schemaErr).mockResolvedValueOnce("ok");
    await expect(withSchemaRetry(fn, { sleep })).resolves.toBe("ok");
  });

  it("gives up after 3 attempts with a tagged error and the 500/1500 delays", async () => {
    const fn = vi.fn(async () => ({ data: null, error: schemaErr }));
    const err = await withSchemaRetry(fn, { sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaNotExposedError);
    expect(err.tag).toBe("deputy_schema_not_exposed");
    expect(err.detail).toContain("PGRST106");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1500]);
  });

  it("does not retry other returned errors", async () => {
    const other = { code: "42501", message: "permission denied" };
    const fn = vi.fn(async () => ({ data: null, error: other }));
    await expect(withSchemaRetry(fn, { sleep })).resolves.toEqual({ data: null, error: other });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry other thrown errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withSchemaRetry(fn, { sleep })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("deputyReadError", () => {
  it("maps 503 deputy_schema_not_exposed to the friendly message", async () => {
    const err = await deputyReadError("rosters", {
      status: 503,
      json: async () => ({ error: "deputy_schema_not_exposed", message: "m" }),
    });
    expect(err.message).toMatch(/not exposing the 'deputy' schema/);
    expect(err.message).toMatch(/Exposed schemas/);
  });
  it("includes status and code for other errors", async () => {
    const err = await deputyReadError("rosters", {
      status: 500,
      json: async () => ({ error: "query_failed", detail: "x" }),
    });
    expect(err.message).toBe("deputy-read rosters failed: 500 query_failed");
  });
  it("falls back to status when the body is not JSON", async () => {
    const err = await deputyReadError("timesheets", {
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    });
    expect(err.message).toBe("deputy-read timesheets failed: 502");
  });
});

describe("getDeputyRosters via fetch", () => {
  it("rejects with the friendly message on a 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "deputy_schema_not_exposed" }), { status: 503 })
      )
    );
    const { getDeputyRosters } = await import("../api/deputy");
    await expect(getDeputyRosters()).rejects.toThrow(/not exposing the 'deputy' schema/);
    vi.unstubAllGlobals();
  });
});
