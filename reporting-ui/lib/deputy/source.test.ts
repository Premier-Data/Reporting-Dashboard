import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultDeputySource } from "./source";
afterEach(() => vi.unstubAllGlobals());
describe("defaultDeputySource", () => {
  it("passes read options to deputy-read as query params", async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rows: [], synced: true }) }) as unknown as Response);
    vi.stubGlobal("fetch", fn);
    const out = await defaultDeputySource.getRostersWithMeta({ from: "2026-03-01", to: "2026-03-07", sync: true });
    expect(out).toEqual({ rows: [], synced: true });
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("dataset=rosters");
    expect(url).toContain("from=2026-03-01");
    expect(url).toContain("to=2026-03-07");
    expect(url).toContain("sync=1");
  });
});
