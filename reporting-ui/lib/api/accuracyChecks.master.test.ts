import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Minimal in-memory supabase fake (select/update with common filters) ----
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  updates: [] as { id: number; payload: Row }[],
  deletes: 0,
  failUpdateIds: new Set<number>(),
}));

vi.mock("@/lib/supabase", () => {
  function builder() {
    const f: ((r: Row) => boolean)[] = [];
    let cols: string | null = null;
    let op: "select" | "update" | "delete" = "select";
    let payload: Row = {};
    let single = false;
    let limit = Infinity;
    let orderBy: { col: string; asc: boolean } | null = null;
    const run = () => {
      let rows = db.rows.filter((r) => f.every((fn) => fn(r)));
      if (op === "delete") {
        db.deletes += 1;
        return { data: null, error: null };
      }
      if (op === "update") {
        for (const r of rows) {
          const id = r.id as number;
          if (db.failUpdateIds.has(id)) {
            return { data: null, error: { message: "boom" } };
          }
          db.updates.push({ id, payload });
          Object.assign(r, payload);
        }
        return { data: null, error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) =>
          (a[col] as number) < (b[col] as number) ? (asc ? -1 : 1) : asc ? 1 : -1
        );
      }
      rows = rows.slice(0, limit);
      const names =
        cols && cols !== "*" ? cols.split(",").map((s) => s.trim()) : null;
      const proj = rows.map((r) => {
        if (!names) return { ...r };
        const o: Row = {};
        for (const n of names) o[n] = r[n];
        return o;
      });
      if (single) {
        return proj[0]
          ? { data: proj[0], error: null }
          : { data: null, error: { message: "no rows" } };
      }
      return { data: proj, error: null };
    };
    const b: any = {
      select: (c?: string) => ((cols = c ?? "*"), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (f.push((r) => vs.includes(r[c])), b),
      gt: (c: string, v: number) => (f.push((r) => (r[c] as number) > v), b),
      is: (c: string, v: null) => (f.push((r) => (r[c] ?? null) === v), b),
      ilike: (c: string, pat: string) => {
        const re = new RegExp(
          "^" +
            pat
              .toLowerCase()
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/%/g, ".*")
              .replace(/_/g, ".") +
            "$"
        );
        f.push((r) => re.test(String(r[c] ?? "").toLowerCase()));
        return b;
      },
      order: (col: string, o?: { ascending?: boolean }) => (
        (orderBy = { col, asc: o?.ascending !== false }), b
      ),
      limit: (n: number) => ((limit = n), b),
      single: () => ((single = true), b),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  return { supabase: { from: () => builder() } };
});

import {
  diagnoseMasterConsistency,
  fixStaleMasterTotals,
  instancesFromRaw,
  propagateMasterCorrection,
  regradeAllChecks,
  getMasterCheckSiblings,
  jsonDeepEqual,
  probeMasterVersions,
} from "./accuracyChecks";
import { mastersGenuinelyDiffer } from "./masterGroup";
import { parseInstances } from "@/lib/comparison/xml-compare";

const FIX = join(__dirname, "..", "comparison", "__fixtures__");
const feed = JSON.parse(
  readFileSync(join(FIX, "pd-819-34131-AI.json"), "utf8")
) as { allStatistics: unknown[] };
const slice = (n: number) =>
  JSON.stringify({ ...feed, allStatistics: feed.allStatistics.slice(0, n) });

const MASTER_JSON = slice(80);
const ANALYST_JSON = slice(70);
const NAME = "Specific - R6 PD Passing AFc v PD Passing SC.json";

function check(id: number, over: Row = {}): Row {
  return {
    id,
    analyst_name: `Analyst ${id}`,
    created_at: `2026-01-0${id}T00:00:00Z`,
    deleted_at: null,
    tolerance: 3,
    sport: "football",
    file_name_master: NAME,
    xml_master: MASTER_JSON,
    xml_analyst: ANALYST_JSON,
    master_total: 1,
    accuracy: 0.1,
    player_accuracy: null,
    ...over,
  };
}

beforeEach(() => {
  db.rows = [];
  db.updates = [];
  db.deletes = 0;
  db.failUpdateIds = new Set();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("JSON-aware master counting", () => {
  it("counts a JSON feed via instancesFromRaw but not via XML parseInstances", () => {
    expect(instancesFromRaw(MASTER_JSON).length).toBeGreaterThan(0);
    expect(parseInstances(MASTER_JSON).length).toBe(0);
  });

  it("diagnoseMasterConsistency reports the real count for a JSON master, never 0", async () => {
    db.rows = [check(1), check(2, { file_name_master: NAME.replace("AFc", "AFC") })];
    const expected = instancesFromRaw(MASTER_JSON).length;
    const report = await diagnoseMasterConsistency(NAME);
    expect(report.checks).toHaveLength(2);
    for (const c of report.checks) {
      expect(c.parsedMasterTotal).toBe(expected);
      expect(c.gradedMasterTotal).not.toBeNull();
    }
    expect(report.distinctCounts).toEqual([expected]);
    expect(report.consistent).toBe(true);
    expect(report.unparsableMasterCheckIds).toEqual([]);
    // stored master_total (1) differs from the graded total, so both are stale
    expect(report.staleTotalCheckIds.sort()).toEqual([1, 2]);
  });

  it("flags a master that is non-empty but parses to 0 as unparsable, not stale", async () => {
    db.rows = [check(1, { xml_master: '{"allStatistics":[]}' })];
    const report = await diagnoseMasterConsistency(NAME);
    expect(report.unparsableMasterCheckIds).toEqual([1]);
    expect(report.staleTotalCheckIds).toEqual([]);
  });
});

describe("probeMasterVersions", () => {
  it("ignores differing stored master_total when the master file is identical", async () => {
    db.rows = [
      check(1, { master_total: 10 }),
      check(2, { master_total: 70 }),
      check(3, { master_total: 0 }),
    ];
    const r = await probeMasterVersions(NAME);
    expect(r.distinctCounts).toEqual([instancesFromRaw(MASTER_JSON).length]);
    expect(mastersGenuinelyDiffer(r.distinctCounts)).toBe(false);
  });

  it("reports both sizes when checks use genuinely different masters", async () => {
    db.rows = [check(1), check(2, { xml_master: slice(60) })];
    const r = await probeMasterVersions(NAME);
    expect(r.distinctCounts).toHaveLength(2);
    expect(mastersGenuinelyDiffer(r.distinctCounts)).toBe(true);
  });
});

describe("fixStaleMasterTotals never writes 0", () => {
  it("skips and reports a master that parses to 0 instances, writes nothing", async () => {
    db.rows = [check(1, { xml_master: '{"allStatistics":[]}', master_total: 415 })];
    const res = await fixStaleMasterTotals([1]);
    expect(res.fixed).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].id).toBe(1);
    expect(db.updates).toEqual([]);
    expect(db.rows[0].master_total).toBe(415);
  });

  it("re-grades a good JSON master with a positive total and never touches xml_*", async () => {
    db.rows = [check(1)];
    const res = await fixStaleMasterTotals([1]);
    expect(res.fixed).toBe(1);
    const p = db.updates[0].payload;
    expect(p.master_total as number).toBeGreaterThan(0);
    expect("xml_master" in p).toBe(false);
    expect("xml_analyst" in p).toBe(false);
  });
});

describe("propagateMasterCorrection", () => {
  const NEW_MASTER = slice(60);

  it("updates every check of the normalised master group, skips other masters, never writes xml_analyst", async () => {
    db.rows = [
      check(1),
      check(2, { file_name_master: NAME.replace("AFc", "AFC") }),
      check(3, { file_name_master: ` ${NAME} ` }),
      check(4, { file_name_master: "Other master.json" }),
      check(5, { deleted_at: "2026-01-01T00:00:00Z" }),
    ];
    const res = await propagateMasterCorrection(NAME, NEW_MASTER);
    expect(res.updated).toBe(3);
    expect(res.failed).toBe(0);
    expect(db.updates.map((u) => u.id).sort()).toEqual([1, 2, 3]);
    for (const u of db.updates) {
      expect(u.payload.xml_master).toBe(NEW_MASTER);
      expect("xml_analyst" in u.payload).toBe(false);
      expect(u.payload.master_total as number).toBeGreaterThan(0);
    }
    expect(db.rows[3].xml_master).toBe(MASTER_JSON);
    expect(db.rows[4].xml_master).toBe(MASTER_JSON);
    expect(res.matchedNames).toHaveLength(3);
  });

  it("honours excludeId", async () => {
    db.rows = [check(1), check(2)];
    const res = await propagateMasterCorrection(NAME, NEW_MASTER, { excludeId: 1 });
    expect(res.updated).toBe(1);
    expect(db.updates.map((u) => u.id)).toEqual([2]);
  });

  it("throws and writes nothing for an empty or unparsable master", async () => {
    db.rows = [check(1), check(2)];
    await expect(propagateMasterCorrection(NAME, "")).rejects.toThrow(/no instances/);
    await expect(
      propagateMasterCorrection(NAME, '{"allStatistics":[]}')
    ).rejects.toThrow(/no instances/);
    expect(db.updates).toEqual([]);
  });

  it("continues after a per-row failure and reports it", async () => {
    db.rows = [check(1), check(2), check(3)];
    db.failUpdateIds.add(2);
    const res = await propagateMasterCorrection(NAME, NEW_MASTER);
    expect(res.updated).toBe(2);
    expect(res.failed).toBe(1);
  });

  it("getMasterCheckSiblings counts the same normalised group", async () => {
    db.rows = [
      check(1),
      check(2, { file_name_master: NAME.replace("AFc", "AFC") }),
      check(3, { file_name_master: "Other.json" }),
    ];
    const s = await getMasterCheckSiblings(NAME);
    expect(s.count).toBe(2);
  });
});

describe("regradeAllChecks", () => {
  it("skips rows with missing XML, never deletes, backs up old values first and reports changes", async () => {
    db.rows = [
      check(1),
      check(2, { xml_analyst: null }),
      check(3, { xml_master: '{"allStatistics":[]}' }),
    ];
    const order: string[] = [];
    const res = await regradeAllChecks({
      onBackup: (rows) => {
        order.push(`backup:${db.updates.length}`);
        expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
        expect(rows[0].accuracy).toBe(0.1);
      },
    });
    expect(order).toEqual(["backup:0"]); // backup before any write
    expect(res.total).toBe(3);
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(2);
    expect(res.changed).toBe(1);
    expect(db.deletes).toBe(0);
    expect(db.updates.map((u) => u.id)).toEqual([1]);
    expect("xml_master" in db.updates[0].payload).toBe(false);
  });

  it("resumes after afterId without re-running the backup", async () => {
    db.rows = [check(1), check(2), check(3)];
    const onBackup = vi.fn();
    const res = await regradeAllChecks({ afterId: 2, onBackup });
    expect(onBackup).not.toHaveBeenCalled();
    expect(db.updates.map((u) => u.id)).toEqual([3]);
    expect(res.lastId).toBe(3);
  });

  it("aborts without writing when the backup callback throws", async () => {
    db.rows = [check(1)];
    await expect(
      regradeAllChecks({
        onBackup: () => {
          throw new Error("no download");
        },
      })
    ).rejects.toThrow("no download");
    expect(db.updates).toEqual([]);
  });

  it("does not delete soft-deleted rows or touch them", async () => {
    db.rows = [check(1, { deleted_at: "2026-01-01T00:00:00Z" })];
    const res = await regradeAllChecks();
    expect(res.total).toBe(0);
    expect(db.updates).toEqual([]);
  });
});

describe("jsonDeepEqual", () => {
  it("ignores object key order", () => {
    expect(jsonDeepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonDeepEqual(null, undefined)).toBe(true);
  });
});
