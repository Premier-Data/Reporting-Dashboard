import { describe, it, expect } from "vitest";
import { aggregateTTLocations, ttLocationColours, ttLocationLabel } from "./ttLocations";

// The previous hard-coded logic, kept here to prove AUS/PHL/Mixed are unchanged.
function oldCounts(locs: string[]) {
  const c = { AUS: 0, PHL: 0, Mixed: 0 };
  for (const raw of locs) {
    const l = raw.trim().toLowerCase();
    const aus = l.includes("aus");
    const phl = l.includes("phl");
    if (aus && phl) c.Mixed++;
    else if (aus) c.AUS++;
    else if (phl) c.PHL++;
  }
  return c;
}

describe("ttLocationLabel", () => {
  it("normalises, folds AUS+PHL into Mixed, blank into Unknown", () => {
    expect(ttLocationLabel(" aus ")).toBe("AUS");
    expect(ttLocationLabel("ind")).toBe("IND");
    expect(ttLocationLabel("PHL/ AUS")).toBe("Mixed");
    expect(ttLocationLabel("phl/aus")).toBe("Mixed");
    expect(ttLocationLabel("AUS/  VN")).toBe("AUS/ VN");
    expect(ttLocationLabel("")).toBe("Unknown");
    expect(ttLocationLabel(null)).toBe("Unknown");
  });
});

describe("aggregateTTLocations", () => {
  const rows = [
    { week: "2", location: "PHL" },
    { week: "1", location: "AUS" },
    { week: "1", location: "IND" },
    { week: "1", location: "ind" },
    { week: "2", location: "PHL/ AUS" },
    { week: "2", location: "" },
    { week: "10", location: "AUS" },
  ];
  it("lists IND as its own location, AUS first then by total desc", () => {
    const r = aggregateTTLocations(rows);
    expect(r.locations).toEqual(["AUS", "IND", "Mixed", "PHL", "Unknown"]);
    expect(r.totals.IND).toBe(2);
  });
  it("sums per week and overall to the row count; weeks sorted numerically", () => {
    const r = aggregateTTLocations(rows);
    expect(r.weeks.map((w) => w.week)).toEqual(["1", "2", "10"]);
    for (const w of r.weeks) expect(Object.values(w.counts).reduce((a, b) => a + b, 0)).toBe(w.games);
    expect(Object.values(r.totals).reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect(r.games).toBe(rows.length);
  });
  it("matches the old AUS/PHL/Mixed numbers for a 2026-like fixture", () => {
    const locs = ["AUS", "AUS", "PHL", "PHL", "PHL/ AUS", "AUS/PHL", "aus", "Phl"];
    const r = aggregateTTLocations(locs.map((location, i) => ({ week: String((i % 3) + 1), location })));
    const o = oldCounts(locs);
    expect(r.totals.AUS).toBe(o.AUS);
    expect(r.totals.PHL).toBe(o.PHL);
    expect(r.totals.Mixed).toBe(o.Mixed);
  });
});

describe("ttLocationColours", () => {
  it("keeps AUS/PHL/Mixed colours and is stable for others", () => {
    expect(ttLocationColours("AUS")[0]).toBe("#4ade80");
    expect(ttLocationColours("IND")).toEqual(ttLocationColours("IND"));
  });
});
