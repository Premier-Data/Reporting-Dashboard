// JSON-event -> Instance adapter for the accuracy comparison engine.
//
// The comparison engine (see xml-compare.ts) matches two sets of `Instance`
// records built from SportsCode XML. A separate data source provides the same
// coded events as JSON, e.g.:
//
//   {
//     "uid": 1123,
//     "quarter": 1,
//     "relativeTime": 2795,          // the actual moment of the action
//     "statTypeCode": "Carry",       // -> category
//     "statTypeName": "Carry",       // -> stat
//     "playerName": "Jacob Maddox",
//     "playerNumber": 8,             // -> playerNumber
//     "teamName": "Merthyr Town FC", // -> team (raw; canonicalised later)
//     "teamUid": 2,                  // 1 = home, 2 = away (authoritative)
//     "startWidth": 100,
//     "startHeight": 100
//   }
//
// This adapter converts those JSON events into the SAME `Instance` shape the
// XML parser emits, so they flow through `compareInstances` unchanged — all
// the matching, tolerance and accuracy logic stays in one place.
//
// Confirmed against a real Chester FC vs Merthyr Town FC feed + master XML:
//   - `relativeTime` is WHOLE-MATCH SECONDS (it keeps climbing across the
//     quarter boundary, e.g. Q1 ends ~2828s, Q2 starts ~2836s), so no
//     per-quarter offset is needed.
//   - `relativeTime` lines up with the XML instance <start> (e.g. feed event
//     at 5877s == XML instance start 5877/end 5887), so it maps to `start`;
//     the engine derives the code-time `mid` from start/end via codeTime().
//   - stat detail lives in `statTypeCode` (statTypeName is coarse, e.g.
//     "Pass"), so matching is driven by the code -> STAT_CODE_MAP.
//
// These remain configurable via JsonAdapterOptions for other feeds that may
// differ (getting the time base wrong silently shifts events out of the match
// tolerance).

import {
  type Instance,
  buildCode,
  codeTime,
} from "./xml-compare";

/** A single coded event as delivered by the JSON feed. */
export type JsonEvent = {
  uid: number | string;
  /** Period marker (1-based). Used with quarterOffsets to build a match clock. */
  quarter?: number;
  /** The actual moment of the action, in the feed's own time unit/base. */
  relativeTime: number;
  /** Stat category code, e.g. "Carry". */
  statTypeCode?: string;
  /** Human stat name, e.g. "Carry". Mapped to a canonical stat label. */
  statTypeName: string;
  playerName?: string;
  playerNumber?: number | null;
  /**
   * Player identity. The raw S3 stat events carry NO jersey number, only a
   * `playerUid`; the number is joined from the report's `allParticipants` via
   * JsonAdapterOptions.playerNumberByUid.
   */
  playerUid?: number;
  teamName?: string;
  /** Team identity. Conventionally 1 = home, 2 = away. */
  teamUid?: number;
  /** Pitch coordinates (unused by the matcher; carried through if needed). */
  startWidth?: number;
  startHeight?: number;
};

export type JsonAdapterOptions = {
  /**
   * Unit of `relativeTime`. The comparison engine works in SECONDS, so ms
   * inputs are divided by 1000. Default: "seconds".
   */
  timeUnit?: "seconds" | "milliseconds";

  /**
   * playerUid -> jersey number, built from the report's `allParticipants`.
   * The raw S3 stat events have no number of their own, so this join is the
   * only way to attach it. Used when the event's own `playerNumber` is absent.
   */
  playerNumberByUid?: Map<number, number>;

  /**
   * Seconds to ADD to `relativeTime` for each quarter, keyed by the `quarter`
   * value, to build a single whole-match clock. Only needed when the feed's
   * `relativeTime` RESETS each period. Example (20-min quarters, in seconds):
   *   { 1: 0, 2: 1200, 3: 2400, 4: 3600 }
   * If omitted, `relativeTime` is treated as already being a whole-match time.
   */
  quarterOffsets?: Record<number, number>;

  /**
   * How to interpret `relativeTime`:
   *   - "start-marker" (DEFAULT): it equals the XML instance <start>. The
   *     code-time `mid` is derived with the XML's codeTime() so stat offsets
   *     (corner +5s, throw-in +7s, …) match the master. This is correct for the
   *     confirmed Chester/Merthyr feed.
   *   - "code-time": it is already the true moment of the action; use it
   *     directly as `mid` with no offset. For feeds that pre-resolve timing.
   */
  timeSemantics?: "code-time" | "start-marker";

  /**
   * Map a raw event to the canonical stat label used by the XML and the
   * STAT_PREFERENCES tables (all lowercased there via normStat). Receives both
   * the coarse `statTypeName` and the detailed `statTypeCode`; the detail
   * lives in the CODE (e.g. "ShortPassEffective"), so prefer it. If omitted,
   * `defaultMapStatName` is used (code-driven, see STAT_CODE_MAP).
   */
  mapStatName?: (statTypeName: string, statTypeCode?: string) => string;

  /**
   * Map an event to the category (the XML `<label><group>`, e.g. "Passing").
   * Defaults to the (mapped) stat label, since the feed's `statTypeCode` is
   * consumed for the fine-grained stat, not the category.
   */
  mapCategory?: (event: JsonEvent, mappedStat: string) => string;
};

