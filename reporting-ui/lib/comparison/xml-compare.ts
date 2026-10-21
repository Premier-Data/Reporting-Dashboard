// XML comparison engine for SportsCode-style instance exports.
//
// Each XML has <ALL_INSTANCES><instance>... with:
//   <start>seconds</start> <end>seconds</end>
//   <code>Team - #N. N</code>
//   <label><group>Team</group><text>...</text></label>
//   <label><group>Player</group><text>...</text></label>
//   <label><group>{StatCategory}</group><text>{Stat}</text></label>
//
// Master = the correct reference (e.g. "Soccer Comp A").
// Analyst = the one being graded (e.g. "PD Accuracy").

export type Instance = {
  id: string;
  start: number;
  end: number;
  /**
   * The "code time" — the midpoint between start and end. Coders apply a
   * lead/lag window around the actual event (start = lead, end = lag), so
   * the true moment of the coded action is halfway between them. This is
   * what's shown on the timeline and used for matching.
   */
  mid: number;
  team: string;
  /** jersey number parsed from the code label, e.g. 10 */
  playerNumber: number | null;
  /** raw player label text */
  playerRaw: string;
  /** the stat text, e.g. "Tackles Successful" */
  stat: string;
  /** the stat group/category, e.g. "Tackles" */
  category: string;
  /** original code string */
  code: string;
};

export type MatchStatus =
  | "exact"
  | "wrong_stat" // correct team + player, wrong stat
  | "wrong_player" // correct team, wrong player
  | "wrong_team" // matched in window but different team
  | "missed" // master instance, no analyst instance in window
  | "extra"; // analyst instance with no master match

export type ComparisonRow = {
  status: MatchStatus;
  master: Instance | null;
  analyst: Instance | null;
  /** absolute time delta in seconds between matched instances */
  timeDelta: number | null;
  /**
   * Secondary flag: a wrong-stat pair where the PLAYER also differs. The
   * primary `status` stays "wrong_stat" (so counts/filters are unchanged);
   * the UI shows an extra "wrong player" badge when this is true.
   */
  alsoWrongPlayer?: boolean;
};

export type CategoryBreakdown = {
  category: string;
  total: number;
  exact: number;
  accuracy: number;
};

export type StatBreakdown = {
  /** the individual stat text, e.g. "Hit Out", "Loose Ball Get" */
  stat: string;
  /** master instances of this stat */
  total: number;
  /** exact matches (team + player + stat) */
  exact: number;
  accuracy: number;
};

export type TeamBreakdown = {
  team: string;
  /** number of master instances for this team */
  masterTotal: number;
  exact: number;
  wrongStat: number;
  wrongPlayer: number;
  /** analyst put this team's event on the other team (or vice versa) */
  wrongTeam: number;
  missed: number;
  /** analyst-only instances attributed to this team */
  extra: number;
  /** exact / masterTotal */
  accuracy: number;
  /** average absolute time delta of this team's exact matches */
  avgTimeDrift: number;
};

export type ComparisonResult = {
  rows: ComparisonRow[];
  tolerance: number;
  summary: {
    masterTotal: number;
    analystTotal: number;
    exact: number;
    wrongStat: number;
    wrongPlayer: number;
    wrongTeam: number;
    missed: number;
    extra: number;
    /** exact / masterTotal */
    accuracy: number;
    /** average absolute time delta of exact matches */
    avgTimeDrift: number;
  };
  byCategory: CategoryBreakdown[];
  byStat: StatBreakdown[];
  byTeam: TeamBreakdown[];
};

