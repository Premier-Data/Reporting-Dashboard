"use client";

import {
  useMemo,
  useState,
  useEffect,
  useRef,
  Suspense,
  type MutableRefObject,
} from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Upload,
  FileText,
  X,
  Sparkles,
  Target,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  ArrowRightLeft,
  Clock,
  Download,
  Save,
  Video,
  X as XIcon,
  ChevronLeft,
  ChevronRight,
  Flag,
  Info,
  Pencil,
  Plus,
  Settings,
} from "lucide-react";
import {
  saveAccuracyCheck,
  updateAccuracyCheck,
  getAccuracyCheckById,
  getSavedMasters,
  getSavedMasterXml,
  propagateMasterCorrection,
  getMasterCheckSiblings,
  type SavedMaster,
} from "@/lib/api/accuracyChecks";
import { getPlatformAnalystNames } from "@/lib/api/analysts";
import { useAuth } from "@/components/auth/AuthContext";
import {
  createDispute,
  getDisputesForCheck,
  resolveDispute,
  disputeKey,
  DISPUTE_CATEGORIES,
  type Dispute,
  type DisputeSide,
  type DisputeCategory,
} from "@/lib/api/disputes";
import {
  parseInstances,
  compareInstances,
  canonicaliseTeams,
  parseHomeAwayFromFileName,
  formatTime,
  parseTime,
  serializeInstances,
  buildCode,
  type Instance,
  type ComparisonRow,
  type MatchStatus,
  type StatBreakdown,
} from "@/lib/comparison/xml-compare";
import {
  jsonEventsToInstances,
  serializeInstancesToJson,
  playerNumberMapFromReport,
  type JsonEvent,
} from "@/lib/comparison/json-adapter";
import { deriveOverlapWindow } from "@/lib/comparison/overlap-window";
import { canFlagRowPure, emptyCellAnchor } from "./dispute-permissions";
import ManageMastersDialog from "./ManageMastersDialog";
import { fetchFixtureReport } from "@/lib/api/fixtureReports";
import {
  generateInsights,
  generateRecommendations,
} from "@/lib/comparison/insights";
import {
  computePlayerAccuracy,
  type AccuracyGroup,
} from "@/lib/comparison/player-accuracy";
import MasterEditModal from "@/components/MasterEditModal";
import {
  buildSeekClips,
  currentSeekIndex,
  nextSkipIndex,
  nearestClipIndex,
  type SeekClip,
} from "./review-seek";

// Accent colors (lms-platform used custom pd-red / pd-navy tokens; reporting-ui
// doesn't define those, so we map to the closest standard Tailwind colors).
const ACCENT = "red-600"; // was pd-red
const ACCENT_BG = "bg-red-600";
const ACCENT_TEXT = "text-red-600";

type LoadedFile = {
  name: string;
  instances: Instance[];
  raw: string;
  /**
   * Where the instances came from. "xml" = a SportsCode XML export (the
   * default). "json" = a JSON event feed converted via jsonEventsToInstances
   * (see the analyst dropzone). Used to badge the source and to skip
   * XML-only affordances (master edit/serialize) for JSON-sourced files.
   */
  kind?: "xml" | "json";
};

const STATUS_META: Record<
  MatchStatus,
  { label: string; badge: string; dot: string }
> = {
  exact: {
    label: "Exact",
    badge: "bg-emerald-100 text-emerald-700",
    dot: "bg-emerald-500",
  },
  wrong_stat: {
    label: "Wrong stat",
    badge: "bg-amber-100 text-amber-700",
    dot: "bg-amber-500",
  },
  wrong_player: {
    label: "Wrong player",
    badge: "bg-orange-100 text-orange-700",
    dot: "bg-orange-500",
  },
  wrong_team: {
    label: "Wrong team",
    badge: "bg-red-100 text-red-700",
    dot: "bg-red-500",
  },
  missed: {
    label: "Missed",
    badge: "bg-slate-200 text-slate-700",
    dot: "bg-slate-400",
  },
  extra: {
    label: "Extra",
    badge: "bg-purple-100 text-purple-700",
    dot: "bg-purple-500",
  },
};

const TONE_META = {
  positive: {
    icon: CheckCircle2,
    ring: "border-emerald-200 bg-emerald-50",
    ic1: "text-emerald-600",
  },
  warning: {
    icon: AlertTriangle,
    ring: "border-amber-200 bg-amber-50",
    ic1: "text-amber-600",
  },
  critical: {
    icon: AlertTriangle,
    ring: "border-red-200 bg-red-50",
    ic1: "text-red-600",
  },
  neutral: {
    icon: Sparkles,
    ring: "border-slate-200 bg-slate-50",
    ic1: "text-slate-500",
  },
};

/**
 * Shape of the JSON event feed (as delivered by the match data API). The
 * timed events live in `allStatistics`; the team names/uids give an
 * authoritative Home/Away signal. Only the fields the adapter needs are
 * described here — extra fields are ignored.
 */
type FeedJson = {
  homeTeamName?: string;
  awayTeamName?: string;
  homeTeamUid?: number;
  awayTeamUid?: number;
  allStatistics?: JsonEvent[];
  // Carries playerUid -> jersey number; raw events have no number of their own.
  allParticipants?: { playerUid?: number | null; playerNumber?: number | null }[];
};

/**
 * Convert a JSON feed's text into a LoadedFile. Throws with a human-readable
 * message when the JSON isn't a recognised feed (no `allStatistics` array) so
 * the dropzone can surface it. The original JSON text is kept as `raw` so it
 * can be re-downloaded/saved unchanged (it is NOT valid XML, so the master
 * edit/serialize path is disabled for json-sourced files — see `kind`).
 */
function loadedFileFromJson(name: string, text: string): LoadedFile {
  let parsed: FeedJson;
  try {
    parsed = JSON.parse(text) as FeedJson;
  } catch {
    throw new Error("That .json file isn't valid JSON.");
  }
  const events = parsed.allStatistics;
  if (!Array.isArray(events)) {
    throw new Error(
      'This JSON has no "allStatistics" array — is it a match event feed?'
    );
  }
  const instances = jsonEventsToInstances(events, {
    playerNumberByUid: playerNumberMapFromReport(parsed),
  });
  if (instances.length === 0) {
    throw new Error("No timed events found in this feed.");
  }
  return { name, instances, raw: text, kind: "json" };
}

/**
 * Rebuild a LoadedFile from stored raw text (used when re-opening a saved
 * check). Detects a JSON feed by file name (.json) or a leading "{" and routes
 * it through the adapter; otherwise treats the text as SportsCode XML. Keeps
 * re-opened checks consistent with how the file was originally uploaded — a
 * JSON-sourced analyst would otherwise parse to zero instances via
 * parseInstances and silently vanish on reload.
 */
function loadedFileFromRaw(name: string, raw: string): LoadedFile {
  const isJson = /\.json$/i.test(name) || raw.trimStart().startsWith("{");
  if (isJson) {
    try {
      return loadedFileFromJson(name, raw);
    } catch {
      // Fall through to XML parsing if the JSON turns out unreadable, so a
      // reopen never hard-fails.
    }
  }
  return { name, instances: parseInstances(raw), raw, kind: "xml" };
}

