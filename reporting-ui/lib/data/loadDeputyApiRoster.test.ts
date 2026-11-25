import { describe, it, expect, vi } from "vitest";
import { loadDeputyApiRoster, loadDeputyApiRosterWithSync } from "./loadDeputyApiRoster";
import type { DeputySource } from "@/lib/deputy/source";
const row = {
  deputy_id: "1",
  roster_date: "2026-03-02",
  employee_name: "Amy A",
  operational_unit_name: "Studio",
  start_at: "2026-03-02T00:00:00Z",
  end_at: "2026-03-02T08:00:00Z",
  total_time: 8,
  published: true,
  open_shift: false,
};
function fakeSource(): DeputySource {
  return {
    getRosters: vi.fn(async () => [row]),
    getRostersWithMeta: vi.fn(async () => ({ rows: [row], synced: true })),
    getTimesheets: vi.fn(async () => []),
  };
}
describe("loadDeputyApiRoster with a source", () => {
  it("reads through the source with the date window", async () => {
    const s = fakeSource();
    const out = await loadDeputyApiRoster({ startDate: "2026-03-01", endDate: "2026-03-07", source: s });
    expect(s.getRosters).toHaveBeenCalledWith({ from: "2026-03-01", to: "2026-03-07" });
    expect(out.map((r) => r.employee_name)).toEqual(["Amy A"]);
    expect(out[0].area_name).toBe("Studio");
  });
  it("asks the source to sync and reports it", async () => {
    const s = fakeSource();
    const out = await loadDeputyApiRosterWithSync({ startDate: "2026-03-01", endDate: "2026-03-07", source: s });
    expect(s.getRostersWithMeta).toHaveBeenCalledWith({ from: "2026-03-01", to: "2026-03-07", sync: true });
    expect(out.synced).toBe(true);
    expect(out.roster).toHaveLength(1);
  });
});
