/**
 * "PREMIER DATA" is a placeholder name recorded in Deputy shifts and
 * TT_Games when a shift or game was jointly handled by multiple analysts
 * rather than a single individual. It is not a real analyst and must be
 * excluded from every page that ranks, scores, lists, or attributes work
 * to analysts (Leaderboard, Analyst Profile, Analyst Compare,
 * Recommendations, Reporting).
 *
 * Matching is case/whitespace insensitive so variants like "Premier Data",
 * "premier  data" or trailing spaces are all caught.
 */

const EXCLUDED_ANALYST_NAMES = ["premier data"];

function normalise(name: string): string {
  return name
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isExcludedAnalystName(
  name: string | null | undefined
): boolean {
  if (!name) return false;

  return EXCLUDED_ANALYST_NAMES.includes(normalise(name));
}