/** Parse a jersey number out of strings like "St Josephs 10", "10 10", "02 2", "#10". */
function parseNumber(...candidates: string[]): number | null {
  for (const c of candidates) {
    if (!c) continue;
    // Prefer a number after a '#'
    const hash = c.match(/#\s*(\d+)/);
    if (hash) return parseInt(hash[1], 10);
    // Otherwise take the last standalone number in the string
    const all = c.match(/\d+/g);
    if (all && all.length) return parseInt(all[all.length - 1], 10);
  }
  return null;
}

/**
 * Stat-specific fixed offsets (seconds after start) for the code time.
 * Some stats are coded with a consistent lead-in rather than sitting at
 * the midpoint of the window. For these, code time = start + offset.
 * Everything not listed here uses the midpoint of start/end.
 */
// Order matters: codeTime() uses the FIRST keyword the stat text
// includes, so list more specific phrases before broader ones (e.g.
// "around ground bounce" before any generic "bounce").
// `exact: true` matches the whole (normalised) stat name, so short words
// like "goal"/"behind" don't accidentally catch "Goal Assist" etc.
// `exact` omitted = substring match (for phrase variants like bounces).
const STAT_START_OFFSETS: {
  keyword: string;
  offset: number;
  exact?: boolean;
}[] = [
  // Corners (football) are marked at the start of the build-up; the actual
  // delivery is ~5s later, so code time = start + 5s. "corner" is a substring
  // match so it covers "Corner", "Corners", "Corner Won", etc.
  { keyword: "corner", offset: 5 },

  { keyword: "uncontested mark", offset: 5 },

  // Around-the-ground bounce (sometimes coded as "Ball Up") — 9s.
  // Must come before centre-bounce so "bounce" phrasing resolves here.
  { keyword: "around the ground bounce", offset: 9 },
  { keyword: "around ground bounce", offset: 9 },
  { keyword: "ball up", offset: 9 },

  // Centre bounce — 6s.
  { keyword: "centre bounce", offset: 6 },
  { keyword: "center bounce", offset: 6 },

  // Throw ins (aka boundary throws) — NO fixed offset. The code time falls
  // through to the window midpoint (for feed events where end === start, that
  // is simply the start). A former +7s offset was removed: throw-ins show no
  // consistent lead-in to correct for (see the check-562 investigation), so
  // forcing one only pushed them out of alignment.

  // Kick ins — 6s.
  { keyword: "kick in", offset: 6 },
  { keyword: "kick-in", offset: 6 },

  // Turnovers — 7s.
  { keyword: "turnover", offset: 7 },

  // Effective & ineffective kicks — 5s. "ineffective kick" is listed
  // first; order doesn't matter here since both map to 5s, but keeping
  // the more specific phrase first is safe practice.
  { keyword: "ineffective kick", offset: 5 },
  { keyword: "effective kick", offset: 5 },

  // Scoring shots. "rushed behind" MUST be listed before "behind" so a
  // rushed behind resolves to 6s, not the plain-behind 30s rule.
  // "goal"/"behind" use exact matching so they don't catch things like
  // "Goal Assist" or "Behind Assist".
  { keyword: "rushed behind", offset: 6, exact: true },
  { keyword: "rushed behinds", offset: 6, exact: true },
  { keyword: "behind", offset: 30, exact: true },
  { keyword: "behinds", offset: 30, exact: true },
  // NB: Goals get NO fixed start offset. They are coded within a short
  // lead/lag window (e.g. start 2609s / end 2619s in the master export), so
  // the true moment is the window midpoint — exactly what SportsCode's
  // timeline shows. An earlier +45s offset pushed the code time ~35s PAST the
  // instance's own end, so goals displayed (and matched) far too late (a 6:32
  // goal appeared at ~7:17). Falling through to the midpoint rule below keeps
  // goals aligned with the source timeline. Both the XML parser and the JSON
  // adapter call codeTime(), so this applies identically to both sources.
];

/**
 * The "code time" for an instance — the moment the action actually
 * happened within the lead/lag window.
 *   - Stats with a fixed offset (see STAT_START_OFFSETS): start + offset,
 *     clamped so it never runs past the window end.
 *   - Everything else: the midpoint of start and end.
 */
export function codeTime(stat: string, start: number, end: number): number {
  const s = normStat(stat);
  const rule = STAT_START_OFFSETS.find((r) =>
    r.exact ? s === r.keyword : s.includes(r.keyword)
  );
  if (rule) {
    // Honour the configured offset exactly (these are deliberate fixed
    // lead-ins, e.g. a corner is coded 5s after the start marker, so the
    // window is expected to be long enough — don't clamp to end). NB: goals
    // carry NO fixed offset (see STAT_START_OFFSETS) and fall through to the
    // window midpoint below.
    return start + rule.offset;
  }
  const mid = (start + end) / 2;
  // "Shot Saved" is coded slightly late, so nudge it 2s EARLIER. Checked
  // before the generic "save" rule below (which shifts keeper "Saves" later).
  if (s.includes("shot saved")) return mid - 2;
  // These stats are coded slightly early relative to the actual moment, so
  // nudge their code time 2s later (relative to the window midpoint) to line
  // up. "foul" covers both "Foul" and "Fouls Drawn".
  if (
    s.includes("touch") ||
    s.includes("foul") ||
    s.includes("claim") ||
    s.includes("save")
  ) {
    return mid + 2;
  }
  return mid;
}

/**
 * Parse a SportsCode XML string into instances.
 * Robust to leading junk, missing groups, and multiple stat labels
 * (first non Team/Player label wins as the stat).
 */
/**
 * Infer the sport from a parsed set of instances by scanning the stat and
 * category text for sport-distinctive keywords. Used to classify saved
 * checks whose `sport` column wasn't recorded. Returns "afl" | "football",
 * or null if there's no clear signal.
 */
const AFL_KEYWORDS = [
  "handball",
  "hit out",
  "hitout",
  "mark",
  "behind",
  "centre bounce",
  "center bounce",
  "ball up",
  "hard ball",
  "loose ball",
  "spoil",
  "i50",
  "inside 50",
  "clanger",
];
const FOOTBALL_KEYWORDS = [
  "pass",
  "cross",
  "dribble",
  "through ball",
  "goal kick",
  "throw in",
  "corner",
  "offside",
  "aerial",
  "ground duel",
  "clearance",
  "interception",
  "ball recover",
  "header",
  "keeper",
];

export function detectSportFromInstances(
  instances: Instance[]
): "afl" | "football" | null {
  let afl = 0;
  let football = 0;
  for (const i of instances) {
    const s = `${i.stat} ${i.category}`.toLowerCase();
    for (const k of AFL_KEYWORDS) if (s.includes(k)) afl++;
    for (const k of FOOTBALL_KEYWORDS) if (s.includes(k)) football++;
  }
  if (afl === 0 && football === 0) return null;
  return football > afl ? "football" : "afl";
}

/** Convenience: infer sport straight from raw XML. */
export function detectSportFromXml(
  xml: string | null | undefined
): "afl" | "football" | null {
  if (!xml) return null;
  return detectSportFromInstances(parseInstances(xml));
}

// Non-action markers excluded from the comparison and the by-category table:
// substitutions, half markers, and pitch zones. Mirrors isExcludedStatLabel in
// json-adapter.ts (kept inline to avoid a circular import). Matched
// case-insensitively against a stat or category label.
const EXCLUDED_COMPARE_LABELS = new Set([
  "substitution",
  "substitute",
  "start half",
  "starthalf",
  "end half",
  "endhalf",
  // Pitch zones — named "Back/Middle/Front Third" and "Penalty Box".
  "back third",
  "backthird",
  "middle third",
  "middlethird",
  "front third",
  "frontthird",
  "penalty box",
  "penaltybox",
]);

function isExcludedCompareLabel(label: string): boolean {
  const v = (label ?? "").trim().toLowerCase();
  return v.length > 0 && EXCLUDED_COMPARE_LABELS.has(v);
}

// Pitch-zone label bases. A zone label can carry trailing suffixes the exact
// EXCLUDED_COMPARE_LABELS set doesn't cover (e.g. "Penalty Box (a)",
// "Front Third 116,"), so match on a normalised START-WITH basis instead.
const PITCH_ZONE_BASES = [
  "back third",
  "middle third",
  "front third",
  "penalty box",
];

/**
 * Conservative pitch-zone detector: returns true when the (normalised) group
 * OR text STARTS WITH a pitch-zone base ("back third", "middle third",
 * "front third", "penalty box"), tolerant of trailing suffixes like " (a)" or
 * " 116,". Anchored at the start so it never swallows unrelated stats that
 * merely contain a zone word. Used only to SKIP a pitch-zone label when
 * selecting an instance's stat — the exclusion guard below is unchanged.
 */
function isPitchZoneLabel(group: string, text: string): boolean {
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const g = norm(group);
  const t = norm(text);
  return PITCH_ZONE_BASES.some(
    (base) => g.startsWith(base) || t.startsWith(base)
  );
}

export function parseInstances(xml: string): Instance[] {
  const instances: Instance[] = [];
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    // Should only run client-side; guard anyway.
    return instances;
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = Array.from(doc.getElementsByTagName("instance"));

  for (const node of nodes) {
    const get = (tag: string) =>
      node.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";

    const id = get("ID") || crypto.randomUUID();
    const start = parseFloat(get("start"));
    const end = parseFloat(get("end"));
    const code = get("code");

    let team = "";
    let playerRaw = "";
    let stat = "";
    let category = "";

    const labels = Array.from(node.getElementsByTagName("label"));
    for (const label of labels) {
      const group =
        label.getElementsByTagName("group")[0]?.textContent?.trim() ?? "";
      const text =
        label.getElementsByTagName("text")[0]?.textContent?.trim() ?? "";
      const g = group.toLowerCase();
      if (g === "team") team = text;
      else if (g === "player") playerRaw = text;
      else if (!stat && !isPitchZoneLabel(group, text)) {
        // First non-meta, non-pitch-zone label is the stat + category. Pitch
        // zones (e.g. "Penalty Box (a)", "Front Third 116,") are SKIPPED here
        // so the loop keeps scanning and the first REAL stat label wins. This
        // stops real early stats being captured as a zone and then dropped by
        // the exclusion guard below.
        category = group;
        stat = text;
      }
    }

    // Fall back to team from code if the Team label was absent.
    if (!team && code.includes(" - #")) team = code.split(" - #")[0].trim();

    // Prefer the number from the CODE (e.g. "... - #42. Mino") — it's the
    // reliable jersey number. The Player label sometimes reads "00 Mino"
    // (a placeholder 0), which would otherwise collapse many players onto
    // a bogus "#0" row.
    const playerNumber = parseNumber(code, playerRaw);

    if (Number.isNaN(start)) continue;

    const safeEnd = Number.isNaN(end) ? start : end;
    const cleanStat = stat.trim();

    // No real stat label was found (e.g. the instance carried ONLY a pitch
    // zone, which the loop above now skips as a stat candidate). Drop it — it
    // represents no coded action. Previously such an instance was dropped by
    // the exclusion guard because the pitch zone was captured as the stat;
    // skipping the zone leaves `stat` empty, so drop explicitly here.
    if (!cleanStat) continue;

    // Exclude non-action markers (substitutions, Start/End Half, pitch zones:
    // Back/Middle/Front/Penalty Box) from the comparison and the by-category
    // table. Matched on the stat OR category label. (Kept inline rather than
    // imported to avoid a circular dependency with the JSON adapter.)
    if (
      isExcludedCompareLabel(cleanStat) ||
      isExcludedCompareLabel(category)
    )
      continue;

    // Code time = the actual moment of the coded action within the
    // lead/lag window. Most stats sit at the midpoint, but some stats
    // are coded with a consistent fixed offset from the start instead
    // (see codeTime()).
    const mid = codeTime(cleanStat, start, safeEnd);

    instances.push({
      id,
      start,
      end: safeEnd,
      mid,
      team: team.trim(),
      playerNumber,
      playerRaw,
      stat: cleanStat,
      category: category.trim(),
      code,
    });
  }

  // Sort by code time (midpoint) so the timeline reflects the actual
  // coded moment rather than the lead-in point.
  instances.sort((a, b) => a.mid - b.mid);
  return instances;
}

/** Escape a string for safe inclusion in XML text/nodes. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serialize instances back into SportsCode-style XML — the inverse of
 * parseInstances. Used after an admin edits the master so the change can be
 * persisted (stored `xml_master`) and downloaded as a corrected .xml file.
 *
 * Emits <file><ALL_INSTANCES><instance>… with ID/start/end/code and <label>
 * groups for Team, Player and the stat (group = the stat's category). This
 * round-trips through parseInstances: team/player/stat/category/time/id are
 * all preserved. `mid` is derived on re-parse, so it isn't stored.
 */
export function serializeInstances(instances: Instance[]): string {
  const rows = [...instances].sort((a, b) => a.start - b.start);
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<file>`);
  lines.push(`  <ALL_INSTANCES>`);
  for (const i of rows) {
    lines.push(`    <instance>`);
    lines.push(`      <ID>${escapeXml(i.id)}</ID>`);
    lines.push(`      <start>${i.start}</start>`);
    lines.push(`      <end>${i.end}</end>`);
    lines.push(`      <code>${escapeXml(i.code)}</code>`);
    if (i.team) {
      lines.push(`      <label>`);
      lines.push(`        <group>Team</group>`);
      lines.push(`        <text>${escapeXml(i.team)}</text>`);
      lines.push(`      </label>`);
    }
    if (i.playerRaw) {
      lines.push(`      <label>`);
      lines.push(`        <group>Player</group>`);
      lines.push(`        <text>${escapeXml(i.playerRaw)}</text>`);
      lines.push(`      </label>`);
    }
    if (i.stat) {
      lines.push(`      <label>`);
      lines.push(`        <group>${escapeXml(i.category || "Action")}</group>`);
      lines.push(`        <text>${escapeXml(i.stat)}</text>`);
      lines.push(`      </label>`);
    }
    lines.push(`    </instance>`);
  }
  lines.push(`  </ALL_INSTANCES>`);
  lines.push(`</file>`);
  return lines.join("\n");
}

/**
 * Build the `code` string for an instance from its team + player, matching the
 * "<Team> - #<number>. <name>" convention parseInstances reads the jersey
 * number from. Used when adding/editing so the derived playerNumber is stable.
 */
export function buildCode(
  team: string,
  playerNumber: number | null,
  playerName: string
): string {
  const num = playerNumber != null ? `#${playerNumber}` : "";
  const namePart = playerName.trim();
  const right = [num, namePart].filter(Boolean).join(". ");
  return right ? `${team} - ${right}` : team;
}

function normTeam(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}
function normStat(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The "base action" of a stat, with any OUTCOME suffix removed — i.e.
 * "successful" / "unsuccessful" / "unsuccesful" (the source's one-'s'
 * misspelling), plus trailing plural 's'. So:
 *   "crosses" / "crosses successful" / "crosses unsuccesful"  -> "cross"
 *   "through balls" / "through balls successful/unsuccessful" -> "through ball"
 * Lets a coder's BARE action (e.g. "Crosses") count as the SAME action as
 * another coder's outcome-tagged version ("Crosses Successful") — a coding-
 * granularity difference, not a different action.
 */
function baseAction(s: string): string {
  const norm = normStat(s)
    .replace(/\b(unsuccessful|unsuccesful|successful|effective|ineffective)\b/g, "")
    // Canonicalise the singular/plural "catch"/"catches" to one base so a
    // coder's "Catch" counts as the SAME action as another's "Catches"
    // (either side, treated as an exact match). Scoped to this one word
    // rather than blanket plural-stripping so unrelated stats aren't merged.
    .replace(/\bcatches\b/g, "catch")
    .replace(/\s+/g, " ")
    .trim();

  // AFL (Aussie Rules) DEPTH collapse: the shallow and deep variants of an
  // inside-50 stat are the SAME action for exact-match purposes, so a master
  // coding the shallow variant and an analyst coding the deep variant (or
  // vice versa) at the same player/team/time scores EXACT. Each pair collapses
  // only within its OWN base stat; the three bases below stay mutually
  // distinct so cross-pair comparisons remain wrong-stat / non-exact.
  //
  // Order matters: marks and rebound are matched FIRST, and the plain
  // scoring inside-50 case explicitly excludes mark/marks/rebound. A bare
  // "shallow"/"deep" on an unrelated label is never stripped.
  const hasShallowOrDeep = norm.includes("shallow") || norm.includes("deep");
  if (hasShallowOrDeep) {
    // (a) "Marks i50 - Shallow" / "Marks i50 - Deep" -> "marks i50"
    if (norm.includes("marks i50")) {
      return "marks i50";
    }
    // (b) "Rebound 50s - Shallow" / "Rebound 50s - Deep" -> "rebound 50s"
    if (norm.includes("rebound 50s")) {
      return "rebound 50s";
    }
    // (c) plain Scoring inside-50 ("Shallow I50" / "Deep I50") -> sentinel
    // "scoring i50". Guarded to exclude mark/marks (handled above) and
    // rebound so the three bases never collide.
    if (
      norm.includes("i50") &&
      !norm.includes("mark") &&
      !norm.includes("rebound")
    ) {
      return "scoring i50";
    }
  }

  return norm;
}

/**
 * Two stats are the SAME action when their labels are identical, OR they share
 * the same base action after stripping the outcome suffix (so a bare
 * "Crosses" == "Crosses Successful"). Used for "exact" scoring so differing
 * only in outcome granularity still counts as a correct match.
 */
function sameBaseAction(a: string, b: string): boolean {
  if (normStat(a) === normStat(b)) return true;
  const ba = baseAction(a);
  const bb = baseAction(b);
  return ba.length > 0 && ba === bb;
}

/**
 * Game-flow "events" (centre bounces, around-the-ground bounces, throw-ins)
 * aren't attributed to a specific player/team. If both files log the same
 * event in the same time window, that's a correct match regardless of the
 * player or team recorded against it.
 */
const EVENT_STAT_KEYWORDS = [
  "centre bounce",
  "center bounce",
  "ball up", // around-the-ground bounce is often coded as a ball-up
  "around ground bounce",
  "around the ground bounce",
  "ground bounce",
  "bounce", // catch-all for bounce variants
  "throw in",
  "throw-in",
  "boundary throw", // "Boundary Throws" = boundary throw-in
  "throw", // catch-all for throw variants (boundary throws, throw ins)
];

function isEventStat(stat: string): boolean {
  const s = normStat(stat);
  return EVENT_STAT_KEYWORDS.some((k) => s.includes(k));
}

/**
 * Stat preference map (per the analyst-provided comparison table). For each
 * MASTER stat, an ordered list of acceptable ANALYST stats (index 0 = same
 * stat = best). Two DIFFERENT stats are only comparable (can pair as
 * wrong-stat / wrong-player) if the analyst stat appears in the master stat's
 * preference list. Rankings are asymmetric — each master stat defines its own
 * order. Stats with no entry only match on an exact same-stat basis.
 *
 * All keys/values are lowercased to match normStat().
 */
const STAT_PREFERENCES: Record<string, string[]> = {
  // --- Passing ---
  "long passes successful": [
    "long passes successful",
    "long passes unsuccessful",
    "short passes successful",
    "short passes unsuccessful",
    "through balls successful",
    "through balls unsuccessful",
    "clearances",
  ],
  "long passes unsuccessful": [
    "long passes unsuccessful",
    "long passes successful",
    "short passes successful",
    "short passes unsuccessful",
    "through balls successful",
    "through balls unsuccessful",
    "clearances",
  ],
  "short passes successful": [
    "short passes successful",
    "short passes unsuccessful",
    "long passes successful",
    "long passes unsuccessful",
    "through balls successful",
    "through balls unsuccessful",
    "clearances",
  ],
  "short passes unsuccessful": [
    "short passes unsuccessful",
    "short passes successful",
    "long passes unsuccessful",
    "long passes successful",
    "through balls successful",
    "through balls unsuccessful",
    "clearances",
  ],
  // Bare "Through Balls" (no outcome) is the same action as the
  // successful/unsuccessful variants — pair them all.
  "through balls": [
    "through balls",
    "through balls successful",
    "through balls unsuccessful",
    "long passes successful",
    "long passes unsuccessful",
    "short passes successful",
    "short passes unsuccessful",
    "clearances",
  ],
  "through balls successful": [
    "through balls successful",
    "through balls unsuccessful",
    "through balls",
    "long passes successful",
    "long passes unsuccessful",
    "short passes successful",
    "short passes unsuccessful",
    "clearances",
  ],
  "through balls unsuccessful": [
    "through balls unsuccessful",
    "through balls successful",
    "through balls",
    "long passes unsuccessful",
    "long passes successful",
    "short passes unsuccessful",
    "short passes successful",
    "clearances",
  ],
  // --- Ball-winning ---
  "ball recoverys": [
    "ball recoverys",
    "intercepts",
    "clearances",
    "ground duels won",
    "tackles successful",
    "tackles unsuccessful",
  ],
  "ground duels won": ["ground duels won", "ball recoverys", "tackles successful", "tackles unsuccessful"],
  intercepts: [
    "intercepts",
    "ball recoverys",
    "clearances",
    "tackles successful",
    "tackles unsuccessful",
  ],
  // --- Tackles (defensive actions; comparable with other ball-winning stats) ---
  "tackles successful": [
    "tackles successful",
    "tackles unsuccessful",
    "intercepts",
    "ball recoverys",
    "clearances",
    "ground duels won",
  ],
  "tackles unsuccessful": [
    "tackles unsuccessful",
    "tackles successful",
    "intercepts",
    "ball recoverys",
    "clearances",
    "ground duels won",
  ],
  clearances: [
    "clearances",
    "intercepts",
    "ball recoverys",
    "tackles successful",
    "tackles unsuccessful",
    "blocks",
    "long passes successful",
    "long passes unsuccessful",
    "short passes successful",
    "short passes unsuccessful",
    "through balls successful",
    "through balls unsuccessful",
  ],
  // --- Crosses (source misspells "unsuccesful" with one 's') ---
  // Some coders log a bare "Crosses" (no outcome); others split into
  // successful/unsuccesful. Treat all three as the same action so a bare
  // master cross pairs with an effective/ineffective analyst cross (and vice
  // versa) instead of counting as missed/extra.
  crosses: ["crosses", "crosses successful", "crosses unsuccesful"],
  "crosses successful": ["crosses successful", "crosses unsuccesful", "crosses"],
  "crosses unsuccesful": ["crosses unsuccesful", "crosses successful", "crosses"],
  // --- Goalkeeper handling ---
  // "catch" and "catches" are the SAME action (see baseAction) — list both the
  // singular and plural forms so comparability holds whichever a timeline uses.
  catches: ["catches", "catch", "claims", "saves"],
  catch: ["catch", "catches", "claims", "saves"],
  claims: ["claims", "catches", "catch", "saves"],
  saves: ["saves", "catches", "catch", "claims"],
  // --- Goal kicks (succ/unsucc are the same action, different outcome) ---
  "goal kicks successful": [
    "goal kicks successful",
    "goal kicks unsuccessful",
  ],
  "goal kicks unsuccessful": [
    "goal kicks unsuccessful",
    "goal kicks successful",
  ],
  // --- On-ball possession ---
  touch: ["touch", "carries", "dribbles successful", "dribbles unsuccessful"],
  carries: ["carries", "touch", "dribbles successful", "dribbles unsuccessful"],
  // --- Dribbles (succ/unsucc are the same action, different outcome) ---
  "dribbles successful": [
    "dribbles successful",
    "dribbles unsuccessful",
    "carries",
    "touch",
  ],
  "dribbles unsuccessful": [
    "dribbles unsuccessful",
    "dribbles successful",
    "carries",
    "touch",
  ],
};

/**
 * Preference rank of an analyst stat given the master stat. 0 = same stat
 * (best). Lower is better. Returns a large number if not comparable.
 */
function statPreferenceRank(masterStat: string, analystStat: string): number {
  const m = normStat(masterStat);
  const a = normStat(analystStat);
  if (m === a) return 0;
  const prefs = STAT_PREFERENCES[m];
  if (!prefs) return 999;
  const idx = prefs.indexOf(a);
  return idx === -1 ? 999 : idx;
}

/**
 * Are two stats comparable (same stat, or one lists the other in its
 * preference table)? Comparability is symmetric: either direction counts.
 */
function sameStatGroup(a: string, b: string): boolean {
  const na = normStat(a);
  const nb = normStat(b);
  if (na === nb) return true;
  return (
    (STAT_PREFERENCES[na]?.includes(nb) ?? false) ||
    (STAT_PREFERENCES[nb]?.includes(na) ?? false)
  );
}

/**
 * Team-name canonicalisation.
 *
 * The master and analyst files often name the same club differently
 * (e.g. "Eastern Lion" vs "Eastern Lions U15Bs"), which used to flag
 * genuinely-correct events as "wrong team". A game only ever has two
 * sides, so we relabel BOTH files' teams to canonical "Home"/"Away"
 * before comparing — team correctness then no longer depends on the
 * names lining up.
 *
 * How the two sides are aligned across files, WITHOUT trusting names:
 *   1. Take the (up to) two most common team names in each file.
 *   2. For every time-aligned pair (within tolerance) that agrees on
 *      stat and player, tally which analyst team co-occurs with which
 *      master team.
 *   3. Pick the mapping (of the two possible pairings) with the most
 *      co-occurrences. This infers the sides from the actual matched
 *      events rather than the club names.
 *
 * Falls back gracefully: if a file has only one team, or the evidence
 * is empty, we map by frequency order (most common -> Home).
 */
const CANON_HOME = "Home";
const CANON_AWAY = "Away";

function topTwoTeams(instances: Instance[]): string[] {
  const counts = new Map<string, number>();
  for (const i of instances) {
    const t = normTeam(i.team);
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t]) => t);
}

