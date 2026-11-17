import { describe, expect, it } from "vitest";
import {
  groupByMasterKey,
  isSafeMasterWrite,
  masterKey,
  masterTotalsDiffer,
  mastersGenuinelyDiffer,
  resolveMasterCoder,
} from "./masterGroup";

describe("resolveMasterCoder", () => {
  const row = (
    id: number,
    created_at: string,
    master_analyst_name: string | null,
    file_name_master: string | null,
    deleted_at: string | null = null
  ) => ({ id, created_at, master_analyst_name, file_name_master, deleted_at });

  it("earliest check wins", () => {
    const rows = [
      row(1, "2026-02-01T00:00:00Z", "Late", "m.json"),
      row(2, "2026-01-01T00:00:00Z", "Early", "m.json"),
    ];
    expect(resolveMasterCoder(rows, "m.json")).toBe("Early");
  });

  it("matches on the normalised key (case + whitespace)", () => {
    const rows = [row(1, "2026-01-01T00:00:00Z", "Ann", "  R6 AFc.json ")];
    expect(resolveMasterCoder(rows, "r6 afC.json")).toBe("Ann");
  });

  it("ignores soft-deleted checks", () => {
    const rows = [
      row(1, "2026-01-01T00:00:00Z", "Gone", "m.json", "2026-03-01T00:00:00Z"),
      row(2, "2026-02-01T00:00:00Z", "Kept", "m.json"),
    ];
    expect(resolveMasterCoder(rows, "m.json")).toBe("Kept");
  });

  it("returns null when nothing matches or name is blank", () => {
    const rows = [row(1, "2026-01-01T00:00:00Z", "Ann", "other.json")];
    expect(resolveMasterCoder(rows, "m.json")).toBeNull();
    expect(resolveMasterCoder(rows, "  ")).toBeNull();
    expect(resolveMasterCoder([], "m.json")).toBeNull();
  });

  it("breaks created_at ties by lowest id", () => {
    const rows = [
      row(9, "2026-01-01T00:00:00Z", "Nine", "m.json"),
      row(3, "2026-01-01T00:00:00Z", "Three", "m.json"),
    ];
    expect(resolveMasterCoder(rows, "m.json")).toBe("Three");
  });
});

describe("masterKey", () => {
  it("trims and lowercases, null becomes empty", () => {
    expect(masterKey("  Specific - R6 AFc.json ")).toBe("specific - r6 afc.json");
    expect(masterKey(null)).toBe("");
    expect(masterKey(undefined)).toBe("");
  });
});

describe("groupByMasterKey", () => {
  const rows = [
    { id: 1, file_name_master: "Specific - R6 PD Passing AFc v PD Passing SC.json" },
    { id: 2, file_name_master: "Specific - R6 PD Passing AFC v PD Passing SC.json" },
    { id: 3, file_name_master: " Specific - R6 PD Passing AFC v PD Passing SC.json " },
    { id: 4, file_name_master: "Specific - R6 PD Passing AFC v PD Passing SC.xml" },
    { id: 5, file_name_master: null },
  ];

  it("merges case and whitespace spellings of one master", () => {
    const g = groupByMasterKey(rows);
    const key = masterKey(rows[0].file_name_master);
    expect(g.get(key)!.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("keeps .json and .xml as different masters and skips unnamed rows", () => {
    const g = groupByMasterKey(rows);
    expect(g.size).toBe(2);
    expect(g.get(masterKey(rows[3].file_name_master))!.map((r) => r.id)).toEqual([4]);
  });
});

describe("isSafeMasterWrite", () => {
  it("rejects 0 for a non-empty master (unparsable)", () => {
    expect(isSafeMasterWrite('{"allStatistics":[]}', 0)).toBe(false);
  });
  it("rejects an empty or blank master", () => {
    expect(isSafeMasterWrite("", 5)).toBe(false);
    expect(isSafeMasterWrite("   ", 5)).toBe(false);
    expect(isSafeMasterWrite(null, 5)).toBe(false);
  });
  it("accepts a non-empty master with instances", () => {
    expect(isSafeMasterWrite("<x/>", 415)).toBe(true);
  });
});

describe("masterTotalsDiffer", () => {
  it("is false when all non-null totals match", () => {
    expect(masterTotalsDiffer([415, 415, null])).toBe(false);
  });
  it("mastersGenuinelyDiffer ignores identical parsed sizes, flags real differences", () => {
    expect(mastersGenuinelyDiffer([226, 226, 226])).toBe(false);
    expect(mastersGenuinelyDiffer([])).toBe(false);
    expect(mastersGenuinelyDiffer([264, 305])).toBe(true);
  });
  it("is true when totals differ", () => {
    expect(masterTotalsDiffer([415, 414])).toBe(true);
  });
});
