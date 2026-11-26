import { describe, it, expect } from "vitest";
import {
  GAMEFACE_FIXTURE_SPORT,
  competitionOptions,
  filterFixtures,
  fixtureStatus,
  indexAllocations,
  weekFixtureFilters,
} from "./gamefaceFixtures";
import type { GamefaceAllocation } from "@/lib/api/gamefaceDeputy";

const alloc = (id: number, fx: string, roster: string): GamefaceAllocation => ({
  id,
  comp_fixture_id: fx,
  roster_deputy_id: roster,
  employee_name: "A B",
  shift_date: "2026-03-05",
  allocated_by: "admin",
  allocated_at: "2026-03-01T00:00:00Z",
});

describe("weekFixtureFilters", () => {
  it("uses inclusive first/last day keys and AFL only", () => {
    expect(weekFixtureFilters("2026-03-05", "2026-03-11")).toEqual({
      sport: "Australian Rules Football",
      dateFrom: "2026-03-05",
      dateTo: "2026-03-11",
    });
    expect(GAMEFACE_FIXTURE_SPORT).toBe("Australian Rules Football");
  });
});

describe("allocation helpers", () => {
  const idx = indexAllocations([alloc(1, "1:10", "r1"), alloc(2, "1:11", "r1"), alloc(3, "2:5", "r2")]);
  it("indexes by fixture and roster", () => {
    expect(idx.byFixtureId.get("1:10")?.id).toBe(1);
    expect(idx.byRosterId.get("r1")?.map((a) => a.id)).toEqual([1, 2]);
    expect(idx.byRosterId.get("r2")?.length).toBe(1);
  });
  it("reports status", () => {
    expect(fixtureStatus({ id: "1:10" }, idx.byFixtureId)).toBe("Allocated");
    expect(fixtureStatus({ id: "9:9" }, idx.byFixtureId)).toBe("Available");
  });
  it("lists and filters competitions", () => {
    const fx = [{ competition: "B" }, { competition: "A" }, { competition: "B" }];
    expect(competitionOptions(fx)).toEqual(["A", "B"]);
    expect(filterFixtures(fx, "B")).toHaveLength(2);
    expect(filterFixtures(fx, "all")).toHaveLength(3);
  });
});
