// Pull the full stat timeline for a fixture from Premier Data's public S3
// bucket. Report JSON lives at a predictable, keyed-by-fixture-id path:
//
//   s3://premierdata01/JSON/Fixture/Reports{FixtureID}.json
//
// The bucket serves these objects publicly over HTTPS, so we fetch by URL and
// need no AWS SDK or credentials. The event timeline is the top-level
// `allStatistics` array (one on-field action per element); this module fetches
// the report, validates it, and returns a chronologically sorted timeline plus
// fixture metadata.

import type {
  FixtureReport,
  FixtureStatEvent,
  FixtureTimeline,
  FixtureMeta,
  PlayerStatLine,
  StatQuarter,
  RawPlayerStats,
} from "@/types/fixtureReport";
import { isExcludedStatLabel } from "@/lib/comparison/json-adapter";

// One Player Stats column. `key` is the stable id, `label`/`title` for display,
// `statTypes` the JADE statType(s) in allPlayerStats[].allStatistics to sum for
// this column, and `group` the tab it belongs to (soccer splits columns into
// groups; AFL uses a single "afl" group).
export interface StatColumn {
  key: string;
  label: string;
  title: string;
  statTypes: string[];
  group: string;
}

// Which quarter index holds the whole-game TOTAL, per sport. AFL codes 4
// quarters with quarter 5 = total; Soccer codes 2 halves with quarter 3 = total.
export const TOTAL_QUARTER: Record<string, number> = {
  afl: 5,
  soccer: 3,
};

// ── AFL columns (unchanged — the JADE software's Player Stats view) ────────
const AFL_COLUMNS: StatColumn[] = [
  { key: "k", label: "K", title: "Kicks", statTypes: ["Kick"], group: "afl" },
  { key: "hb", label: "HB", title: "Handballs", statTypes: ["Handball"], group: "afl" },
  { key: "d", label: "D", title: "Disposals", statTypes: ["Disposal"], group: "afl" },
  { key: "cp", label: "CP", title: "Contested Possessions", statTypes: ["ContestedDisposal"], group: "afl" },
  { key: "m", label: "M", title: "Marks", statTypes: ["Mark"], group: "afl" },
  { key: "i50", label: "I50", title: "Inside 50s", statTypes: ["Inside50"], group: "afl" },
  { key: "r50", label: "R50", title: "Rebound 50s", statTypes: ["Rebound50"], group: "afl" },
  { key: "onePct", label: "1%", title: "One Percenters", statTypes: ["Percenter"], group: "afl" },
  { key: "t", label: "T", title: "Tackles", statTypes: ["Tackle"], group: "afl" },
  { key: "ci", label: "CI", title: "Clearances", statTypes: ["Clearance"], group: "afl" },
  { key: "g", label: "G", title: "Goals", statTypes: ["Goal"], group: "afl" },
  { key: "b", label: "B", title: "Behinds", statTypes: ["Behind"], group: "afl" },
  { key: "rb", label: "RB", title: "Rushed Behinds", statTypes: ["RushedBehind"], group: "afl" },
  { key: "de", label: "D✓", title: "Effective Disposals", statTypes: ["DisposalEffective"], group: "afl" },
  { key: "ke", label: "K✓", title: "Effective Kicks", statTypes: ["KickEffective"], group: "afl" },
  { key: "hbe", label: "HB✓", title: "Effective Handballs", statTypes: ["HandballEffective"], group: "afl" },
  { key: "cie", label: "CI✓", title: "Effective Clearances", statTypes: ["ClearanceEffective"], group: "afl" },
  { key: "ho", label: "HO", title: "Hit Outs", statTypes: ["HitOut"], group: "afl" },
  { key: "ff", label: "FF", title: "Frees For", statTypes: ["FreeKickFor"], group: "afl" },
  { key: "fa", label: "FA", title: "Frees Against", statTypes: ["FreeKickAgainst"], group: "afl" },
  { key: "rp", label: "RP", title: "Ranking Points", statTypes: ["RankingPoints"], group: "afl" },
];

