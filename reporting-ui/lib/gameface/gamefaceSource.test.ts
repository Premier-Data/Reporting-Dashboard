import { describe, it, expect, vi, afterEach } from "vitest";
import { makeGamefaceDeputySource } from "@/lib/api/gamefaceDeputy";
import { BAD_CREDENTIALS_MESSAGE } from "@/lib/activity/storedPassword";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("makeGamefaceDeputySource", () => {
  it("posts credentials in the body, not the url, and parses rows", async () => {
    const fn = mockFetch(200, { rows: [{ deputy_id: "1" }], synced: true });
    const rows = await makeGamefaceDeputySource("admin", "s3cret").getRosters();
    expect(rows).toEqual([{ deputy_id: "1" }]);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/functions\/v1\/gameface-deputy-read$/);
    expect(url).not.toContain("s3cret");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ username: "admin", password: "s3cret", dataset: "rosters" });
  });
  it("asks for a sync only when requested", async () => {
    const fn = mockFetch(200, { rows: [], synced: true });
    await makeGamefaceDeputySource("a", "b").getTimesheets({ sync: true });
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ dataset: "timesheets", sync: true });
  });
  it("sends the date window for rosters and keeps the body unchanged without options", async () => {
    const fn = mockFetch(200, { rows: [], synced: true });
    const s = makeGamefaceDeputySource("a", "b");
    await s.getRosters({ from: "2026-03-01", to: "2026-03-07" });
    await s.getRostersWithMeta({ sync: true });
    const bodies = fn.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0]).toEqual({ username: "a", password: "b", dataset: "rosters", from: "2026-03-01", to: "2026-03-07" });
    expect(bodies[1]).toEqual({ username: "a", password: "b", dataset: "rosters", sync: true });
    const meta = await s.getRostersWithMeta();
    expect(meta).toEqual({ rows: [], synced: true });
  });
  it("maps 403, 404 and 502 to readable messages", async () => {
    const s = makeGamefaceDeputySource("a", "b");
    mockFetch(403, { error: "forbidden" });
    await expect(s.getRosters()).rejects.toThrow(BAD_CREDENTIALS_MESSAGE);
    mockFetch(404, {});
    await expect(s.getRosters()).rejects.toThrow("not deployed yet");
    mockFetch(502, {});
    await expect(s.getRosters()).rejects.toThrow("migration 014");
  });
  it("reports other failures with status and code", async () => {
    mockFetch(500, { error: "query_failed" });
    await expect(makeGamefaceDeputySource("a", "b").getTimesheets()).rejects.toThrow("gameface-deputy-read timesheets failed: 500 query_failed");
  });
});