/**
 * Parse the [home, away] team names out of a master file name. The naming
 * convention puts the HOME team first and the AWAY team second, as the last
 * two underscore-separated segments after a "_full_" marker, e.g.:
 *   "...Comp 2026_01_full_Hume City FC_Malvern FC U13.xml"
 *      -> ["hume city fc", "malvern fc u13"]
 * Returns null if the name doesn't fit the pattern.
 */
export function parseHomeAwayFromFileName(
  fileName: string | null | undefined
): [string, string] | null {
  if (!fileName) return null;
  // Strip extension and any trailing " (1)", ". 1", ".." noise.
  const base = fileName.replace(/\.(xml|json)$/i, "");

  // JSON fixtures (and any "<Home> vs <Away>" named file) carry the home/away
  // order explicitly: the part before " vs " is HOME. This is authoritative
  // (from the report's homeTeamName/awayTeamName), so honour it directly.
  const vsMatch = base.match(/^(.*?)\s+vs\s+(.*)$/i);
  if (vsMatch) {
    const home = normTeam(vsMatch[1]);
    const away = normTeam(vsMatch[2].replace(/\.+\s*\d*$/, ""));
    if (home && away) return [home, away];
  }
  // The home/away teams follow a round/period marker: full game ("_full_"),
  // a quarter ("_Q1_".."_Q4_"), a half ("_H1_"/"_H2_"), or a finals stage
  // ("_GF_"/"_SF_"/"_QF_"). Match the LAST such marker (some names combine
  // them, e.g. "..._GF_full_<Home>_<Away>", where "_full_" is last and the
  // teams follow it). Previously only "_full_" was recognised, so quarter
  // files (e.g. "..._Q1_PD General AFC_PD General SC") fell back to the
  // most-coded-team heuristic and could put the away team as Home.
  // Markers can appear alone ("_Q1_") or combined ("_GF_full_"). Consume any
  // run of consecutive markers so the tail starts at the actual teams (e.g.
  // "_GF_full_" -> teams follow "_full_", not "_GF_"). \1-style back-to-back
  // markers share an underscore, so match a whole run in one go.
  const markerRunRe = /_(?:full|q[1-4]|h[12]|gf|sf|qf)(?:_(?:full|q[1-4]|h[12]|gf|sf|qf))*_/gi;
  let marker = -1;
  let markerLen = 0;
  for (const m of base.matchAll(markerRunRe)) {
    marker = m.index ?? -1;
    markerLen = m[0].length;
  }
  if (marker === -1) return null;
  const tail = base.slice(marker + markerLen);
  const parts = tail.split("_");
  if (parts.length < 2) return null;
  // Home = first segment, Away = the rest joined (in case an away name itself
  // contained an underscore, though the last two segments are the norm).
  const home = normTeam(parts[0]);
  const away = normTeam(parts.slice(1).join(" ").replace(/\.+\s*\d*$/, ""));
  if (!home || !away) return null;
  return [home, away];
}