/**
 * Build a playerUid -> jersey number map from a report's `allParticipants`.
 * Raw stat events carry no number, so this join is how the number is attached.
 * Pass the result as JsonAdapterOptions.playerNumberByUid.
 */
export function playerNumberMapFromReport(report: {
  allParticipants?: {
    playerUid?: number | null;
    playerNumber?: number | null;
  }[];
}): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of report?.allParticipants ?? []) {
    if (p && p.playerUid != null && p.playerNumber != null) {
      m.set(Number(p.playerUid), Number(p.playerNumber));
    }
  }
  return m;
}

/**
 * True when an event is a substitution (roster change), identified by the
 * native code "Substitute" / name "Substitution". These are not coded on-field
 * actions, so they're excluded from every comparison and timeline — a sub's
 * timestamp must never count toward accuracy or appear in the event list.
 * Shared so the comparison adapter and the fixture timeline filter identically.
 */
export function isSubstitutionEvent(
  statTypeCode?: string | null,
  statTypeName?: string | null
): boolean {
  const code = (statTypeCode ?? "").trim().toLowerCase();
  const name = (statTypeName ?? "").trim().toLowerCase();
  return code === "substitute" || name === "substitution";
}

// Non-action markers excluded from EVERY comparison and timeline (lowercased
// for matching). These are match administration / pitch-zone markers, not
// coded on-field actions, so they must not appear in the accuracy-by-stat-
// category table or count toward accuracy:
//   - half markers: Start Half / End Half (StartHalf / EndHalf)
//   - pitch zones:  Back / Middle / Front / Penalty Box
const EXCLUDED_STAT_LABELS = new Set([
  "substitution",
  "substitute",
  "start half",
  "starthalf",
  "end half",
  "endhalf",
  // Pitch zones — the feed/XML name them "Back/Middle/Front Third" and
  // "Penalty Box" (codes BackThird/MiddleThird/FrontThird/PenaltyBox).
  "back third",
  "backthird",
  "middle third",
  "middlethird",
  "front third",
  "frontthird",
  "penalty box",
  "penaltybox",
]);

/**
 * True when a stat/category label is a non-action marker (substitution, half
 * marker, or pitch zone) that should be excluded from all comparisons and
 * timelines. Checks any of the provided label strings (stat name, code, or
 * category) so both the JSON feed and XML masters are covered.
 */
export function isExcludedStatLabel(
  ...labels: (string | null | undefined)[]
): boolean {
  for (const l of labels) {
    const v = (l ?? "").trim().toLowerCase();
    if (v && EXCLUDED_STAT_LABELS.has(v)) return true;
  }
  return false;
}

/**
 * Convert one JSON event into the whole-match code time (seconds), applying
 * the unit conversion and per-quarter offset. Returns NaN if relativeTime is
 * not a finite number (such events are dropped by jsonEventsToInstances).
 */
function eventTime(ev: JsonEvent, opts: JsonAdapterOptions): number {
  const raw = ev.relativeTime;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return NaN;
  const inSeconds = opts.timeUnit === "milliseconds" ? raw / 1000 : raw;
  const offset =
    ev.quarter != null && opts.quarterOffsets
      ? opts.quarterOffsets[ev.quarter] ?? 0
      : 0;
  return inSeconds + offset;
}

