import { describe, it, expect } from "vitest";
import { pullResource } from "../../supabase/functions/gameface-deputy-sync/engine";
import type { DeputyQuery } from "../../supabase/functions/deputy-sync/query";
import type { Json } from "../../supabase/functions/deputy-sync/mappers";
import rosters from "./fixtures/roster.json";
import employees from "./fixtures/employee.json";

function pager(data: Json[]) {
  const calls: { resource: string; query: DeputyQuery }[] = [];
  const fetchPage = async (resource: string, query: DeputyQuery) => {
    calls.push({ resource, query });
    return data.slice(query.start, query.start + query.max);
  };
  return { calls, fetchPage };
}

describe("pullResource", () => {
  it("pages until a short page, sending only QUERY bodies", async () => {
    const { calls, fetchPage } = pager(rosters as Json[]);
    const r = await pullResource({ fetchPage, pageSize: 2, maxPages: 50 }, "Roster", {
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    expect(calls.map((c) => c.query.start)).toEqual([0, 2, 4]);
    expect(r.read).toBe(5);
    expect(r.rows).toHaveLength(5);
    expect([...r.returnedIds].sort()).toEqual(["1001", "1002", "1003", "1004", "1005"]);
    for (const c of calls) {
      expect(c.resource).toBe("Roster");
      expect(Object.keys(c.query).sort()).toEqual(["max", "search", "sort", "start"]);
    }
  });
  it("sends the day after endDate as the exclusive upper bound", async () => {
    const { calls, fetchPage } = pager(rosters as Json[]);
    await pullResource({ fetchPage, pageSize: 100, maxPages: 5 }, "Roster", {
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    const s = calls[0].query.search!;
    expect(s.s2).toMatchObject({ field: "Date", type: "ge", data: "2026-05-01" });
    expect(s.s3).toMatchObject({ field: "Date", type: "lt", data: "2026-06-01" });
  });
  it("does not add a date filter for reference resources", async () => {
    const { calls, fetchPage } = pager(employees as Json[]);
    await pullResource({ fetchPage, pageSize: 100, maxPages: 5 }, "Employee", { startDate: "2026-05-01", endDate: "2026-05-31" });
    expect(Object.keys(calls[0].query.search!)).toEqual(["s1"]);
  });
  it("dedupes repeated ids and counts them as skipped", async () => {
    const dup = [...(rosters as Json[]), rosters[0] as Json];
    const { fetchPage } = pager(dup);
    const r = await pullResource({ fetchPage, pageSize: 100, maxPages: 5 }, "Roster", {});
    expect(r.read).toBe(6);
    expect(r.rows).toHaveLength(5);
    expect(r.skipped).toBe(1);
  });
  it("scrubs personal fields and reports a dry-run summary matching the fixtures", async () => {
    const { fetchPage } = pager(employees as Json[]);
    const r = await pullResource({ fetchPage, pageSize: 100, maxPages: 5 }, "Employee", {});
    expect(r.rows.every((x) => x.email === null)).toBe(true);
    expect(JSON.stringify(r.rows)).not.toContain("example.invalid");
    expect(r.droppedFieldNames).toContain("DateOfBirth");
    expect(r.summary.read).toBe(2);
    const rr = await pullResource({ fetchPage: pager(rosters as Json[]).fetchPage, pageSize: 100, maxPages: 5 }, "Roster", {});
    expect(rr.summary.dateMismatches).toBe(0);
  });
  it("stops at maxPages", async () => {
    const { calls, fetchPage } = pager(rosters as Json[]);
    await pullResource({ fetchPage, pageSize: 1, maxPages: 2 }, "Roster", {});
    expect(calls).toHaveLength(2);
  });
  it("rejects unknown resources", async () => {
    const { fetchPage } = pager([]);
    await expect(pullResource({ fetchPage, pageSize: 1, maxPages: 1 }, "Memo", {})).rejects.toThrow();
  });
});