function Dropzone({
  title,
  subtitle,
  file,
  onLoad,
  onClear,
  allowJson = false,
}: {
  title: string;
  subtitle: string;
  file: LoadedFile | null;
  onLoad: (f: LoadedFile) => void;
  onClear: () => void;
  /**
   * When true the dropzone also accepts a `.json` event feed, converting it to
   * instances via jsonEventsToInstances. Used for the analyst side so a match
   * data feed can be graded against the master XML. The master side stays
   * XML-only (its edit/serialize/download flow requires real XML).
   */
  allowJson?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(fileList: FileList | null) {
    setError(null);
    const f = fileList?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      // Route by extension (falling back to a content sniff): a JSON feed goes
      // through the adapter, everything else is treated as SportsCode XML.
      const isJson =
        allowJson &&
        (/\.json$/i.test(f.name) || text.trimStart().startsWith("{"));
      if (isJson) {
        onLoad(loadedFileFromJson(f.name, text));
        return;
      }
      const instances = parseInstances(text);
      if (instances.length === 0) {
        setError("No <instance> entries found in this file.");
        return;
      }
      onLoad({ name: f.name, instances, raw: text, kind: "xml" });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read that file."
      );
    }
  }

  return (
    <div>
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex h-[68px] cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 transition ${
          file
            ? "border-emerald-300 bg-emerald-50/50"
            : "border-slate-300 bg-slate-50 hover:border-red-500 hover:bg-red-50/40"
        }`}
      >
        <input
          type="file"
          accept={
            allowJson
              ? ".xml,.json,text/xml,application/xml,application/json"
              : ".xml,text/xml,application/xml"
          }
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {file ? (
          <>
            <FileText className="shrink-0 text-emerald-600" size={20} />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-900">
                <span className="truncate">{file.name}</span>
                {file.kind === "json" && (
                  <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                    JSON feed
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-500">
                {file.instances.length}{" "}
                {file.kind === "json" ? "events converted" : "instances parsed"}
              </p>
            </div>
          </>
        ) : (
          <>
            <Upload className="shrink-0 text-slate-400" size={20} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {title}
              </p>
              <p className="text-xs text-slate-500">{subtitle}</p>
            </div>
          </>
        )}
      </label>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {file && (
        <button
          onClick={onClear}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-red-600"
        >
          <X size={13} /> Remove
        </button>
      )}
    </div>
  );
}

function exportStatCsv(stats: StatBreakdown[]) {
  const header = "Statistic Type,Master,Exact,Accuracy %";
  const lines = stats.map(
    (s) =>
      `${JSON.stringify(s.stat)},${s.total},${s.exact},${(
        s.accuracy * 100
      ).toFixed(1)}`
  );
  const totalMaster = stats.reduce((a, s) => a + s.total, 0);
  const totalExact = stats.reduce((a, s) => a + s.exact, 0);
  const totalAcc = totalMaster > 0 ? (totalExact / totalMaster) * 100 : 0;
  lines.push(`Totals,${totalMaster},${totalExact},${totalAcc.toFixed(1)}`);
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "stat-breakdown.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------
// SPORTS
// ------------------------------------------------------------------
// The per-player stats table is sport-specific. Each sport defines:
//   - init():   the zeroed counts object
//   - bump():   classify a stat label into the counts
//   - derive(): compute any totals from the raw counts
//   - columns:  which counts to show (label + accessor)
//   - relevant(): whether a player row has any data worth showing
// This keeps the table generic so new sports just add a config entry.

type Sport = "afl" | "football";

// A counts object is an open string->number map so each sport can use
// its own keys.
type PlayerCounts = Record<string, number>;

type PlayerRow = {
  key: string;
  team: string;
  number: number | null;
  master: PlayerCounts;
  analyst: PlayerCounts;
  analystOnly: boolean;
};

type PlayerCol = {
  key: string;
  label: string;
  get: (c: PlayerCounts) => number;
};

type SportConfig = {
  id: Sport;
  label: string;
  init: () => PlayerCounts;
  bump: (c: PlayerCounts, statLower: string) => void;
  derive: (c: PlayerCounts) => PlayerCounts;
  columns: PlayerCol[];
  relevant: (master: PlayerCounts, analyst: PlayerCounts) => boolean;
  csvName: string;
};

// ---- Aussie Rules ------------------------------------------------
const AFL_CONFIG: SportConfig = {
  id: "afl",
  label: "Aussie Rules",
  init: () => ({ effKick: 0, ineffKick: 0, effHb: 0, ineffHb: 0, marks: 0 }),
  bump: (c, s) => {
    const isKick = s.includes("kick");
    const isHb = s.includes("handball");
    const isEff = s.includes("effective") && !s.includes("ineffective");
    const isIneff = s.includes("ineffective");
    if (isKick && isEff) c.effKick += 1;
    else if (isKick && isIneff) c.ineffKick += 1;
    else if (isHb && isEff) c.effHb += 1;
    else if (isHb && isIneff) c.ineffHb += 1;
    else if (
      s.includes("mark") &&
      (s.includes("contested") || s.includes("uncontested"))
    )
      c.marks += 1;
  },
  derive: (c) => ({
    ...c,
    totalKicks: c.effKick + c.ineffKick,
    totalHb: c.effHb + c.ineffHb,
    disposals: c.effKick + c.ineffKick + c.effHb + c.ineffHb,
  }),
  columns: [
    { key: "disposals", label: "Total Disposals", get: (c) => c.disposals },
    { key: "effKick", label: "Eff Kicks", get: (c) => c.effKick },
    { key: "ineffKick", label: "Ineff Kicks", get: (c) => c.ineffKick },
    { key: "totalKicks", label: "Total Kicks", get: (c) => c.totalKicks },
    { key: "effHb", label: "Eff Handballs", get: (c) => c.effHb },
    { key: "ineffHb", label: "Ineff Handballs", get: (c) => c.ineffHb },
    { key: "totalHb", label: "Total Handballs", get: (c) => c.totalHb },
    { key: "marks", label: "Marks", get: (c) => c.marks },
  ],
  relevant: (m, a) =>
    m.disposals + m.marks + a.disposals + a.marks > 0,
  csvName: "player-disposals-marks.csv",
};

// ---- Football (Soccer) -------------------------------------------
// Stat keywords match the actual labels used in the football XML, e.g.
// "Short Passes Successful", "Crosses Unsuccesful" (note the source's
// misspelling), "Ground Duels Won", "Shots Off Target", etc.
const FOOTBALL_CONFIG: SportConfig = {
  id: "football",
  label: "Football",
  init: () => ({
    shortPassSucc: 0,
    shortPassUnsucc: 0,
    longPassSucc: 0,
    longPassUnsucc: 0,
    throughSucc: 0,
    throughUnsucc: 0,
    crossSucc: 0,
    crossUnsucc: 0,
    touches: 0,
    carries: 0,
    shots: 0,
    goals: 0,
    tacklesSucc: 0,
    tacklesUnsucc: 0,
    dribblesSucc: 0,
    dribblesUnsucc: 0,
    interceptions: 0,
    clearances: 0,
    ballRecoveries: 0,
    groundDuelsWon: 0,
    groundDuelsLost: 0,
    aerialWon: 0,
    aerialLost: 0,
    headers: 0,
    fouls: 0,
    foulsDrawn: 0,
    // Goalkeeper
    gkSaves: 0,
    gkBlocks: 0,
    gkCatches: 0,
    gkClaims: 0,
    gkPunches: 0,
    gkGoalKicks: 0,
    gkThrows: 0,
  }),
  bump: (c, s) => {
    // Goalkeeper stats first — some labels contain words that later checks
    // would otherwise swallow (e.g. "Goal Kick" contains "goal"/"kick",
    // "keeper throw" is a distinct action, saves/blocks/catches are GK-only).
    if (s.includes("save")) c.gkSaves += 1;
    else if (s.includes("block")) c.gkBlocks += 1;
    else if (s.includes("catch")) c.gkCatches += 1;
    else if (s.includes("claim")) c.gkClaims += 1;
    else if (s.includes("punch")) c.gkPunches += 1;
    else if (s.includes("goal kick")) c.gkGoalKicks += 1;
    else if (
      (s.includes("keeper") || s.includes("goalkeeper")) &&
      s.includes("throw")
    )
      c.gkThrows += 1;
    // Shots & goals (before generic pass/cross checks).
    else if (s.includes("goal") && !s.includes("goal kick")) c.goals += 1;
    else if (s.includes("shot")) c.shots += 1; // off target / saved / free kick shots
    // Passing
    else if (s.includes("short pass") && s.includes("unsuccessful"))
      c.shortPassUnsucc += 1;
    else if (s.includes("short pass") && s.includes("successful"))
      c.shortPassSucc += 1;
    else if (s.includes("long pass") && s.includes("unsuccessful"))
      c.longPassUnsucc += 1;
    else if (s.includes("long pass") && s.includes("successful"))
      c.longPassSucc += 1;
    else if (s.includes("through ball") && s.includes("unsuccessful"))
      c.throughUnsucc += 1;
    else if (s.includes("through ball") && s.includes("successful"))
      c.throughSucc += 1;
    // Bare "Through Balls" (no outcome) — count toward the Through Balls total.
    else if (s.includes("through ball")) c.throughSucc += 1;
    // Crosses — source misspells "Unsuccesful" (one 's'), so match both.
    else if (
      s.includes("cross") &&
      (s.includes("unsuccessful") || s.includes("unsuccesful"))
    )
      c.crossUnsucc += 1;
    else if (s.includes("cross") && s.includes("successful"))
      c.crossSucc += 1;
    // Bare "Crosses" (no outcome) — count toward the Crosses total.
    else if (s.includes("cross")) c.crossSucc += 1;
    // On-ball
    else if (s.includes("touch")) c.touches += 1;
    else if (s.includes("carr")) c.carries += 1; // Carries
    // Defensive / duels
    else if (s.includes("tackle") && s.includes("unsuccessful"))
      c.tacklesUnsucc += 1;
    else if (s.includes("tackle") && s.includes("successful"))
      c.tacklesSucc += 1;
    else if (s.includes("dribble") && s.includes("unsuccessful"))
      c.dribblesUnsucc += 1;
    else if (s.includes("dribble") && s.includes("successful"))
      c.dribblesSucc += 1;
    else if (s.includes("intercept")) c.interceptions += 1;
    else if (s.includes("clearance")) c.clearances += 1;
    else if (s.includes("ball recover")) c.ballRecoveries += 1;
    else if (s.includes("ground duels won")) c.groundDuelsWon += 1;
    else if (s.includes("ground duels lost")) c.groundDuelsLost += 1;
    else if (s.includes("aerial win")) c.aerialWon += 1;
    else if (s.includes("aerial loss")) c.aerialLost += 1;
    else if (s.includes("header")) c.headers += 1;
    else if (s.includes("fouls drawn")) c.foulsDrawn += 1;
    else if (s.includes("foul")) c.fouls += 1;
  },
  derive: (c) => ({
    ...c,
    // Passes EXCLUDE through balls — through balls are their own column, so
    // this keeps the table consistent with the Passing card (no double-count).
    passSucc: c.shortPassSucc + c.longPassSucc,
    passUnsucc: c.shortPassUnsucc + c.longPassUnsucc,
    totalPasses:
      c.shortPassSucc +
      c.longPassSucc +
      c.shortPassUnsucc +
      c.longPassUnsucc,
    crosses: c.crossSucc + c.crossUnsucc,
    tackles: c.tacklesSucc + c.tacklesUnsucc,
  }),
  columns: [
    { key: "touches", label: "Touches", get: (c) => c.touches },
    { key: "totalPasses", label: "Passes", get: (c) => c.totalPasses },
    { key: "passSucc", label: "Pass Succ", get: (c) => c.passSucc },
    { key: "passUnsucc", label: "Pass Unsucc", get: (c) => c.passUnsucc },
    {
      key: "throughBalls",
      label: "Through Balls",
      get: (c) => c.throughSucc + c.throughUnsucc,
    },
    { key: "carries", label: "Carries", get: (c) => c.carries },
    { key: "crosses", label: "Crosses", get: (c) => c.crosses },
    { key: "shots", label: "Shots", get: (c) => c.shots },
    { key: "goals", label: "Goals", get: (c) => c.goals },
    {
      key: "dribbles",
      label: "Dribbles",
      get: (c) => c.dribblesSucc + c.dribblesUnsucc,
    },
    { key: "tackles", label: "Tackles", get: (c) => c.tackles },
    {
      key: "interceptions",
      label: "Intercepts",
      get: (c) => c.interceptions,
    },
    { key: "clearances", label: "Clearances", get: (c) => c.clearances },
    {
      key: "ballRecoveries",
      label: "Ball Recov",
      get: (c) => c.ballRecoveries,
    },
    {
      key: "groundDuels",
      label: "Ground Duels",
      get: (c) => c.groundDuelsWon + c.groundDuelsLost,
    },
    {
      key: "aerialDuels",
      label: "Aerial Duels",
      get: (c) => c.aerialWon + c.aerialLost,
    },
    { key: "headers", label: "Headers", get: (c) => c.headers },
    { key: "fouls", label: "Fouls", get: (c) => c.fouls },
  ],
  relevant: (m, a) => {
    const sum = (c: PlayerCounts) =>
      c.touches +
      c.totalPasses +
      c.throughSucc +
      c.throughUnsucc +
      c.carries +
      c.crosses +
      c.shots +
      c.goals +
      c.tackles +
      c.interceptions +
      c.clearances +
      c.ballRecoveries +
      c.dribblesSucc +
      c.dribblesUnsucc +
      c.groundDuelsWon +
      c.groundDuelsLost +
      c.aerialWon +
      c.aerialLost +
      c.headers +
      c.fouls;
    return sum(m) + sum(a) > 0;
  },
  csvName: "player-football-stats.csv",
};

const SPORT_CONFIGS: Record<Sport, SportConfig> = {
  afl: AFL_CONFIG,
  football: FOOTBALL_CONFIG,
};

/**
 * Does a single stat (lowercased) contribute to the given column for this
 * sport? Reuses the config's own bump()+derive() so it always matches how
 * the table is built: run the classifier on a fresh counts object holding
 * just this stat, then check whether the column's accessor picked it up.
 */
function statMatchesColumn(
  config: SportConfig,
  columnKey: string,
  statLower: string
): boolean {
  const col = config.columns.find((c) => c.key === columnKey);
  if (!col) return false;
  const counts = config.init();
  config.bump(counts, statLower);
  return col.get(config.derive(counts)) > 0;
}

function FragmentSubHead() {
  return (
    <>
      <th className="border-b border-l border-slate-200 px-2 py-1 text-center font-semibold">
        M
      </th>
      <th className="border-b border-slate-200 px-2 py-1 text-center font-semibold">
        A
      </th>
    </>
  );
}

function PlayerCells({
  master,
  analyst,
  mismatch,
  onClick,
}: {
  master: number;
  analyst: number;
  mismatch: boolean;
  /** When set, the pair of cells is clickable to review this stat/player. */
  onClick?: () => void;
}) {
  const clickable = !!onClick && master + analyst > 0;
  const base = clickable ? "cursor-pointer hover:bg-sky-50" : "";
  return (
    <>
      <td
        onClick={clickable ? onClick : undefined}
        title={clickable ? "Review this stat for this player in video" : undefined}
        className={`border-l border-slate-200 px-2 py-2 text-center tabular-nums text-slate-700 ${base}`}
      >
        {master}
      </td>
      <td
        onClick={clickable ? onClick : undefined}
        title={clickable ? "Review this stat for this player in video" : undefined}
        className={`px-2 py-2 text-center tabular-nums font-semibold ${
          mismatch ? "text-red-600" : "text-emerald-600"
        } ${base}`}
      >
        {analyst}
      </td>
    </>
  );
}

function exportPlayerCsv(rows: PlayerRow[], cols: PlayerCol[], fileName: string) {
  const head = ["Player"];
  for (const col of cols) head.push(`${col.label} (M)`, `${col.label} (A)`);
  head.push("Analyst only");
  const lines = rows.map((p) => {
    const cells: string[] = [JSON.stringify(p.key)];
    for (const col of cols)
      cells.push(String(col.get(p.master)), String(col.get(p.analyst)));
    cells.push(p.analystOnly ? "yes" : "");
    return cells.join(",");
  });
  const csv = [head.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// A Player Accuracy card: shows the group's exact-match %, the exact/master
// totals, and an info icon revealing the per-stat breakdown (exact vs master)
// and the exact / master formula. This matches the per-stat breakdown table.
function PlayerAccuracyCard({
  label,
  group,
  highlight = false,
}: {
  label: string;
  group: AccuracyGroup;
  /** Emphasised styling for the summary (Overall) card. */
  highlight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A group with no master events has no data — show "—", not a %/colour.
  // Guard on master (not just pct) so a 0/0 group is never treated as 100%.
  const hasData = group.master > 0 && group.pct != null;
  const accent =
    !hasData
      ? "text-slate-400"
      : group.pct! >= 0.9
        ? "text-emerald-600"
        : group.pct! >= 0.8
          ? "text-yellow-500"
          : group.pct! >= 0.7
            ? "text-orange-500"
            : "text-red-600";

  return (
    <div
      className={`relative rounded-2xl border p-4 shadow-sm ${
        highlight
          ? "border-slate-300 bg-slate-50"
          : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onBlur={() => setOpen(false)}
          aria-label={`How ${label} is calculated`}
          className="-mr-1 -mt-1 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <Info size={15} />
        </button>
      </div>
      <p className={`mt-1 text-2xl font-bold ${accent}`}>
        {hasData ? `${(group.pct! * 100).toFixed(1)}%` : "—"}
      </p>
      <p className="text-xs text-slate-500">
        {hasData
          ? `${group.exact}/${group.master} exact`
          : "No data to compare"}
      </p>

      {open && (
        <div className="absolute right-2 top-10 z-20 w-64 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-lg">
          <p className="mb-2 text-xs font-semibold text-slate-700">
            How this % is calculated
          </p>
          <table className="w-full text-[11px] text-slate-600">
            <thead>
              <tr className="text-slate-400">
                <th className="pb-1 text-left font-medium">Stat</th>
                <th className="pb-1 text-right font-medium">Exact</th>
                <th className="pb-1 text-right font-medium">Master</th>
                <th className="pb-1 text-right font-medium">Acc</th>
              </tr>
            </thead>
            <tbody>
              {group.parts.map((p) => {
                const acc = p.master === 0 ? 1 : p.exact / p.master;
                return (
                  <tr key={p.label}>
                    <td className="py-0.5 text-left">{p.label}</td>
                    <td className="py-0.5 text-right tabular-nums">{p.exact}</td>
                    <td className="py-0.5 text-right tabular-nums">
                      {p.master}
                    </td>
                    <td
                      className={`py-0.5 text-right tabular-nums ${
                        p.master === 0
                          ? "text-slate-400"
                          : acc >= 0.9
                            ? "text-emerald-600"
                            : acc >= 0.8
                              ? "text-yellow-500"
                              : acc >= 0.7
                                ? "text-orange-500"
                                : "text-red-600"
                      }`}
                    >
                      {p.master === 0 ? "—" : `${(acc * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-slate-200 font-semibold text-slate-700">
                <td className="pt-1 text-left">Total</td>
                <td className="pt-1 text-right tabular-nums">{group.exact}</td>
                <td className="pt-1 text-right tabular-nums">{group.master}</td>
                <td className="pt-1 text-right tabular-nums">
                  {hasData ? `${(group.pct! * 100).toFixed(0)}%` : "—"}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-500">
            <p className="text-slate-500">
              Exact = master events the analyst matched exactly (team, player,
              stat and timing all agree).
            </p>
            <p className="mt-1 font-mono text-slate-600">exact / master</p>
            <p className="mt-1">
              = {group.exact} / {group.master} ={" "}
              <span className="font-semibold text-slate-700">
                {hasData ? `${(group.pct! * 100).toFixed(1)}%` : "—"}
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}


export default function AccuracyComparePage() {
  return (
    <Suspense fallback={null}>
      <AccuracyCompareInner />
    </Suspense>
  );
}

function AccuracyCompareInner() {
  const searchParams = useSearchParams();
  const [master, setMaster] = useState<LoadedFile | null>(null);
  const [analyst, setAnalyst] = useState<LoadedFile | null>(null);
  const [tolerance, setTolerance] = useState(3);
  const [statusFilter, setStatusFilter] = useState<MatchStatus | "all">("all");
  const [teamFilter, setTeamFilter] = useState<string | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | "all">("all");
  const [statFilter, setStatFilter] = useState<string | "all">("all");

  const [rangeMode, setRangeMode] = useState<"auto" | "full" | "manual">(
    "auto"
  );
  const [manualStart, setManualStart] = useState("");
  const [manualEnd, setManualEnd] = useState("");

  // Active sport — drives which per-player stats table is shown.
  const [sport, setSport] = useState<Sport>("afl");
  const sportConfig = SPORT_CONFIGS[sport];

  // Video review: paste a URL, open a player, click any stat to seek.
  const [videoUrl, setVideoUrl] = useState("");
  const [videoOpen, setVideoOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Optional player+stat focus for the video review, set by clicking a cell
  // in the player stats table. When set, the review timeline shows only that
  // player's instances of that column's stat(s). Cleared to review by stat.
  const [reviewPlayer, setReviewPlayer] = useState<{
    team: string;
    number: number | null;
    columnKey: string;
    columnLabel: string;
  } | null>(null);

  // Status filter inside the video review (Exact / Missed / Wrong stat …).
  // Independent of the main page's status filter.
  const [videoStatusFilter, setVideoStatusFilter] = useState<
    MatchStatus | "all"
  >("all");
  // When on, the review shows only instances that have been flagged.
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  // Disputes: which saved check is loaded (if any), so instances can be
  // flagged and the flags reflected in both timelines.
  const { user } = useAuth();
  const [loadedCheckId, setLoadedCheckId] = useState<number | null>(null);
  // Mirror of loadedCheckId for the URL-sync effect to read without adding
  // loadedCheckId to its deps (which would re-run the reset on every load).
  const loadedCheckIdRef = useRef<number | null>(null);
  useEffect(() => {
    loadedCheckIdRef.current = loadedCheckId;
  }, [loadedCheckId]);
  const [checkAnalystName, setCheckAnalystName] = useState<string | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  // Right-click context menu target for flagging.
  const [flagMenu, setFlagMenu] = useState<{
    x: number;
    y: number;
    instance: Instance;
    side: DisputeSide;
  } | null>(null);

  // Only the analyst a check is saved to may FLAG (raise) disputes — this is
  // their review of their own game. ANY role may flag — the gate is that the
  // check is allocated to THIS user (their analyst_name matches the check's),
  // so e.g. an admin who is also the allocated analyst can raise disputes on
  // their own check. (Resolving stays admin-only, below.)
  const canFlag =
    loadedCheckId != null &&
    !!user &&
    !!user.analyst_name &&
    !!checkAnalystName &&
    user.analyst_name.trim().toLowerCase() ===
      checkAnalystName.trim().toLowerCase();

  // Only admins/super admins may RESOLVE a flagged instance (Analyst correct /
  // Master correct) from the review pop-up.
  const canResolveDispute =
    loadedCheckId != null &&
    (user?.role === "admin" || user?.role === "super_admin");

  // Who may FLAG a given comparison row. The allocated analyst (`canFlag`) may
  // flag any row; any logged-in user viewing a loaded check may flag an
  // empty-slot (missed/extra) row — the dispute attaches to the single
  // populated side. Fully-populated rows stay allocated-analyst-only. The
  // `hasCheck` guard gates the empty-slot arm for non-allocated users; keep it.
  const canFlagRow = (status: MatchStatus): boolean =>
    canFlagRowPure(status, {
      isAllocated: canFlag,
      isLoggedIn: !!user,
      hasCheck: loadedCheckId != null,
    });

  // Only admins/super admins may EDIT the master (fix a mis-coded player/stat,
  // remove a bad instance, or add one the master missed). Edits recompute the
  // accuracy live and can be downloaded / saved as a corrected master.
  // Master editing is admin-only AND requires a real XML master: the edit /
  // download / propagate flow serializes back to SportsCode XML, which a JSON
  // feed can't round-trip through. So a JSON-sourced master is read-only —
  // still fully comparable, just not correctable in place.
  const masterIsJson = master?.kind === "json";
  const canEditMaster =
    (user?.role === "admin" || user?.role === "super_admin") && !masterIsJson;

  // Only admins/super admins may MANAGE saved masters (rename / delete /
  // replace) from the "reuse a saved master" area. Mirrors the gates above.
  // Non-admins never see or trigger these controls.
  const canManageMasters =
    user?.role === "admin" || user?.role === "super_admin";

  // Which master instance is being edited (by id), or "new" to add one.
  const [editingMaster, setEditingMaster] = useState<Instance | "new" | null>(
    null
  );

  // Open the editor for a master instance. Timeline rows carry the
  // CANONICALISED instance (team = "Home"/"Away"), but we edit the ORIGINAL
  // master instances (real club names). Resolve back to the original by id so
  // the modal shows/keeps the real team name rather than "Home"/"Away".
  const editMasterInstance = (canonical: Instance) => {
    const original =
      master?.instances.find((i) => i.id === canonical.id) ?? canonical;
    setEditingMaster(original);
  };



  // Replace the master's instances and keep the raw XML in sync (so a Save or
  // Download reflects the edit). Re-parsing the serialized XML normalises the
  // instances (recomputes `mid`, playerNumber from code, etc.) exactly like a
  // fresh upload, keeping every downstream memo consistent.
  const applyMasterInstances = (next: Instance[]) => {
    setMaster((cur) => {
      if (!cur) return cur;
      const raw = serializeInstances(next);
      return { ...cur, instances: parseInstances(raw), raw };
    });
  };

  const upsertMasterInstance = (inst: Instance) => {
    if (!master) return;
    const exists = master.instances.some((i) => i.id === inst.id);
    const next = exists
      ? master.instances.map((i) => (i.id === inst.id ? inst : i))
      : [...master.instances, inst];
    applyMasterInstances(next);
    setEditingMaster(null);
  };

  const deleteMasterInstance = (id: string) => {
    if (!master) return;
    applyMasterInstances(master.instances.filter((i) => i.id !== id));
    setEditingMaster(null);
  };



  // Vocabulary of valid { stat, category } pairs, from every stat present in
  // the master + analyst files. Powers the edit dropdowns so a stat can only
  // be set to a real, correctly-spelled label (and its category auto-fills).
  const statCatalog = useMemo(() => {
    const map = new Map<string, { stat: string; category: string }>();
    const add = (i: Instance) => {
      const stat = i.stat.trim();
      if (!stat) return;
      const key = stat.toLowerCase();
      if (!map.has(key)) map.set(key, { stat, category: i.category.trim() });
    };
    for (const i of master?.instances ?? []) add(i);
    for (const i of analyst?.instances ?? []) add(i);
    return Array.from(map.values()).sort((a, b) =>
      a.stat.localeCompare(b.stat)
    );
  }, [master, analyst]);

  // Download the (possibly edited) master as a corrected .xml file.
  const downloadMaster = () => {
    if (!master) return;
    const blob = new Blob([master.raw], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = master.name.replace(/\.xml$/i, "");
    a.download = `${base}-corrected.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Download the (possibly edited) master timeline as JSON, built from the
  // parsed instances (independent of the master's source format). Round-trips
  // through jsonEventsToInstances / instancesFromRaw.
  const downloadMasterJson = () => {
    if (!master) return;
    const json = serializeInstancesToJson(master.instances);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = master.name.replace(/\.(xml|json)$/i, "");
    a.download = `${base}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Save the corrected master back to EVERY check of this master (shared
  // source of truth), re-grading each against its own analyst. Only available
  // when a saved check is loaded (so we have the master file name).
  const [savingMaster, setSavingMaster] = useState(false);
  const [masterSaveMsg, setMasterSaveMsg] = useState<string | null>(null);
  const saveCorrectedMaster = async () => {
    if (!master || loadedCheckId == null) return;
    const fileName = master.name;
    let siblings = { count: 1, analysts: [] as string[] };
    try {
      siblings = await getMasterCheckSiblings(fileName);
    } catch {
      /* fall back */
    }
    const others = Math.max(0, siblings.count - 1);
    const confirmed = window.confirm(
      `Correcting this master updates all ${siblings.count} check` +
        `${siblings.count === 1 ? "" : "s"} of "${fileName}"` +
        (others > 0
          ? ` and re-grades ${others} other analyst check${
              others === 1 ? "" : "s"
            } (${siblings.analysts.join(", ")}).`
          : ".") +
        `\n\nContinue?`
    );
    if (!confirmed) return;

    setSavingMaster(true);
    setMasterSaveMsg(null);
    try {
      const res = await propagateMasterCorrection(fileName, master.raw);
      setMasterSaveMsg(
        `Saved. Master corrected across ${res.updated} check` +
          `${res.updated === 1 ? "" : "s"}` +
          (res.analysts.length ? ` (${res.analysts.join(", ")}).` : ".")
      );
    } catch (err) {
      setMasterSaveMsg(
        err instanceof Error ? err.message : "Failed to save corrected master."
      );
    } finally {
      setSavingMaster(false);
    }
  };

  // Fast lookup of flagged instances by "instanceId|side".
  const flaggedKeys = useMemo(() => {
    const m = new Map<string, Dispute>();
    for (const d of disputes) m.set(disputeKey(d.instance_id, d.side), d);
    return m;
  }, [disputes]);

  const reloadDisputes = async (checkId: number) => {
    try {
      setDisputes(await getDisputesForCheck(checkId));
    } catch (err) {
      console.error("Failed loading disputes:", err);
    }
  };

  // Index of the current clip within the filtered review rows, so Prev/Next
  // can step (and seek) between instances instead of playing through gaps.
  const [reviewIndex, setReviewIndex] = useState(0);

  // Auto-skip: when on, playback jumps to the next instance as soon as the
  // current instance's XML end time is reached (skipping the gaps).
  const [autoSkip, setAutoSkip] = useState(true);
  // Refs so the video's timeupdate handler reads fresh values without
  // re-binding or capturing stale closures.
  const reviewIndexRef = useRef(0);
  const autoSkipRef = useRef(true);
  // Start-sorted seek list (NOT display order) that the auto-skip handler
  // walks, so it never seeks backward. Mirrors the `seekClips` memo below.
  const reviewClipsRef = useRef<SeekClip[]>([]);
  // Set true only while WE assign currentTime (a programmatic gap-skip). The
  // <video> onSeeked handler clears it. The timeupdate handler early-returns
  // while it's set, so our own seek can't retrigger another skip. User scrubs
  // leave it false and are handled as manual seeks.
  const skippingRef = useRef(false);
  // Last observed playback time (retained for minimal churn; the new seek
  // logic derives everything from the current playhead, not this delta).
  const lastTimeRef = useRef(0);
  useEffect(() => {
    reviewIndexRef.current = reviewIndex;
  }, [reviewIndex]);
  useEffect(() => {
    autoSkipRef.current = autoSkip;
  }, [autoSkip]);

  // Current playback position (seconds), used to highlight the stat(s)
  // whose [start, end] window is on screen right now.
  const [videoTime, setVideoTime] = useState(0);

  // Ref to the currently-active timeline row so we can keep it in view
  // as the video plays.
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [videoTime]);

  // Seek the (open) video to a given second. Clicking a timeline row
  // jumps to the instance's START time (the lead-in of the coded
  // window) so you see the build-up to the action. If the player isn't
  // mounted yet (first click opens it), retry briefly until the <video>
  // element exists.
  const seekVideo = (seconds: number) => {
    setVideoOpen(true);
    const target = Math.max(0, seconds);
    let attempts = 0;
    const trySeek = () => {
      const v = videoRef.current;
      if (v) {
        v.currentTime = target;
        v.play().catch(() => {});
        return;
      }
      if (attempts++ < 30) requestAnimationFrame(trySeek);
    };
    requestAnimationFrame(trySeek);
  };

  // Step to a clip (filtered review row) by index and seek the video to it.
  // Defined via ref-free closure over reviewSeekTimes at call sites below.
  const goToClip = (index: number, times: number[]) => {
    if (times.length === 0) return;
    const clamped = Math.max(0, Math.min(index, times.length - 1));
    setReviewIndex(clamped);
    seekVideo(times[clamped]);
  };

  // Video time updates: track position for row highlighting, and (when
  // auto-skip is on) jump to the next instance once the current instance's
  // XML end time is reached, so playback skips the gaps between clips.
  const handleVideoTimeUpdate = (
    e: React.SyntheticEvent<HTMLVideoElement>
  ) => {
    const t = e.currentTarget.currentTime;
    lastTimeRef.current = t;
    setVideoTime(t);

    // `clips` is the dedicated start-sorted seek list (see `seekClips` memo),
    // so start/end are non-decreasing by index and we never seek backward.
    const clips = reviewClipsRef.current;
    if (clips.length === 0) return;

    // Self-seek guard: this tick is the echo of OUR programmatic gap-skip
    // (we set currentTime, the browser is settling). Don't skip again — the
    // <video> onSeeked handler clears the flag once the seek completes. User
    // scrubs leave skippingRef false and fall through to normal handling.
    if (skippingRef.current) return;

    // Derive the current clip straight from the playhead (binary search for
    // the last clip starting at/before t) instead of a forward-only cursor
    // that could drift. `inWindow` means the playhead is actually inside the
    // clip's [start,end] window (vs. the dead air after it).
    const cur = currentSeekIndex(clips, t);
    const inWindow = cur >= 0 && t <= clips[cur].end;

    // Keep the DISPLAY-order cursor (reviewIndex: Prev/Next + "N / M" counter)
    // in sync with what is actually playing. When the playhead is inside a
    // clip, use that clip's display row; otherwise (gap or before the first
    // clip) use the clip NEAREST in time, so the cursor matches the closest
    // instance rather than a stale index. The row HIGHLIGHT is driven directly
    // off `videoTime` elsewhere, so this only moves the Prev/Next cursor.
    const rowSource = inWindow ? cur : nearestClipIndex(clips, t);
    if (rowSource >= 0) {
      const rowIdx = clips[rowSource].rowIndex;
      if (rowIdx !== reviewIndexRef.current) {
        reviewIndexRef.current = rowIdx;
        setReviewIndex(rowIdx);
      }
    }

    // Auto-skip OFF: play straight through. Only the highlight (playhead-
    // driven) and the cursor advance; we NEVER write currentTime.
    if (!autoSkipRef.current) return;

    // Auto-skip ON: only jump across genuine forward GAPS (dead air). While
    // the playhead is inside a clip window, let it play through (clusters /
    // overlapping stats in the same window play naturally).
    if (inWindow) return;

    const nextIdx = nextSkipIndex(clips, t); // first clip starting after t
    if (nextIdx >= clips.length) {
      // No coded clip ahead. If we're also past the last clip's end, stop so
      // playback doesn't run into unrelated game action. (If t were inside a
      // clip we'd have returned above.)
      videoRef.current?.pause();
      return;
    }

    const GAP = 1; // seconds of dead air before we bother skipping
    const nextStart = clips[nextIdx].start;
    if (nextStart > t + GAP) {
      const v = videoRef.current;
      if (v) {
        skippingRef.current = true;
        v.currentTime = Math.max(0, nextStart);
        lastTimeRef.current = nextStart;
        v.play().catch(() => {});
      }
    }
  };

  // Open the video review focused on one player's instances of a single
  // stat column (clicked from the player stats table), and jump the video to
  // the first matching instance instead of leaving it at the game start.
  const openPlayerReview = (
    player: { team: string; number: number | null },
    col: { key: string; label: string }
  ) => {
    setReviewPlayer({
      team: player.team,
      number: player.number,
      columnKey: col.key,
      columnLabel: col.label,
    });
    setVideoStatFilter("all");

    // Find the earliest matching instance so playback starts there.
    const teamLower = player.team.toLowerCase();
    const matches = (i: Instance | null) =>
      !!i &&
      i.team.toLowerCase() === teamLower &&
      i.playerNumber === player.number &&
      statMatchesColumn(sportConfig, col.key, i.stat.toLowerCase());

    let firstStart: number | null = null;
    for (const row of result?.rows ?? []) {
      for (const inst of [row.master, row.analyst]) {
        if (matches(inst)) {
          const s = (inst as Instance).start;
          if (firstStart === null || s < firstStart) firstStart = s;
        }
      }
    }

    // Open the video review on the first matching instance when a video is
    // available; the review list is filtered to this player either way.
    if (videoUrl.trim()) {
      if (firstStart !== null) {
        // seekVideo also opens the modal.
        seekVideo(firstStart);
      } else {
        setVideoOpen(true);
      }
    } else {
      // No video: still open the review panel so the filtered instance list
      // (missed / extra / exact for this player+stat) is visible.
      setVideoOpen(true);
    }
  };

  // Right-click a timeline instance in the video review. Analysts get the
  // flag form; admins get resolve options on already-flagged instances.
  const openFlagMenu = (
    e: React.MouseEvent,
    instance: Instance,
    side: DisputeSide,
    status: MatchStatus
  ) => {
    const isFlagged = flaggedKeys.has(disputeKey(instance.id, side));
    const allowFlag = canFlagRow(status);
    const allowResolve = canResolveDispute && isFlagged;
    if (!allowFlag && !allowResolve) return;
    e.preventDefault();
    setFlagMenu({ x: e.clientX, y: e.clientY, instance, side });
  };

  const submitFlag = async (
    reason: string | null,
    category: DisputeCategory | null
  ) => {
    if (!flagMenu || loadedCheckId == null) return;
    const { instance, side } = flagMenu;
    setFlagMenu(null);
    try {
      await createDispute({
        checkId: loadedCheckId,
        instanceId: instance.id,
        side,
        stat: instance.stat || null,
        player:
          instance.playerNumber != null
            ? `#${instance.playerNumber}`
            : instance.playerRaw || null,
        team: instance.team || null,
        codeTime: instance.mid,
        raisedBy: user?.username ?? null,
        reason,
        category,
      });
      await reloadDisputes(loadedCheckId);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to flag instance.");
    }
  };

  // Admin resolves a flagged instance from the review pop-up.
  const submitResolve = async (
    status: "confirmed" | "denied",
    note: string | null
  ) => {
    if (!flagMenu || loadedCheckId == null) return;
    const dispute = flaggedKeys.get(
      disputeKey(flagMenu.instance.id, flagMenu.side)
    );
    setFlagMenu(null);
    if (!dispute) return;
    try {
      await resolveDispute(dispute.id, status, user?.username ?? null, note);
      await reloadDisputes(loadedCheckId);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to resolve.");
    }
  };

  // Close the flag menu on any outside click / escape.
  useEffect(() => {
    if (!flagMenu) return;
    const close = () => setFlagMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFlagMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [flagMenu]);

  // Previously-saved masters, for the "reuse master" dropdown. Only the
  // file names are loaded up front; the chosen master's XML is fetched on
  // demand (see getSavedMasterXml) to keep this list fast.
  const [savedMasters, setSavedMasters] = useState<SavedMaster[]>([]);
  // Whether the admin-only "Manage saved masters" dialog is open.
  const [manageMastersOpen, setManageMastersOpen] = useState(false);
  // Re-fetch the saved-master list. Shared by the initial load effect and the
  // post-mutation refresh after a rename/delete/replace in the dialog.
  const refreshSavedMasters = async () => {
    const m = await getSavedMasters();
    setSavedMasters(m);
    return m;
  };
  const [loadingSavedMaster, setLoadingSavedMaster] = useState(false);

  // Analyst allocation + save
  const [analystNames, setAnalystNames] = useState<string[]>([]);
  const [masterAnalyst, setMasterAnalyst] = useState("");
  const [gradedAnalyst, setGradedAnalyst] = useState("");
  const [matchLabel, setMatchLabel] = useState("");
  // Whether the user has typed their own label. Until they do, the
  // label auto-defaults to AnalystName_AnalystFilename.
  const [labelEdited, setLabelEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Load the distinct analyst names for the allocation dropdowns. Unions the
  // shared platform `analysts` table (manually-added analysts) with the
  // Deputy roster, so newly-added analysts appear here immediately.
  useEffect(() => {
    let cancelled = false;

    getPlatformAnalystNames()
      .then((names) => {
        if (!cancelled) setAnalystNames(names);
      })
      .catch((err) => console.error("Failed loading analyst names:", err));

    return () => {
      cancelled = true;
    };
  }, []);

  // Load previously-saved master XMLs for the reuse dropdown.
  useEffect(() => {
    let cancelled = false;
    getSavedMasters().then((m) => {
      if (!cancelled) setSavedMasters(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Which ?check=<id> we've already loaded into state. Guards the effect below
  // from re-fetching (and overwriting in-memory MASTER EDITS) when
  // `searchParams` changes reference on unrelated re-renders — e.g. after an
  // admin edits a master instance and setMaster triggers a render.
  const loadedFromUrlRef = useRef<string | null>(null);
  // The fixture id whose master is currently loaded (or being fetched). Used
  // to de-dupe the S3 fetch WITHOUT falling foul of React 18 Strict Mode's
  // double effect invoke in dev: the ref is set only AFTER a successful load,
  // and a fetch already in flight for this id is tracked separately, so the
  // mount→cleanup→mount cycle doesn't cancel the one and only fetch.
  const loadedFixtureRef = useRef<string | null>(null);
  const fetchingFixtureRef = useRef<string | null>(null);
  // Same de-dupe pair for the ANALYST side (loaded from its own fixture report
  // on S3 via ?analystFixtureId=…).
  const loadedAnalystFixtureRef = useRef<string | null>(null);
  const fetchingAnalystFixtureRef = useRef<string | null>(null);

  // Re-open a saved check: if the URL has ?check=<id>, load that check
  // from Supabase, parse its stored XML back into master/analyst, and
  // restore the allocation/label so the full comparison is rebuilt.
  useEffect(() => {
    const checkId = searchParams.get("check");
    const fixtureId = searchParams.get("fixtureId");
    const analystFixtureId = searchParams.get("analystFixtureId");

    // Deep-link from the Fixture Accuracy picker: ?fixtureId=<jadeUid> loads
    // the MASTER timeline from that fixture's S3 report (JSON), and the
    // optional ?analystFixtureId=<jadeUid> loads the ANALYST timeline from its
    // own fixture report — so a comparison can be built entirely from S3 with
    // no manual uploads. Handled before the ?check= path (mutually exclusive).
    if ((fixtureId || analystFixtureId) && !checkId) {
      const sportParam = searchParams.get("sport");
      if (sportParam === "afl" || sportParam === "football") {
        setSport(sportParam);
      }

      // Load one side (master or analyst) from a fixture report. De-dupe via a
      // loaded/fetching ref pair so React 18 Strict Mode's double effect invoke
      // in dev can't cancel the one fetch (same fix as the master side).
      const loadSide = (
        id: string,
        side: "master" | "analyst",
        loadedRef: MutableRefObject<string | null>,
        fetchingRef: MutableRefObject<string | null>
      ) => {
        if (loadedRef.current === id || fetchingRef.current === id) return;
        fetchingRef.current = id;
        (async () => {
          try {
            const report = await fetchFixtureReport(id, { cache: "no-store" });
            const events = Array.isArray(report.allStatistics)
              ? (report.allStatistics as unknown as JsonEvent[])
              : [];
            // Raw events carry no jersey number — join it from participants.
            const instances = jsonEventsToInstances(events, {
              playerNumberByUid: playerNumberMapFromReport(report),
            });
            const home = report.homeTeamName?.trim();
            const away = report.awayTeamName?.trim();
            const label =
              home && away ? `${home} vs ${away}` : `Fixture ${id}`;
            // kind "json": feed-sourced — fully comparable, but XML-only
            // affordances (master edit/serialize) stay disabled.
            const loaded: LoadedFile = {
              name: `${label}.json`,
              instances,
              raw: JSON.stringify(report),
              kind: "json",
            };
            // Auto-fill the game video from the report so the review timeline
            // and player-table drill-down have a video to play. Prefer the
            // MASTER's video (the reference coding); the analyst's video is
            // only used as a fallback when there is no master side.
            const vid = (
              (report as { myMatchVideo?: { videoFileName?: string } })
                .myMatchVideo?.videoFileName ?? ""
            ).trim();
            if (side === "master") {
              setMaster(loaded);
              // Fresh compare — drop any previously-loaded saved check.
              setLoadedCheckId(null);
              setCheckAnalystName(null);
              setDisputes([]);
              // Master video wins — set it whenever present.
              if (vid) setVideoUrl(vid);
            } else {
              setAnalyst(loaded);
              // Only use the analyst's video when there's no master to take it
              // from (analyst-only load); otherwise the master's video wins.
              if (vid && !fixtureId) setVideoUrl(vid);
            }
            loadedRef.current = id;
          } catch (err) {
            console.error(
              `Failed loading ${side} fixture ${id} from S3:`,
              err
            );
            window.alert(
              `Could not load the ${side} timeline for fixture ${id}. ` +
                `The report may not exist yet (it's created once the match is finalised).`
            );
          } finally {
            fetchingRef.current = null;
          }
        })();
      };

      if (fixtureId) {
        loadedFromUrlRef.current = `fixture:${fixtureId}`;
        loadSide(fixtureId, "master", loadedFixtureRef, fetchingFixtureRef);
      }
      if (analystFixtureId) {
        loadSide(
          analystFixtureId,
          "analyst",
          loadedAnalystFixtureRef,
          fetchingAnalystFixtureRef
        );
      }

      return;
    }

    // Skip re-fetching ONLY when this exact check is already loaded into state
    // (guards against `searchParams` changing reference on unrelated
    // re-renders — e.g. after a master edit — which would otherwise wipe
    // unsaved edits). Comparing against the actually-loaded check id (not a
    // separate ref) means navigating to a check always loads it, even the
    // same one re-opened after leaving.
    if (
      checkId &&
      loadedFromUrlRef.current === checkId &&
      loadedCheckIdRef.current === Number(checkId)
    )
      return;

    // No ?check= in the URL — this is a fresh "new accuracy check" view.
    // If a saved check was previously loaded (e.g. the user navigated here
    // from Accuracy History and then clicked the sidebar tab), clear it so
    // they get a blank comparison instead of the stale check.
    if (!checkId) {
      loadedFromUrlRef.current = null;
      if (loadedCheckIdRef.current != null) {
        setMaster(null);
        setAnalyst(null);
        setLoadedCheckId(null);
        setCheckAnalystName(null);
        setDisputes([]);
        setMatchLabel("");
        setLabelEdited(false);
        setGradedAnalyst("");
        setMasterAnalyst("");
        setVideoUrl("");
        setVideoOpen(false);
      }
      return;
    }

    // Mark this check id as loaded up-front so a re-render mid-fetch doesn't
    // start a second load of the same check.
    loadedFromUrlRef.current = checkId;

    // Optional deep-link from the Disputes page: open the video review and
    // seek to a specific instance (by its stat + start time seconds).
    const reviewSeek = searchParams.get("seek");
    const reviewStat = searchParams.get("stat");

    let cancelled = false;

    (async () => {
      const check = await getAccuracyCheckById(Number(checkId));
      if (!check || cancelled) return;

      if (check.xml_master) {
        setMaster(
          loadedFileFromRaw(
            check.file_name_master ?? "master.xml",
            check.xml_master
          )
        );
      }
      if (check.xml_analyst) {
        // The analyst side may have been a JSON feed (kind "json"); rebuild it
        // the same way it was uploaded so it doesn't parse to zero instances.
        setAnalyst(
          loadedFileFromRaw(
            check.file_name_analyst ?? "analyst.xml",
            check.xml_analyst
          )
        );
      }
      if (check.tolerance != null) setTolerance(check.tolerance);
      if (check.master_analyst_name) setMasterAnalyst(check.master_analyst_name);
      setGradedAnalyst(check.analyst_name);
      if (check.match_label) {
        setMatchLabel(check.match_label);
        setLabelEdited(true);
      }
      if (check.video_url) setVideoUrl(check.video_url);
      // Set the sport so the right cards/table show immediately. The stored
      // `sport` flag is often null on older checks, so when it's missing we
      // infer it from the master XML: if it has any football stats it's
      // football, otherwise AFL. This runs before the UI reads `sport`.
      if (check.sport === "afl" || check.sport === "football") {
        setSport(check.sport);
      } else if (check.xml_master) {
        // Infer sport: compare the master against an empty analyst so every
        // master instance is a row, then check if any football stats grouped.
        const masterInstances = parseInstances(check.xml_master);
        const cmp = compareInstances(masterInstances, [], check.tolerance ?? 3);
        const fb = computePlayerAccuracy(cmp.rows);
        // Overall excludes the standalone Other group, so also count Other
        // when deciding football vs afl — otherwise a check whose only stats
        // are Other-type (touches, carries, throw-ins, …) is misread as AFL.
        setSport(
          fb.overall.master > 0 || fb.other.master > 0 ? "football" : "afl"
        );
      }

      // Enable disputes for this saved check.
      setLoadedCheckId(check.id);
      setCheckAnalystName(check.analyst_name);
      reloadDisputes(check.id);

      // Deep-link: open the review focused on the disputed stat and seek to
      // it. Filter by stat so the reviewer sees that stat's instances, then
      // seek to the exact moment.
      if (reviewSeek != null && check.video_url) {
        const seconds = parseFloat(reviewSeek);
        if (!Number.isNaN(seconds)) {
          if (reviewStat) setVideoStatFilter(reviewStat);
          // seekVideo opens the modal and retries until the <video> mounts.
          seekVideo(seconds);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  // Default the save label to AnalystName_AnalystFilename (analyst name
  // with spaces stripped + underscore + analyst file name minus .xml),
  // until the user types their own label.
  useEffect(() => {
    if (labelEdited) return;
    if (!gradedAnalyst) {
      setMatchLabel("");
      return;
    }
    const analystNoSpaces = gradedAnalyst.replace(/\s+/g, "");
    // Prefer a short "Analyst_Home_v_Away" label using the team names parsed
    // from the master file name. Fall back to the analyst file name if the
    // teams can't be determined.
    const teams = parseHomeAwayFromFileName(master?.name);
    if (teams) {
      const clean = (t: string) => t.trim().replace(/\s+/g, "");
      setMatchLabel(
        `${analystNoSpaces}_${clean(teams[0])}_v_${clean(teams[1])}`
      );
    } else if (analyst?.name) {
      const fileNoExt = analyst.name.replace(/\.xml$/i, "");
      setMatchLabel(`${analystNoSpaces}_${fileNoExt}`);
    } else {
      setMatchLabel("");
    }
  }, [gradedAnalyst, analyst, master, labelEdited]);

  // Overlap window = the section the analyst coded. Derived via the SHARED
  // pure helper so the live Overlap view and every stored-accuracy path
  // (save/update/propagate/backfill) compute the SAME window from the same
  // inputs. Only .start/.end are read downstream (the `source` field the inline
  // version carried was never consumed, so it is dropped).
  const analystWindow = useMemo(() => {
    if (!master || !analyst) return null;
    const w = deriveOverlapWindow(master.instances, analyst.instances);
    if (!w) return null;
    return { start: w.start, end: w.end };
  }, [master, analyst]);

  const effectiveRange = useMemo(() => {
    if (rangeMode === "full") return { start: -Infinity, end: Infinity };
    if (rangeMode === "manual") {
      const s = parseTime(manualStart);
      const e = parseTime(manualEnd);
      return { start: s ?? -Infinity, end: e ?? Infinity };
    }
    if (analystWindow)
      return { start: analystWindow.start, end: analystWindow.end };
    return { start: -Infinity, end: Infinity };
  }, [rangeMode, manualStart, manualEnd, analystWindow]);

  const inRange = (i: Instance) =>
    i.mid >= effectiveRange.start && i.mid <= effectiveRange.end;

  // Canonicalise team names to Home/Away ONCE, so team filtering and the
  // player breakdown use the same labels the comparison produces. Without
  // this, clicking a "Home"/"Away" filter would match none of the raw
  // instances (which still carry the original club names).
  const canonical = useMemo(() => {
    if (!master || !analyst) return null;
    return canonicaliseTeams(
      master.instances,
      analyst.instances,
      tolerance,
      master.name
    );
  }, [master, analyst, tolerance]);

  // Map a canonical team ("Home"/"Away") to the real club name from the master
  // file, for display only. Comparison/filtering still use the canonical team.
  const teamDisplay = useMemo(() => {
    const names = canonical?.displayNames;
    return (canonTeam: string): string => {
      const key = canonTeam.trim().toLowerCase();
      if (key === "home" && names?.home) return names.home;
      if (key === "away" && names?.away) return names.away;
      return canonTeam;
    };
  }, [canonical]);

  const result = useMemo(() => {
    if (!canonical) return null;
    const m = canonical.master.filter(inRange);
    const a = canonical.analyst.filter(inRange);
    // Pass the master file name so the (second) canonicalisation inside
    // compareInstances assigns Home/Away the SAME way as `canonical` did.
    // Without it, the heuristic can flip teams on the filtered subset, and
    // then the player table (built from `canonical`) and the video review
    // (built from `result.rows`) disagree on a player's team — so clicking a
    // player-table cell matches no rows and the review timeline shows empty.
    return compareInstances(m, a, tolerance, master?.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical, tolerance, effectiveRange, master?.name]);

  const scopedResult = useMemo(() => {
    if (!canonical) return null;
    const matchTeam = (i: Instance) =>
      teamFilter === "all" || i.team === teamFilter;
    const matchCat = (i: Instance) =>
      categoryFilter === "all" || i.category === categoryFilter;
    const m = canonical.master.filter(
      (i) => inRange(i) && matchTeam(i) && matchCat(i)
    );
    const a = canonical.analyst.filter(
      (i) => inRange(i) && matchTeam(i) && matchCat(i)
    );
    return compareInstances(m, a, tolerance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical, tolerance, effectiveRange, teamFilter, categoryFilter]);

  const insights = useMemo(
    () => (scopedResult ? generateInsights(scopedResult) : []),
    [scopedResult]
  );
  const recommendations = useMemo(
    () => (scopedResult ? generateRecommendations(scopedResult) : []),
    [scopedResult]
  );

  const rowTeam = (r: ComparisonRow) =>
    r.master?.team ?? r.analyst?.team ?? "Unknown";
  const rowCategory = (r: ComparisonRow) =>
    r.master?.category ?? r.analyst?.category ?? "Uncategorised";

  const rowStat = (r: ComparisonRow) =>
    r.master?.stat ?? r.analyst?.stat ?? "Uncategorised";

  // Team + category scope. Drives the stat breakdown table (so every
  // stat stays listed and clickable, regardless of statFilter).
  const teamScopedRows: ComparisonRow[] = useMemo(() => {
    if (!result) return [];
    return result.rows.filter(
      (r) =>
        (teamFilter === "all" || rowTeam(r) === teamFilter) &&
        (categoryFilter === "all" || rowCategory(r) === categoryFilter)
    );
  }, [result, teamFilter, categoryFilter]);

  // Adds the selected-stat scope on top of team + category. Used for the
  // top summary cards and (with status) the timeline.
  const statScopedRows: ComparisonRow[] = useMemo(() => {
    if (statFilter === "all") return teamScopedRows;
    return teamScopedRows.filter((r) => rowStat(r) === statFilter);
  }, [teamScopedRows, statFilter]);

  const filteredRows: ComparisonRow[] = useMemo(() => {
    if (statusFilter === "all") return statScopedRows;
    return statScopedRows.filter((r) => r.status === statusFilter);
  }, [statScopedRows, statusFilter]);

  // Video review has its own stat filter so it can show every instance of a
  // selected stat without inheriting the page's team/category/stat/status
  // filters. Keep the original comparison rows so missed and extra entries
  // remain available in the review.
  const [videoStatFilter, setVideoStatFilter] = useState<string | "all">("all");
  // Reset the clip index when the review scope changes.
  useEffect(() => {
    setReviewIndex(0);
  }, [videoStatFilter, videoStatusFilter, reviewPlayer]);
  const videoStatOptions = useMemo(() => {
    if (!result) return [];
    const stats = new Set<string>();
    for (const row of result.rows) {
      if (row.master?.stat.trim()) stats.add(row.master.stat.trim());
      if (row.analyst?.stat.trim()) stats.add(row.analyst.stat.trim());
    }
    return Array.from(stats).sort((a, b) => a.localeCompare(b));
  }, [result]);

  const videoRows: ComparisonRow[] = useMemo(() => {
    if (!result) return [];

    let rows: ComparisonRow[];

    // Player+stat focus (from clicking a player-table cell) takes priority:
    // show only instances for that player that belong to the clicked column.
    if (reviewPlayer) {
      const teamLower = reviewPlayer.team.toLowerCase();
      const matchesPlayer = (i: Instance | null) =>
        !!i &&
        i.team.toLowerCase() === teamLower &&
        i.playerNumber === reviewPlayer.number &&
        statMatchesColumn(
          sportConfig,
          reviewPlayer.columnKey,
          i.stat.toLowerCase()
        );
      rows = result.rows.filter(
        (row) => matchesPlayer(row.master) || matchesPlayer(row.analyst)
      );
    } else if (videoStatFilter === "all") {
      rows = result.rows;
    } else {
      rows = result.rows.filter(
        (row) =>
          row.master?.stat.trim() === videoStatFilter ||
          row.analyst?.stat.trim() === videoStatFilter
      );
    }

    // Layer the status filter (Exact / Missed / Wrong stat …) on top.
    if (videoStatusFilter !== "all") {
      rows = rows.filter((row) => row.status === videoStatusFilter);
    }

    // Flagged-only: keep rows where either side is a flagged instance.
    if (flaggedOnly) {
      rows = rows.filter(
        (row) =>
          (!!row.master &&
            flaggedKeys.has(disputeKey(row.master.id, "master"))) ||
          (!!row.analyst &&
            flaggedKeys.has(disputeKey(row.analyst.id, "analyst")))
      );
    }

    return rows;
  }, [
    result,
    videoStatFilter,
    reviewPlayer,
    videoStatusFilter,
    flaggedOnly,
    flaggedKeys,
    sportConfig,
  ]);

  // Per-status counts for the video review filter buttons (reflect the
  // current stat/player scope, before the status filter is applied).
  const videoStatusCounts = useMemo(() => {
    if (!result) return {} as Record<MatchStatus, number>;

    let base: ComparisonRow[];
    if (reviewPlayer) {
      const teamLower = reviewPlayer.team.toLowerCase();
      const matchesPlayer = (i: Instance | null) =>
        !!i &&
        i.team.toLowerCase() === teamLower &&
        i.playerNumber === reviewPlayer.number &&
        statMatchesColumn(
          sportConfig,
          reviewPlayer.columnKey,
          i.stat.toLowerCase()
        );
      base = result.rows.filter(
        (row) => matchesPlayer(row.master) || matchesPlayer(row.analyst)
      );
    } else if (videoStatFilter === "all") {
      base = result.rows;
    } else {
      base = result.rows.filter(
        (row) =>
          row.master?.stat.trim() === videoStatFilter ||
          row.analyst?.stat.trim() === videoStatFilter
      );
    }

    const counts = {} as Record<MatchStatus, number>;
    for (const row of base) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  }, [result, videoStatFilter, reviewPlayer, sportConfig]);

  // Start/end window for each filtered review row: from whichever displayed
  // side is present (prefer master). Prev/Next seek to `start`; auto-skip
  // watches for playback passing `end` and jumps to the next clip.
  const reviewClips = useMemo(() => {
    const sideShows = (inst: Instance | null): boolean => {
      if (!inst) return false;
      if (reviewPlayer) {
        return (
          inst.team.toLowerCase() === reviewPlayer.team.toLowerCase() &&
          inst.playerNumber === reviewPlayer.number &&
          statMatchesColumn(
            sportConfig,
            reviewPlayer.columnKey,
            inst.stat.toLowerCase()
          )
        );
      }
      return videoStatFilter === "all" || inst.stat.trim() === videoStatFilter;
    };
    return videoRows.map((row) => {
      const m = sideShows(row.master) ? row.master : null;
      const a = sideShows(row.analyst) ? row.analyst : null;
      const inst = m ?? a;
      return { start: inst?.start ?? 0, end: inst?.end ?? 0 };
    });
  }, [videoRows, reviewPlayer, videoStatFilter, sportConfig]);

  const reviewSeekTimes = useMemo(
    () => reviewClips.map((c) => c.start),
    [reviewClips]
  );
  // Dedicated start-sorted seek list for the auto-skip handler. Display order
  // (reviewClips/videoRows) stays mid-sorted; this list is sorted by `start`
  // so the handler can walk clips in playback order without ever seeking
  // backward. Each entry carries its display `rowIndex` so the handler can map
  // back to the display cursor (reviewIndex) for Prev/Next + the counter.
  const seekClips = useMemo(() => buildSeekClips(reviewClips), [reviewClips]);
  useEffect(() => {
    reviewClipsRef.current = seekClips;
  }, [seekClips]);

  // Player Accuracy cards (football): volume of the analyst's coded stats vs
  // the master's, grouped into Overall / Passing / Offensive / Defensive /
  // Goalkeeper via the shared computePlayerAccuracy (single source of truth,
  // also used by the Accuracy History fixture table). Each group's % is the
  // summed per-stat absolute error against the master total. Respects the
  // active time-range + team filter.
  const playerAccuracy = useMemo(() => {
    if (!canonical || sport !== "football") return null;
    const inScope = (i: Instance) =>
      inRange(i) && (teamFilter === "all" || i.team === teamFilter);
    // Exact-match player accuracy: compare the scoped instances, then group.
    const cmp = compareInstances(
      canonical.master.filter(inScope),
      canonical.analyst.filter(inScope),
      tolerance
    );
    return computePlayerAccuracy(cmp.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical, sport, tolerance, effectiveRange, teamFilter]);

  const scopedStatBreakdown = useMemo(() => {
    const map = new Map<string, { total: number; exact: number }>();
    for (const r of teamScopedRows) {
      if (!r.master) continue;
      const stat = r.master.stat || "Uncategorised";
      const e = map.get(stat) ?? { total: 0, exact: 0 };
      e.total += 1;
      if (r.status === "exact") e.exact += 1;
      map.set(stat, e);
    }
    return Array.from(map.entries())
      .map(([stat, v]) => ({
        stat,
        total: v.total,
        exact: v.exact,
        accuracy: v.total > 0 ? v.exact / v.total : 0,
      }))
      .sort((a, b) => a.stat.localeCompare(b.stat));
  }, [teamScopedRows]);

  const scopedTotals = useMemo(() => {
    const total = scopedStatBreakdown.reduce((a, s) => a + s.total, 0);
    const exact = scopedStatBreakdown.reduce((a, s) => a + s.exact, 0);
    return { total, exact, accuracy: total > 0 ? exact / total : 0 };
  }, [scopedStatBreakdown]);

  // Category breakdown that reflects the TEAM filter (but not the category
  // filter, so every category stays visible + clickable). This replaces
  // the previously-static result.byCategory so the "Accuracy by stat
  // category" chart updates when Both/Home/Away is toggled.
  const scopedCategoryBreakdown = useMemo(() => {
    if (!result) return [];
    const rows = result.rows.filter(
      (r) => teamFilter === "all" || rowTeam(r) === teamFilter
    );
    const map = new Map<string, { total: number; exact: number }>();
    for (const r of rows) {
      if (!r.master) continue;
      const category = r.master.category || "Uncategorised";
      const e = map.get(category) ?? { total: 0, exact: 0 };
      e.total += 1;
      if (r.status === "exact") e.exact += 1;
      map.set(category, e);
    }
    return Array.from(map.entries())
      .map(([category, v]) => ({
        category,
        total: v.total,
        exact: v.exact,
        accuracy: v.total > 0 ? v.exact / v.total : 0,
      }))
      .sort((a, b) => b.total - a.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, teamFilter]);

  // Per-player stats table. Driven by the active sport's config (see
  // SPORT_CONFIGS): the same aggregation, with sport-specific stat
  // classification, derived totals, columns and relevance filter.
  // Master is the gold standard; players only in the analyst are flagged.
  // Respects the active time-range + team filters.
  const playerTable = useMemo(() => {
    if (!result) return [];

    const inScope = (i: Instance) =>
      teamFilter === "all" || i.team === teamFilter;

    // key = "team|number"; keep display name + which side(s) it appears in.
    const rows = new Map<
      string,
      {
        team: string;
        number: number | null;
        master: PlayerCounts;
        analyst: PlayerCounts;
        inMaster: boolean;
        inAnalyst: boolean;
      }
    >();

    const ensure = (i: Instance) => {
      const key = `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}`;
      let r = rows.get(key);
      if (!r) {
        r = {
          team: i.team,
          number: i.playerNumber,
          master: sportConfig.init(),
          analyst: sportConfig.init(),
          inMaster: false,
          inAnalyst: false,
        };
        rows.set(key, r);
      }
      return r;
    };

    // Source from result.rows (the SAME canonical instances the video review
    // uses) so a player's team label here matches the review exactly — a
    // player-table click then always finds its instances in the timeline.
    for (const row of result.rows) {
      if (row.master && inScope(row.master)) {
        const r = ensure(row.master);
        r.inMaster = true;
        sportConfig.bump(r.master, row.master.stat.toLowerCase());
      }
      if (row.analyst && inScope(row.analyst)) {
        const r = ensure(row.analyst);
        r.inAnalyst = true;
        sportConfig.bump(r.analyst, row.analyst.stat.toLowerCase());
      }
    }

    return Array.from(rows.values())
      .map((r) => ({
        key: `${r.team} - #${r.number ?? "?"}`,
        team: r.team,
        number: r.number,
        master: sportConfig.derive(r.master),
        analyst: sportConfig.derive(r.analyst),
        // A player only in the analyst (not in master) is incorrect.
        analystOnly: r.inAnalyst && !r.inMaster,
      }))
      // Drop players with no relevant stats on either side.
      .filter((r) => sportConfig.relevant(r.master, r.analyst))
      .sort((a, b) => {
        // Master players first, then by team, then by number.
        if (a.analystOnly !== b.analystOnly) return a.analystOnly ? 1 : -1;
        if (a.team !== b.team) return a.team.localeCompare(b.team);
        return (a.number ?? 999) - (b.number ?? 999);
      });
  }, [result, teamFilter, sportConfig]);

  // Real comparison teams have master instances and a proper name. Teams with
  // no master instances (analyst-only extras from a name mismatch, or an
  // analyst that only coded one team) or "Unknown" are surfaced separately.
  const realTeams = useMemo(
    () =>
      (result?.byTeam ?? []).filter(
        (t) => t.masterTotal > 0 && t.team.toLowerCase() !== "unknown"
      ),
    [result]
  );
  const unmatchedTeams = useMemo(
    () =>
      (result?.byTeam ?? []).filter(
        (t) => t.masterTotal === 0 || t.team.toLowerCase() === "unknown"
      ),
    [result]
  );
  const unmatchedExtra = useMemo(
    () => unmatchedTeams.reduce((a, t) => a + t.extra, 0),
    [unmatchedTeams]
  );

  function swap() {
    const m = master;
    setMaster(analyst);
    setAnalyst(m);
    // Keep allocations aligned with the files they describe.
    const ma = masterAnalyst;
    setMasterAnalyst(gradedAnalyst);
    setGradedAnalyst(ma);
  }

  async function handleSaveCheck() {
    if (!result) return;

    if (!gradedAnalyst) {
      setSaveMsg("Select the analyst being graded first.");
      return;
    }

    try {
      setSaving(true);
      setSaveMsg(null);

      await saveAccuracyCheck({
        analystName: gradedAnalyst,
        masterAnalystName: masterAnalyst || null,
        matchLabel: matchLabel || null,
        fileNameMaster: master?.name ?? null,
        fileNameAnalyst: analyst?.name ?? null,
        tolerance,
        // Save the full-window result (not the team/category-scoped one)
        // so the stored summary reflects the whole check.
        result,
        // Store the raw XML so the check can be fully re-opened later.
        xmlMaster: master?.raw ?? null,
        xmlAnalyst: analyst?.raw ?? null,
        // Store the game video URL so it doesn't need re-finding.
        videoUrl: videoUrl || null,
        // Store the sport so it re-opens with the right stats table.
        sport,
      });

      setSaveMsg(
        `Saved to ${gradedAnalyst}'s profile` +
          (masterAnalyst ? ` (master by ${masterAnalyst})` : "") +
          "."
      );
    } catch (err) {
      console.error(err);
      setSaveMsg(
        err instanceof Error ? err.message : "Failed to save accuracy check."
      );
    } finally {
      setSaving(false);
    }
  }

  // Update the currently-loaded saved check IN PLACE (no new row). Only
  // available when a check was opened from history (loadedCheckId set).
  async function handleUpdateCheck() {
    if (!result || loadedCheckId == null) return;
    if (!gradedAnalyst) {
      setSaveMsg("Select the analyst being graded first.");
      return;
    }
    try {
      setSaving(true);
      setSaveMsg(null);
      await updateAccuracyCheck({
        id: loadedCheckId,
        xmlMaster: master?.raw ?? "",
        xmlAnalyst: analyst?.raw ?? null,
        result,
        analystName: gradedAnalyst,
        masterAnalystName: masterAnalyst || null,
        matchLabel: matchLabel || null,
        fileNameMaster: master?.name ?? null,
        fileNameAnalyst: analyst?.name ?? null,
        tolerance,
        videoUrl: videoUrl || null,
        sport,
      });
      setSaveMsg("Updated this check (no new check created).");
    } catch (err) {
      console.error(err);
      setSaveMsg(
        err instanceof Error ? err.message : "Failed to update accuracy check."
      );
    } finally {
      setSaving(false);
    }
  }

  // Override master: re-upload the SAME master file (now with external
  // corrections) and replace it on the existing check(s) in place — without
  // creating a new check. Propagates to every check of this master and
  // re-grades each against its own analyst. Admin-only; needs a loaded check.
  const overrideMasterInputRef = useRef<HTMLInputElement | null>(null);
  const handleOverrideMaster = async (fileList: FileList | null) => {
    const f = fileList?.[0];
    if (!f || !master || loadedCheckId == null) return;
    // Keep the master's stored file name as the identity (so it overrides the
    // existing check), regardless of the uploaded file's name.
    const fileName = master.name;
    let text: string;
    try {
      text = await f.text();
      const parsed = parseInstances(text);
      if (parsed.length === 0) {
        setSaveMsg("That file has no <instance> entries.");
        return;
      }
    } catch {
      setSaveMsg("Could not read that file.");
      return;
    }

    let siblings = { count: 1, analysts: [] as string[] };
    try {
      siblings = await getMasterCheckSiblings(fileName);
    } catch {
      /* fall back */
    }
    const others = Math.max(0, siblings.count - 1);
    const confirmed = window.confirm(
      `Override the master for "${fileName}" with this file?\n\n` +
        `This replaces the master on all ${siblings.count} check` +
        `${siblings.count === 1 ? "" : "s"}` +
        (others > 0
          ? ` and re-grades ${others} other analyst check${
              others === 1 ? "" : "s"
            } (${siblings.analysts.join(", ")}).`
          : ".") +
        `\n\nNo new check is created. Continue?`
    );
    if (!confirmed) return;

    setSavingMaster(true);
    setMasterSaveMsg(null);
    try {
      const res = await propagateMasterCorrection(fileName, text);
      // Reflect the new master in the current view immediately.
      setMaster((cur) =>
        cur ? { ...cur, instances: parseInstances(text), raw: text } : cur
      );
      setMasterSaveMsg(
        `Master overridden across ${res.updated} check` +
          `${res.updated === 1 ? "" : "s"}` +
          (res.analysts.length ? ` (${res.analysts.join(", ")}).` : ".")
      );
    } catch (err) {
      setMasterSaveMsg(
        err instanceof Error ? err.message : "Failed to override master."
      );
    } finally {
      setSavingMaster(false);
      if (overrideMasterInputRef.current)
        overrideMasterInputRef.current.value = "";
    }
  };

  return (
    <div className="min-h-full bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-7xl p-6 lg:p-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              Accuracy Comparison
            </h1>
            <div className={`mt-3 h-1 w-12 rounded-full ${ACCENT_BG}`} />
            <p className="mt-3 max-w-2xl text-sm text-slate-600">
              Upload a master and an analyst file (SportsCode XML, or a JSON
              event feed) to grade accuracy. Instances are matched by timestamp
              (within the tolerance), then compared on team, player number and
              stat.
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Home
          </Link>
        </div>

        {/* Sport toggle */}
        <div className="mb-5 flex items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Sport
          </span>
          {(Object.values(SPORT_CONFIGS) as SportConfig[]).map((sc) => (
            <button
              key={sc.id}
              onClick={() => setSport(sc.id)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                sport === sc.id
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {sc.label}
            </button>
          ))}
        </div>

        {/* Video URL + Watch */}
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Game video
          </span>
          <input
            type="text"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="Paste the game video URL (mp4 / direct link)"
            className="min-w-[280px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          <button
            onClick={() => {
              if (!videoUrl.trim()) return;
              setReviewPlayer(null);
              setVideoOpen(true);
            }}
            disabled={!videoUrl.trim()}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition ${ACCENT_BG} hover:opacity-90 disabled:cursor-not-allowed disabled:bg-slate-300`}
          >
            <Video size={14} /> Watch
          </button>
          {videoUrl.trim() && (
            <span className="text-xs text-slate-400">
              Click any stat in the timeline to jump to that moment.
            </span>
          )}
        </div>

        {/* Upload row */}
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div>
            <p className="mb-2 text-sm font-semibold text-slate-700">
              Master{" "}
              <span className="font-normal text-slate-400">
                (correct reference)
              </span>
            </p>
            <Dropzone
              title="Upload master XML or JSON feed"
              subtitle="Drag & drop or click — .xml or .json"
              file={master}
              allowJson
              onLoad={(f) => {
                setMaster(f);
                if (f.kind === "json") setSport("football");
              }}
              onClear={() => setMaster(null)}
            />
            {savedMasters.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-xs font-medium text-slate-500">
                    {loadingSavedMaster
                      ? "Loading master…"
                      : "...or reuse a saved master"}
                  </label>
                  {canManageMasters && (
                    <button
                      type="button"
                      onClick={() => setManageMastersOpen(true)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Manage
                    </button>
                  )}
                </div>
                <select
                  value=""
                  disabled={loadingSavedMaster}
                  onChange={async (e) => {
                    const sm = savedMasters.find(
                      (m) => m.fileName === e.target.value
                    );
                    if (!sm) return;
                    // The XML isn't loaded with the dropdown list (it's
                    // large); fetch just the picked master's XML now.
                    setLoadingSavedMaster(true);
                    try {
                      const xml = await getSavedMasterXml(sm.checkId);
                      if (!xml) return;
                      setMaster({
                        name: sm.fileName,
                        instances: parseInstances(xml),
                        raw: xml,
                      });
                      // If this master had a video and none is set yet,
                      // prefill it too.
                      if (sm.videoUrl && !videoUrl) setVideoUrl(sm.videoUrl);
                    } finally {
                      setLoadingSavedMaster(false);
                    }
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-500 focus:outline-none disabled:cursor-wait disabled:opacity-60"
                >
                  <option value="">Select a saved master...</option>
                  {savedMasters.map((m) => (
                    <option key={m.fileName} value={m.fileName}>
                      {m.fileName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {canManageMasters && manageMastersOpen && (
              <ManageMastersDialog
                masters={savedMasters}
                isAdmin={canManageMasters}
                username={user?.username ?? null}
                onClose={() => setManageMastersOpen(false)}
                onChanged={async (change) => {
                  // Keep the in-view master consistent if it was the one
                  // changed, mirroring the override/saveCorrectedMaster
                  // handlers, then refresh the dropdown list.
                  if (change.type === "rename") {
                    setMaster((cur) =>
                      cur && cur.name === change.oldName
                        ? { ...cur, name: change.newName }
                        : cur
                    );
                  } else if (change.type === "replace") {
                    setMaster((cur) =>
                      cur && cur.name === change.name
                        ? {
                            ...cur,
                            instances: parseInstances(change.raw),
                            raw: change.raw,
                          }
                        : cur
                    );
                  } else if (change.type === "delete") {
                    setMaster((cur) =>
                      cur && cur.name === change.name ? null : cur
                    );
                  }
                  await refreshSavedMasters();
                }}
              />
            )}
            <div className="mt-2">
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Coded by (master)
              </label>
              <AnalystCombobox
                value={masterAnalyst}
                onChange={setMasterAnalyst}
                options={analystNames}
              />
            </div>
          </div>

          <div className="flex items-end justify-center pb-6">
            <button
              onClick={swap}
              disabled={!master && !analyst}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:opacity-40"
              title="Swap master and analyst"
            >
              <ArrowRightLeft size={14} /> Swap
            </button>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-slate-700">
              Analyst{" "}
              <span className="font-normal text-slate-400">(being graded)</span>
            </p>
            <Dropzone
              title="Upload analyst XML or JSON feed"
              subtitle="Drag & drop or click — .xml or .json"
              file={analyst}
              allowJson
              onLoad={(f) => {
                setAnalyst(f);
                // A JSON event feed is football data, so switch the per-player
                // stats table to Football automatically. (XML uploads leave
                // the sport as-is / inferred elsewhere.)
                if (f.kind === "json") setSport("football");
              }}
              onClear={() => setAnalyst(null)}
            />
            <div className="mt-2">
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Coded by (analyst being graded)
              </label>
              <AnalystCombobox
                value={gradedAnalyst}
                onChange={setGradedAnalyst}
                options={analystNames}
              />
            </div>
          </div>
        </div>

        {/* Tolerance + time range controls (same row) */}
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {/* Tolerance control */}
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <span className="text-sm font-semibold text-slate-700">
            Tolerance
          </span>
          <div className="flex gap-1">
            {[2, 3, 5].map((t) => (
              <button
                key={t}
                onClick={() => setTolerance(t)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  tolerance === t
                    ? `${ACCENT_BG} text-white`
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                ±{t}s
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">
            Match window; stat still must agree for exact.
          </span>
        </div>

        {/* Time range control */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Clock size={15} /> Range
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setRangeMode("auto")}
                title="Overlapping section"
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  rangeMode === "auto"
                    ? `${ACCENT_BG} text-white`
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                Overlap
              </button>
              <button
                onClick={() => setRangeMode("manual")}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  rangeMode === "manual"
                    ? `${ACCENT_BG} text-white`
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                Custom
              </button>
              <button
                onClick={() => setRangeMode("full")}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  rangeMode === "full"
                    ? `${ACCENT_BG} text-white`
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                Full game
              </button>
            </div>

            {rangeMode === "manual" && (
              <div className="flex items-center gap-2">
                <input
                  value={manualStart}
                  onChange={(e) => setManualStart(e.target.value)}
                  placeholder={
                    analystWindow ? analystWindow.start.toFixed(2) : "e.g. 2082"
                  }
                  className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-900 outline-none focus:border-red-500"
                />
                <span className="text-slate-400">to</span>
                <input
                  value={manualEnd}
                  onChange={(e) => setManualEnd(e.target.value)}
                  placeholder={
                    analystWindow ? analystWindow.end.toFixed(2) : "e.g. 3976"
                  }
                  className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-900 outline-none focus:border-red-500"
                />
                <span className="text-xs text-slate-400">seconds</span>
              </div>
            )}
          </div>

          {result && master && analyst && (
            <p className="mt-2.5 text-xs text-slate-500">
              In window:{" "}
              <span className="font-semibold text-slate-700">
                {master.instances.filter(inRange).length}
              </span>{" "}
              master ·{" "}
              <span className="font-semibold text-slate-700">
                {analyst.instances.filter(inRange).length}
              </span>{" "}
              analyst instances
              {rangeMode !== "full" && (
                <>
                  {" "}
                  (of {master.instances.length} / {analyst.instances.length}{" "}
                  total)
                </>
              )}
            </p>
          )}
        </div>
        </div>

        {!result && (
          <div className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
            <Target className="mb-3 text-slate-300" size={40} />
            <p className="text-sm font-medium text-slate-500">
              Upload both files to see the comparison.
            </p>
          </div>
        )}

        {result && (
          <>
            {/* Low-score hint. A JSON feed and an XML master are often coded
                independently (different match clock, event counts and player
                attribution), so a very low exact-match rate usually means the
                two sources genuinely disagree rather than the analyst being
                "wrong". Surfaced only when a JSON feed is involved and the
                overall accuracy is low, so normal XML-vs-XML checks are
                unaffected. */}
            {(master?.kind === "json" || analyst?.kind === "json") &&
              result.summary.masterTotal > 0 &&
              result.summary.accuracy < 0.4 && (
                <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
                  <Info className="mt-0.5 shrink-0 text-sky-600" size={16} />
                  <div>
                    <p className="font-semibold">
                      Low match rate — the two sources may be coded
                      independently.
                    </p>
                    <p className="mt-1 text-sky-800">
                      A JSON feed and an XML file are often produced from
                      separate coding passes, so their event clocks, counts and
                      player attribution rarely line up exactly. A low exact-match
                      rate here usually reflects that genuine disagreement, not an
                      analyst error. For a meaningful score, compare a JSON feed
                      against a master coded from the same pass.
                    </p>
                  </div>
                </div>
              )}

            {/* Save allocation bar */}
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-semibold text-slate-700">
                Save this check
              </div>
              <input
                type="text"
                value={matchLabel}
                onChange={(e) => {
                  setLabelEdited(true);
                  setMatchLabel(e.target.value);
                }}
                placeholder="Match label (auto: Analyst_Home_v_Away)"
                className="min-w-[240px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
              />
              <div className="text-xs text-slate-500">
                Graded:{" "}
                <span className="font-semibold text-slate-700">
                  {gradedAnalyst || "— select above —"}
                </span>
                {masterAnalyst && (
                  <>
                    {"  ·  Master: "}
                    <span className="font-semibold text-slate-700">
                      {masterAnalyst}
                    </span>
                  </>
                )}
              </div>
              {loadedCheckId != null && (
                <button
                  onClick={handleUpdateCheck}
                  disabled={saving || !gradedAnalyst}
                  title="Overwrite the check you opened (no new check is created)"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  <Save size={14} />
                  {saving ? "Updating..." : "Update this check"}
                </button>
              )}
              <button
                onClick={handleSaveCheck}
                disabled={saving || !gradedAnalyst}
                title="Create a new saved check"
                className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition ${ACCENT_BG} hover:opacity-90 disabled:cursor-not-allowed disabled:bg-slate-300`}
              >
                <Save size={14} />
                {saving ? "Saving..." : "Save as new check"}
              </button>
              {canEditMaster && loadedCheckId != null && (
                <>
                  <input
                    ref={overrideMasterInputRef}
                    type="file"
                    accept=".xml,text/xml,application/xml"
                    className="hidden"
                    onChange={(e) => handleOverrideMaster(e.target.files)}
                  />
                  <button
                    onClick={() => overrideMasterInputRef.current?.click()}
                    disabled={savingMaster}
                    title="Replace the master XML on this check (and all checks of this master) with an updated file — no new check is created"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-40"
                  >
                    <Upload size={14} />
                    {savingMaster ? "Overriding..." : "Override master"}
                  </button>
                </>
              )}
              {saveMsg && (
                <span className="text-xs font-medium text-slate-600">
                  {saveMsg}
                </span>
              )}
              {masterSaveMsg && (
                <span className="w-full text-xs font-medium text-slate-600">
                  {masterSaveMsg}
                </span>
              )}
            </div>

            {/* Active-filter chips */}
            {(statFilter !== "all" ||
              categoryFilter !== "all" ||
              teamFilter !== "all") && (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold uppercase tracking-wide text-slate-500">
                  Showing:
                </span>
                {teamFilter !== "all" && (
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                    {teamDisplay(teamFilter)}
                  </span>
                )}
                {categoryFilter !== "all" && (
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                    {categoryFilter}
                  </span>
                )}
                {statFilter !== "all" && (
                  <span className="rounded-md bg-red-100 px-2 py-0.5 font-medium text-red-700">
                    {statFilter}
                  </span>
                )}
                <button
                  onClick={() => {
                    setStatFilter("all");
                    setCategoryFilter("all");
                    setTeamFilter("all");
                  }}
                  className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800"
                >
                  <X size={12} /> Clear all
                </button>
              </div>
            )}

            {/* Player Accuracy — analyst's coded volume vs master, grouped.
                Passing (passes + crosses), Offensive (shots + goals),
                Defensive (tackles + intercepts + clearances + blocks).
                Each card has an info icon showing the per-stat breakdown and
                how the absolute-difference % is calculated. */}
            {playerAccuracy && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Golden Player Accuracy Checks <span className="font-normal normal-case text-slate-400">(Analyst vs Master)</span>
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
                  {(
                    [
                      { label: "Overall %", g: playerAccuracy.overall, highlight: true },
                      { label: "Passing %", g: playerAccuracy.passing, highlight: false },
                      { label: "Offensive %", g: playerAccuracy.offensive, highlight: false },
                      { label: "Defensive %", g: playerAccuracy.defensive, highlight: false },
                      { label: "Goalkeeper %", g: playerAccuracy.goalkeeper, highlight: false },
                      { label: "Other %", g: playerAccuracy.other, highlight: false },
                    ] as const
                  ).map(({ label, g, highlight }) => (
                    <PlayerAccuracyCard
                      key={label}
                      label={label}
                      group={g}
                      highlight={highlight}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Category breakdown + per-stat breakdown (same row) */}
            <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
            {/* Category breakdown */}
            {scopedCategoryBreakdown.length > 0 && (
              <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-slate-700">
                    Accuracy by stat category
                  </h2>
                  <div className="flex items-center gap-3">
                    <TeamToggle
                      teams={realTeams.map((t) => t.team)}
                      value={teamFilter}
                      onChange={setTeamFilter}
                      labelFor={teamDisplay}
                    />
                    {categoryFilter !== "all" && (
                      <button
                        onClick={() => setCategoryFilter("all")}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-200"
                      >
                        <X size={12} /> Clear category
                      </button>
                    )}
                  </div>
                </div>
                <p className="mb-3 text-xs text-slate-400">
                  Click a category to filter the breakdown table and timeline.
                </p>
                <div className="max-h-80 flex-1 space-y-1 overflow-y-auto">
                  {scopedCategoryBreakdown.map((c) => {
                    const active = categoryFilter === c.category;
                    return (
                      <button
                        key={c.category}
                        onClick={() =>
                          setCategoryFilter(active ? "all" : c.category)
                        }
                        className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition ${
                          active
                            ? "bg-red-50 ring-1 ring-red-200"
                            : "hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className={`w-32 shrink-0 truncate text-sm ${
                            active
                              ? `font-semibold ${ACCENT_TEXT}`
                              : "text-slate-600"
                          }`}
                        >
                          {c.category}
                        </span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full ${
                              c.accuracy >= 0.9
                                ? "bg-emerald-500"
                                : c.accuracy >= 0.8
                                  ? "bg-yellow-500"
                                  : c.accuracy >= 0.7
                                    ? "bg-orange-500"
                                    : "bg-red-500"
                            }`}
                            style={{ width: `${c.accuracy * 100}%` }}
                          />
                        </div>
                        <span className="w-24 shrink-0 text-right text-xs text-slate-500">
                          {(c.accuracy * 100).toFixed(0)}% ({c.exact}/{c.total})
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Per-stat breakdown table */}
            {result.byStat.length > 0 && (
              <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 p-4">
                  <h2 className="text-sm font-semibold text-slate-700">
                    Statistic breakdown
                    {categoryFilter !== "all" && (
                      <span className="ml-2 rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">
                        {categoryFilter}
                      </span>
                    )}
                  </h2>
                  <button
                    onClick={() => exportStatCsv(scopedStatBreakdown)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    <Download size={13} /> Export CSV
                  </button>
                </div>
                <div className="max-h-80 flex-1 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-2.5">Statistic Type</th>
                        <th className="px-4 py-2.5 text-right">Master</th>
                        <th className="px-4 py-2.5 text-right">Exact</th>
                        <th className="px-4 py-2.5 text-right">Accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scopedStatBreakdown.map((s) => {
                        const active = statFilter === s.stat;
                        return (
                        <tr
                          key={s.stat}
                          onClick={() =>
                            setStatFilter(active ? "all" : s.stat)
                          }
                          className={`cursor-pointer border-b border-slate-100 last:border-b-0 ${
                            active
                              ? "bg-red-50 ring-1 ring-inset ring-red-200"
                              : "hover:bg-slate-50/60"
                          }`}
                          title="Click to filter the timeline by this stat"
                        >
                          <td
                            className={`px-4 py-2 font-medium ${
                              active ? ACCENT_TEXT : "text-slate-800"
                            }`}
                          >
                            {s.stat}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                            {s.total}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                            {s.exact}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums font-semibold ${
                              s.accuracy >= 0.9
                                ? "text-emerald-600"
                                : s.accuracy >= 0.8
                                  ? "text-yellow-500"
                                  : s.accuracy >= 0.7
                                    ? "text-orange-500"
                                    : "text-red-600"
                            }`}
                          >
                            {(s.accuracy * 100).toFixed(0)}%
                          </td>
                        </tr>
                        );
                      })}
                      {scopedStatBreakdown.length === 0 && (
                        <tr>
                          <td
                            colSpan={4}
                            className="px-4 py-6 text-center text-sm text-slate-400"
                          >
                            No stats for this filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot className="sticky bottom-0">
                      <tr className="border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900">
                        <td className="px-4 py-2.5">Totals</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {scopedTotals.total}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {scopedTotals.exact}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {(scopedTotals.accuracy * 100).toFixed(0)}%
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
            </div>

            {/* Per-player disposals & marks table */}
            {playerTable.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
                  <h2 className="text-sm font-semibold text-slate-700">
                    {sport === "afl"
                      ? "Player disposals & marks"
                      : "Player stats"}{" "}
                    <span className="font-normal text-slate-400">
                      (Master / Analyst)
                    </span>
                  </h2>
                  <div className="flex items-center gap-3">
                    <TeamToggle
                      teams={realTeams.map((t) => t.team)}
                      value={teamFilter}
                      onChange={setTeamFilter}
                      labelFor={teamDisplay}
                    />
                    <button
                      onClick={() =>
                        exportPlayerCsv(
                          playerTable,
                          sportConfig.columns,
                          sportConfig.csvName
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                    >
                      <Download size={13} /> Export CSV
                    </button>
                  </div>
                </div>
                <div className="max-h-[520px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <th
                          rowSpan={2}
                          className="sticky left-0 z-20 border-b border-slate-200 bg-slate-50 px-4 py-2 text-left"
                        >
                          Player
                        </th>
                        {sportConfig.columns.map((col) => (
                          <th
                            key={col.key}
                            colSpan={2}
                            className="border-b border-l border-slate-200 px-3 py-1.5 text-center"
                          >
                            {col.label}
                          </th>
                        ))}
                      </tr>
                      <tr className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        {sportConfig.columns.map((col) => (
                          <FragmentSubHead key={col.key} />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {playerTable.map((p) => (
                        <tr
                          key={p.key}
                          className={`group border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 ${
                            p.analystOnly ? "bg-red-50/60" : ""
                          }`}
                        >
                          <td
                            className={`sticky left-0 z-10 whitespace-nowrap px-4 py-2 font-medium text-slate-800 ${
                              p.analystOnly ? "bg-red-50" : "bg-white"
                            } group-hover:bg-slate-50`}
                          >
                            {p.key}
                            {p.analystOnly && (
                              <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                                analyst only
                              </span>
                            )}
                          </td>
                          {sportConfig.columns.map((col) => {
                            const m = col.get(p.master);
                            const a = col.get(p.analyst);
                            const mismatch = m !== a;
                            return (
                              <PlayerCells
                                key={col.key}
                                master={m}
                                analyst={a}
                                mismatch={mismatch}
                                // Always clickable: filters the review
                                // timeline to this player's instances of the
                                // stat. If a video URL exists it also seeks;
                                // without one the timeline still filters.
                                onClick={() => openPlayerReview(p, col)}
                              />
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="sticky bottom-0 z-10">
                      <tr className="border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900">
                        <td className="sticky left-0 z-20 whitespace-nowrap bg-slate-100 px-4 py-2.5 text-left">
                          Team totals
                        </td>
                        {sportConfig.columns.map((col) => {
                          const mTot = playerTable.reduce(
                            (sum, p) => sum + col.get(p.master),
                            0
                          );
                          const aTot = playerTable.reduce(
                            (sum, p) => sum + col.get(p.analyst),
                            0
                          );
                          const mismatch = mTot !== aTot;
                          return (
                            <PlayerCells
                              key={col.key}
                              master={mTot}
                              analyst={aTot}
                              mismatch={mismatch}
                            />
                          );
                        })}
                      </tr>
                      {/* How many players have identical master vs analyst
                          totals for each stat. Counts every player in the
                          table — a 0-vs-0 still means the analyst correctly
                          did not code that stat for the player. */}
                      <tr className="border-t border-slate-200 bg-slate-50 text-slate-600">
                        <td className="sticky left-0 z-20 whitespace-nowrap bg-slate-50 px-4 py-2 text-left text-xs font-semibold">
                          Players matching
                        </td>
                        {sportConfig.columns.map((col) => {
                          const totalPlayers = playerTable.length;
                          const matching = playerTable.filter(
                            (p) => col.get(p.master) === col.get(p.analyst)
                          ).length;
                          const allMatch =
                            totalPlayers > 0 && matching === totalPlayers;
                          return (
                            <td
                              key={col.key}
                              colSpan={2}
                              title={`${matching} of ${totalPlayers} player${
                                totalPlayers === 1 ? "" : "s"
                              } match on ${col.label}`}
                              className={`border-l border-slate-200 px-2 py-2 text-center text-xs font-bold tabular-nums ${
                                totalPlayers === 0
                                  ? "text-slate-300"
                                  : allMatch
                                    ? "text-emerald-600"
                                    : "text-slate-700"
                              }`}
                            >
                              {matching}
                              <span className="font-medium text-slate-400">
                                /{totalPlayers}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
                  {sport === "afl"
                    ? "Total Disposals = eff + ineff kicks & handballs. Marks = contested + uncontested only. "
                    : "Total Passes = complete + incomplete. "}
                  Analyst counts shown in red differ from the master.
                </p>
              </div>
            )}

            {/* Unmatched teams warning (name mismatch or one-team analyst) */}
            {unmatchedExtra > 0 && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-800">
                <AlertTriangle
                  size={17}
                  className="mt-0.5 shrink-0 text-amber-500"
                />
                <p>
                  <span className="font-semibold">{unmatchedExtra}</span> analyst
                  instance{unmatchedExtra === 1 ? "" : "s"} couldn&apos;t be
                  matched to any master team
                  {unmatchedTeams.some(
                    (t) => t.team.toLowerCase() !== "unknown"
                  ) && (
                    <>
                      {" "}
                      (
                      {unmatchedTeams
                        .filter((t) => t.team.toLowerCase() !== "unknown")
                        .map((t) => `"${t.team}"`)
                        .join(", ")}
                      )
                    </>
                  )}
                  . Either the analyst coded only one team, or the team names
                  differ between the master and analyst files.
                </p>
              </div>
            )}

            {/* AI insights */}
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Sparkles size={18} className={ACCENT_TEXT} />
                  <h2 className="text-sm font-semibold text-slate-700">
                    AI insights
                  </h2>
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                    {teamFilter === "all" ? "Both teams" : teamDisplay(teamFilter)}
                    {categoryFilter !== "all" ? ` · ${categoryFilter}` : ""}
                  </span>
                </div>
                <div className="max-h-[340px] space-y-2.5 overflow-y-auto pr-1">
                  {insights.map((ins, i) => {
                    const meta = TONE_META[ins.tone];
                    const Icon = meta.icon;
                    return (
                      <div
                        key={i}
                        className={`flex gap-3 rounded-xl border p-3 ${meta.ring}`}
                      >
                        <Icon
                          size={18}
                          className={`mt-0.5 shrink-0 ${meta.ic1}`}
                        />
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            {ins.title}
                          </p>
                          <p className="text-xs text-slate-600">{ins.detail}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <Lightbulb size={18} className={ACCENT_TEXT} />
                  <h2 className="text-sm font-semibold text-slate-700">
                    Recommendations
                  </h2>
                </div>
                <ul className="space-y-2">
                  {recommendations.map((r, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-600">
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${ACCENT_BG}`}
                      />
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Team filter */}
            {realTeams.length >= 1 && (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Team
                </span>
                <TeamToggle
                  teams={realTeams.map((t) => t.team)}
                  value={teamFilter}
                  onChange={setTeamFilter}
                  labelFor={teamDisplay}
                />
              </div>
            )}

            {/* Status filter */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setStatusFilter("all")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  statusFilter === "all"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                All ({statScopedRows.length})
              </button>
              {(Object.keys(STATUS_META) as MatchStatus[]).map((s) => {
                const n = statScopedRows.filter((r) => r.status === s).length;
                if (n === 0) return null;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      statusFilter === s
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${STATUS_META[s].dot}`}
                    />
                    {STATUS_META[s].label} ({n})
                  </button>
                );
              })}
            </div>

            {/* Synced side-by-side timeline */}
            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {canEditMaster && master && (
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-amber-50/60 px-3 py-2">
                  <span className="text-xs font-semibold text-amber-700">
                    Master editing
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Fix a mis-coded player/stat, remove a bad entry, or add one
                    the master missed. Accuracy updates live.
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => setEditingMaster("new")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Plus size={13} /> Add instance
                    </button>
                    <button
                      onClick={downloadMaster}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Download size={13} /> Download corrected
                    </button>
                    <button
                      onClick={downloadMasterJson}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Download size={13} /> Download JSON
                    </button>
                    {loadedCheckId != null && (
                      <button
                        onClick={saveCorrectedMaster}
                        disabled={savingMaster}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                      >
                        <Save size={13} />{" "}
                        {savingMaster ? "Saving…" : "Save corrected master"}
                      </button>
                    )}
                  </div>
                  {masterSaveMsg && (
                    <span className="w-full text-[11px] text-slate-500">
                      {masterSaveMsg}
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-[128px_1fr_1fr] border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <div className="p-3">Status</div>
                <div className="border-l border-slate-200 p-3">
                  Master {master ? `· ${master.name}` : ""}
                </div>
                <div className="border-l border-slate-200 p-3">
                  Analyst {analyst ? `· ${analyst.name}` : ""}
                </div>
              </div>
              <div className="max-h-[600px] overflow-y-auto">
                {filteredRows.map((row, i) => {
                  const meta = STATUS_META[row.status];
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[128px_1fr_1fr] border-b border-slate-100 text-sm last:border-b-0 hover:bg-slate-50/60"
                    >
                      <div className="flex flex-wrap items-center gap-1 px-2 py-1">
                        <span
                          className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${meta.badge}`}
                        >
                          {meta.label}
                        </span>
                        {row.alsoWrongPlayer && (
                          <span
                            className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_META.wrong_player.badge}`}
                          >
                            {STATUS_META.wrong_player.label}
                          </span>
                        )}
                      </div>
                      <TimelineCell
                        instance={row.master}
                        onSeek={videoUrl.trim() ? seekVideo : undefined}
                        onEdit={
                          canEditMaster && row.master
                            ? () => editMasterInstance(row.master!)
                            : undefined
                        }
                        teamLabel={
                          row.master ? teamDisplay(row.master.team) : undefined
                        }
                        flagged={
                          !!row.master &&
                          flaggedKeys.has(disputeKey(row.master.id, "master"))
                        }
                      />
                      <TimelineCell
                        instance={row.analyst}
                        delta={row.timeDelta}
                        onSeek={videoUrl.trim() ? seekVideo : undefined}
                        teamLabel={
                          row.analyst
                            ? teamDisplay(row.analyst.team)
                            : undefined
                        }
                        flagged={
                          !!row.analyst &&
                          flaggedKeys.has(
                            disputeKey(row.analyst.id, "analyst")
                          )
                        }
                      />
                    </div>
                  );
                })}
                {filteredRows.length === 0 && (
                  <div className="p-8 text-center text-sm text-slate-400">
                    No rows for this filter.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Admin master instance editor */}
      {editingMaster && master && (
        <MasterEditModal
          instance={editingMaster === "new" ? null : editingMaster}
          isNew={editingMaster === "new"}
          teamOptions={Array.from(
            new Set(master.instances.map((i) => i.team).filter(Boolean))
          )}
          statCatalog={statCatalog}
          playerCatalog={master.instances}
          onSave={upsertMasterInstance}
          onDelete={deleteMasterInstance}
          onClose={() => setEditingMaster(null)}
        />
      )}



      {/* Split-screen review pop-up: video on the left half, both
          timelines (clickable) on the right half. */}
      {videoOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/80 p-2 backdrop-blur-sm">
          <div className="mx-auto flex h-full w-full max-w-[1800px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-4 py-2.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Video size={15} /> Video review
                <span className="text-xs font-normal text-slate-400">
                  · click any stat to jump to that moment
                  {canFlag
                    ? " · right-click an instance to flag it"
                    : user
                      ? " · right-click a missed/extra instance to flag it"
                      : ""}
                  {canResolveDispute
                    ? " · right-click a flagged instance to resolve it"
                    : ""}
                </span>
              </span>
              <div className="flex items-center gap-3">
                {reviewPlayer ? (
                  <span className="inline-flex items-center gap-2 rounded-md border border-sky-500/60 bg-sky-500/10 px-2.5 py-1.5 text-xs font-semibold text-sky-200">
                    {reviewPlayer.team} · #{reviewPlayer.number ?? "?"} ·{" "}
                    {reviewPlayer.columnLabel}
                    <button
                      onClick={() => setReviewPlayer(null)}
                      className="text-sky-300 hover:text-white"
                      title="Clear player filter"
                    >
                      <XIcon size={13} />
                    </button>
                  </span>
                ) : (
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-400">
                    <span>Show stat</span>
                    <select
                      value={videoStatFilter}
                      onChange={(e) => setVideoStatFilter(e.target.value)}
                      className="max-w-[240px] rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs font-medium normal-case text-slate-100 outline-none focus:border-sky-400"
                      aria-label="Select a stat to show in video review"
                    >
                      <option value="all">All stats</option>
                      {videoStatOptions.map((stat) => (
                        <option key={stat} value={stat}>
                          {stat}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  onClick={() => setVideoOpen(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                  title="Close"
                >
                  <XIcon size={18} />
                </button>
              </div>
            </div>

            {/* Status filter + clip navigator bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 bg-slate-900 px-4 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Status
                </span>
                <button
                  onClick={() => setVideoStatusFilter("all")}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    videoStatusFilter === "all"
                      ? "bg-white text-slate-900"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  All (
                  {Object.values(videoStatusCounts).reduce((a, b) => a + b, 0)})
                </button>
                {(Object.keys(STATUS_META) as MatchStatus[]).map((s) => {
                  const n = videoStatusCounts[s] ?? 0;
                  if (n === 0) return null;
                  const active = videoStatusFilter === s;
                  return (
                    <button
                      key={s}
                      onClick={() =>
                        setVideoStatusFilter(active ? "all" : s)
                      }
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                        active
                          ? "bg-white text-slate-900"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {STATUS_META[s].label} ({n})
                    </button>
                  );
                })}
                {disputes.length > 0 && (
                  <button
                    onClick={() => setFlaggedOnly((v) => !v)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                      flaggedOnly
                        ? "bg-amber-500 text-white"
                        : "bg-slate-800 text-amber-300 hover:bg-slate-700"
                    }`}
                    title="Show only flagged instances"
                  >
                    <Flag size={11} /> Flagged ({disputes.length})
                  </button>
                )}
              </div>

              {/* Clip navigator: jump straight to each instance. */}
              <div className="flex items-center gap-2">
                <label className="mr-1 inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-slate-300">
                  <input
                    type="checkbox"
                    checked={autoSkip}
                    onChange={(e) => setAutoSkip(e.target.checked)}
                    className="h-3.5 w-3.5 accent-sky-500"
                  />
                  Auto-skip
                </label>
                <button
                  onClick={() => goToClip(reviewIndex - 1, reviewSeekTimes)}
                  disabled={reviewSeekTimes.length === 0 || reviewIndex <= 0}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
                  title="Previous instance"
                >
                  <ChevronLeft size={14} /> Prev
                </button>
                <span className="min-w-[52px] text-center text-xs font-semibold tabular-nums text-slate-300">
                  {reviewSeekTimes.length === 0
                    ? "0 / 0"
                    : `${reviewIndex + 1} / ${reviewSeekTimes.length}`}
                </span>
                <button
                  onClick={() => goToClip(reviewIndex + 1, reviewSeekTimes)}
                  disabled={
                    reviewSeekTimes.length === 0 ||
                    reviewIndex >= reviewSeekTimes.length - 1
                  }
                  className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:opacity-40"
                  title="Next instance"
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>

            {/* Body: video (left, larger) + timelines (right) */}
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[2fr_1fr]">
              {/* Left: video (or a placeholder when no video is available —
                  the filtered instance list on the right still works). */}
              <div className="flex min-h-0 items-center justify-center bg-black p-2">
                {videoUrl.trim() ? (
                  <video
                    ref={videoRef}
                    src={videoUrl.trim()}
                    controls
                    onTimeUpdate={handleVideoTimeUpdate}
                    onSeeked={() => {
                      // Clear the self-seek guard once the browser finishes a
                      // seek. For OUR programmatic gap-skip this re-enables
                      // auto-skip on the next tick; for a user scrub it's a
                      // no-op (the flag was already false).
                      skippingRef.current = false;
                    }}
                    className="max-h-full max-w-full"
                  />
                ) : (
                  <div className="px-6 text-center text-sm text-slate-400">
                    No game video for this fixture. The filtered instances are
                    listed on the right.
                  </div>
                )}
              </div>

              {/* Right: timelines */}
              <div className="flex min-h-0 flex-col border-t border-slate-700 lg:border-l lg:border-t-0">
                <div className="grid grid-cols-[124px_1fr_1fr] border-b border-slate-700 bg-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <div className="p-2.5">Status</div>
                  <div className="border-l border-slate-700 p-2.5">
                    Master
                  </div>
                  <div className="border-l border-slate-700 p-2.5">
                    Analyst
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto bg-white">
                  {videoRows.map((row, i) => {
                    const meta = STATUS_META[row.status];
                    // A selected stat/player can exist on only one side of a
                    // row. Keep each side independent so every matching
                    // instance stays visible and the other side blanks out.
                    const sideShows = (inst: Instance | null) => {
                      if (!inst) return false;
                      if (reviewPlayer) {
                        return (
                          inst.team.toLowerCase() ===
                            reviewPlayer.team.toLowerCase() &&
                          inst.playerNumber === reviewPlayer.number &&
                          statMatchesColumn(
                            sportConfig,
                            reviewPlayer.columnKey,
                            inst.stat.toLowerCase()
                          )
                        );
                      }
                      return (
                        videoStatFilter === "all" ||
                        inst.stat.trim() === videoStatFilter
                      );
                    };
                    const masterInstance = sideShows(row.master)
                      ? row.master
                      : null;
                    const analystInstance = sideShows(row.analyst)
                      ? row.analyst
                      : null;
                    // For a missed/extra row the empty cell's dispute anchors
                    // to the OPPOSING populated instance. Use the RAW row
                    // sides (filter-independent) so a stat/player filter never
                    // suppresses the affordance — permission is gated by the
                    // filter-independent row.status via canFlagRow below.
                    const emptyAnchor = emptyCellAnchor(row.status, {
                      master: row.master,
                      analyst: row.analyst,
                    });
                    const emptyFlagAllowed =
                      !!emptyAnchor &&
                      (canFlagRow(row.status) || canResolveDispute);
                    const masterActive =
                      !!masterInstance &&
                      videoTime >= masterInstance.start &&
                      videoTime <= masterInstance.end;
                    const analystActive =
                      !!analystInstance &&
                      videoTime >= analystInstance.start &&
                      videoTime <= analystInstance.end;
                    const rowActive = masterActive || analystActive;
                    return (
                      <div
                        key={i}
                        ref={rowActive ? activeRowRef : undefined}
                        className={`grid grid-cols-[124px_1fr_1fr] border-b text-sm last:border-b-0 ${
                          rowActive
                            ? "border-sky-400 bg-sky-50 shadow-[inset_4px_0_0_0_#0ea5e9]"
                            : "border-slate-100"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-1 px-2 py-1">
                          <span
                            className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${meta.badge}`}
                          >
                            {meta.label}
                          </span>
                          {row.alsoWrongPlayer && (
                            <span
                              className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_META.wrong_player.badge}`}
                            >
                              {STATUS_META.wrong_player.label}
                            </span>
                          )}
                        </div>
                        <TimelineCell
                          instance={masterInstance}
                          onSeek={seekVideo}
                          active={masterActive}
                          onEdit={
                            canEditMaster && masterInstance
                              ? () => editMasterInstance(masterInstance)
                              : undefined
                          }
                          teamLabel={
                            masterInstance
                              ? teamDisplay(masterInstance.team)
                              : undefined
                          }
                          flagged={
                            !!masterInstance &&
                            flaggedKeys.has(
                              disputeKey(masterInstance.id, "master")
                            )
                          }
                          onFlag={
                            (canFlagRow(row.status) || canResolveDispute) &&
                            masterInstance
                              ? (e) =>
                                  openFlagMenu(
                                    e,
                                    masterInstance,
                                    "master",
                                    row.status
                                  )
                              : undefined
                          }
                          emptyFlag={
                            !masterInstance &&
                            !row.master &&
                            emptyAnchor &&
                            emptyAnchor.side === "analyst" &&
                            emptyFlagAllowed
                              ? {
                                  onFlag: (e) =>
                                    openFlagMenu(
                                      e,
                                      emptyAnchor.instance,
                                      emptyAnchor.side,
                                      row.status
                                    ),
                                  flagged: flaggedKeys.has(
                                    disputeKey(
                                      emptyAnchor.instance.id,
                                      emptyAnchor.side
                                    )
                                  ),
                                  title:
                                    "right-click to dispute this extra event",
                                }
                              : undefined
                          }
                        />
                        <TimelineCell
                          instance={analystInstance}
                          delta={masterInstance && analystInstance ? row.timeDelta : null}
                          onSeek={seekVideo}
                          active={analystActive}
                          teamLabel={
                            analystInstance
                              ? teamDisplay(analystInstance.team)
                              : undefined
                          }
                          flagged={
                            !!analystInstance &&
                            flaggedKeys.has(
                              disputeKey(analystInstance.id, "analyst")
                            )
                          }
                          onFlag={
                            (canFlagRow(row.status) || canResolveDispute) &&
                            analystInstance
                              ? (e) =>
                                  openFlagMenu(
                                    e,
                                    analystInstance,
                                    "analyst",
                                    row.status
                                  )
                              : undefined
                          }
                          emptyFlag={
                            !analystInstance &&
                            !row.analyst &&
                            emptyAnchor &&
                            emptyAnchor.side === "master" &&
                            emptyFlagAllowed
                              ? {
                                  onFlag: (e) =>
                                    openFlagMenu(
                                      e,
                                      emptyAnchor.instance,
                                      emptyAnchor.side,
                                      row.status
                                    ),
                                  flagged: flaggedKeys.has(
                                    disputeKey(
                                      emptyAnchor.instance.id,
                                      emptyAnchor.side
                                    )
                                  ),
                                  title:
                                    "right-click to dispute this missing event",
                                }
                              : undefined
                          }
                        />
                      </div>
                    );
                  })}
                  {videoRows.length === 0 && (
                    <div className="p-8 text-center text-sm text-slate-400">
                      No instances for this stat.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Flag-as-dispute context menu (right-click a review instance). */}
      {flagMenu && (
        <FlagMenu
          x={flagMenu.x}
          y={flagMenu.y}
          instance={flagMenu.instance}
          side={flagMenu.side}
          dispute={
            flaggedKeys.get(
              disputeKey(flagMenu.instance.id, flagMenu.side)
            ) ?? null
          }
          // Analysts flag; admins resolve flagged instances.
          mode={
            canResolveDispute &&
            flaggedKeys.has(disputeKey(flagMenu.instance.id, flagMenu.side))
              ? "resolve"
              : "flag"
          }
          onSubmit={submitFlag}
          onResolve={submitResolve}
        />
      )}
    </div>
  );
}

// Small popover shown on right-clicking a review instance: optional reason
// then flag. Stops propagation so the outside-click handler doesn't close it.
function FlagMenu({
  x,
  y,
  instance,
  side,
  dispute,
  mode,
  onSubmit,
  onResolve,
}: {
  x: number;
  y: number;
  instance: Instance;
  side: DisputeSide;
  dispute: Dispute | null;
  mode: "flag" | "resolve";
  onSubmit: (reason: string | null, category: DisputeCategory | null) => void;
  onResolve: (status: "confirmed" | "denied", note: string | null) => void;
}) {
  const [reason, setReason] = useState(dispute?.reason ?? "");
  const [category, setCategory] = useState<DisputeCategory | "">(
    dispute?.category ?? ""
  );
  const [note, setNote] = useState("");
  // Keep the menu on-screen.
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 300);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 220);

  const header = (
    <p className="mb-2 truncate text-[11px] text-slate-500">
      {side === "master" ? "Master" : "Analyst"} ·{" "}
      {instance.stat || "—"}
      {instance.playerNumber != null ? ` · #${instance.playerNumber}` : ""}
    </p>
  );

  if (mode === "resolve") {
    // Admin resolving a flagged instance.
    return (
      <div
        className="fixed z-[60] w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-2xl"
        style={{ left, top }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <Flag size={13} className="text-amber-600" /> Resolve dispute
        </p>
        {header}
        {dispute?.reason && (
          <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
            Reason: {dispute.reason}
          </p>
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Resolution note (optional)"
          className="mb-2 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-slate-500"
        />
        <div className="flex gap-1.5">
          <button
            onClick={() => onResolve("confirmed", note.trim() || null)}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            Analyst correct
          </button>
          <button
            onClick={() => onResolve("denied", note.trim() || null)}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-sky-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
          >
            Master correct
          </button>
        </div>
      </div>
    );
  }

  // Analyst flagging (or updating the reason).
  return (
    <div
      className="fixed z-[60] w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-2xl"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
        <Flag size={13} className="text-amber-600" /> Flag as dispute
      </p>
      {header}
      {dispute && (
        <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          Already flagged — submitting updates the category & reason.
        </p>
      )}
      <label className="mb-1 block text-[11px] font-medium text-slate-500">
        Category
      </label>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as DisputeCategory | "")}
        autoFocus
        className="mb-2 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-amber-500"
      >
        <option value="">Select a category…</option>
        {DISPUTE_CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Reason (optional)"
        className="mb-2 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-amber-500"
      />
      <button
        onClick={() => onSubmit(reason.trim() || null, category || null)}
        disabled={!category}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Flag size={13} /> Flag instance
      </button>
    </div>
  );
}

// Searchable analyst picker: type to filter, scrollable list, click to
// select. Replaces the native <select> (which scroll-jumps and can't be
// typed into).
function AnalystCombobox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={open ? query : value}
        placeholder="Type to search analyst..."
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
      />
      {value && !open && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
          title="Clear"
          type="button"
        >
          <XIcon size={14} />
        </button>
      )}
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                  setQuery("");
                }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-100 ${
                  o === value ? "bg-slate-50 font-semibold text-slate-900" : "text-slate-700"
                }`}
              >
                {o}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Both teams / Home / Away toggle. Shared above the category breakdown
// and the player table; changing it updates teamFilter, which every
// team-aware table on the page reads from.
function TeamToggle({
  teams,
  value,
  onChange,
  labelFor,
}: {
  teams: string[];
  value: string;
  onChange: (v: string) => void;
  /** Maps a canonical team value to a display label (e.g. real club name). */
  labelFor?: (team: string) => string;
}) {
  const btn = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
      active
        ? "bg-slate-900 text-white"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button onClick={() => onChange("all")} className={btn(value === "all")}>
        Both teams
      </button>
      {teams.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={btn(value === t)}
        >
          {labelFor ? labelFor(t) : t}
        </button>
      ))}
    </div>
  );
}

function TimelineCell({
  instance,
  delta,
  onSeek,
  active,
  flagged,
  onFlag,
  onEdit,
  teamLabel,
  emptyFlag,
}: {
  instance: Instance | null;
  delta?: number | null;
  onSeek?: (seconds: number) => void;
  active?: boolean;
  flagged?: boolean;
  onFlag?: (e: React.MouseEvent) => void;
  /** Admin-only: edit this (master) instance. Renders a pencil button. */
  onEdit?: () => void;
  /** Real club name to show instead of the canonical "Home"/"Away". */
  teamLabel?: string;
  /**
   * Makes the EMPTY "— no entry —" cell of a missed/extra row flaggable. The
   * dispute anchors to the OPPOSING populated instance (handled by the caller
   * via `onFlag`). When undefined the empty cell stays the inert placeholder.
   */
  emptyFlag?: {
    onFlag: (e: React.MouseEvent) => void;
    flagged: boolean;
    title: string;
  };
}) {
  if (!instance) {
    if (emptyFlag) {
      return (
        <div
          className={`border-l border-slate-200 px-2 py-1 cursor-context-menu hover:bg-amber-50/60 ${
            emptyFlag.flagged ? "ring-2 ring-inset ring-amber-500" : ""
          }`}
          onContextMenu={emptyFlag.onFlag}
          title={emptyFlag.title}
        >
          <span className="flex items-center gap-x-1.5 text-[11px] italic text-slate-300">
            {emptyFlag.flagged && (
              <Flag
                size={10}
                className="shrink-0 not-italic fill-amber-500 text-amber-600"
              />
            )}
            — no entry —
          </span>
        </div>
      );
    }
    return (
      <div className="border-l border-slate-200 px-2 py-1">
        <span className="text-[11px] italic text-slate-300">— no entry —</span>
      </div>
    );
  }

  // Colour the whole cell by team: Home = green, Away = orange (teams
  // are canonicalised to Home/Away). Anything else (Unknown /
  // unattributed events) stays neutral.
  const teamKey = instance.team.trim().toLowerCase();
  const isHome = teamKey === "home";
  const isAway = teamKey === "away";
  const cellBg = isHome
    ? "bg-emerald-50 border-emerald-200"
    : isAway
      ? "bg-orange-50 border-orange-200"
      : "border-slate-200";

  const clickable = !!onSeek;

  return (
    <div
      className={`border-l px-2 py-1 ${
        active ? "bg-sky-100 ring-2 ring-inset ring-sky-500" : cellBg
      } ${
        clickable ? "cursor-pointer hover:brightness-95" : ""
      } ${flagged ? "ring-2 ring-inset ring-amber-500" : ""}`}
      onClick={
        clickable
          ? () => onSeek!(instance.start)
          : undefined
      }
      onContextMenu={onFlag}
      title={
        onFlag
          ? `${formatTime(instance.mid)} · ${
              instance.stat || instance.category || "—"
            } · ${teamLabel ?? instance.team}${
              instance.playerNumber != null ? ` #${instance.playerNumber}` : ""
            } — click to jump · right-click to flag`
          : clickable
            ? "Jump to this moment in the video"
            : undefined
      }
    >
      {/* Single compact line: time · icons · stat (truncates) · team/#player */}
      <div className="flex items-center gap-x-1.5 overflow-hidden whitespace-nowrap">
        <span className="shrink-0 font-mono text-[11px] font-semibold text-slate-500">
          {formatTime(instance.mid)}
        </span>
        {clickable && (
          <Video size={10} className="shrink-0 text-slate-400" />
        )}
        {flagged && (
          <Flag size={10} className="shrink-0 fill-amber-500 text-amber-600" />
        )}
        {delta != null && delta > 0 && (
          <span className="shrink-0 text-[10px] text-slate-400">
            +{delta.toFixed(1)}s
          </span>
        )}
        <span className="truncate text-xs font-semibold text-slate-900">
          {instance.stat || instance.category || "—"}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-medium text-slate-500">
          {teamLabel ?? instance.team}
          {instance.playerNumber != null && ` #${instance.playerNumber}`}
        </span>
        {onEdit && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            title="Edit master instance"
            className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
