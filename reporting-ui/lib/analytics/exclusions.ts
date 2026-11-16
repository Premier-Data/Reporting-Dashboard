// Pure helpers for the competition / team exclusion list (no Supabase import).
import {
  FALLBACK_EXCLUDED_COMPETITIONS,
  canonicalCompetition,
  canonicalTeam,
  isExcludedCompetition,
} from "@/lib/analytics/competitionNames";
import type { SummaryRow } from "@/lib/analytics/competitionSummary";

export type ExclusionKind = "competition" | "team";

export type ExclusionRow = {
  /** null for built-in fallback rows (not stored in the database). */
  id: number | null;
  kind: ExclusionKind;
  /** Canonical key (canonicalCompetition / canonicalTeam). */
  key: string;
  label: string;
  reason: string | null;
  created_by: string | null;
  created_at: string | null;
};

/** The built-in 8 competitions, used when the exclusions table is unavailable. */
export function fallbackExclusionRows(): ExclusionRow[] {
  return FALLBACK_EXCLUDED_COMPETITIONS.map((label) => ({
    id: null,
    kind: "competition" as const,
    key: canonicalCompetition(label),
    label,
    reason: "Built-in list",
    created_by: null,
    created_at: null,
  }));
}

export function exclusionKeySets(rows: readonly ExclusionRow[]): {
  competitionKeys: Set<string>;
  teamKeys: Set<string>;
} {
  const competitionKeys = new Set<string>();
  const teamKeys = new Set<string>();
  for (const r of rows) {
    if (r.kind === "competition") competitionKeys.add(canonicalCompetition(r.key));
    else if (r.kind === "team") teamKeys.add(canonicalTeam(r.key));
  }
  return { competitionKeys, teamKeys };
}

/** Drops practice games and games in an excluded competition. */
export function filterExcludedCompetitions<T extends { Competition?: string | null }>(
  games: readonly T[],
  competitionKeys: ReadonlySet<string>
): T[] {
  return games.filter((g) => !isExcludedCompetition(g.Competition, competitionKeys));
}

/**
 * How many games / teams an exclusion affects in the loaded data.
 * Pass the UNFILTERED game list so already-excluded entries still show impact.
 */
export function exclusionImpact(
  allGames: readonly SummaryRow[],
  kind: ExclusionKind,
  key: string
): { games: number; teams: number } {
  let games = 0;
  if (kind === "competition") {
    const teams = new Set<string>();
    for (const g of allGames) {
      if (canonicalCompetition(g.Competition) !== key) continue;
      games++;
      const h = canonicalTeam(g.home_team);
      const a = canonicalTeam(g.away_team);
      if (h) teams.add(h);
      if (a) teams.add(a);
    }
    return { games, teams: teams.size };
  }
  for (const g of allGames) {
    if (canonicalTeam(g.home_team) === key || canonicalTeam(g.away_team) === key) games++;
  }
  return { games, teams: games > 0 ? 1 : 0 };
}

/** Only admins and super admins can change exclusions (UI-level gate). */
export function canManageExclusions(role: string | null | undefined): boolean {
  return role === "admin" || role === "super_admin";
}
