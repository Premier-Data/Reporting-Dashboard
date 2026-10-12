// Match report for a Live Scores game.
//
// The Live Scores page shows PlayHQ fixtures (ids like "78454e3d"). The rich
// stat report for a finalised game lives in Premier Data's S3 bucket keyed by
// the internal JADE fixture uid (Reports{uid}.json). There's no direct PlayHQ→
// JADE id link, so we RESOLVE one by matching the game's teams + round + season
// against comp_fixtures (whose id embeds the JADE uid), then load + aggregate
// the report into team totals and a per-player table — the data the General /
// Efficiencies / Players tabs render.

import {
  getFixtureTimeline,
  statColumnsForSport,
} from "@/lib/api/fixtureReports";
import type { FixtureTimeline, PlayerStatLine } from "@/types/fixtureReport";
import { queryCompFixtures } from "@/lib/api/compFixtures";
import { normaliseClub } from "@/lib/api/clubLogos";
import { sides, type PlayHqGame } from "@/lib/api/playhq";

// AFL whole-game total lives in quarter 5 of each player's column breakdown.
const TOTAL_Q = 5 as const;

// ── Resolve a PlayHQ game → JADE fixture uid ────────────────────────────────

/** Pull the round number out of a round name ("Round 2" → 2; finals → null). */
function roundNumber(name: string | null | undefined): number | null {
  const m = String(name ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

type Gender = "men" | "women";

// Grade/gender filler words dropped when picking a search token (so we key on
// the distinctive club word, not "Men"/"Premier").
const TOKEN_FILLER = new Set([
  "men", "women", "mens", "womens", "premier", "league", "seniors", "senior",
  "reserves", "reserve", "grade", "division", "div", "the", "fc", "afc",
]);

/**
 * A distinctive, punctuation-safe search token from a team name, used to narrow
 * the comp_fixtures query. Taken from the RAW name split on non-letters (so
 * "St Mary's" → "mary", matching both "St Mary's" and "St Marys"), dropping
 * grade/gender filler, then the longest remaining ≥3-letter word. A pure-letter
 * token sidesteps apostrophes in ilike.
 */
function searchToken(name: string): string {
  const words = name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !TOKEN_FILLER.has(w));
  if (words.length === 0) {
    return name.replace(/[^A-Za-z]/g, "").slice(0, 4) || name;
  }
  return words.sort((a, b) => b.length - a.length)[0];
}

/**
 * Infer a fixture's gender from any descriptive strings (team names and/or
 * competition name). "Women"/"Womens"/"Ladies"/"Girls" → women; otherwise men
 * (the unmarked default in these feeds). `normaliseClub` strips the gender
 * suffix, so a men's and a women's game between the same clubs collapse to the
 * same key — this guard keeps them from cross-matching.
 */
function genderOf(...parts: Array<string | null | undefined>): Gender {
  const hay = parts.join(" ").toLowerCase();
  return /\b(women|womens|woman|ladies|girls|female)\b/.test(hay)
    ? "women"
    : "men";
}

/** Two team-name sets match if their normalised club names are equal. */
function teamsMatch(
  aHome: string,
  aAway: string,
  bHome: string,
  bAway: string
): boolean {
  const nh = normaliseClub(aHome);
  const na = normaliseClub(aAway);
  const bh = normaliseClub(bHome);
  const ba = normaliseClub(bAway);
  // Allow either orientation (home/away can be recorded flipped between feeds).
  return (nh === bh && na === ba) || (nh === ba && na === bh);
}

/**
 * Find the JADE fixture uid for a PlayHQ game by matching teams + round + year
 * against comp_fixtures. Returns null when no confident match exists (e.g. the
 * match isn't finalised / coded yet, so no report).
 */
export async function resolveJadeUidForGame(
  game: PlayHqGame
): Promise<number | null> {
  const { home, away } = sides(game);
  const homeName = home?.name ?? "";
  const awayName = away?.name ?? "";
  if (!homeName || !awayName) return null;

  const year = game.schedule?.date
    ? Number(game.schedule.date.slice(0, 4))
    : null;
  const rnd = roundNumber(game.round?.name);
  // The PlayHQ team names carry the gender suffix ("… Men Premier" / "… Women
  // Premier"); use it to avoid matching a men's game to the women's fixture
  // between the same clubs (and vice-versa), which otherwise collide because
  // normaliseClub strips the suffix.
  const gameGender = genderOf(homeName, awayName, game.round?.name);

  // Query comp_fixtures with a distinctive team-name token to keep the result
  // set small, then match precisely on normalised names + gender.
  const rows = await queryCompFixtures({
    season: year,
    search: searchToken(homeName),
  });

  const candidates = rows.filter(
    (r) =>
      teamsMatch(homeName, awayName, r.home_team, r.away_team) &&
      genderOf(r.competition, r.home_team, r.away_team) === gameGender
  );
  if (candidates.length === 0) return null;

  // The two clubs usually meet twice a season (home + away legs), so round is
  // the decider. Require an EXACT round match; only when a single candidate
  // exists do we accept it without a round match. Never guess between legs —
  // returning the wrong leg would show the wrong match's stats.
  const exact =
    rnd != null
      ? candidates.filter((r) => roundNumber(r.round) === rnd)
      : [];
  const chosen = exact[0] ?? (candidates.length === 1 ? candidates[0] : null);
  if (!chosen) return null;

  const uidPart = chosen.id.includes(":") ? chosen.id.split(":")[1] : "";
  const uid = Number(uidPart);
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}

// ── Aggregate a report into team totals ─────────────────────────────────────

/** A single comparable stat line for the General / Efficiencies tabs. */
export type TeamStatRow = {
  key: string;
  label: string;
  home: number;
  away: number;
  /** When true, render as a percentage (0–100) rather than a raw count. */
  percent?: boolean;
  /**
   * When true, a LOWER value is the better result (e.g. Frees Against,
   * turnovers). The comparison bar fills the lower side fully and shortens the
   * higher side proportionally. Defaults to higher-is-better.
   */
  lowerIsBetter?: boolean;
};

export type MatchReportTeam = {
  uid: number;
  name: string;
  players: PlayerStatLine[];
};

export type MatchReport = {
  fixtureId: number;
  round: string;
  venue: string;
  date: string;
  home: MatchReportTeam;
  away: MatchReportTeam;
  /** Team-total rows for the General tab (counting stats). */
  general: TeamStatRow[];
  /** Team-total efficiency rows (percentages). */
  efficiencies: TeamStatRow[];
  /** The player stat columns available (keys match PlayerStatLine.columns). */
  timeline: FixtureTimeline;
};

/** Sum a column's whole-game total across a list of players. */
function sumCol(players: PlayerStatLine[], key: string): number {
  let n = 0;
  for (const p of players) n += p.columns[key]?.[TOTAL_Q] ?? 0;
  return n;
}

/** Safe percentage (effective / total × 100), 0 when the denominator is 0. */
function pct(eff: number, total: number): number {
  return total > 0 ? Math.round((eff / total) * 100) : 0;
}

/**
 * Fetch + aggregate a fixture report into the match-report shape. `sport`
 * defaults to AFL (the Live Scores feature is NTFL/AFL only today).
 */
export async function getMatchReport(
  jadeUid: number | string,
  sport: string | null = "Australian Rules Football"
): Promise<MatchReport> {
  const timeline = await getFixtureTimeline(jadeUid, {
    sport,
    cache: "force-cache",
  });
  const { meta, players } = timeline;

  const homePlayers = players.filter((p) => p.teamUid === meta.homeTeamUid);
  const awayPlayers = players.filter((p) => p.teamUid === meta.awayTeamUid);

  const col = (key: string) => ({
    home: sumCol(homePlayers, key),
    away: sumCol(awayPlayers, key),
  });

  const rp = col("rp");
  const g = col("g");
  const b = col("b");
  const rb = col("rb");
  const d = col("d");
  const k = col("k");
  const hb = col("hb");
  const m = col("m");
  const t = col("t");
  const ci = col("ci");
  const i50 = col("i50");
  const cp = col("cp");
  const ho = col("ho");
  const ff = col("ff");
  const fa = col("fa");

  // Effective counts (for efficiency %s).
  const de = col("de");
  const ke = col("ke");
  const hbe = col("hbe");
  const cie = col("cie");

  const general: TeamStatRow[] = [
    { key: "rp", label: "Ranking Points", ...rp },
    { key: "g", label: "Goals", ...g },
    { key: "rb", label: "Rushed Behinds", ...rb },
    { key: "b", label: "Behinds", ...b },
    { key: "d", label: "Disposals", ...d },
    { key: "k", label: "Kicks", ...k },
    { key: "hb", label: "Handballs", ...hb },
    { key: "m", label: "Marks", ...m },
    { key: "t", label: "Tackles", ...t },
    { key: "ci", label: "Clearances", ...ci },
    { key: "i50", label: "Inside 50s", ...i50 },
    { key: "cp", label: "Contested Possessions", ...cp },
    { key: "ho", label: "Hit Outs", ...ho },
    { key: "ff", label: "Frees For", ...ff },
    { key: "fa", label: "Frees Against", ...fa, lowerIsBetter: true },
  ];

  const efficiencies: TeamStatRow[] = [
    {
      key: "de",
      label: "Disposal Efficiency",
      home: pct(de.home, d.home),
      away: pct(de.away, d.away),
      percent: true,
    },
    {
      key: "ke",
      label: "Kicking Efficiency",
      home: pct(ke.home, k.home),
      away: pct(ke.away, k.away),
      percent: true,
    },
    {
      key: "hbe",
      label: "Handball Efficiency",
      home: pct(hbe.home, hb.home),
      away: pct(hbe.away, hb.away),
      percent: true,
    },
    {
      key: "cie",
      label: "Clearance Efficiency",
      home: pct(cie.home, ci.home),
      away: pct(cie.away, ci.away),
      percent: true,
    },
    {
      key: "goalAcc",
      label: "Goal Accuracy",
      home: pct(g.home, g.home + b.home),
      away: pct(g.away, g.away + b.away),
      percent: true,
    },
  ];

  // Players sorted by ranking points (desc) — matches the app's default order.
  const sortByRp = (list: PlayerStatLine[]) =>
    [...list].sort(
      (a, b2) =>
        (b2.columns.rp?.[TOTAL_Q] ?? 0) - (a.columns.rp?.[TOTAL_Q] ?? 0)
    );

  return {
    fixtureId: Number(meta.uid),
    round: meta.round,
    venue: meta.venue,
    date: meta.fixtureDate,
    home: {
      uid: meta.homeTeamUid,
      name: meta.homeTeamName,
      players: sortByRp(homePlayers),
    },
    away: {
      uid: meta.awayTeamUid,
      name: meta.awayTeamName,
      players: sortByRp(awayPlayers),
    },
    general,
    efficiencies,
    timeline,
  };
}

/**
 * Convenience: resolve a PlayHQ game to its report in one call. Returns null
 * when the game can't be matched to a coded fixture (no report yet).
 */
export async function getMatchReportForGame(
  game: PlayHqGame
): Promise<MatchReport | null> {
  const uid = await resolveJadeUidForGame(game);
  if (uid == null) return null;
  return getMatchReport(uid);
}

/** The per-player DE% for the Players table (effective / total disposals). */
export function playerDePercent(p: PlayerStatLine): number {
  const d = p.columns.d?.[TOTAL_Q] ?? 0;
  const de = p.columns.de?.[TOTAL_Q] ?? 0;
  return pct(de, d);
}

/** Expose the player column defs (label/title) for the Players table header. */
export const PLAYER_TABLE_COLUMNS = statColumnsForSport("afl");
