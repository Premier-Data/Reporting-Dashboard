import { describe, it, expect } from "vitest";
import {
  sydneyTimeOfDay,
  sydneyDateOf,
  mapApiRosterToDeputyRoster,
  mapApiRosters,
} from "./deputyApiRoster";
import type { DeputyRosterRow } from "@/lib/api/deputy";

function row(over: Partial<DeputyRosterRow> = {}): DeputyRosterRow {
  return {
    deputy_id: "100",
    roster_date: "2026-11-10",
    employee_name: "Jane Doe",
    operational_unit_name: "Soccer - Operations",
    start_at: "2026-11-09T22:30:00Z",
    end_at: "2026-11-10T06:30:00Z",
    total_time: 8,
    published: true,
    open_shift: false,
    ...over,
  };
}

describe("sydneyTimeOfDay", () => {
  it("converts in AEDT (+11)", () => {
    expect(sydneyTimeOfDay("2026-11-09T22:30:00Z")).toBe("09:30:00");
  });
  it("converts in AEST (+10)", () => {
    expect(sydneyTimeOfDay("2026-07-01T23:30:00Z")).toBe("09:30:00");
  });
  it("DST start 2026-10-04: 15:59Z is 01:59 AEST, 16:00Z is 03:00 AEDT", () => {
    expect(sydneyTimeOfDay("2026-10-03T15:59:00Z")).toBe("01:59:00");
    expect(sydneyTimeOfDay("2026-10-03T16:00:00Z")).toBe("03:00:00");
  });
  it("DST end 2027-04-04: 15:59Z is 02:59 AEDT, 16:00Z is 02:00 AEST", () => {
    expect(sydneyTimeOfDay("2027-04-03T15:59:00Z")).toBe("02:59:00");
    expect(sydneyTimeOfDay("2027-04-03T16:00:00Z")).toBe("02:00:00");
  });
  it("formats just after midnight as 00:xx, never 24:xx", () => {
    // 2026-11-09T13:05:00Z = 2026-11-10 00:05 AEDT
    expect(sydneyTimeOfDay("2026-11-09T13:05:00Z")).toBe("00:05:00");
  });
  it("returns null for null / invalid", () => {
    expect(sydneyTimeOfDay(null)).toBeNull();
    expect(sydneyTimeOfDay("not a date")).toBeNull();
  });
});

describe("sydneyDateOf", () => {
  it("uses the Sydney date, not UTC", () => {
    expect(sydneyDateOf("2026-11-09T22:30:00Z")).toBe("2026-11-10");
    expect(sydneyDateOf(null)).toBeNull();
  });
});

describe("mapApiRosterToDeputyRoster", () => {
  it("maps fields to the legacy shape", () => {
    expect(mapApiRosterToDeputyRoster(row())).toEqual({
      roster_key: "deputy:100",
      employee_name: "Jane Doe",
      email: null,
      location: null,
      area_name: "Soccer - Operations",
      shift_date: "2026-11-10",
      start_time: "09:30:00",
      end_date: "2026-11-10",
      end_time: "17:30:00",
      total_hours: 8,
      status: "Published",
      note: null,
      cost: null,
      week: null,
    });
  });
  it("overnight shift: shift_date is the start day, end_date the next day", () => {
    // 16:30 -> 00:30 Sydney (AEDT): 05:30Z -> 13:30Z
    const m = mapApiRosterToDeputyRoster(
      row({ start_at: "2026-11-10T05:30:00Z", end_at: "2026-11-10T13:30:00Z" })
    )!;
    expect(m.shift_date).toBe("2026-11-10");
    expect(m.start_time).toBe("16:30:00");
    expect(m.end_time).toBe("00:30:00");
    expect(m.end_date).toBe("2026-11-11");
  });
  it("null start/end gives null times; null total_time gives 0", () => {
    const m = mapApiRosterToDeputyRoster(row({ start_at: null, end_at: null, total_time: null }))!;
    expect(m.start_time).toBeNull();
    expect(m.end_time).toBeNull();
    expect(m.end_date).toBeNull();
    expect(m.total_hours).toBe(0);
  });
  it("returns null with no employee or no date", () => {
    expect(mapApiRosterToDeputyRoster(row({ employee_name: null }))).toBeNull();
    expect(mapApiRosterToDeputyRoster(row({ employee_name: "  " }))).toBeNull();
    expect(mapApiRosterToDeputyRoster(row({ roster_date: null }))).toBeNull();
  });
  it("marks unpublished as Draft", () => {
    expect(mapApiRosterToDeputyRoster(row({ published: false }))!.status).toBe("Draft");
  });
});

describe("mapApiRosters", () => {
  const win = { startDate: "2026-11-05", endDate: "2026-11-11" };

  it("drops unpublished, open and null-employee rows", () => {
    const out = mapApiRosters(
      [
        row({ deputy_id: "1" }),
        row({ deputy_id: "2", published: false }),
        row({ deputy_id: "3", published: null }),
        row({ deputy_id: "4", open_shift: true }),
        row({ deputy_id: "5", employee_name: null }),
      ],
      win
    );
    expect(out.map((r) => r.roster_key)).toEqual(["deputy:1"]);
  });
  it("drops rows outside the inclusive window", () => {
    const out = mapApiRosters(
      [
        row({ deputy_id: "1", roster_date: "2026-11-04" }),
        row({ deputy_id: "2", roster_date: "2026-11-05" }),
        row({ deputy_id: "3", roster_date: "2026-11-11" }),
        row({ deputy_id: "4", roster_date: "2026-11-12" }),
      ],
      win
    );
    expect(out.map((r) => r.roster_key)).toEqual(["deputy:2", "deputy:3"]);
  });
  it("keys are stable and unique", () => {
    const rows = [row({ deputy_id: "7" }), row({ deputy_id: "8" })];
    const a = mapApiRosters(rows, win).map((r) => r.roster_key);
    const b = mapApiRosters(rows, win).map((r) => r.roster_key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });
  it("sorts by date then start time", () => {
    const out = mapApiRosters(
      [
        row({ deputy_id: "1", roster_date: "2026-11-10", start_at: "2026-11-10T03:00:00Z" }),
        row({ deputy_id: "2", roster_date: "2026-11-09", start_at: "2026-11-09T05:00:00Z" }),
        row({ deputy_id: "3", roster_date: "2026-11-10", start_at: "2026-11-09T22:00:00Z" }),
      ],
      win
    );
    expect(out.map((r) => r.roster_key)).toEqual(["deputy:2", "deputy:3", "deputy:1"]);
  });
});