/**
 * Convert JSON events into the `Instance[]` shape consumed by
 * `compareInstances`. Events with a non-finite `relativeTime` are skipped
 * (mirrors the XML parser dropping instances with NaN start). Instances are
 * returned sorted by code time, matching parseInstances' output order.
 *
 * TIME SEMANTICS (critical for matching):
 * `relativeTime` corresponds to the XML instance <start>. The feed has no
 * separate lead/lag window, so end = start. The code-time `mid` — which the
 * matcher actually compares — is then computed with the SAME `codeTime()` the
 * XML parser uses, so stat-specific offsets (corners +5s, throw-ins +7s, etc.;
 * goals use the window midpoint with no fixed offset) are applied identically
 * on both sides. Skipping this
 * would push offset stats (corners, throw-ins…) out of tolerance
 * against the master XML.
 */
export function jsonEventsToInstances(
  events: JsonEvent[],
  opts: JsonAdapterOptions = {}
): Instance[] {
  const instances: Instance[] = [];

  for (const ev of events) {
    // Exclude non-action markers (substitutions, Start/End Half, pitch zones)
    // from every comparison timeline so they never count toward accuracy.
    if (isExcludedStatLabel(ev.statTypeCode, ev.statTypeName)) continue;

    const start = eventTime(ev, opts);
    if (Number.isNaN(start)) continue;

    const stat = opts.mapStatName
      ? opts.mapStatName(ev.statTypeName, ev.statTypeCode)
      : defaultMapStatName(ev.statTypeName, ev.statTypeCode);
    const category = opts.mapCategory
      ? opts.mapCategory(ev, stat)
      : defaultMapCategory(ev.statTypeCode, stat);

    const team = (ev.teamName ?? "").trim();
    // Prefer the event's own number; else join playerUid -> number from the
    // participants map (raw S3 events carry no jersey number of their own).
    const playerNumber =
      typeof ev.playerNumber === "number"
        ? ev.playerNumber
        : ev.playerUid != null && opts.playerNumberByUid
          ? opts.playerNumberByUid.get(Number(ev.playerUid)) ?? null
          : null;
    const playerRaw = ev.playerName?.trim() ?? "";

    // Build a code string in the same "<Team> - #<n>. <name>" convention the
    // XML uses, so anything that re-derives fields from `code` stays valid.
    const code = buildCode(team, playerNumber, playerRaw);

    // No lead/lag window in the feed: end == start. Derive the code-time the
    // same way the XML side does so both align (offsets applied identically).
    // When timeSemantics is "code-time", relativeTime IS already the code time
    // (some feeds provide the true moment), so use it directly as mid.
    const end = start;
    const mid =
      opts.timeSemantics === "code-time"
        ? start
        : codeTime(stat.trim(), start, end);

    instances.push({
      id: String(ev.uid ?? crypto.randomUUID()),
      start,
      end,
      mid,
      team,
      playerNumber,
      playerRaw,
      stat: stat.trim(),
      category: category.trim(),
      code,
    });
  }

  instances.sort((a, b) => a.mid - b.mid);
  return instances;
}

// ---------------------------------------------------------------------------
// statTypeCode -> canonical XML stat label
// ---------------------------------------------------------------------------
//
// IMPORTANT: the JSON feed carries the reliable stat detail in `statTypeCode`
// (e.g. "ShortPassEffective"), NOT `statTypeName` (which is coarse, e.g.
// "Pass" for every pass variant). The comparison engine's STAT_PREFERENCES
// tables (xml-compare.ts) are keyed on the fine-grained XML labels such as
// "short passes successful", so matching MUST be driven by the code.
//
// Observed code pattern: {Length}{Type}{Effective|Ineffective}, e.g.
//   ShortPassEffective   -> "Short Passes Successful"
//   ShortPassIneffective -> "Short Passes Unsuccessful"
//   LongPassEffective    -> "Long Passes Successful"
//
// NOTE on the XML's spelling quirk: crosses use the source misspelling
// "unsuccesful" (single 's') — see STAT_PREFERENCES. That's why crosses get an
// explicit entry below rather than going through the generic pass builder.
//
// This map is intentionally small and covers only what the samples confirm.
// Extend it as the full `statTypeCode` vocabulary is provided; unknown codes
// fall back to a de-camel-cased version of the code so they remain legible
// (and will simply not pair unless they happen to match an XML label).

