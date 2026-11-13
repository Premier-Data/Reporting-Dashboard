import { describe, it, expect } from "vitest";

import { compareValues, roundSortValue, sortRows, type SortColumn } from "./tableSort";

type R = { name: string | null; n: number | null; round?: string | number | null; date?: string };

const col = (value: SortColumn<R>["value"], extra: Partial<SortColumn<R>> = {}): SortColumn<R> => ({
  value,
  ...extra,
});

const names = (rows: R[]) => rows.map((r) => r.name);

describe("compareValues", () => {
  it("compares numbers numerically, not as text", () => {
    expect(compareValues(9, 10, "asc")).toBeLessThan(0);
    expect(compareValues(9, 10, "desc")).toBeGreaterThan(0);
  });

  it("compares text case-insensitively and naturally", () => {
    expect(compareValues("apple", "Banana", "asc")).toBeLessThan(0);
    expect(compareValues("Team 2", "Team 10", "asc")).toBeLessThan(0);
  });

  it("compares ISO dates chronologically in raw mode", () => {
    expect(compareValues("2024-03-02", "2024-10-01", "asc", true)).toBeLessThan(0);
  });

  it("puts blanks last in both directions", () => {
    for (const blank of [null, undefined, "", "\u2014", "-"]) {
      expect(compareValues(blank, 5, "asc")).toBeGreaterThan(0);
      expect(compareValues(blank, 5, "desc")).toBeGreaterThan(0);
      expect(compareValues("x", blank, "asc")).toBeLessThan(0);
      expect(compareValues("x", blank, "desc")).toBeLessThan(0);
    }
  });

  it("uses later array elements as tiebreaks", () => {
    expect(compareValues([1, "a"], [1, "b"], "asc")).toBeLessThan(0);
    expect(compareValues([1, "a"], [1, "b"], "desc")).toBeGreaterThan(0);
  });
});

describe("roundSortValue", () => {
  it("sorts numeric rounds first, then finals in order, then other text", () => {
    const rounds = ["GF", "10", 2, "SF", "QF", "EF", "PF", "Grand", "1"];
    const sorted = [...rounds].sort((a, b) =>
      compareValues(roundSortValue(a), roundSortValue(b), "asc")
    );
    expect(sorted).toEqual(["1", 2, "10", "EF", "QF", "SF", "PF", "GF", "Grand"]);
  });

  it("treats empty rounds as blank", () => {
    expect(roundSortValue("")).toBeNull();
    expect(roundSortValue(null)).toBeNull();
  });
});

describe("sortRows", () => {
  const rows: R[] = [
    { name: "b", n: 10 },
    { name: "A", n: 9 },
    { name: null, n: null },
    { name: "c", n: 9 },
  ];

  it("sorts ascending and descending with blanks last", () => {
    const byName = col((r) => r.name);
    expect(names(sortRows(rows, byName, "asc"))).toEqual(["A", "b", "c", null]);
    expect(names(sortRows(rows, byName, "desc"))).toEqual(["c", "b", "A", null]);
  });

  it("keeps input order for ties (stable) and applies the tiebreak", () => {
    const byN = col((r) => r.n);
    expect(names(sortRows(rows, byN, "asc"))).toEqual(["A", "c", "b", null]);
    const tie = (a: R, b: R) => (a.name ?? "").localeCompare(b.name ?? "") * -1;
    expect(names(sortRows(rows, byN, "asc", tie))).toEqual(["c", "A", "b", null]);
  });

  it("orders fixtures by date then round, and by round with text finals last", () => {
    const fx: R[] = [
      { name: "gf", n: 0, round: "GF", date: "2024-09-01" },
      { name: "r2b", n: 0, round: 2, date: "2024-04-01" },
      { name: "r10", n: 0, round: 10, date: "2024-04-01" },
      { name: "r2a", n: 0, round: 2, date: "2024-03-01" },
    ];
    const byWk = col((r) => [r.date ?? "", roundSortValue(r.round)], { raw: true });
    const byRnd = col((r) => [roundSortValue(r.round), r.date ?? ""]);
    expect(names(sortRows(fx, byWk, "asc"))).toEqual(["r2a", "r2b", "r10", "gf"]);
    expect(names(sortRows(fx, byWk, "desc"))).toEqual(["gf", "r10", "r2b", "r2a"]);
    expect(names(sortRows(fx, byRnd, "asc"))).toEqual(["r2a", "r2b", "r10", "gf"]);
  });
});
