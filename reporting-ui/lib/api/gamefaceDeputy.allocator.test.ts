import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { AlreadyAllocatedError, makeGamefaceAllocator } from "./gamefaceDeputy";
import { BAD_CREDENTIALS_MESSAGE } from "@/lib/activity/storedPassword";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});
afterEach(() => vi.unstubAllGlobals());

const api = () => makeGamefaceAllocator("admin", "pw");
const args = { compFixtureId: "1:2", rosterId: "r1", employeeName: "A B" };

describe("makeGamefaceAllocator", () => {
  it("posts credentials and action to the function", async () => {
    const fn = mockFetch(200, { rows: [] });
    expect(await api().list("2026-03-05", "2026-03-11")).toEqual([]);
    const [url, init] = fn.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://x.supabase.co/functions/v1/gameface-fixture-allocations");
    expect(init.headers.Authorization).toBe("Bearer anon");
    expect(JSON.parse(init.body)).toEqual({
      username: "admin",
      password: "pw",
      action: "list",
      from: "2026-03-05",
      to: "2026-03-11",
    });
  });
  it("allocate sends ids and returns the row", async () => {
    const fn = mockFetch(200, { row: { id: 5 } });
    expect(await api().allocate(args)).toEqual({ id: 5 });
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ action: "allocate", ...args, username: "admin", password: "pw" });
  });
  it("403 maps to the bad credentials message (non-admin cannot allocate)", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(api().allocate(args)).rejects.toThrow(BAD_CREDENTIALS_MESSAGE);
  });
  it("409 maps to AlreadyAllocatedError with the UI message", async () => {
    mockFetch(409, { error: "already_allocated" });
    const err = await api().allocate(args).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyAllocatedError);
    expect(err.message).toBe("This fixture is already allocated to a shift. Unallocate it there first.");
  });
  it("422 gives readable messages", async () => {
    mockFetch(422, { error: "shift_not_allocatable" });
    await expect(api().allocate(args)).rejects.toThrow(/published/);
    mockFetch(422, { error: "fixture_not_allocatable" });
    await expect(api().allocate(args)).rejects.toThrow(/AFL/);
  });
  it("404 not deployed, 502 migration hint", async () => {
    mockFetch(404, null);
    await expect(api().list("a", "b")).rejects.toThrow("GameFace allocation function is not deployed yet");
    mockFetch(502, { error: "upstream_unavailable" });
    await expect(api().list("a", "b")).rejects.toThrow("The admin check is unavailable. Has migration 015 been run?");
  });
  it("unallocate posts the id", async () => {
    const fn = mockFetch(200, { row: { id: 7 } });
    await api().unallocate(7);
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ action: "unallocate", allocationId: 7 });
  });
});
