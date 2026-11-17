import { describe, expect, it } from "vitest";
import {
  groupByMasterKey,
  isSafeMasterWrite,
  masterKey,
  masterTotalsDiffer,
} from "./masterGroup";

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
  it("is true when totals differ", () => {
    expect(masterTotalsDiffer([415, 414])).toBe(true);
  });
});