// ── Soccer columns, mapped to real JADE soccer statTypes (verified against a
// real report). Two groups mirroring the software: "basic" (attacking / on-ball)
// and "involvements" (defensive / keeper). Columns with no backing statType
// (Key Passes, Passes into Final Third / Penalty Area) are omitted — that data
// isn't in the feed. Summed columns (Shots, duels, Successful Passes) add their
// component statTypes.
const SOCCER_COLUMNS: StatColumn[] = [
  // Basic
  { key: "g", label: "G", title: "Goals", statTypes: ["Goal"], group: "basic" },
  { key: "a", label: "A", title: "Assists", statTypes: ["Assist"], group: "basic" },
  {
    key: "sh",
    label: "SH",
    title: "Shots",
    statTypes: ["ShotOnTarget", "ShotOffTarget", "ShotBlocked", "ShotSaved"],
    group: "basic",
  },
  { key: "sot", label: "SOT", title: "Shots on Target", statTypes: ["ShotOnTarget"], group: "basic" },
  {
    key: "passSucc",
    label: "Pass ✓",
    title: "Successful Passes",
    statTypes: ["ShortPassEffective", "LongPassEffective"],
    group: "basic",
  },
  {
    key: "dribbles",
    label: "Drib",
    title: "Dribbles",
    statTypes: ["Dribble"],
    group: "basic",
  },
  {
    key: "groundDuels",
    label: "GD",
    title: "Ground Duels",
    statTypes: ["GroundDuelWin", "GroundDuelLoss"],
    group: "basic",
  },
  {
    key: "aerialDuels",
    label: "AD",
    title: "Aerial Duels",
    statTypes: ["AerialWin", "AerialLoss"],
    group: "basic",
  },
  // Involvements (defensive / keeper)
  { key: "tackles", label: "Tkl", title: "Tackles", statTypes: ["Tackle"], group: "involvements" },
  { key: "tacklesSucc", label: "Tkl ✓", title: "Tackles Successful", statTypes: ["TackleEffective"], group: "involvements" },
  { key: "intercepts", label: "Int", title: "Intercepts", statTypes: ["Intercept"], group: "involvements" },
  { key: "clearances", label: "Clr", title: "Clearances", statTypes: ["Clearance"], group: "involvements" },
  { key: "blocks", label: "Blk", title: "Blocks", statTypes: ["Block"], group: "involvements" },
  { key: "ballRecovery", label: "Rec", title: "Ball Recoveries", statTypes: ["BallRecovery"], group: "involvements" },
  { key: "saves", label: "Sv", title: "Saves", statTypes: ["Save"], group: "involvements" },
  { key: "punches", label: "Pun", title: "Punches", statTypes: ["Punch"], group: "involvements" },
];

// Resolve the column set for a sport. Anything not Soccer defaults to AFL
// (the platform is overwhelmingly Aussie Rules).
export function statColumnsForSport(sport: string | null | undefined): StatColumn[] {
  return isSoccer(sport) ? SOCCER_COLUMNS : AFL_COLUMNS;
}

// The total-quarter index for a sport (AFL=5, Soccer=3).
export function totalQuarterForSport(sport: string | null | undefined): number {
  return isSoccer(sport) ? TOTAL_QUARTER.soccer : TOTAL_QUARTER.afl;
}

function isSoccer(sport: string | null | undefined): boolean {
  return (sport ?? "").trim().toLowerCase() === "soccer";
}

// Backwards-compatible export: existing importers of STAT_COLUMNS get the AFL
// set (the default). New sport-aware callers use statColumnsForSport().
export const STAT_COLUMNS: StatColumn[] = AFL_COLUMNS;

// Region-qualified public bucket host. If Premier Data ever fronts these files
// with a CDN or a different bucket, this is the single place to change.
const FIXTURE_REPORT_BASE =
  "https://premierdata01.s3.ap-southeast-2.amazonaws.com/JSON/Fixture";

/** Build the public S3 URL for a fixture's report JSON. */
export function fixtureReportUrl(fixtureId: number | string): string {
  return `${FIXTURE_REPORT_BASE}/Reports${fixtureId}.json`;
}

// Narrow the meta fields off a raw report into a typed FixtureMeta. Kept
// separate so both the timeline result and any metadata-only caller can reuse
// it. Missing fields fall back to sensible empties rather than throwing — the
// timeline is still useful without, say, a venue.
function extractMeta(report: FixtureReport): FixtureMeta {
  return {
    uid: Number(report.uid),
    homeTeamName: report.homeTeamName ?? "",
    awayTeamName: report.awayTeamName ?? "",
    homeTeamUid: Number(report.homeTeamUid ?? 0),
    awayTeamUid: Number(report.awayTeamUid ?? 0),
    competitionUid: Number(report.competitionUid ?? 0),
    fixtureDate: report.fixtureDate ?? "",
    fixtureTime: report.fixtureTime ?? "",
    round: report.round ?? "",
    venue: report.venue ?? "",
    isFinal: Boolean(report.isFinal),
    isLive: Boolean(report.isLive),
    isStarted: Boolean(report.isStarted),
  };
}

