import { describe, it, expect } from "vitest";
import {
  mapCompany,
  mapOperationalUnit,
  mapEmployee,
  mapRoster,
  mapTimesheet,
  mapLeave,
  toBool,
  toNum,
  toDate,
  idToText,
} from "../../supabase/functions/deputy-sync/mappers";
import {
  buildQuery,
  hasMorePages,
  toRecordArray,
  dedupeByDeputyId,
  isRetryable,
  backoffMs,
} from "../../supabase/functions/deputy-sync/query";

// ── Scalar coercion ──────────────────────────────────────────────────────────
describe("scalar coercion (never invents a default)", () => {
  it("toBool handles Deputy 1/0/true/false and null", () => {
    expect(toBool(1)).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool("1")).toBe(true);
    expect(toBool(undefined)).toBeNull(); // not false!
  });
  it("toNum returns null (not 0) for missing values", () => {
    expect(toNum("")).toBeNull();
    expect(toNum(undefined)).toBeNull();
    expect(toNum("12.5")).toBe(12.5);
    expect(toNum("abc")).toBeNull();
  });
  it("idToText stringifies numeric ids, null-safe", () => {
    expect(idToText(42)).toBe("42");
    expect(idToText(null)).toBeNull();
    expect(idToText("")).toBeNull();
  });
  it("toDate extracts yyyy-mm-dd", () => {
    expect(toDate("2026-10-23T00:00:00+11:00")).toBe("2026-10-22"); // tz-shifted via ISO
    expect(toDate(null)).toBeNull();
  });
});

// ── Mappers map to the real columns + preserve source_data ───────────────────
describe("resource mappers", () => {
  it("employee maps verified fields and keeps inactive", () => {
    const row = mapEmployee({
      Id: 100, DisplayName: "A B", FirstName: "A", LastName: "B",
      Email: "a@b.com", Active: false, Company: 2, OperationalUnit: 7,
      Created: "2025-01-01T00:00:00Z", Modified: "2025-02-01T00:00:00Z",
    });
    expect(row.deputy_id).toBe("100");
    expect(row.active).toBe(false); // inactive preserved, not filtered
    expect(row.company_id).toBe("2");
    expect(row.operational_unit_id).toBe("7");
    expect((row.source_data as Record<string, unknown>).DisplayName).toBe("A B");
  });
  it("employee falls back PrimaryEmail when Email absent", () => {
    expect(mapEmployee({ Id: 1, PrimaryEmail: "p@x.com" }).email).toBe("p@x.com");
  });
  it("company + operational unit map ids as text", () => {
    expect(mapCompany({ Id: 5, CompanyName: "Co", Active: 1 }).deputy_id).toBe("5");
    expect(mapOperationalUnit({ Id: 9, Company: 5, OperationalUnitName: "U" }).company_id).toBe("5");
  });
  it("roster keeps epoch + iso and does not require an employee", () => {
    const r = mapRoster({ Id: 1, Date: "2026-10-23", StartTime: 1760000000, EndTime: 1760028000, Employee: null, OperationalUnit: 3 });
    expect(r.deputy_id).toBe("1");
    expect(r.employee_deputy_id).toBeNull(); // open shift, no employee
    expect(typeof r.start_time_epoch).toBe("number");
    expect(typeof r.start_at).toBe("string");
  });
  it("timesheet retains states and roster link", () => {
    const t = mapTimesheet({ Id: 2, Employee: 100, Roster: 1, TimeApproved: 1, Disputed: 0, Discarded: 0, IsLeave: 0, TotalTime: 7.5 });
    expect(t.roster_deputy_id).toBe("1");
    expect(t.time_approved).toBe(true);
    expect(t.total_time).toBe(7.5);
  });
  it("leave preserves status string verbatim (no enum assumption)", () => {
    const l = mapLeave({ Id: 3, Employee: 100, Status: "Approved", DateStart: "2026-01-01", DateEnd: "2026-01-02", Days: 2 });
    expect(l.status).toBe("Approved");
    expect(l.date_start).toBe("2026-01-01");
    expect(l.days).toBe(2);
  });
});

// ── Query + pagination ───────────────────────────────────────────────────────
describe("query building + pagination", () => {
  it("buildQuery sorts by Id asc and adds a date window when given", () => {
    const q = buildQuery({ start: 0, max: 500, dateField: "Date", from: "2025-10-23", to: "2026-10-24" });
    expect(q.sort).toEqual({ Id: "asc" });
    expect(q.search?.s2).toEqual({ field: "Date", type: "ge", data: "2025-10-23" });
    expect(q.search?.s3).toEqual({ field: "Date", type: "lt", data: "2026-10-24" });
  });
  it("buildQuery omits date filters for reference resources", () => {
    const q = buildQuery({ start: 0, max: 500 });
    expect(q.search?.s2).toBeUndefined();
  });
  it("hasMorePages stops on a short/empty page", () => {
    expect(hasMorePages(500, 500)).toBe(true);
    expect(hasMorePages(499, 500)).toBe(false);
    expect(hasMorePages(0, 500)).toBe(false);
  });
  it("toRecordArray handles bare array and wrapped shapes", () => {
    expect(toRecordArray([{ Id: 1 }]).length).toBe(1);
    expect(toRecordArray({ data: [{ Id: 1 }, { Id: 2 }] }).length).toBe(2);
    expect(toRecordArray({ nope: true }).length).toBe(0);
  });
});

// ── Idempotency / dedupe ─────────────────────────────────────────────────────
describe("dedupe within a batch", () => {
  it("collapses duplicate deputy_ids and counts them", () => {
    const { unique, duplicates } = dedupeByDeputyId([
      { deputy_id: "1", v: "a" }, { deputy_id: "2" }, { deputy_id: "1", v: "b" },
    ]);
    expect(unique.length).toBe(2);
    expect(duplicates).toBe(1);
    // last occurrence wins
    expect(unique.find((r) => r.deputy_id === "1")?.v).toBe("b");
  });
  it("drops rows with a null deputy_id rather than upserting a null key", () => {
    const { unique } = dedupeByDeputyId([{ deputy_id: null }, { deputy_id: "9" }]);
    expect(unique.length).toBe(1);
  });
});

// ── Retry policy ─────────────────────────────────────────────────────────────
describe("retry policy", () => {
  it("retries transient + rate-limit, not auth/validation", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(401)).toBe(false);
    expect(isRetryable(400)).toBe(false);
  });
  it("backoff honours Retry-After and is bounded", () => {
    expect(backoffMs(0, 7)).toBe(7000);
    expect(backoffMs(0, 1000)).toBe(60_000); // capped
    const b = backoffMs(3);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(30_000);
  });
});
