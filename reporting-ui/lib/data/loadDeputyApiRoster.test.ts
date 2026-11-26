import { describe, it, expect, vi } from "vitest";
import { loadDeputyApiRoster, loadDeputyApiRosterWithSync } from "./loadDeputyApiRoster";
import { pickScheduleRows } from "./scheduleEmployees";
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

describe("GameFace schedule data path (published shifts only)", () => {
  // Rows as gameface-deputy-read returns them: Andy Din, Camera Operator,
  // 12:00 am to 04:00 am Sydney on Thu 26 Nov 2026.
  const andy = {
    deputy_id: "9",
    roster_date: "2026-11-26",
    employee_name: "Andy Din",
    operational_unit_name: "Camera Operator",
    start_at: "2026-11-25T13:00:00Z",
    end_at: "2026-11-25T17:00:00Z",
    total_time: 4,
    published: false,
    open_shift: false,
  };
  const publishedAndy = { ...andy, deputy_id: "10", published: true };
  const src = (rows: (typeof andy)[]): DeputySource => ({
    getRosters: vi.fn(async () => rows),
    getRostersWithMeta: vi.fn(async () => ({ rows, synced: false })),
    getTimesheets: vi.fn(async () => []),
  });
  const win = { startDate: "2026-11-26", endDate: "2026-12-02" };
  it("does not show the unpublished shift", async () => {
    const out = await loadDeputyApiRoster({ ...win, source: src([andy]) });
    expect(out).toHaveLength(0);
    expect(pickScheduleRows(true, [], out, [])).toHaveLength(0);
  });
  it("does not show the unpublished shift when syncing too", async () => {
    const out = await loadDeputyApiRosterWithSync({ ...win, source: src([andy]) });
    expect(out.roster).toHaveLength(0);
  });
  it("shows a published shift and derives one employee row", async () => {
    const out = await loadDeputyApiRoster({ ...win, source: src([andy, publishedAndy]) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ shift_date: "2026-11-26", start_time: "00:00:00", end_time: "04:00:00", area_name: "Camera Operator" });
    const rows = pickScheduleRows(true, [], out, []);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { name: string }).name).toBe("Andy Din");
  });
});
