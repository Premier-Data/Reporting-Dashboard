import { describe, it, expect } from "vitest";
import { filterRosterForFixture } from "./rosterSeason";
import { deputySeasonOf } from "@/lib/deputy/reportWeeks";

describe("filterRosterForFixture", () => {
  const rosters = [
    { id: "a", week: 5, season: 2026 },
    { id: "b", week: 5, season: 2027 },
  ];

  it("keeps only the fixture season when the season field is given", () => {
    expect(filterRosterForFixture(rosters, 2027).map((r) => r.id)).toEqual(["b"]);
    expect(filterRosterForFixture(rosters, 2026).map((r) => r.id)).toEqual(["a"]);
  });

  it("works with a season derived from the fixture date", () => {
    const season = deputySeasonOf("2026-11-04");
    expect(filterRosterForFixture(rosters, season).map((r) => r.id)).toEqual(["b"]);
  });

  it("returns a new array and leaves the input unchanged", () => {
    const out = filterRosterForFixture(rosters, 2026);
    expect(out).not.toBe(rosters);
    expect(rosters).toHaveLength(2);
  });
});