// Each entry maps a lowercased statTypeCode to [canonical stat, category].
// The canonical stat MUST match the label the XML uses (and the keys in
// STAT_PREFERENCES) or comparable events won't pair. Where the source data
// misspells a word (e.g. "Unsuccesful", "Recoverys"), the XML keeps that
// spelling, so we reproduce it EXACTLY here.
//
// The `stat` and `category` values below are the EXACT `<text>`/`<group>`
// strings used by the master XML (verified against the Chester FC vs Merthyr
// Town FC master: National League North 2026_08). The XML groups its stats
// under just a handful of categories — "Passing", "General Play", "Event",
// "Goal Keeper", "Shots" — so those (not per-stat categories) are reproduced
// here. Getting the `stat` label byte-for-byte right is what lets an event
// pair via STAT_PREFERENCES; a plural mismatch ("Carry" vs "Carries") or a
// stray word ("Header Pass" vs "Header") silently prevents matching.
const STAT_CODE_MAP: Record<string, { stat: string; category: string }> = {
  // --- Passing group ---
  shortpasseffective: { stat: "Short Passes Successful", category: "Passing" },
  shortpassineffective: { stat: "Short Passes Unsuccessful", category: "Passing" },
  longpasseffective: { stat: "Long Passes Successful", category: "Passing" },
  longpassineffective: { stat: "Long Passes Unsuccessful", category: "Passing" },
  throughballeffective: { stat: "Through Balls Successful", category: "Passing" },
  throughballineffective: { stat: "Through Balls Unsuccessful", category: "Passing" },
  // Crosses live in the Passing group; the XML misspells "Unsuccesful" (one 's').
  crosseffective: { stat: "Crosses Successful", category: "Passing" },
  crossineffective: { stat: "Crosses Unsuccesful", category: "Passing" },
  // Bare "Cross"/"ThroughBall" (no effective/ineffective) still belong to
  // Passing so they group correctly even without an outcome.
  cross: { stat: "Crosses", category: "Passing" },
  throughball: { stat: "Through Balls", category: "Passing" },
  freekickpass: { stat: "Free Kick Passes", category: "Passing" },
  carry: { stat: "Carries", category: "Passing" },
  touch: { stat: "Touch", category: "Passing" },
  // The feed's "Header" is a header (General Play in the XML, not a pass).
  header: { stat: "Header", category: "General Play" },

  // --- Event group (set pieces / restarts; XML pluralises these) ---
  corner: { stat: "Corners", category: "Event" },
  throwin: { stat: "Throw Ins", category: "Event" },
  kickoff: { stat: "Kick Offs", category: "Event" },

  // --- General Play group ---
  dribbleeffective: { stat: "Dribbles Successful", category: "General Play" },
  dribbleineffective: { stat: "Dribbles Unsuccessful", category: "General Play" },
  tackleeffective: { stat: "Tackles Successful", category: "General Play" },
  tackleineffective: { stat: "Tackles Unsuccessful", category: "General Play" },
  ballrecovery: { stat: "Ball Recoverys", category: "General Play" },
  clearance: { stat: "Clearances", category: "General Play" },
  interception: { stat: "Intercepts", category: "General Play" },
  // The S3 feed emits the code "Intercept" (singular); alias it so native
  // exports round-trip back to the same canonical label.
  intercept: { stat: "Intercepts", category: "General Play" },
  aerialwin: { stat: "Aerial Wins", category: "General Play" },
  aerialloss: { stat: "Aerial Losses", category: "General Play" },
  // Match the XML master's exact labels ("Ground Duels Won/Lost") so JSON and
  // XML masters pair.
  groundduelwin: { stat: "Ground Duels Won", category: "General Play" },
  groundduelloss: { stat: "Ground Duels Lost", category: "General Play" },
  foul: { stat: "Fouls", category: "General Play" },
  fouldrawn: { stat: "Fouls Drawn", category: "General Play" },
  offside: { stat: "Offsides", category: "General Play" },

  // --- Goal Keeper group ---
  save: { stat: "Saves", category: "Goal Keeper" },
  block: { stat: "Blocks", category: "Goal Keeper" },
  punch: { stat: "Punches", category: "Goal Keeper" },
  // Match the XML master's exact labels: "Claims" (not "Claimed") and the
  // singular "Rebound".
  claimed: { stat: "Claims", category: "Goal Keeper" },
  rebound: { stat: "Rebound", category: "Goal Keeper" },
  keeperthrowsuccessful: { stat: "Keeper Throws Successful", category: "Goal Keeper" },
  keeperthrowunsuccessful: { stat: "Keeper Throws Unsuccessful", category: "Goal Keeper" },
  goalkicksuccessful: { stat: "Goal Kicks Successful", category: "Goal Keeper" },
  goalkickunsuccessful: { stat: "Goal Kicks Unsuccessful", category: "Goal Keeper" },

  // --- Shots group ---
  // NOTE: the feed's generic "shot" (lowercase) and "Goal" both carry
  // statTypeName "Shot in Play"; the XML has no generic in-play shot label,
  // only outcome-specific ones, so a plain "shot" will not pair (expected).
  shotofftarget: { stat: "Shots Off Target", category: "Shots" },
  shotsaved: { stat: "Shots Saved", category: "Shots" },
  shotblocked: { stat: "Shots Blocked", category: "Shots" },
  freekickshot: { stat: "Free Kick Shots", category: "Shots" },
  goal: { stat: "Goals", category: "Shots" },
};

