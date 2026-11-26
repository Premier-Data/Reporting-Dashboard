// Pure helpers for the GameFace Schedule fixture panel. No I/O.
import type { CompFixtureRow } from "@/lib/api/compFixtures";
import type { GamefaceAllocation } from "@/lib/api/gamefaceDeputy";

// Exact comp_fixtures.sport / sportName value for AFL (same as AUSSIE_RULES in
// app/comp-fixtures/page.tsx). A comp counts as AFL when its fixtures carry it.
export const GAMEFACE_FIXTURE_SPORT = "Australian Rules Football";

export type FixtureStatus = "Available" | "Allocated";

export function weekFixtureFilters(firstDayKey: string, lastDayKey: string) {
  return { sport: GAMEFACE_FIXTURE_SPORT, dateFrom: firstDayKey, dateTo: lastDayKey };
}

export function indexAllocations(allocs: GamefaceAllocation[]) {
  const byFixtureId = new Map<string, GamefaceAllocation>();
  const byRosterId = new Map<string, GamefaceAllocation[]>();
  for (const a of allocs) {
    byFixtureId.set(a.comp_fixture_id, a);
    const list = byRosterId.get(a.roster_deputy_id);
    if (list) list.push(a);
    else byRosterId.set(a.roster_deputy_id, [a]);
  }
  return { byFixtureId, byRosterId };
}

export function fixtureStatus(
  fixture: Pick<CompFixtureRow, "id">,
  byFixtureId: Map<string, GamefaceAllocation>
): FixtureStatus {
  return byFixtureId.has(fixture.id) ? "Allocated" : "Available";
}

export function competitionOptions(fixtures: Pick<CompFixtureRow, "competition">[]): string[] {
  return Array.from(new Set(fixtures.map((f) => f.competition))).sort((a, b) => a.localeCompare(b));
}

export function filterFixtures<T extends Pick<CompFixtureRow, "competition">>(
  fixtures: T[],
  competition: string
): T[] {
  return !competition || competition === "all" ? fixtures : fixtures.filter((f) => f.competition === competition);
}
