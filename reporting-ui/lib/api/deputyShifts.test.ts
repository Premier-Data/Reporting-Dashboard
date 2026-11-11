import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getTimesheets = vi.fn();
const getRosters = vi.fn();
vi.mock("@/lib/api/deputy", () => ({
  getDeputyTimesheets: (...a: unknown[]) => getTimesheets(...a),
  getDeputyRosters: (...a: unknown[]) => getRosters(...a),
}));

// Supabase mock: from(table).select().order().order().range(a,b) -> handler(table, a, b)
type Res = { data: unknown; error: { message: string } | null };
let handler: (table: string, from: number, to: number) => Res = () => ({ data: [], error: null });
vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.range = (from: number, to: number) => Promise.resolve(handler(table, from, to));
    return b;
  };
  return { supabase: { from: (t: string) => builder(t) } };
});

import {
  DeputyShiftsError,
  analystShifts,
  clearDeputyShiftsCache,
  ensureDeputySynced,
  getDeputyRostersWithWeek,
  getDeputyShiftAggregates,
  getDeputyShiftEmployeeNames,
  getDeputyShifts,
  mapTimesheetToShift,
  normaliseEmployeeName,
  sydneyToday,
} from "./deputyShifts";

const ts = (over: Record<string, unknown> = {}) => ({
  deputy_id: "1",
  timesheet_date: "2026-04-01",
  employee_name: "Jane Doe",
  operational_unit_name: "Aussie Rules - Home Analyst",
  start_at: "2026-04-01T00:00:00Z",
  end_at: "2026-04-01T08:00:00Z",
  total_time: 8,
  mealbreak_minutes: 0,
  cost: 200,
  on_cost: 50,
  time_approved: true,
  pay_rule_approved: true,
  disputed: false,
  is_leave: false,
  ...over,
});

const areaMapRows = [{ unit_name: "Aussie Rules - Training", area_name: "Aussie Rules - Supervising" }];

