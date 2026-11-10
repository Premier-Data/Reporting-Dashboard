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
  sydneyDateFromEpochSeconds,
} from "../../supabase/functions/deputy-sync/mappers";
import {
  buildQuery,
  hasMorePages,
  toRecordArray,
  dedupeByDeputyId,
  isRetryable,
  backoffMs,
  nextDay,
} from "../../supabase/functions/deputy-sync/query";
import { planRosterReconcile } from "../../supabase/functions/deputy-sync/reconcile";

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

// ── Sydney-local shift date bucketing ────────────────────────────────────────
describe("Sydney-local shift date bucketing", () => {
  it("AEDT (+11): evening-UTC instant falls on the next Sydney day", () => {
    // 1793570400 s = 2026-11-01T22:00:00Z = 2026-11-02 09:00 Sydney (AEDT +11)
    expect(sydneyDateFromEpochSeconds(1793570400)).toBe("2026-11-02");
    expect(sydneyDateFromEpochSeconds(1793570400)).not.toBe("2026-11-01"); // not the UTC date
  });
  it("AEST (+10, winter): same-day and day-crossing cases", () => {
    // 1755561600 s = 2025-08-19T00:00:00Z = 2025-08-19 10:00 Sydney (AEST +10)
    expect(sydneyDateFromEpochSeconds(1755561600)).toBe("2025-08-19");
    // 1784152800 s = 2026-07-15T22:00:00Z = 2026-07-16 08:00 Sydney (AEST +10)
    expect(sydneyDateFromEpochSeconds(1784152800)).toBe("2026-07-16");
    expect(sydneyDateFromEpochSeconds(1784152800)).not.toBe("2026-07-15"); // crosses the day
  });
  it("null/invalid input -> null", () => {
    expect(sydneyDateFromEpochSeconds(null)).toBeNull();
    expect(sydneyDateFromEpochSeconds(undefined)).toBeNull();
    expect(sydneyDateFromEpochSeconds("")).toBeNull();
    expect(sydneyDateFromEpochSeconds(NaN)).toBeNull();
    expect(sydneyDateFromEpochSeconds("abc")).toBeNull();
    expect(sydneyDateFromEpochSeconds(Infinity)).toBeNull();
  });
  it("mapped row date equals the Sydney-local date of StartTime (StartTime wins over UTC Date)", () => {
    const t = mapTimesheet({ Id: 2, StartTime: 1793570400, Date: "2026-11-01", Employee: 100 });
    expect(t.timesheet_date).toBe("2026-11-02");
    const r = mapRoster({ Id: 1, StartTime: 1793570400, Date: "2026-11-01", OperationalUnit: 3 });
    expect(r.roster_date).toBe("2026-11-02");
  });
  it("falls back to the Date field when StartTime is absent", () => {
    const t = mapTimesheet({ Id: 3, Date: "2026-11-01" });
    expect(t.timesheet_date).toBe(toDate("2026-11-01"));
    expect(t.timesheet_date).toBe("2026-11-01");
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


// ── Inclusive end date ───────────────────────────────────────────────────────
// Deputy's range filter is `Date lt <to>` (exclusive), but callers (nightly
// cron, Reload, manual runs) pass an INCLUSIVE endDate. The function sends
// Deputy nextDay(endDate), otherwise "today" is never fetched.
describe("nextDay (makes the exclusive Deputy upper bound inclusive)", () => {
  it("adds one day", () => {
    expect(nextDay("2026-11-09")).toBe("2026-11-10");
  });

  it("rolls over month and year ends", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("handles leap years", () => {
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2028-02-29")).toBe("2028-03-01");
    expect(nextDay("2026-02-28")).toBe("2026-03-01");
  });

  it("returns null for malformed or non-existent dates", () => {
    expect(nextDay("2026-02-31")).toBeNull();
    expect(nextDay("2026-13-01")).toBeNull();
    expect(nextDay("not-a-date")).toBeNull();
    expect(nextDay("2026-1-5")).toBeNull();
    expect(nextDay("")).toBeNull();
  });

  it("an inclusive endDate of 'today' yields a Deputy upper bound that includes today", () => {
    // Regression: endDate 2026-11-09 used to be sent as `Date lt 2026-11-09`,
    // which excluded Monday 9 Nov's shifts entirely.
    const q = buildQuery({
      start: 0,
      max: 500,
      dateField: "Date",
      from: "2026-10-27",
      to: nextDay("2026-11-09") ?? undefined,
    });
    expect(q.search?.s3).toEqual({ field: "Date", type: "lt", data: "2026-11-10" });
  });
});

// ── Roster soft-delete reconcile ─────────────────────────────────────────────
describe("mapRoster is_deleted", () => {
  it("writes is_deleted:false so a reappearing roster is un-hidden", () => {
    expect(mapRoster({ Id: 9, Date: "2026-11-10" }).is_deleted).toBe(false);
  });
});

describe("planRosterReconcile", () => {
  const base = {
    resource: "Roster",
    status: "succeeded" as const,
    dryRun: false,
    startDate: "2026-10-28",
    endDate: "2026-12-08",
    readCount: 18,
    returnedIds: Array.from({ length: 18 }, (_, i) => String(i + 1)),
    existingIds: Array.from({ length: 20 }, (_, i) => String(i + 1)),
  };

  it("soft-deletes stored ids Deputy no longer returns (sorted, deduped)", () => {
    const p = planRosterReconcile({ ...base, existingIds: [...base.existingIds, "20"] });
    expect(p.action).toBe("apply");
    expect(p.idsToDelete).toEqual(["19", "20"]);
  });

  it("is idempotent: once applied, re-planning finds nothing", () => {
    const p = planRosterReconcile({
      ...base,
      existingIds: base.existingIds.filter((id) => base.returnedIds.includes(id)),
    });
    expect(p.action).toBe("skip");
    expect(p.idsToDelete).toEqual([]);
    expect(p.reason).toBe("nothing_to_delete");
  });

  it("never runs for partial or failed syncs", () => {
    expect(planRosterReconcile({ ...base, status: "partial" }).reason).toBe("sync_not_succeeded");
    expect(planRosterReconcile({ ...base, status: "failed" }).action).toBe("skip");
  });

  it("never runs on dryRun", () => {
    expect(planRosterReconcile({ ...base, dryRun: true }).reason).toBe("dry_run");
  });

  it("only applies to Roster", () => {
    expect(planRosterReconcile({ ...base, resource: "Timesheet" }).reason).toBe("not_roster");
  });

  it("requires a strictly bounded window", () => {
    expect(planRosterReconcile({ ...base, startDate: undefined }).reason).toBe("no_window");
    expect(planRosterReconcile({ ...base, endDate: "" }).reason).toBe("no_window");
  });

  it("refuses an empty read when the window has stored rows", () => {
    const p = planRosterReconcile({ ...base, readCount: 0, returnedIds: [] });
    expect(p.action).toBe("skip");
    expect(p.reason).toBe("empty_read_guard");
    expect(p.idsToDelete).toEqual([]);
  });

  it("zero read + zero stored is a no-op, not an error", () => {
    const p = planRosterReconcile({ ...base, readCount: 0, returnedIds: [], existingIds: [] });
    expect(p.action).toBe("skip");
    expect(p.reason).toBe("nothing_to_delete");
  });

  it("circuit breaker: refuses 12 of 20, allows 2 of 20", () => {
    const refused = planRosterReconcile({
      ...base,
      readCount: 8,
      returnedIds: base.returnedIds.slice(0, 8),
      minAbsolute: 5,
    });
    expect(refused.reason).toBe("mass_delete_guard");
    expect(refused.idsToDelete).toEqual([]);
    expect(planRosterReconcile(base).action).toBe("apply");
  });

  it("small windows may delete up to minAbsolute even above the fraction", () => {
    const p = planRosterReconcile({
      ...base,
      readCount: 1,
      returnedIds: ["1"],
      existingIds: ["1", "2", "3"],
    });
    expect(p.action).toBe("apply");
    expect(p.idsToDelete).toEqual(["2", "3"]);
  });
});