// Chronological order: quarter first, then relativeTime within the quarter.
// relativeTime is already whole-game seconds in the sampled data, but sorting
// by quarter first keeps events correct even if a fixture ever resets the
// clock per quarter.
function byChronology(a: FixtureStatEvent, b: FixtureStatEvent): number {
  if (a.quarter !== b.quarter) return a.quarter - b.quarter;
  return a.relativeTime - b.relativeTime;
}

/**
 * Turn a raw fixture report object into a sorted timeline. Exposed separately
 * from the fetch so it can be unit-tested and reused on already-loaded reports
 * (e.g. a locally cached file). Tolerates a missing/!array `allStatistics` by
 * treating it as an empty timeline.
 */
// JADE exports some events twice: the real event, plus a "mirror" record whose
// uid is the real uid + this offset (e.g. 20001 and 320001). The mirror is a
// re-coded companion (different statTypeCode/errorReason) that maps to the same
// display name, so it shows up as a visible duplicate in the timeline. We drop
// any event whose uid is >= the offset AND whose (uid - offset) also exists in
// the report — that's the confirmed signature of a mirror. Genuine events with
// naturally large uids (no low twin) are kept.
const MIRROR_UID_OFFSET = 300000;

function dropMirrorDuplicates(
  events: FixtureStatEvent[]
): FixtureStatEvent[] {
  const lowUids = new Set<number>();
  for (const e of events) {
    const uid = Number(e.uid);
    if (uid < MIRROR_UID_OFFSET) lowUids.add(uid);
  }
  return events.filter((e) => {
    const uid = Number(e.uid);
    if (uid >= MIRROR_UID_OFFSET && lowUids.has(uid - MIRROR_UID_OFFSET)) {
      return false; // mirror of a real event → drop
    }
    return true;
  });
}

// Build per-player stat lines from allPlayerStats. For each player we read the
// STAT_COLUMNS statTypes and index their per-quarter scores (quarter 5 = game
// total). A stat/quarter not present defaults to 0.
function parsePlayerStats(
  report: FixtureReport,
  sport: string | null | undefined
): PlayerStatLine[] {
  const raw = report.allPlayerStats ?? [];
  const columnsDef = statColumnsForSport(sport);

  // statType -> list of column keys it contributes to (a statType can feed
  // more than one column, and a column can sum several statTypes).
  const statToCols = new Map<string, string[]>();
  for (const c of columnsDef) {
    for (const st of c.statTypes) {
      const arr = statToCols.get(st) ?? [];
      arr.push(c.key);
      statToCols.set(st, arr);
    }
  }

  const lines: PlayerStatLine[] = [];
  for (const p of raw) {
    if (!p || p.playerUid == null) continue;

    // Zeroed columns for every tracked column and quarter 1–5 (soccer only
    // uses 1–3, but keeping 1–5 keeps the shape uniform).
    const columns: Record<string, Record<StatQuarter, number>> = {};
    for (const c of columnsDef) {
      columns[c.key] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    }

    for (const entry of (p as RawPlayerStats).allStatistics ?? []) {
      const colKeys = statToCols.get(entry.statType);
      if (!colKeys) continue;
      const q = Number(entry.quarter) as StatQuarter;
      if (q < 1 || q > 5) continue;
      const score = Number(entry.score) || 0;
      // ADD (not set) so summed columns accumulate their component statTypes.
      for (const colKey of colKeys) columns[colKey][q] += score;
    }

    lines.push({
      playerUid: Number(p.playerUid),
      playerNumber: Number(p.playerNumber ?? 0),
      playerName: p.playerName ?? "",
      teamUid: Number(p.teamUid ?? 0),
      teamName: p.teamName ?? "",
      columns,
    });
  }
  return lines;
}

