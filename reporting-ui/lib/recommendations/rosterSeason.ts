// Roster week numbers repeat across seasons, so a roster must be scoped to the
// season of the fixture it is compared with before matching by week.
export function filterRosterForFixture<T extends { season: number }>(
  rosters: T[],
  fixtureSeason: number
): T[] {
  return rosters.filter((r) => r.season === fixtureSeason);
}