/**
 * How well two team-name strings match, as a word-overlap score in [0,1].
 * Used to line up a file-name team (e.g. "northcote city u15b") with the
 * actual team label in the XML (e.g. "northcote city u15 boys"), which are
 * close but rarely identical.
 */
function teamNameSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      normTeam(s)
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2)
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

export type CanonTeamNames = { home: string | null; away: string | null };

export function canonicaliseTeams(
  master: Instance[],
  analyst: Instance[],
  tolerance: number,
  masterFileName?: string | null
): {
  master: Instance[];
  analyst: Instance[];
  mapped: boolean;
  /** Real club names for each canonical side, taken from the master's XML. */
  displayNames: CanonTeamNames;
} {
  // Idempotency guard: if the instances are ALREADY canonicalised (their only
  // teams are "Home"/"Away"), do NOT re-map them. This happens when a caller
  // canonicalises once, filters the result, then passes the subset back into
  // compareInstances (which canonicalises again). On that second pass the real
  // club names are gone, so the file-name similarity match scores 0 and the
  // frequency fallback can FLIP Home/Away on the subset — silently swapping the
  // teams shown on the timeline. Passing through keeps the first (correct)
  // assignment intact.
  const isCanon = (arr: Instance[]) =>
    arr.length > 0 &&
    arr.every((i) => {
      const t = normTeam(i.team);
      return t === "home" || t === "away" || t === "";
    });
  if (isCanon(master) && isCanon(analyst)) {
    return {
      master,
      analyst,
      mapped: true,
      // Already canonical; real club names aren't recoverable here, so leave
      // display names null (callers that need them use the FIRST canonicalise).
      displayNames: { home: null, away: null },
    };
  }

  const mTeams = topTwoTeams(master);
  const aTeams = topTwoTeams(analyst);

  // Original-cased team name for a normalised key, from the master instances
  // (so the timeline can show the real club name instead of "Home"/"Away").
  const originalCase = (normKey: string): string | null => {
    for (const i of master) {
      if (normTeam(i.team) === normKey) return i.team.trim();
    }
    return normKey || null;
  };

  // Nothing to align if either side has no team info.
  if (mTeams.length === 0 || aTeams.length === 0) {
    return {
      master,
      analyst,
      mapped: false,
      displayNames: { home: null, away: null },
    };
  }

  // Tally analyst-team co-occurrence with master-team over time-aligned,
  // stat+player-agreeing pairs.
  const coOccur = new Map<string, number>(); // key: `${mTeam}|||${aTeam}`
  for (const m of master) {
    for (const a of analyst) {
      if (Math.abs(a.mid - m.mid) > tolerance) continue;
      const statOk = sameBaseAction(m.stat, a.stat);
      const playerOk =
        m.playerNumber != null &&
        a.playerNumber != null &&
        m.playerNumber === a.playerNumber;
      if (!statOk && !playerOk) continue;
      const key = `${normTeam(m.team)}|||${normTeam(a.team)}`;
      coOccur.set(key, (coOccur.get(key) ?? 0) + 1);
    }
  }

  // Decide the master-team -> analyst-team mapping.
  const mapMasterToAnalyst = new Map<string, string>();

  if (mTeams.length === 2 && aTeams.length === 2) {
    const score = (mt: string, at: string) =>
      coOccur.get(`${mt}|||${at}`) ?? 0;
    // Pairing 1: m0->a0, m1->a1   vs   Pairing 2: m0->a1, m1->a0
    const p1 = score(mTeams[0], aTeams[0]) + score(mTeams[1], aTeams[1]);
    const p2 = score(mTeams[0], aTeams[1]) + score(mTeams[1], aTeams[0]);
    if (p2 > p1) {
      mapMasterToAnalyst.set(mTeams[0], aTeams[1]);
      mapMasterToAnalyst.set(mTeams[1], aTeams[0]);
    } else {
      // Ties fall back to frequency order.
      mapMasterToAnalyst.set(mTeams[0], aTeams[0]);
      mapMasterToAnalyst.set(mTeams[1], aTeams[1]);
    }
  } else {
    // One side has a single team; map by order.
    mapMasterToAnalyst.set(mTeams[0], aTeams[0]);
  }

  // Decide which master team is Home. Preferred source of truth: the master
  // FILE NAME, which by convention lists the home team first, away second
  // (e.g. "..._full_<Home>_<Away>.xml"). Match those names to the actual XML
  // team labels (they're close but not identical). Fall back to the old
  // heuristic (most-coded team = Home) when the file name isn't usable.
  let homeTeam = mTeams[0];
  let awayTeam = mTeams[1];

  const fileTeams = parseHomeAwayFromFileName(masterFileName);
  if (fileTeams && mTeams.length === 2) {
    const [fileHome, fileAway] = fileTeams;
    // Two ways to assign the two master teams to the file's home/away; pick
    // the assignment with the higher combined name similarity.
    const s = teamNameSimilarity;
    const assignA =
      s(mTeams[0], fileHome) + s(mTeams[1], fileAway); // m0=Home, m1=Away
    const assignB =
      s(mTeams[1], fileHome) + s(mTeams[0], fileAway); // m1=Home, m0=Away
    if (assignB > assignA) {
      homeTeam = mTeams[1];
      awayTeam = mTeams[0];
    } else {
      homeTeam = mTeams[0];
      awayTeam = mTeams[1];
    }
  }

  // Assign canonical labels.
  const masterCanon = new Map<string, string>();
  masterCanon.set(homeTeam, CANON_HOME);
  if (awayTeam) masterCanon.set(awayTeam, CANON_AWAY);

  const analystCanon = new Map<string, string>();
  for (const [mt, at] of mapMasterToAnalyst.entries()) {
    const canon = masterCanon.get(mt);
    if (canon && at) analystCanon.set(at, canon);
  }

  const relabelMaster = (i: Instance): Instance => ({
    ...i,
    team: masterCanon.get(normTeam(i.team)) ?? i.team,
  });
  const relabelAnalyst = (i: Instance): Instance => ({
    ...i,
    team: analystCanon.get(normTeam(i.team)) ?? i.team,
  });

  return {
    master: master.map(relabelMaster),
    analyst: analyst.map(relabelAnalyst),
    mapped: true,
    displayNames: {
      home: originalCase(homeTeam),
      away: awayTeam ? originalCase(awayTeam) : null,
    },
  };
}

