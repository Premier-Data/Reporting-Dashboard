import { describe, it, expect, vi, afterEach } from "vitest";
import { parseDeputyBody, getDeputyTimesheets } from "./deputy";

describe("parseDeputyBody", () => {
  it("returns rows and synced true", () => {
    expect(parseDeputyBody({ rows: [1, 2], synced: true })).toEqual({
      rows: [1, 2],
      synced: true,
    });
  });

  it("defaults synced to false and rows to []", () => {
    expect(parseDeputyBody({})).toEqual({ rows: [], synced: false });
    expect(parseDeputyBody({ rows: [1], synced: "yes" })).toEqual({
      rows: [1],
      synced: false,
    });
  });
});

describe("getDeputyTimesheets strict option", () => {
  const mockFetch = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))
    );
  afterEach(() => vi.unstubAllGlobals());

  it("returns [] for a body without rows when not strict", async () => {
    mockFetch({});
    await expect(getDeputyTimesheets()).resolves.toEqual([]);
  });

  it("throws for a body without rows when strict", async () => {
    mockFetch({ error: "x" });
    await expect(getDeputyTimesheets({ strict: true })).rejects.toThrow(
      "deputy-read timesheets returned no rows array"
    );
  });

  it("returns rows when strict and rows is an array", async () => {
    mockFetch({ rows: [] });
    await expect(getDeputyTimesheets({ strict: true })).resolves.toEqual([]);
  });
});