// Name normalisers for the Competitions summary dashboard.
// Competition names in older sheets carry the season in the name
// (e.g. "PSA 2022", "2026-27 TIO NTFL Men Premier League"); for tallies those
// are the same competition as "PSA" / "TIO NTFL Men Premier League".

const YEAR = "(?:19|20)\\d{2}";
// 2022, 2022-23, 2022/23, 2022-2023
const SEASON = `${YEAR}(?:\\s*[-/\\u2013]\\s*(?:${YEAR}|\\d{2}))?`;
const SEP = "[\\s,\\-\\u2013]";

// Bracketed token at the end (separator optional), or bare token after a separator.
const TRAILING = new RegExp(
  `(?:${SEP}*[\\(\\[]\\s*${SEASON}\\s*[\\)\\]]|${SEP}+${SEASON}|(?<=[A-Za-z])${YEAR})$`
);
// Token at the start, followed by a separator (so "2026-27 TIO ..." but not "2026TIO").
const LEADING = new RegExp(
  `^(?:[\\(\\[]\\s*${SEASON}\\s*[\\)\\]]|${SEASON})(?!\\d)${SEP}*[:\\s,\\-\\u2013]+(?=\\S)`
);

/** Collapses all whitespace (incl. NBSP) and trims. */
export function collapseSpaces(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Display form: whitespace collapsed and a leading/trailing season token removed. */
export function stripCompetitionYear(name: string | null | undefined): string {
  const base = collapseSpaces(name);
  let out = base.replace(TRAILING, "").trim();
  out = out.replace(LEADING, "").trim();
  // A name that is only a year stays as it was.
  return out === "" ? base : out;
}

/** Grouping key: year-stripped and case-insensitive. Empty string for blank names. */
export function canonicalCompetition(name: string | null | undefined): string {
  return stripCompetitionYear(name).toLowerCase();
}

/** Display form of a team: whitespace collapsed, a literal trailing 20xx year removed. */
export function stripTeamYear(name: string | null | undefined): string {
  const base = collapseSpaces(name);
  const out = base.replace(/\s+20\d{2}$/, "").trim();
  return out === "" ? base : out;
}

/**
 * Practice / pre-season matches are not counted on the Competitions page.
 * Matches "Practice" (or the "Practise" spelling) as a whole word, any case,
 * anywhere in the name: "NGA Practice", "Practice Kilsyth", "VAFA Practice 2025".
 */
export function isPracticeCompetition(name: string | null | undefined): boolean {
  return /\bpracti[cs]e\b/i.test(collapseSpaces(name));
}

/** Grouping key for a team: case-insensitive, whitespace collapsed. */
export function canonicalTeam(name: string | null | undefined): string {
  return stripTeamYear(name).toLowerCase();
}