beforeEach(() => {
  clearDeputyShiftsCache();
  getTimesheets.mockReset();
  getRosters.mockReset();
  getTimesheets.mockResolvedValue([]);
  handler = (table) => ({ data: table === "deputy_area_map" ? areaMapRows : [], error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("normaliseEmployeeName", () => {
  it.each([
    [null, "Unknown"],
    [undefined, "Unknown"],
    ["", "Unknown"],
    ["   ", "Unknown"],
    ["4821", "Unknown"],
    ["  Jane   Doe ", "Jane Doe"],
    ["Jane Doe", "Jane Doe"],
    ["Jimmy Dwyer", "Jimmy New Dwyer"],
    ["  jimmy   DWYER ", "Jimmy New Dwyer"],
    ["James Dwyer", "James Dwyer"],
  ])("%s -> %s", (raw, out) => {
    expect(normaliseEmployeeName(raw)).toBe(out);
  });
});

describe("analystShifts", () => {
  it("drops Unknown only, returns a new array, input unchanged", () => {
    const rows = [
      { employee_name: "Unknown", x: 1 },
      { employee_name: "Jane Doe", x: 2 },
    ];
    const out = analystShifts(rows);
    expect(out).toEqual([{ employee_name: "Jane Doe", x: 2 }]);
    expect(out).not.toBe(rows);
    expect(rows).toHaveLength(2);
  });
});

describe("mapTimesheetToShift", () => {
  const map = new Map([["Aussie Rules - Training", "Aussie Rules - Supervising"]]);

  it("uses cost (not on_cost), derives rate, week, season and Sydney times", () => {
    const r = mapTimesheetToShift(ts() as never, map)!;
    expect(r).toMatchObject({
      shift_key: "api_1",
      employee_name: "Jane Doe",
      shift_date: "2026-04-01",
      total_hours: 8,
      total_cost: 200,
      hourly_rate: 25,
      area_name: "Aussie Rules - Home Analyst",
      week: 2,
      season: 2026,
      day_name: "Wednesday",
      month_name: "April",
      start_time: "11:00:00",
      end_time: "19:00:00",
      level: null,
      employee_comment: null,
      comment: null,
      source: "deputy-api",
    });
  });

  it("maps the area through deputy_area_map and blank units to Unassigned", () => {
    expect(mapTimesheetToShift(ts({ operational_unit_name: "Aussie Rules - Training" }) as never, map)!.area_name).toBe(
      "Aussie Rules - Supervising"
    );
    expect(mapTimesheetToShift(ts({ operational_unit_name: "0" }) as never, map)!.area_name).toBe("Unassigned");
    expect(mapTimesheetToShift(ts({ operational_unit_name: null }) as never, map)!.area_name).toBe("Unassigned");
  });

  it("treats non-finite numbers as 0 with a null rate, drops bad dates", () => {
    const r = mapTimesheetToShift(ts({ total_time: "x", cost: NaN }) as never, map)!;
    expect(r.total_hours).toBe(0);
    expect(r.total_cost).toBe(0);
    expect(r.hourly_rate).toBeNull();
    expect(mapTimesheetToShift(ts({ timesheet_date: null }) as never, map)).toBeNull();
    expect(mapTimesheetToShift(ts({ timesheet_date: "2026-4-1" }) as never, map)).toBeNull();
  });

  it("unresolved employees become Unknown", () => {
    expect(mapTimesheetToShift(ts({ employee_name: "4821" }) as never, map)!.employee_name).toBe("Unknown");
  });
});

describe("getDeputyShifts", () => {
  it("requests one strict window per season, drops pre-cutoff rows, sorts by date then key", async () => {
    getTimesheets.mockImplementation(async (o: { from?: string; sync?: boolean }) => {
      if (o.sync) return [];
      if (o.from === "2026-01-01")
        return [ts({ deputy_id: "9", timesheet_date: "2026-02-01" }), ts({ deputy_id: "2", timesheet_date: "2025-12-31" })];
      return [ts({ deputy_id: "3", timesheet_date: "2026-02-01" })];
    });
    const rows = await getDeputyShifts();
    expect(rows.map((r) => r.shift_key)).toEqual(["api_3", "api_9"]);
    const windowCalls = getTimesheets.mock.calls.map((c) => c[0]).filter((o) => !o.sync);
    expect(windowCalls.length).toBeGreaterThanOrEqual(2);
    expect(windowCalls[0]).toMatchObject({ from: "2026-01-01", to: "2026-09-29", strict: true });
    expect(windowCalls[1]).toMatchObject({ from: "2026-09-30", strict: true });
  });

  it("throws truncated when a window reaches the ceiling", async () => {
    getTimesheets.mockImplementation(async (o: { sync?: boolean }) =>
      o.sync ? [] : Array.from({ length: 20000 }, (_, i) => ts({ deputy_id: String(i) }))
    );
    await expect(getDeputyShifts()).rejects.toMatchObject({ code: "truncated" });
  });

  it("never returns an empty array on failure", async () => {
    getTimesheets.mockImplementation(async (o: { sync?: boolean }) => {
      if (o.sync) return [];
      throw new Error("deputy-read timesheets failed: 500");
    });
    const p = getDeputyShifts();
    await expect(p).rejects.toBeInstanceOf(DeputyShiftsError);
    await expect(p).rejects.toMatchObject({ code: "http" });
  });

  it("maps no-rows-array to bad_data and other errors to network", async () => {
    getTimesheets.mockImplementation(async (o: { sync?: boolean }) => {
      if (o.sync) return [];
      throw new Error("deputy-read timesheets returned no rows array");
    });
    await expect(getDeputyShifts()).rejects.toMatchObject({ code: "bad_data" });
    clearDeputyShiftsCache();
    getTimesheets.mockImplementation(async (o: { sync?: boolean }) => {
      if (o.sync) return [];
      throw new TypeError("Failed to fetch");
    });
    await expect(getDeputyShifts()).rejects.toMatchObject({ code: "network" });
  });

  it("throws area_map when the area map cannot be read", async () => {
    handler = () => ({ data: null, error: { message: "denied" } });
    await expect(getDeputyShifts()).rejects.toMatchObject({ code: "area_map" });
  });

  it("caches, honours force, shares in-flight calls, does not cache failures, isolates copies", async () => {
    getTimesheets.mockImplementation(async (o: { sync?: boolean; from?: string }) => (o.sync || o.from !== "2026-01-01" ? [] : [ts()]));
    const [a, b] = await Promise.all([getDeputyShifts(), getDeputyShifts()]);
    const calls = () => getTimesheets.mock.calls.filter((c) => !c[0].sync).length;
    const first = calls();
    expect(a).not.toBe(b);
    a.pop();
    expect((await getDeputyShifts()).length).toBe(1); // cache hit, not corrupted by pop()
    expect(calls()).toBe(first);
    await getDeputyShifts({ force: true });
    expect(calls()).toBeGreaterThan(first);

    clearDeputyShiftsCache();
    getTimesheets.mockImplementation(async (o: { sync?: boolean }) => {
      if (o.sync) return [];
      throw new Error("deputy-read timesheets failed: 500");
    });
    await expect(getDeputyShifts()).rejects.toBeInstanceOf(DeputyShiftsError);
    getTimesheets.mockImplementation(async (o: { sync?: boolean; from?: string }) => (o.sync || o.from !== "2026-01-01" ? [] : [ts()]));
    await expect(getDeputyShifts()).resolves.toHaveLength(1);
  });

  it("expires the cache after 60 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    getTimesheets.mockImplementation(async (o: { sync?: boolean; from?: string }) => (o.sync || o.from !== "2026-01-01" ? [] : [ts()]));
    await getDeputyShifts();
    const n = getTimesheets.mock.calls.length;
    vi.setSystemTime(new Date("2026-11-11T00:00:30Z"));
    await getDeputyShifts();
    expect(getTimesheets.mock.calls.length).toBe(n);
    vi.setSystemTime(new Date("2026-11-11T00:01:30Z"));
    await getDeputyShifts();
    expect(getTimesheets.mock.calls.length).toBeGreaterThan(n);
  });

  it("returns rows that tolerate frozen input objects", async () => {
    getTimesheets.mockImplementation(async (o: { sync?: boolean; from?: string }) => (o.sync || o.from !== "2026-01-01" ? [] : [Object.freeze(ts())]));
    await expect(getDeputyShifts()).resolves.toHaveLength(1);
  });
});

describe("getDeputyShiftEmployeeNames", () => {
  it("returns sorted distinct names and excludes Unknown", async () => {
    getTimesheets.mockImplementation(async (o: { sync?: boolean; from?: string }) =>
      o.sync || o.from !== "2026-01-01"
        ? []
        : [
            ts({ deputy_id: "1", employee_name: "Zed" }),
            ts({ deputy_id: "2", employee_name: "  Amy   Lee " }),
            ts({ deputy_id: "3", employee_name: "Amy Lee" }),
            ts({ deputy_id: "4", employee_name: "4821" }),
          ]
    );
    expect(await getDeputyShiftEmployeeNames()).toEqual(["Amy Lee", "Zed"]);
  });
});

describe("getDeputyShiftAggregates", () => {
  const viewRow = (i: number, source = "deputy-api") => ({
    shift_key: `api_${i}`,
    shift_date: "2026-04-01",
    area_name: "A",
    total_hours: "2.5",
    total_cost: 10,
    week: 2,
    season: 2026,
    source,
  });

  it("pages the view beyond 1000 rows", async () => {
    handler = (table, from) => {
      if (table !== "weekly_report_shifts") return { data: [], error: null };
      const total = 2300;
      const n = Math.max(0, Math.min(1000, total - from));
      return { data: Array.from({ length: n }, (_, i) => viewRow(from + i)), error: null };
    };
    const rows = await getDeputyShiftAggregates();
    expect(rows).toHaveLength(2300);
    expect(rows[0].total_hours).toBe(2.5);
  });

  it("throws stale_view when a row is not from the API", async () => {
    handler = () => ({ data: [viewRow(1, "excel")], error: null });
    await expect(getDeputyShiftAggregates()).rejects.toMatchObject({ code: "stale_view" });
  });

  it("throws http on a page error and does not cache it", async () => {
    handler = () => ({ data: null, error: { message: "boom" } });
    await expect(getDeputyShiftAggregates()).rejects.toMatchObject({ code: "http" });
    handler = () => ({ data: [viewRow(1)], error: null });
    await expect(getDeputyShiftAggregates()).resolves.toHaveLength(1);
  });
});

describe("getDeputyRostersWithWeek", () => {
  const roster = (over: Record<string, unknown> = {}) => ({
    deputy_id: "r1",
    roster_date: "2026-04-01",
    employee_name: "Jane Doe",
    operational_unit_name: "Soccer - Operations",
    start_at: "2026-04-01T00:00:00Z",
    end_at: "2026-04-01T08:00:00Z",
    total_time: 8,
    published: true,
    open_shift: false,
    ...over,
  });

  it("derives week and season, normalises names, drops drafts and unresolved names", async () => {
    getRosters.mockResolvedValue([
      roster(),
      roster({ deputy_id: "r2", employee_name: "  Jane   Doe " , roster_date: "2026-10-07" }),
      roster({ deputy_id: "r3", employee_name: "4821" }),
      roster({ deputy_id: "r4", employee_name: "   " }),
      roster({ deputy_id: "r5", published: false }),
    ]);
    const rows = await getDeputyRostersWithWeek();
    expect(rows.map((r) => [r.roster_key, r.employee_name, r.week, r.season])).toEqual([
      ["deputy:r1", "Jane Doe", 2, 2026],
      ["deputy:r2", "Jane Doe", 2, 2027],
    ]);
    expect(getRosters).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-01-01", strict: true }));
  });

  it("throws truncated at the ceiling", async () => {
    getRosters.mockResolvedValue(Array.from({ length: 20000 }, (_, i) => roster({ deputy_id: String(i) })));
    await expect(getDeputyRostersWithWeek()).rejects.toMatchObject({ code: "truncated" });
  });
});

describe("ensureDeputySynced", () => {
  it("syncs once with the Sydney date even near UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T23:30:00Z")); // 2026-11-11 10:30 in Sydney
    expect(sydneyToday()).toBe("2026-11-11");
    getTimesheets.mockResolvedValue([]);
    await ensureDeputySynced();
    await ensureDeputySynced();
    expect(getTimesheets).toHaveBeenCalledTimes(1);
    expect(getTimesheets).toHaveBeenCalledWith({ sync: true, from: "2026-11-11", to: "2026-11-11" });
  });

  it("swallows errors", async () => {
    getTimesheets.mockRejectedValue(new Error("deputy-read timesheets failed: 500"));
    await expect(ensureDeputySynced()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    getTimesheets.mockReturnValue(new Promise(() => {}));
    const p = ensureDeputySynced();
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(p).resolves.toBeUndefined();
  });
});