/**
 * Compare master vs analyst instances.
 * Matching: for each master instance, find the best analyst instance whose
 * start time is within `tolerance` seconds that hasn't been consumed yet.
 * "Best" = the one that agrees on the most fields, then closest in time.
 *
 * Team names are canonicalised to Home/Away first (see canonicaliseTeams)
 * so mismatched club naming between files doesn't cause false "wrong team".
 */
export function compareInstances(
  masterRaw: Instance[],
  analystRaw: Instance[],
  tolerance: number,
  masterFileName?: string | null
): ComparisonResult {
  const { master, analyst } = canonicaliseTeams(
    masterRaw,
    analystRaw,
    tolerance,
    masterFileName
  );
  const rows: ComparisonRow[] = [];
  const usedAnalyst = new Set<number>();
  const usedMaster = new Set<number>();

  const fieldsOk = (m: Instance, a: Instance) => {
    // Same action if identical OR same base action ignoring outcome granularity
    // (bare "Crosses" == "Crosses Successful"), so differing only in outcome
    // detail still scores as exact.
    const statOk = sameBaseAction(m.stat, a.stat);
    // Game-flow events aren't tied to a player/team. When the stat matches and
    // it's an event, team/player don't apply, so treat them as agreeing.
    if (statOk && isEventStat(m.stat)) {
      return { teamOk: true, playerOk: true, statOk: true, event: true };
    }
    const teamOk = normTeam(m.team) === normTeam(a.team);

    // Team-level stats (e.g. "Rushed Behinds") are attributed to a team but
    // NOT a specific player, so neither file records a jersey number. When
    // BOTH sides have no player number, player attribution doesn't apply —
    // treat it as agreeing so a correct team + stat + time counts as exact
    // rather than being downgraded to "wrong player".
    const noPlayerEitherSide =
      m.playerNumber == null && a.playerNumber == null;
    // A real same-player match (both sides carry the SAME jersey number).
    const samePlayerNum =
      m.playerNumber != null &&
      a.playerNumber != null &&
      m.playerNumber === a.playerNumber;
    const playerOk = noPlayerEitherSide ? true : samePlayerNum;

    // Two DIFFERENT stats are only comparable (can pair as wrong-stat /
    // wrong-player) if they share a defined preference group (see
    // STAT_GROUPS). This replaces the old loose XML-<group> check so
    // unrelated stats in the same broad category (e.g. Dribble vs Through
    // Ball) don't wrongly pair.
    const categoryOk = sameStatGroup(m.stat, a.stat);

    return { teamOk, playerOk, statOk, categoryOk, samePlayerNum, event: false };
  };

  // Match-quality tier (higher = better). SAME PLAYER is the top priority: a
  // coded action belongs to a specific player, so if the SAME player did
  // something at the SAME time (within tolerance), that is the same event even
  // when the two coders labelled the action differently (e.g. master "Tackles
  // Successful" vs analyst "Ground Duel Loss"). Such pairs match as wrong-stat
  // rather than being dropped as missed/extra.
  //   8 = exact (team + player + stat)
  //   7 = stat + player, wrong team   (same action & player, opposing team)
  //   6 = player + team + SAME GROUP, wrong stat
  //         (same player, comparable stat — e.g. Short Pass vs Long Pass)
  //   5 = player + team, wrong stat, ANY stat (same player & team, different
  //         action — players-first pairing even across stat groups)
  //   4 = stat + team, wrong player  (same action, right team, wrong #)
  //   3 = player only (wrong team), wrong stat, ANY stat
  //         (same jersey #, opposing team label — still the same player)
  //   2 = stat only, wrong team & player (same action, opposing team)
  //   1 = team + SAME GROUP, wrong stat AND wrong player
  //         (comparable action, different player)
  //   0 = not a plausible match
  //
  // Eligibility: a pair matches if the STAT matches, OR the stats share a
  // preference group, OR it is the SAME PLAYER (jersey number) within the
  // time window. Only genuinely-unrelated events on different players stay
  // unmatched (master "missed", analyst "extra").
  const quality = (m: Instance, a: Instance): number => {
    const { teamOk, playerOk, statOk, categoryOk, samePlayerNum } = fieldsOk(
      m,
      a
    );
    if (statOk && playerOk && teamOk) return 8;
    if (statOk && playerOk) return 7;
    if (playerOk && teamOk && categoryOk) return 6;
    // Players-first: same real player + team, ANY different stat. Only when
    // both sides carry the same jersey number (not the team-level no-number
    // case, which must not pair unrelated team stats together).
    if (samePlayerNum && teamOk) return 5;
    if (statOk && teamOk) return 4;
    if (samePlayerNum) return 3; // same player, wrong team label, any stat
    if (statOk) return 2;
    if (teamOk && categoryOk) return 1; // same group, wrong stat + wrong player
    return 0; // ineligible
  };

  // Preference tie-break between equal-quality candidates: within a stat
  // group, prefer the analyst stat the master's stat ranks highest (per the
  // configured preference order). Higher score = more preferred. A same-stat
  // pair scores highest; then same base stat opposite success; then group
  // order. Non-comparable stats score 0.
  const familyScore = (m: Instance, a: Instance): number => {
    // Use the better (lower) preference rank in either direction, since some
    // stats define preferences the other doesn't list symmetrically.
    const rank = Math.min(
      statPreferenceRank(m.stat, a.stat),
      statPreferenceRank(a.stat, m.stat)
    );
    if (rank >= 999) return 0;
    // Invert: rank 0 (same stat) -> highest score.
    return 100 - rank;
  };

  // Build every candidate pair within the time tolerance, then assign the
  // best pairs first (global greedy). This avoids the master-order greedy
  // bug where an early weak match consumes an analyst row a later master
  // row needed.
  type Candidate = {
    mi: number;
    ai: number;
    q: number;
    fam: number;
    delta: number;
  };
  const candidates: Candidate[] = [];
  for (let mi = 0; mi < master.length; mi++) {
    const m = master[mi];
    for (let ai = 0; ai < analyst.length; ai++) {
      const a = analyst[ai];
      const delta = Math.abs(a.mid - m.mid);
      if (delta > tolerance) continue;
      const q = quality(m, a);
      if (q === 0) continue; // not a plausible match — skip
      candidates.push({ mi, ai, q, fam: familyScore(m, a), delta });
    }
  }

  // Best first: higher quality wins; then closer stat sub-family (so a pass
  // prefers a same-type pass over a different-type pass); then smaller time
  // delta.
  candidates.sort(
    (x, y) => (y.q - x.q) || (y.fam - x.fam) || (x.delta - y.delta)
  );

  const matchByMaster = new Map<number, { ai: number; delta: number }>();
  for (const c of candidates) {
    if (usedMaster.has(c.mi) || usedAnalyst.has(c.ai)) continue;
    usedMaster.add(c.mi);
    usedAnalyst.add(c.ai);
    matchByMaster.set(c.mi, { ai: c.ai, delta: c.delta });
  }

  // Emit a row for every master instance.
  for (let mi = 0; mi < master.length; mi++) {
    const m = master[mi];
    const match = matchByMaster.get(mi);
    if (!match) {
      rows.push({ status: "missed", master: m, analyst: null, timeDelta: null });
      continue;
    }
    const a = analyst[match.ai];
    const { teamOk, playerOk, statOk } = fieldsOk(m, a);

    // Matched pairs always share stat or player (see quality()).
    let status: MatchStatus;
    let alsoWrongPlayer = false;
    if (statOk && playerOk && teamOk) {
      status = "exact";
    } else if (statOk && !teamOk) {
      // Same action credited to the opposing team = wrong team.
      status = "wrong_team";
    } else if (statOk && teamOk && !playerOk) {
      // Same action, right team, wrong jersey number.
      status = "wrong_player";
    } else {
      // Comparable stat but the action differs = wrong stat. If the player
      // ALSO differs (a same-group cross-player pair), flag it so the UI can
      // show a second "wrong player" badge.
      status = "wrong_stat";
      alsoWrongPlayer = !playerOk;
    }

    rows.push({
      status,
      master: m,
      analyst: a,
      timeDelta: match.delta,
      alsoWrongPlayer,
    });
  }

  // Any analyst instance never consumed is an "extra" (false positive).
  for (let i = 0; i < analyst.length; i++) {
    if (usedAnalyst.has(i)) continue;
    rows.push({
      status: "extra",
      master: null,
      analyst: analyst[i],
      timeDelta: null,
    });
  }

  // Sort rows by the timeline (code time / midpoint of whichever
  // instance is present).
  rows.sort((r1, r2) => {
    const t1 = r1.master?.mid ?? r1.analyst?.mid ?? 0;
    const t2 = r2.master?.mid ?? r2.analyst?.mid ?? 0;
    return t1 - t2;
  });

  // Summary
  const count = (s: MatchStatus) => rows.filter((r) => r.status === s).length;
  const exact = count("exact");
  const wrongStat = count("wrong_stat");
  const wrongPlayer = count("wrong_player");
  const wrongTeam = count("wrong_team");
  const missed = count("missed");
  const extra = count("extra");
  const masterTotal = master.length;
  const analystTotal = analyst.length;

  const exactDeltas = rows
    .filter((r) => r.status === "exact" && r.timeDelta != null)
    .map((r) => r.timeDelta as number);
  const avgTimeDrift =
    exactDeltas.length > 0
      ? exactDeltas.reduce((a, b) => a + b, 0) / exactDeltas.length
      : 0;

  // Per-category accuracy (based on master categories).
  const catMap = new Map<string, { total: number; exact: number }>();
  for (const r of rows) {
    if (!r.master) continue;
    const cat = r.master.category || "Uncategorised";
    const entry = catMap.get(cat) ?? { total: 0, exact: 0 };
    entry.total += 1;
    if (r.status === "exact") entry.exact += 1;
    catMap.set(cat, entry);
  }
  const byCategory: CategoryBreakdown[] = Array.from(catMap.entries())
    .map(([category, v]) => ({
      category,
      total: v.total,
      exact: v.exact,
      accuracy: v.total > 0 ? v.exact / v.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Per-stat accuracy (by the individual stat text, e.g. "Hit Out").
  const statMap = new Map<string, { total: number; exact: number }>();
  for (const r of rows) {
    if (!r.master) continue;
    const stat = r.master.stat || "Uncategorised";
    const entry = statMap.get(stat) ?? { total: 0, exact: 0 };
    entry.total += 1;
    if (r.status === "exact") entry.exact += 1;
    statMap.set(stat, entry);
  }
  const byStat: StatBreakdown[] = Array.from(statMap.entries())
    .map(([stat, v]) => ({
      stat,
      total: v.total,
      exact: v.exact,
      accuracy: v.total > 0 ? v.exact / v.total : 0,
    }))
    .sort((a, b) => a.stat.localeCompare(b.stat));

  // Per-team accuracy. A row is attributed to the master's team, or (for
  // analyst-only "extra" rows) to the analyst's team.
  type TeamAcc = {
    masterTotal: number;
    exact: number;
    wrongStat: number;
    wrongPlayer: number;
    wrongTeam: number;
    missed: number;
    extra: number;
    deltas: number[];
  };
  const teamMap = new Map<string, TeamAcc>();
  const ensureTeam = (name: string): TeamAcc => {
    const key = name || "Unknown";
    let t = teamMap.get(key);
    if (!t) {
      t = {
        masterTotal: 0,
        exact: 0,
        wrongStat: 0,
        wrongPlayer: 0,
        wrongTeam: 0,
        missed: 0,
        extra: 0,
        deltas: [],
      };
      teamMap.set(key, t);
    }
    return t;
  };

  for (const r of rows) {
    if (r.status === "extra") {
      const t = ensureTeam(r.analyst?.team ?? "Unknown");
      t.extra += 1;
      continue;
    }
    const team = r.master?.team ?? r.analyst?.team ?? "Unknown";
    const t = ensureTeam(team);
    t.masterTotal += 1;
    if (r.status === "exact") {
      t.exact += 1;
      if (r.timeDelta != null) t.deltas.push(r.timeDelta);
    } else if (r.status === "wrong_stat") t.wrongStat += 1;
    else if (r.status === "wrong_player") t.wrongPlayer += 1;
    else if (r.status === "wrong_team") t.wrongTeam += 1;
    else if (r.status === "missed") t.missed += 1;
  }

  const byTeam: TeamBreakdown[] = Array.from(teamMap.entries())
    .map(([team, v]) => ({
      team,
      masterTotal: v.masterTotal,
      exact: v.exact,
      wrongStat: v.wrongStat,
      wrongPlayer: v.wrongPlayer,
      wrongTeam: v.wrongTeam,
      missed: v.missed,
      extra: v.extra,
      accuracy: v.masterTotal > 0 ? v.exact / v.masterTotal : 0,
      avgTimeDrift:
        v.deltas.length > 0
          ? v.deltas.reduce((a, b) => a + b, 0) / v.deltas.length
          : 0,
    }))
    .sort((a, b) => b.masterTotal - a.masterTotal);

  return {
    rows,
    tolerance,
    summary: {
      masterTotal,
      analystTotal,
      exact,
      wrongStat,
      wrongPlayer,
      wrongTeam,
      missed,
      extra,
      accuracy: masterTotal > 0 ? exact / masterTotal : 0,
      avgTimeDrift,
    },
    byCategory,
    byStat,
    byTeam,
  };
}

/** Format seconds as mm:ss. */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Parse a time input into seconds. Accepts "mm:ss", "h:mm:ss", or a plain
 * number of seconds. Returns null for empty/invalid input.
 */
export function parseTime(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  if (t.includes(":")) {
    const parts = t.split(":").map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    return seconds;
  }
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}