/** Split "ShortPassEffective" -> "Short Pass Effective" for a readable fallback. */
function deCamel(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Default stat mapper. Prefers `statTypeCode` (the reliable detail) over the
 * coarse `statTypeName`. Falls back to a de-camel-cased code, then the name.
 */
export function defaultMapStatName(
  statTypeName: string,
  statTypeCode?: string
): string {
  if (statTypeCode) {
    const entry = STAT_CODE_MAP[statTypeCode.toLowerCase()];
    if (entry) return entry.stat;
    // Unknown code: keep it human-readable so it's obvious in the UI/logs.
    return deCamel(statTypeCode);
  }
  return statTypeName ?? "";
}

/**
 * Classify a stat label into one of the real XML category groups by keyword,
 * so the by-category breakdown groups like the XML (a handful of categories)
 * instead of making every unmapped stat its own category. Mirrors the XML's
 * groups: Passing, General Play, Event, Goal Keeper, Shots.
 */
function classifyCategory(label: string): string {
  const s = label.toLowerCase();
  // Goal Keeper
  if (
    /\b(save|block|punch|claim|rebound|keeper|goal kick)\b/.test(s)
  )
    return "Goal Keeper";
  // Shots
  if (/\b(shot|goal|free kick shot)\b/.test(s)) return "Shots";
  // Event / set pieces
  if (/\b(corner|throw in|throw-in|kick off|kick-off)\b/.test(s))
    return "Event";
  // Passing
  if (/\b(pass|cross|through ball|carry|carries|touch|free kick pass)\b/.test(s))
    return "Passing";
  // Everything else (duels, tackles, recoveries, fouls, offsides, headers…)
  return "General Play";
}

/**
 * Default category mapper. Uses the STAT_CODE_MAP category for known codes.
 * For anything unmapped it classifies the stat label into a real group (NOT
 * the stat label itself) so the by-category breakdown stays grouped like the
 * XML comparison rather than listing one row per stat.
 */
export function defaultMapCategory(
  statTypeCode: string | undefined,
  mappedStat: string
): string {
  if (statTypeCode) {
    const entry = STAT_CODE_MAP[statTypeCode.toLowerCase()];
    if (entry) return entry.category;
  }
  return classifyCategory(mappedStat);
}

/**
 * Home/Away hint derived from `teamUid` (1 = home, 2 = away by convention).
 * The comparison engine canonicalises team names to Home/Away itself, but the
 * JSON's `teamUid` is an authoritative signal you can use to override the
 * XML's filename-based Home/Away detection when wiring the two together.
 */
export function homeAwayFromTeamUid(
  teamUid: number | undefined
): "home" | "away" | null {
  if (teamUid === 1) return "home";
  if (teamUid === 2) return "away";
  return null;
}

// ---------------------------------------------------------------------------
// Instance[] -> native S3 `allStatistics` event (the reverse of the adapter)
// ---------------------------------------------------------------------------
//
// Produces JSON that mirrors the SHAPE of the real JADE/S3 fixture feed
// (s3://premierdata01/JSON/Fixture/Reports{id}.json -> `allStatistics`), not
// a minimal round-trip blob. Each exported event carries the full native
// field set and uses the native stat ENCODING: the fine-grained
// `statTypeCode` (e.g. "ShortPassEffective") plus the coarse singular
// `statTypeName` (e.g. "Short Pass Successful"), exactly like the source.
//
// Verified against Reports32159.json (Cymru League South, 2026). The 49
// code -> name pairs below are the authoritative native vocabulary observed
// in that feed.
//
// RECOVERABLE vs LOST (the compare engine's `Instance` is lossy):
//   - uid           <- inst.id
//   - relativeTime  <- inst.start (whole-match seconds)
//   - statTypeCode  <- reverse lookup from inst.stat (CANONICAL_TO_NATIVE)
//   - statTypeName  <- native coarse name from the same table
//   - playerName    <- inst.playerRaw
//   - playerNumber  <- inst.playerNumber (NOTE: the native feed omits this on
//                      the event itself and derives it from allParticipants;
//                      we include it since we have it, harmless to consumers)
//   - teamName      <- inst.team
//   - quarter, teamUid, startWidth/Height, endX/Y, and the many boolean/empty
//     fields are NOT carried on an Instance, so they default to 0 / false /
//     "" just as the native feed does for events that lack them. `quarter`
//     cannot be reconstructed from relativeTime (the half-time gap varies),
//     so it is emitted as 0.
//
// For stats with no known native code (unmapped XML labels), statTypeCode is
// left "" and the Instance's stat label is used as statTypeName so the event
// is still legible and re-imports via defaultMapStatName's name fallback.

/**
 * The native event shape as delivered by the S3 fixture feed's
 * `allStatistics` array. A superset of the fields the matcher needs; the
 * extras are reproduced so exported files look like the real feed.
 */
export type NativeStatEvent = {
  uid: number | string;
  quarter: number;
  relativeTime: number;
  statTypeCode: string;
  statTypeName: string;
  playerName: string;
  playerNumber: number | null;
  playerUid: number;
  teamName: string;
  teamUid: number;
  startWidth: number;
  startHeight: number;
  endWidth: number;
  endHeight: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  effective: boolean;
  contested: boolean;
  turnover: boolean;
  analystInitials: string;
  notes: string;
};

// Canonical XML stat label (what Instance.stat holds, from STAT_CODE_MAP /
// the XML) -> native { statTypeCode, statTypeName } used by the S3 feed.
// Keyed by the lowercased canonical label for case-insensitive lookup.
//
// Built from the 49 code/name pairs observed in Reports32159.json cross-
// referenced with STAT_CODE_MAP's canonical labels. The native statTypeName
// is the SINGULAR coarse form; the canonical label is the pluralised XML form.
const CANONICAL_TO_NATIVE: Record<
  string,
  { statTypeCode: string; statTypeName: string }
> = {
  // Passing
  "short passes successful": { statTypeCode: "ShortPassEffective", statTypeName: "Short Pass Successful" },
  "short passes unsuccessful": { statTypeCode: "ShortPassIneffective", statTypeName: "Short Pass Unsuccessful" },
  "long passes successful": { statTypeCode: "LongPassEffective", statTypeName: "Long Pass Successful" },
  "long passes unsuccessful": { statTypeCode: "LongPassIneffective", statTypeName: "Long Pass Unsuccessful" },
  "through balls successful": { statTypeCode: "ThroughBallEffective", statTypeName: "Through Ball Successful" },
  "through balls unsuccessful": { statTypeCode: "ThroughBallIneffective", statTypeName: "Through Ball Unsuccessful" },
  // XML misspells "Unsuccesful" (one 's') for crosses; native matches it.
  "crosses successful": { statTypeCode: "CrossEffective", statTypeName: "Cross Successful" },
  "crosses unsuccesful": { statTypeCode: "CrossIneffective", statTypeName: "Cross Unsuccesful" },
  "free kick passes": { statTypeCode: "FreeKickPass", statTypeName: "Free Kick Pass" },
  carries: { statTypeCode: "Carry", statTypeName: "Carry" },
  touch: { statTypeCode: "Touch", statTypeName: "Touch" },
  header: { statTypeCode: "Header", statTypeName: "Header" },

  // Event / set pieces
  corners: { statTypeCode: "Corner", statTypeName: "Corner" },
  "throw ins": { statTypeCode: "ThrowIn", statTypeName: "Throw In" },
  "kick offs": { statTypeCode: "KickOff", statTypeName: "Kick Off" },

  // General Play
  "dribbles successful": { statTypeCode: "DribbleEffective", statTypeName: "Dribble Successful" },
  "dribbles unsuccessful": { statTypeCode: "DribbleIneffective", statTypeName: "Dribble Unsuccessful" },
  "tackles successful": { statTypeCode: "TackleEffective", statTypeName: "Tackle Successful" },
  "tackles unsuccessful": { statTypeCode: "TackleIneffective", statTypeName: "Tackle Unsuccessful" },
  "ball recoverys": { statTypeCode: "BallRecovery", statTypeName: "Ball Recovery" },
  clearances: { statTypeCode: "Clearance", statTypeName: "Clearance" },
  intercepts: { statTypeCode: "Intercept", statTypeName: "Intercept" },
  "aerial wins": { statTypeCode: "AerialWin", statTypeName: "Aerial Win" },
  fouls: { statTypeCode: "Foul", statTypeName: "Foul" },
  "fouls drawn": { statTypeCode: "FoulDrawn", statTypeName: "Foul Drawn" },

  // Goal Keeper
  saves: { statTypeCode: "Save", statTypeName: "Save" },
  blocks: { statTypeCode: "Block", statTypeName: "Block" },

  // Shots
  "shots off target": { statTypeCode: "ShotOffTarget", statTypeName: "Shot Off Target" },
  goals: { statTypeCode: "Goal", statTypeName: "Goal" },
};

/**
 * Reverse a canonical Instance.stat label to the native code/name. Returns
 * null when the label has no known native code (unmapped stats), so the
 * caller can fall back to an empty code + the raw label as statTypeName.
 */
function nativeFromCanonicalStat(
  stat: string
): { statTypeCode: string; statTypeName: string } | null {
  return CANONICAL_TO_NATIVE[stat.trim().toLowerCase()] ?? null;
}

/**
 * Convert parsed `Instance[]` into native-shaped `allStatistics` events that
 * mirror the S3 fixture feed. Stat encoding uses the native statTypeCode +
 * coarse statTypeName; fields the Instance does not carry default to the same
 * zero/empty values the native feed uses.
 */
export function instancesToNativeStatEvents(
  instances: Instance[]
): NativeStatEvent[] {
  return instances.map((inst) => {
    const native = nativeFromCanonicalStat(inst.stat);
    return {
      uid: inst.id,
      // quarter is not retained on an Instance (half-time gap makes it
      // non-derivable from relativeTime), so emit 0 as the native feed does
      // for events without a period.
      quarter: 0,
      relativeTime: inst.start,
      statTypeCode: native?.statTypeCode ?? "",
      statTypeName: native?.statTypeName ?? inst.stat,
      playerName: inst.playerRaw ?? "",
      playerNumber: inst.playerNumber,
      playerUid: 0,
      teamName: inst.team ?? "",
      teamUid: 0,
      startWidth: 0,
      startHeight: 0,
      endWidth: 0,
      endHeight: 0,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
      effective: false,
      contested: false,
      turnover: false,
      analystInitials: "",
      notes: "",
    };
  });
}

/**
 * Serialize parsed `Instance[]` to a pretty-printed JSON string in the native
 * `{ allStatistics: [...] }` wrapper the S3 fixture feed uses. Re-imports
 * cleanly via instancesFromRaw / jsonEventsToInstances: the native statTypeCode
 * round-trips through STAT_CODE_MAP back to the same canonical label.
 */
export function serializeInstancesToJson(instances: Instance[]): string {
  return JSON.stringify(
    { allStatistics: instancesToNativeStatEvents(instances) },
    null,
    2
  );
}