export function toFixtureTimeline(
  report: FixtureReport,
  sport?: string | null
): FixtureTimeline {
  // Build a playerUid → jumper number lookup from the participants list. Stat
  // events carry no number of their own, so this join is the only way to show
  // it. Guard against missing/partial participant data.
  const numberByUid = new Map<number, number>();
  for (const p of report.allParticipants ?? []) {
    if (p && p.playerUid && p.playerNumber != null) {
      numberByUid.set(Number(p.playerUid), Number(p.playerNumber));
    }
  }

  const raw = Array.isArray(report.allStatistics)
    ? report.allStatistics
    : [];

  const events = dropMirrorDuplicates(raw)
    // Drop non-action markers (subs, Start/End Half, pitch zones) so they never
    // appear in the timeline/pitch (matches the comparison adapter).
    .filter((e) => !isExcludedStatLabel(e.statTypeCode, e.statTypeName))
    // Copy is implicit (filter returns a new array). Attach the joined jumper
    // number to each event, then sort chronologically.
    .map((e) => ({
      ...e,
      playerNumber: numberByUid.get(Number(e.playerUid)) ?? null,
    }))
    .sort(byChronology);

  return {
    fixtureId: Number(report.uid),
    meta: extractMeta(report),
    events,
    eventCount: events.length,
    players: parsePlayerStats(report, sport),
    sport: sport ?? null,
  };
}

/** Options for fetching a fixture report. */
export interface FetchFixtureReportOptions {
  /**
   * Passed straight to fetch. Defaults to "no-store" so callers get live data;
   * pass "force-cache" (or use a Route Handler's revalidate) when the fixture
   * is final and its report won't change.
   */
  cache?: RequestCache;
  /** Optional AbortSignal for cancellation / timeouts. */
  signal?: AbortSignal;
  /**
   * Sport of the fixture (e.g. "Soccer", "Australian Rules Football"). Selects
   * the Player Stats column set + total-quarter. The report itself carries no
   * sport field, so the caller supplies it (from comp_fixtures). Defaults to
   * AFL when omitted.
   */
  sport?: string | null;
}

/**
 * Fetch a fixture's raw report JSON from S3. Throws on a network error, a
 * non-2xx response (404 = no report for that fixture id), or invalid JSON.
 */
export async function fetchFixtureReport(
  fixtureId: number | string,
  options: FetchFixtureReportOptions = {}
): Promise<FixtureReport> {
  const { cache = "no-store", signal } = options;
  const url = fixtureReportUrl(fixtureId);

  const response = await fetch(url, { cache, signal });

  if (!response.ok) {
    throw new Error(
      `Failed to load fixture report ${fixtureId} (HTTP ${response.status}) from ${url}`
    );
  }

  // The bucket returns application/json but we parse defensively so a truncated
  // or non-JSON body produces a clear error rather than a confusing crash.
  const data = (await response.json()) as FixtureReport;

  if (!data || typeof data !== "object" || data.uid == null) {
    throw new Error(
      `Fixture report ${fixtureId} did not contain a valid report object`
    );
  }

  return data;
}

/**
 * Resolve a fixture's report, preferring a saved OVERRIDE (edited timeline in
 * Supabase) over the original S3 file. Falls back to S3 when there's no
 * override. Returns the report plus a flag indicating which source was used.
 */
export async function resolveFixtureReport(
  fixtureId: number | string,
  options: FetchFixtureReportOptions & { preferOverride?: boolean } = {}
): Promise<{ report: FixtureReport; source: "override" | "s3" }> {
  if (options.preferOverride !== false) {
    // Lazy import avoids pulling the Supabase client into callers that only
    // ever read S3, and sidesteps any import-order concerns.
    const { getFixtureOverride } = await import("./fixtureOverrides");
    const override = await getFixtureOverride(fixtureId);
    if (override?.report) {
      return { report: override.report, source: "override" };
    }
  }
  const report = await fetchFixtureReport(fixtureId, options);
  return { report, source: "s3" };
}

/**
 * Fetch a fixture's report and return its full stat timeline (chronologically
 * sorted) plus fixture metadata. This is the primary entry point for "pull the
 * full timeline for a fixture". Prefers a saved override over the S3 original
 * (pass preferOverride: false to force the raw S3 file).
 */
export async function getFixtureTimeline(
  fixtureId: number | string,
  options: FetchFixtureReportOptions & { preferOverride?: boolean } = {}
): Promise<FixtureTimeline> {
  const { report } = await resolveFixtureReport(fixtureId, options);
  return toFixtureTimeline(report, options.sport);
}
