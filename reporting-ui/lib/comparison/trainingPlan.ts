// Recommended training plan for the Accuracy comparison page.
//
// Pure and deterministic: no React, DOM or Supabase dependency. Takes the
// page's comparison rows (plus optional history of earlier checks) and returns
// a plan: the specific instances that were missed / extra / wrong player /
// wrong stat / wrong team, trending stats, and a prioritised focus list.
// It only READS a ComparisonResult; it never changes scoring.

import {
  formatTime,
  type CategoryBreakdown,
  type ComparisonResult,
  type ComparisonRow,
  type Instance,
} from "./xml-compare";
import { drillFor, type ErrorType } from "./trainingPlanDrills";
import type { Dispute } from "@/lib/api/disputes";
import type { AccuracyCheckMeta } from "@/lib/api/accuracyChecks";

export type { ErrorType } from "./trainingPlanDrills";

export const ERROR_TYPE_ORDER: ErrorType[] = [
  "missed",
  "extra",
  "wrong_player",
  "wrong_stat",
  "wrong_team",
];

export const ERROR_TYPE_LABEL: Record<ErrorType, string> = {
  missed: "Missed",
  extra: "Extra",
  wrong_player: "Wrong player",
  wrong_stat: "Wrong stat",
  wrong_team: "Wrong team",
};

/** Tie order used to pick the dominant error type of a stat/category item. */
const DOMINANT_TIE_ORDER: ErrorType[] = [
  "wrong_player",
  "missed",
  "extra",
  "wrong_stat",
  "wrong_team",
];

export const TRAINING_TREND_CONSTANTS = {
  /** default window: last N checks */
  DEFAULT_HISTORY_CHECKS: 10,
  /** UI cap (each check = 2 blobs to download and parse) */
  MAX_HISTORY_CHECKS: 20,
  /** alternative window: last D days */
  DEFAULT_HISTORY_DAYS: 90,
  MAX_HISTORY_DAYS: 365,
  /** window for the all-analyst average */
  ALL_ANALYST_DAYS: 90,
  /** a check only "counts" for a stat/category with >= this many events */
  MIN_EVENTS_PER_CHECK: 5,
  /**
   * (i) persistent: error rate >= 30% in a check = a "hit". A stat is
   * persistent only when ALL of the following hold:
   *   - >= PERSISTENT_MIN_CHECKS counted checks (current included)
   *   - hits / counted checks >= PERSISTENT_MIN_SHARE (70%)
   *   - its pooled error rate over the window is >= the PERSISTENT_PERCENTILE
   *     point (90th percentile) of the analyst's own pooled stat error rates,
   *     so only their worst tenth of stats is flagged, even for an analyst
   *     who is generally noisy
   *   - >= PERSISTENT_MIN_CURRENT_ERRORS errors in this check (not worth
   *     flagging a stat that barely occurred this time)
   */
  TREND_PERSISTENT_RATE: 0.3,
  PERSISTENT_MIN_CHECKS: 3,
  PERSISTENT_MIN_SHARE: 0.7,
  PERSISTENT_PERCENTILE: 0.9,
  PERSISTENT_MIN_CURRENT_ERRORS: 3,
  /** (ii) recent = last 3 counted points (current included) */
  WORSENING_RECENT_POINTS: 3,
  /** (ii) needs >= 2 earlier counted points */
  WORSENING_MIN_EARLIER_POINTS: 2,
  /** (ii) each side needs >= 10 pooled events */
  WORSENING_MIN_POOLED_EVENTS: 10,
  /** (ii) recent pooled rate - earlier pooled rate >= 15 percentage points */
  WORSENING_DELTA: 0.15,
  /** (ii) and the recent pooled rate must itself be >= 20% */
  WORSENING_MIN_RECENT_RATE: 0.2,
  /**
   * Tolerance for comparing rates (floating point): a delta of 0.0999999999
   * from rounding counts as exactly the threshold, and the same tolerance is
   * used for the other rate thresholds. Rates are ratios of small integers, so any
   * value this close to a threshold is the threshold.
   */
  EPSILON: 1e-9,
  /** (iii) top 3 stats by error count in scope */
  TOP_N_THIS_CHECK: 3,
  /** (iii) needs >= 3 errors in this check */
  TOP_MIN_ERRORS: 3,
  /** (iii) "appeared in history" = >= 1 earlier check with >= 1 error */
  TOP_MIN_HISTORY_CHECKS: 1,
  /** error-type focus item skipped when >= 70% of its instances are already in a stat/category item */
  FOCUS_COVERAGE_SKIP: 0.7,
  /** key focus areas shown (one block per stat) */
  FOCUS_MAX: 3,
  /** example instances shown per focus area */
  EXAMPLES_MAX: 3,
  /** a non-trending stat / error type becomes a focus item at >= 3 errors */
  FOCUS_TYPE_MIN_ERRORS: 3,
  /** strengths: stat accuracy >= 95% (inclusive) ... */
  STRENGTH_MIN_ACCURACY: 0.95,
  /** ... with at least this many master instances in the check */
  STRENGTH_MIN_INSTANCES: 10,
  /** strengths shown */
  STRENGTH_MAX: 5,
  /** best stats listed when nothing reaches 95% */
  STRENGTH_FALLBACK: 2,
  /** history: "consistently" = 95%+ in at least this share of counted checks */
  STRENGTH_CONSISTENT_SHARE: 0.7,
  /** summary says "in line with" within this many accuracy points */
  SUMMARY_FLAT_PTS: 0.5,
  /** focus titles listed in the default send message */
  MESSAGE_TOP_FOCUS: 3,
} as const;

const C = TRAINING_TREND_CONSTANTS;
const MESSAGE_MAX_CHARS = 4000;

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type PlanScope = "filters" | "all";
export type HistoryWindow =
  | { mode: "checks"; n: number }
  | { mode: "days"; days: number };

export interface PlanOptions {
  scope: PlanScope;
  window: HistoryWindow;
  now?: Date;
}

export interface PlanContext {
  analystName: string | null;
  checkId: number | null;
  checkCreatedAt: string | null;
  sport: "afl" | "football" | null;
  matchLabel: string | null;
  masterFileName: string | null;
  videoUrl: string | null;
  /** CheckCategory of the loaded check; null = unsaved or legacy (treated as full_game) */
  checkCategory: string | null;
  teamLabel: (canonTeam: string) => string;
  scopeFilters: { team: string | "all"; category: string | "all"; stat: string | "all" };
  /** null disables review links; the hook computes it from window.location inside an effect */
  reviewBaseUrl: string | null;
  disputes: Dispute[];
}

export interface CurrentInput {
  result: ComparisonResult;
  scopeRows: ComparisonRow[];
}

export interface StatCounts {
  events: number;
  errors: number;
  byType: Record<ErrorType, number>;
}

export interface HistoryCheck {
  id: number;
  createdAt: string;
  matchLabel: string | null;
  accuracy: number | null;
  summary: {
    masterTotal: number;
    exact: number;
    missed: number;
    extra: number;
    wrongPlayer: number;
    wrongStat: number;
    wrongTeam: number;
  };
  categories: { category: string; total: number; exact: number }[];
  /** keyed by lower-cased trimmed stat; null = not re-graded */
  stats: Record<string, StatCounts> | null;
  category: string | null;
}

export interface HistoryInput {
  checks: HistoryCheck[];
  allAnalystAverage: {
    accuracy: number | null;
    byCategory: Record<string, number>;
  } | null;
  warnings: string[];
  /** checks matching the window before the 20-check cap (for the truncation note) */
  matchedInWindow?: number;
}

export interface PlanInstance {
  key: string;
  type: ErrorType;
  stat: string;
  codedStat: string | null;
  category: string;
  timeSeconds: number;
  startSeconds: number;
  timeLabel: string;
  expected: { team: string; player: string } | null;
  coded: { team: string; player: string } | null;
  alsoWrongPlayer: boolean;
  alsoWrongTeam: boolean;
  timeDelta: number | null;
  dispute: { state: "none" | "open" | "denied"; reason: string | null };
  videoLink: string | null;
  reviewLink: string | null;
}

export type TrendKind = "persistent" | "worsening" | "top_this_check";
export interface TrendReason {
  kind: TrendKind;
  text: string;
}
export interface TrendPoint {
  checkId: number | null;
  date: string;
  events: number;
  errors: number;
  rate: number | null;
  counted: boolean;
  isCurrent: boolean;
}
export interface TrendItem {
  key: string;
  label: string;
  level: "stat" | "category";
  reasons: TrendReason[];
  points: TrendPoint[];
  currentErrors: number;
  byType: Record<ErrorType, number>;
}

export interface FocusItem {
  rank: number;
  id: string;
  kind: "stat" | "category" | "errorType";
  /** one line, e.g. "Touch: over-calling (61 extra)" */
  title: string;
  /** error types of this stat, e.g. "61 extra, 5 missed" */
  why: string;
  drill: string;
  /** dominant error type */
  errorType: ErrorType;
  errorTypes: { type: ErrorType; count: number }[];
  /** stat (or category) label this block is about; null for error-type items */
  label: string | null;
  /** this check's accuracy for the stat (master-based); null when unknown */
  accuracy: number | null;
  /** one short phrase, e.g. "Persistent: 30%+ errors in 4 of 5 checks" */
  trendText: string;
  /** error-rate series for this stat only (oldest to current); null when no history */
  trendPoints: TrendPoint[] | null;
  /** up to EXAMPLES_MAX representative instances */
  examples: PlanInstance[];
  priority: number;
  trendKinds: TrendKind[];
  instanceKeys: string[];
}

export interface StrengthItem {
  stat: string;
  key: string;
  accuracy: number;
  instances: number;
  /** e.g. "consistently 95%+ in 8 of last 10 checks"; null when no history */
  consistency: string | null;
  /** error-rate series for this stat (oldest to current); null when no history */
  trendPoints: TrendPoint[] | null;
}

export interface StrengthsResult {
  /** top STRENGTH_MAX */
  items: StrengthItem[];
  /** every stat that qualifies (used by the Excel Strengths sheet) */
  all: StrengthItem[];
  /** best stats when none qualify */
  fallback: StrengthItem[];
}

export interface TrendsResult {
  level: "stat" | "category" | "none";
  items: TrendItem[];
  notes: string[];
  /** error-rate series for every stat/category (used for inline sparklines) */
  series?: Record<string, TrendPoint[]>;
}

export interface TrainingPlan {
  generatedAt: string;
  options: PlanOptions;
  header: {
    analystName: string | null;
    fixture: string;
    matchLabel: string | null;
    masterFileName: string | null;
    sport: string | null;
    checkId: number | null;
    checkDate: string | null;
    scopeLabel: string;
    overallAccuracy: number;
    scopeAccuracy: number | null;
    counts: Record<ErrorType, number>;
    totalErrors: number;
    excludedByDispute: number;
    underDispute: number;
    categories: {
      category: string;
      accuracy: number;
      analystAvg: number | null;
      allAnalystAvg: number | null;
      deltaVsAnalyst: number | null;
    }[];
    analystAvgAccuracy: number | null;
    allAnalystAvgAccuracy: number | null;
    historyChecksUsed: number;
  };
  /** 2-3 line summary: headline, accuracy vs the analyst's recent average */
  summary: {
    headline: string;
    accuracyLine: string;
    direction: "up" | "down" | "flat" | null;
    /** accuracy points vs analyst average (positive = better) */
    deltaPts: number | null;
  };
  strengths: StrengthsResult;
  instances: PlanInstance[];
  trends: TrendsResult;
  focus: FocusItem[];
  notes: string[];
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

const emptyByType = (): Record<ErrorType, number> => ({
  missed: 0,
  extra: 0,
  wrong_player: 0,
  wrong_stat: 0,
  wrong_team: 0,
});

/** Legacy null category is treated as full_game everywhere categories are compared. */
export function normCat(c: string | null | undefined): string {
  return c ?? "full_game";
}

export function classifyRow(row: ComparisonRow): ErrorType | null {
  return row.status === "exact" ? null : row.status;
}

export function rowStat(row: ComparisonRow): string {
  return (row.master?.stat ?? row.analyst?.stat ?? "Uncategorised").trim();
}

export function rowCategory(row: ComparisonRow): string {
  return (
    row.master?.category ??
    row.analyst?.category ??
    "Uncategorised"
  ).trim();
}

const statKey = (s: string) => s.trim().toLowerCase();

function clampInt(v: number, lo: number, hi: number, dflt: number): number {
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function normaliseOptions(options: PlanOptions): PlanOptions {
  const scope: PlanScope = options.scope === "all" ? "all" : "filters";
  const w = options.window;
  const window: HistoryWindow =
    w && w.mode === "days"
      ? {
          mode: "days",
          days: clampInt(w.days, 1, C.MAX_HISTORY_DAYS, C.DEFAULT_HISTORY_DAYS),
        }
      : {
          mode: "checks",
          n: clampInt(
            (w as { n?: number } | undefined)?.n ?? NaN,
            1,
            C.MAX_HISTORY_CHECKS,
            C.DEFAULT_HISTORY_CHECKS
          ),
        };
  return { ...options, scope, window };
}

const pct0 = (n: number) => `${Math.round(n * 100)}%`;
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

// --------------------------------------------------------------------------
// Links
// --------------------------------------------------------------------------

export function buildVideoLink(
  url: string | null | undefined,
  seconds: number
): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hashAt = u.indexOf("#");
  const base = hashAt >= 0 ? u.slice(0, hashAt) : u;
  return `${base}#t=${Math.max(0, Math.floor(seconds))}`;
}

export function buildReviewLink(
  base: string | null | undefined,
  checkId: number | null,
  start: number,
  stat: string
): string | null {
  if (!base || checkId == null) return null;
  const params = new URLSearchParams({
    check: String(checkId),
    seek: String(start),
    stat,
  });
  return `${base}?${params.toString()}`;
}

// --------------------------------------------------------------------------
// Disputes
// --------------------------------------------------------------------------

type DisputeOutcome = "none" | "open" | "confirmed" | "denied";

function matchesInstance(
  d: Dispute,
  inst: Instance,
  side: "master" | "analyst"
): boolean {
  if (d.side !== side) return false;
  if (d.instance_id === inst.id) return true;
  // Fallback for ID-less XML (random ids on each parse).
  if (d.code_time == null || d.stat == null || d.team == null) return false;
  return (
    d.stat.trim().toLowerCase() === inst.stat.trim().toLowerCase() &&
    d.team.trim().toLowerCase() === inst.team.trim().toLowerCase() &&
    Math.abs(d.code_time - inst.mid) <= 0.5
  );
}

function disputeInfoForRow(
  row: ComparisonRow,
  disputes: Dispute[]
): { outcome: DisputeOutcome; reason: string | null } {
  let open: Dispute | null = null;
  let denied: Dispute | null = null;
  for (const d of disputes) {
    if (d.deleted_at != null) continue;
    const hit =
      (row.master != null && matchesInstance(d, row.master, "master")) ||
      (row.analyst != null && matchesInstance(d, row.analyst, "analyst"));
    if (!hit) continue;
    if (d.status === "confirmed") return { outcome: "confirmed", reason: d.reason };
    if (d.status === "open" && !open) open = d;
    if (d.status === "denied" && !denied) denied = d;
  }
  if (open) return { outcome: "open", reason: open.reason };
  if (denied) return { outcome: "denied", reason: denied.reason };
  return { outcome: "none", reason: null };
}

/**
 * Dispute state of a comparison row: any confirmed ("Analyst correct") on
 * either side wins, then open, then denied. The ONLY place dispute status is
 * read for the plan. (Named to avoid the write function resolveDispute in
 * lib/api/disputes.ts.)
 */
export function disputeOutcomeForRow(
  row: ComparisonRow,
  disputes: Dispute[]
): DisputeOutcome {
  return disputeInfoForRow(row, disputes).outcome;
}

/**
 * excludeFn used by countStats / detectTrends: true drops the row from both
 * events and errors. Rows resolved in the analyst's favour (confirmed) are
 * excluded; open disputes are counted but marked in the plan instances.
 */
export function makeDisputeExclude(
  disputes: Dispute[]
): (row: ComparisonRow) => boolean {
  const active = disputes.filter((d) => d.deleted_at == null);
  if (active.length === 0) return () => false;
  return (row) => disputeOutcomeForRow(row, active) === "confirmed";
}

// --------------------------------------------------------------------------
// Counting
// --------------------------------------------------------------------------

function countBy(
  rows: ComparisonRow[],
  exclude: (row: ComparisonRow) => boolean,
  keyOf: (row: ComparisonRow) => string
): Record<string, StatCounts> {
  const out: Record<string, StatCounts> = {};
  for (const row of rows) {
    if (!row.master && !row.analyst) continue;
    if (exclude(row)) continue;
    const k = statKey(keyOf(row));
    const c = (out[k] ??= { events: 0, errors: 0, byType: emptyByType() });
    c.events += 1;
    const t = classifyRow(row);
    if (t) {
      c.errors += 1;
      c.byType[t] += 1;
    }
  }
  return out;
}

export function countStats(
  rows: ComparisonRow[],
  exclude: (row: ComparisonRow) => boolean
): Record<string, StatCounts> {
  return countBy(rows, exclude, rowStat);
}

// --------------------------------------------------------------------------
// History selection
// --------------------------------------------------------------------------

export function selectHistoryChecks(
  metas: AccuracyCheckMeta[],
  window: HistoryWindow,
  ref: {
    date: Date;
    sport: "afl" | "football" | null;
    category: string | null;
    excludeCheckId: number | null;
    analystName: string;
  }
): { selected: AccuracyCheckMeta[]; matchedInWindow: number } {
  const name = ref.analystName.trim().toLowerCase();
  const refMs = ref.date.getTime();
  const refCat = normCat(ref.category);
  const candidates = metas
    .filter((m) => {
      if (m.accuracy == null) return false;
      if (m.id === ref.excludeCheckId) return false;
      if ((m.analyst_name ?? "").trim().toLowerCase() !== name) return false;
      const t = new Date(m.created_at).getTime();
      if (!Number.isFinite(t) || t > refMs) return false;
      if (ref.sport != null && m.sport != null && m.sport !== ref.sport)
        return false;
      return normCat(m.category) === refCat;
    })
    .sort((a, b) => {
      const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return d !== 0 ? d : a.id - b.id;
    });

  if (window.mode === "days") {
    const days = clampInt(window.days, 1, C.MAX_HISTORY_DAYS, C.DEFAULT_HISTORY_DAYS);
    const cutoff = refMs - days * 86_400_000;
    const inWindow = candidates.filter(
      (m) => new Date(m.created_at).getTime() >= cutoff
    );
    return {
      selected: inWindow.slice(-C.MAX_HISTORY_CHECKS),
      matchedInWindow: inWindow.length,
    };
  }
  const n = clampInt(window.n, 1, C.MAX_HISTORY_CHECKS, C.DEFAULT_HISTORY_CHECKS);
  const selected = candidates.slice(-n);
  return { selected, matchedInWindow: selected.length };
}

// --------------------------------------------------------------------------
// Trends
// --------------------------------------------------------------------------

const rateOf = (events: number, errors: number) =>
  events > 0 ? errors / events : null;

function makePoint(
  checkId: number | null,
  date: string,
  events: number,
  errors: number,
  isCurrent: boolean
): TrendPoint {
  return {
    checkId,
    date,
    events,
    errors,
    rate: rateOf(events, errors),
    counted: events >= C.MIN_EVENTS_PER_CHECK,
    isCurrent,
  };
}

function pooled(points: TrendPoint[]): { events: number; rate: number } {
  const events = points.reduce((s, p) => s + p.events, 0);
  const errors = points.reduce((s, p) => s + p.errors, 0);
  return { events, rate: events > 0 ? errors / events : 0 };
}

/** Pooled error rate over a stat's counted points; null when it has none. */
function pooledCountedRate(points: TrendPoint[]): number | null {
  const counted = points.filter((p) => p.counted);
  return counted.length > 0 ? pooled(counted).rate : null;
}

/** Nearest-rank percentile (p in 0..1); 0 for an empty list. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

function flagPoints(
  points: TrendPoint[],
  scopeRank: number | null,
  scopeErrors: number,
  analystBarRate: number
): TrendReason[] {
  const reasons: TrendReason[] = [];
  const counted = points.filter((p) => p.counted);

  // (i) persistent: high rate in >= 70% of counted checks AND the pooled rate
  // is at or above the analyst's own 90th-percentile stat error rate, with
  // enough errors in this check.
  if (counted.length >= C.PERSISTENT_MIN_CHECKS) {
    const hits = counted.filter(
      (p) => (p.rate ?? 0) >= C.TREND_PERSISTENT_RATE - C.EPSILON
    ).length;
    const own = pooled(counted).rate;
    if (
      hits / counted.length >= C.PERSISTENT_MIN_SHARE - C.EPSILON &&
      own >= analystBarRate - C.EPSILON &&
      // this check's errors over ALL rows (not the scope filter), so the
      // persistent flag does not change with the filters
      (points[points.length - 1]?.errors ?? 0) >= C.PERSISTENT_MIN_CURRENT_ERRORS
    ) {
      reasons.push({
        kind: "persistent",
        text: `Persistent: ${pct0(C.TREND_PERSISTENT_RATE)}+ errors in ${hits} of last ${counted.length} checks`,
      });
    }
  }

  // (ii) worsening
  if (counted.length >= C.WORSENING_RECENT_POINTS + C.WORSENING_MIN_EARLIER_POINTS) {
    const recent = counted.slice(-C.WORSENING_RECENT_POINTS);
    const earlier = counted.slice(0, counted.length - C.WORSENING_RECENT_POINTS);
    const r = pooled(recent);
    const e = pooled(earlier);
    if (
      r.events >= C.WORSENING_MIN_POOLED_EVENTS &&
      e.events >= C.WORSENING_MIN_POOLED_EVENTS &&
      r.rate >= C.WORSENING_MIN_RECENT_RATE - C.EPSILON &&
      r.rate - e.rate >= C.WORSENING_DELTA - C.EPSILON
    ) {
      reasons.push({
        kind: "worsening",
        text: `Worsening: ${pct0(e.rate)} to ${pct0(r.rate)} errors (last ${recent.length} checks vs earlier)`,
      });
    }
  }

  // (iii) top in this check, seen in history
  if (
    scopeRank != null &&
    scopeRank <= C.TOP_N_THIS_CHECK &&
    scopeErrors >= C.TOP_MIN_ERRORS
  ) {
    const hist = points.filter((p) => !p.isCurrent);
    const seen = hist.filter((p) => p.errors >= 1).length;
    if (seen >= C.TOP_MIN_HISTORY_CHECKS) {
      reasons.push({
        kind: "top_this_check",
        text: `${ordinal(scopeRank)} most errors this check (${scopeErrors}); also had errors in ${seen} of last ${hist.length} checks`,
      });
    }
  }
  return reasons;
}

const dateOnly = (iso: string) => iso.slice(0, 10);

export function detectTrends(
  current: {
    allRows: ComparisonRow[];
    scopeRows: ComparisonRow[];
    byCategory: CategoryBreakdown[];
    exclude: (r: ComparisonRow) => boolean;
    /** ISO date for the current point; defaults to the empty string */
    currentDate?: string;
  },
  history: HistoryCheck[]
): TrendsResult {
  const notes: string[] = [];
  const curDate = current.currentDate ?? "";
  if (history.length === 0) {
    return {
      level: "none",
      items: [],
      notes: ["No earlier checks to compare, so no trends are shown."],
    };
  }

  const statHistory = history.filter((h) => h.stats !== null);
  const useStat = statHistory.length > 0;

  type Entry = {
    key: string;
    label: string;
    points: TrendPoint[];
    scope: StatCounts | undefined;
  };
  const entries: Entry[] = [];
  let scopeCounts: Record<string, StatCounts>;
  let labels: Map<string, string>;
  let level: "stat" | "category";

  if (useStat) {
    level = "stat";
    const omitted = history.length - statHistory.length;
    if (omitted > 0) {
      notes.push(
        `${omitted} earlier check${omitted === 1 ? "" : "s"} could not be re-graded per stat and ${omitted === 1 ? "is" : "are"} left out of the stat-level trends.`
      );
    }
    const allCounts = countStats(current.allRows, current.exclude);
    scopeCounts = countStats(current.scopeRows, current.exclude);
    labels = new Map();
    for (const row of [...current.allRows, ...current.scopeRows]) {
      const s = rowStat(row);
      if (!labels.has(statKey(s))) labels.set(statKey(s), s);
    }
    const keys = new Set<string>(Object.keys(allCounts));
    for (const k of Object.keys(scopeCounts)) keys.add(k);
    for (const h of statHistory) for (const k of Object.keys(h.stats!)) keys.add(k);
    for (const key of keys) {
      const points: TrendPoint[] = statHistory.map((h) => {
        const c = h.stats![key];
        return makePoint(h.id, dateOnly(h.createdAt), c?.events ?? 0, c?.errors ?? 0, false);
      });
      const cur = allCounts[key];
      points.push(makePoint(null, dateOnly(curDate), cur?.events ?? 0, cur?.errors ?? 0, true));
      entries.push({ key, label: labels.get(key) ?? key, points, scope: scopeCounts[key] });
    }
  } else {
    const hasCats = history.some((h) => h.categories.length > 0);
    if (!hasCats) {
      return {
        level: "none",
        items: [],
        notes: ["No per-stat or per-category history is available for earlier checks."],
      };
    }
    level = "category";
    notes.push("Per-stat history not available; showing category-level trends");
    scopeCounts = countBy(current.scopeRows, current.exclude, rowCategory);
    labels = new Map();
    const keys = new Set<string>();
    for (const c of current.byCategory) {
      labels.set(statKey(c.category), c.category);
      keys.add(statKey(c.category));
    }
    for (const k of Object.keys(scopeCounts)) keys.add(k);
    for (const h of history)
      for (const c of h.categories) {
        keys.add(statKey(c.category));
        if (!labels.has(statKey(c.category))) labels.set(statKey(c.category), c.category);
      }
    for (const key of keys) {
      const points: TrendPoint[] = history.map((h) => {
        const cat = h.categories.find((c) => statKey(c.category) === key);
        return makePoint(
          h.id,
          dateOnly(h.createdAt),
          cat?.total ?? 0,
          cat ? cat.total - cat.exact : 0,
          false
        );
      });
      const cur = current.byCategory.find((c) => statKey(c.category) === key);
      points.push(
        makePoint(null, dateOnly(curDate), cur?.total ?? 0, cur ? cur.total - cur.exact : 0, true)
      );
      entries.push({ key, label: labels.get(key) ?? key, points, scope: scopeCounts[key] });
    }
  }

  // Rank by scope errors desc, events desc, label asc (a total order).
  const ranked = Object.entries(scopeCounts)
    .map(([key, c]) => ({ key, c, label: labels.get(key) ?? key }))
    .sort(
      (a, b) =>
        b.c.errors - a.c.errors ||
        b.c.events - a.c.events ||
        a.label.localeCompare(b.label)
    );
  const rankOf = new Map<string, number>();
  ranked.forEach((r, i) => rankOf.set(r.key, i + 1));

  // The analyst's own 75th-percentile stat error rate (pooled over the window)
  // is the bar a stat must reach to count as persistent.
  const analystBarRate = percentile(
    entries
      .map((e) => pooledCountedRate(e.points))
      .filter((r): r is number => r != null),
    C.PERSISTENT_PERCENTILE
  );
  const series: Record<string, TrendPoint[]> = {};
  for (const e of entries) series[e.key] = e.points;

  const items: TrendItem[] = [];
  for (const e of entries) {
    const scopeErrors = e.scope?.errors ?? 0;
    const reasons = flagPoints(
      e.points,
      rankOf.get(e.key) ?? null,
      scopeErrors,
      analystBarRate
    );
    if (reasons.length === 0) continue;
    items.push({
      key: e.key,
      label: e.label,
      level,
      reasons,
      points: e.points,
      currentErrors: scopeErrors,
      byType: e.scope ? { ...e.scope.byType } : emptyByType(),
    });
  }
  items.sort(
    (a, b) =>
      b.reasons.length - a.reasons.length ||
      b.currentErrors - a.currentErrors ||
      a.label.localeCompare(b.label)
  );
  return { level, items, notes, series };
}

// --------------------------------------------------------------------------
// Focus list
// --------------------------------------------------------------------------

const TYPE_PHRASE: Record<ErrorType, string> = {
  wrong_player: "attribution",
  missed: "coverage",
  extra: "over-calling",
  wrong_stat: "stat selection",
  wrong_team: "team attribution",
};
const TYPE_NOUN: Record<ErrorType, string> = {
  wrong_player: "wrong-player",
  missed: "missed",
  extra: "extra",
  wrong_stat: "wrong-stat",
  wrong_team: "wrong-team",
};

function dominantType(counts: Record<ErrorType, number>): ErrorType {
  let best: ErrorType = DOMINANT_TIE_ORDER[0];
  for (const t of DOMINANT_TIE_ORDER) if (counts[t] > counts[best]) best = t;
  return best;
}

/** Up to EXAMPLES_MAX instances, spread across the game (by time). */
function spreadPick(xs: PlanInstance[], n: number): PlanInstance[] {
  const s = [...xs].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (s.length <= n) return s;
  return Array.from({ length: n }, (_, j) => s[Math.floor(((j + 0.5) * s.length) / n)]);
}

/**
 * Representative examples: the most frequent error type first (spread across
 * the game); other types only fill the remaining slots.
 */
export function pickExamples(mine: PlanInstance[], dom: ErrorType): PlanInstance[] {
  const picked = spreadPick(
    mine.filter((i) => i.type === dom),
    C.EXAMPLES_MAX
  );
  if (picked.length < C.EXAMPLES_MAX) {
    picked.push(
      ...spreadPick(
        mine.filter((i) => i.type !== dom),
        C.EXAMPLES_MAX - picked.length
      )
    );
  }
  return picked.sort((a, b) => a.timeSeconds - b.timeSeconds);
}

const TREND_TEXT_ORDER: TrendKind[] = ["persistent", "worsening", "top_this_check"];

export function buildFocus(args: {
  instances: PlanInstance[];
  trends: TrendsResult;
  options: PlanOptions;
  history: HistoryCheck[];
  /** this check's per-stat accuracy keyed by lower-cased stat (page definition) */
  statAccuracy?: Map<string, number>;
}): FocusItem[] {
  const { instances, trends } = args;
  type Cand = Omit<FocusItem, "rank">;
  const cands: Cand[] = [];
  const covered = new Set<string>();
  const level = trends.level;
  const hasHistory = level !== "none";

  const keyOfInstance = (i: PlanInstance) =>
    statKey(level === "category" ? i.category : i.stat);

  const statCand = (
    key: string,
    label: string,
    mine: PlanInstance[],
    reasons: TrendReason[],
    points: TrendPoint[] | null
  ): Cand => {
    const counts = emptyByType();
    for (const i of mine) counts[i.type] += 1;
    const dom = dominantType(counts);
    const errorTypes = DOMINANT_TIE_ORDER.map((type) => ({ type, count: counts[type] }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    const flags = new Set(reasons.map((r) => r.kind));
    const topReason = TREND_TEXT_ORDER.map((k) => reasons.find((r) => r.kind === k)).find(Boolean);
    const isCategory = level === "category";
    mine.forEach((i) => covered.add(i.key));
    return {
      id: `${isCategory ? "category" : "stat"}:${key}`,
      kind: isCategory ? "category" : "stat",
      title: `${label}: ${TYPE_PHRASE[dom]} (${counts[dom]} ${TYPE_NOUN[dom]})`,
      why: errorTypes.map((x) => `${x.count} ${TYPE_NOUN[x.type]}`).join(", "),
      drill: drillFor(
        isCategory ? null : label,
        isCategory ? label : null,
        dom
      ),
      errorType: dom,
      errorTypes,
      label,
      accuracy: isCategory ? null : (args.statAccuracy?.get(key) ?? null),
      trendText: topReason
        ? topReason.text
        : hasHistory
          ? "No trend flagged"
          : "No history to compare",
      trendPoints: points,
      examples: pickExamples(mine, dom),
      priority:
        mine.length +
        5 * (flags.has("persistent") ? 1 : 0) +
        4 * (flags.has("worsening") ? 1 : 0) +
        2 * (flags.has("top_this_check") ? 1 : 0),
      trendKinds: Array.from(flags),
      instanceKeys: mine.map((i) => i.key),
    };
  };

  const trending = new Set<string>();
  for (const item of trends.items) {
    const mine = instances.filter((i) => keyOfInstance(i) === item.key);
    if (mine.length === 0) continue;
    trending.add(item.key);
    cands.push(statCand(item.key, item.label, mine, item.reasons, item.points));
  }

  // Stats with enough errors but no trend flag still make a focus block
  // (one block per stat); category-level history has no per-stat series.
  if (level !== "category") {
    const byKey = new Map<string, PlanInstance[]>();
    for (const i of instances) {
      const k = keyOfInstance(i);
      if (trending.has(k)) continue;
      const list = byKey.get(k);
      if (list) list.push(i);
      else byKey.set(k, [i]);
    }
    for (const [k, mine] of byKey) {
      if (mine.length < C.FOCUS_TYPE_MIN_ERRORS) continue;
      cands.push(statCand(k, mine[0].stat, mine, [], trends.series?.[k] ?? null));
    }
  }

  for (const t of ERROR_TYPE_ORDER) {
    const mine = instances.filter((i) => i.type === t);
    if (mine.length < C.FOCUS_TYPE_MIN_ERRORS) continue;
    const inCovered = mine.filter((i) => covered.has(i.key)).length;
    if (inCovered / mine.length >= C.FOCUS_COVERAGE_SKIP - C.EPSILON) continue;
    cands.push({
      id: `type:${t}`,
      kind: "errorType",
      title: `Reduce ${TYPE_NOUN[t]} errors (${mine.length} across several stats)`,
      why: `${mine.length} ${TYPE_NOUN[t]}`,
      drill: drillFor(null, null, t),
      errorType: t,
      errorTypes: [{ type: t, count: mine.length }],
      label: null,
      accuracy: null,
      trendText: "",
      trendPoints: null,
      examples: pickExamples(mine, t),
      priority: 0.8 * mine.length,
      trendKinds: [],
      instanceKeys: mine.map((i) => i.key),
    });
  }

  cands.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.instanceKeys.length - a.instanceKeys.length ||
      a.title.localeCompare(b.title)
  );
  return cands.slice(0, C.FOCUS_MAX).map((c, i) => ({ rank: i + 1, ...c }));
}
// --------------------------------------------------------------------------
// Plan
// --------------------------------------------------------------------------

function playerLabel(inst: Instance): string {
  if (inst.playerNumber != null) return `#${inst.playerNumber}`;
  return inst.playerRaw?.trim() || "Unknown";
}

function sideLabel(inst: Instance | null, teamLabel: (t: string) => string) {
  return inst
    ? { team: teamLabel(inst.team), player: playerLabel(inst) }
    : null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildTrainingPlan(
  current: CurrentInput,
  history: HistoryInput | null,
  ctx: PlanContext,
  rawOptions: PlanOptions
): TrainingPlan {
  const options = normaliseOptions(rawOptions);
  const now = options.now ?? new Date();
  const result = current.result;
  const notes: string[] = [];
  const disputes = (ctx.disputes ?? []).filter((d) => d.deleted_at == null);
  const exclude = makeDisputeExclude(disputes);

  const scopeSource = options.scope === "all" ? result.rows : current.scopeRows;
  const analystName = ctx.analystName?.trim() ? ctx.analystName.trim() : null;

  let skipped = 0;
  const instances: PlanInstance[] = [];
  let excludedByDispute = 0;
  let underDispute = 0;
  let scopeExact = 0;
  let scopeMasterRows = 0;

  scopeSource.forEach((row, idx) => {
    const first = row.master ?? row.analyst;
    if (!first || !Number.isFinite(first.mid) || !Number.isFinite(first.start)) {
      skipped += 1;
      return;
    }
    const type = classifyRow(row);
    const info = disputeInfoForRow(row, disputes);
    if (info.outcome === "confirmed") {
      if (type) excludedByDispute += 1;
      return; // dropped from instances, counts and scope accuracy
    }
    if (row.master) {
      scopeMasterRows += 1;
      if (!type) scopeExact += 1;
    }
    if (!type) return;
    if (info.outcome === "open") underDispute += 1;
    const stat = rowStat(row);
    const alsoWrongTeam =
      type === "wrong_stat" &&
      row.master != null &&
      row.analyst != null &&
      row.master.team !== row.analyst.team;
    instances.push({
      key: String(idx),
      type,
      stat,
      codedStat: row.analyst?.stat ?? null,
      category: rowCategory(row),
      timeSeconds: first.mid,
      startSeconds: first.start,
      timeLabel: formatTime(first.mid),
      expected: sideLabel(row.master, ctx.teamLabel),
      coded: sideLabel(row.analyst, ctx.teamLabel),
      alsoWrongPlayer: type === "wrong_stat" && row.alsoWrongPlayer === true,
      alsoWrongTeam,
      timeDelta: row.timeDelta,
      dispute: {
        state: info.outcome === "open" || info.outcome === "denied" ? info.outcome : "none",
        reason: info.reason,
      },
      videoLink: buildVideoLink(ctx.videoUrl, first.start),
      reviewLink: buildReviewLink(ctx.reviewBaseUrl, ctx.checkId, first.start, stat),
    });
  });
  if (skipped > 0) notes.push(`${skipped} rows skipped (missing data)`);

  instances.sort(
    (a, b) =>
      ERROR_TYPE_ORDER.indexOf(a.type) - ERROR_TYPE_ORDER.indexOf(b.type) ||
      a.timeSeconds - b.timeSeconds
  );

  const counts = emptyByType();
  for (const i of instances) counts[i.type] += 1;

  // Trends
  const hist = history?.checks ?? [];
  const trends = detectTrends(
    {
      allRows: result.rows,
      scopeRows: options.scope === "all" ? result.rows : current.scopeRows,
      byCategory: result.byCategory,
      exclude,
      currentDate: ctx.checkCreatedAt ?? now.toISOString(),
    },
    hist
  );
  // Per-stat accuracy: the comparison page's own definition (result.byStat:
  // exact / master instances), so these figures match the page.
  const statAccuracy = new Map<string, number>();
  for (const s of result.byStat ?? []) statAccuracy.set(statKey(s.stat), s.accuracy);
  const focus = buildFocus({
    instances,
    trends,
    options,
    history: hist,
    statAccuracy,
  });
  const strengths = buildStrengths(result.byStat ?? [], hist, trends.series);

  // Header averages
  const analystAvgAccuracy = mean(
    hist.map((h) => h.accuracy).filter((a): a is number => a != null)
  );
  const categories = result.byCategory.map((c) => {
    const k = statKey(c.category);
    let total = 0;
    let exact = 0;
    for (const h of hist)
      for (const hc of h.categories)
        if (statKey(hc.category) === k) {
          total += hc.total;
          exact += hc.exact;
        }
    const analystAvg = total > 0 ? exact / total : null;
    const all = history?.allAnalystAverage?.byCategory ?? {};
    const allAnalystAvg = typeof all[c.category] === "number" ? all[c.category] : null;
    return {
      category: c.category,
      accuracy: c.accuracy,
      analystAvg,
      allAnalystAvg,
      deltaVsAnalyst: analystAvg != null ? c.accuracy - analystAvg : null,
    };
  });

  // Scope label
  const f = ctx.scopeFilters;
  let scopeLabel: string;
  if (options.scope === "all") {
    scopeLabel = "All instances";
  } else {
    const parts = [
      f.team === "all" ? "Both teams" : ctx.teamLabel(f.team),
      f.category === "all" ? "all categories" : f.category,
    ];
    if (f.stat !== "all") parts.push(f.stat);
    scopeLabel = parts.join(", ");
  }

  // Notes
  notes.push(
    "Counts use the page's pairing filtered by scope and can differ from AI insights"
  );
  if (!analystName) notes.push("No analyst on this comparison, so no history is shown.");
  else if (history == null) notes.push("History not loaded; trends are unavailable.");
  else if (hist.length === 0)
    notes.push(`No earlier checks found for ${analystName} in this window`);
  if (ctx.checkId == null) notes.push("Unsaved comparison: no disputes or review links.");
  if (trends.level === "category" && excludedByDispute > 0)
    notes.push("Category-level trends are not adjusted for resolved disputes");
  if (
    history?.matchedInWindow != null &&
    history.matchedInWindow > hist.length &&
    options.window.mode === "days"
  )
    notes.push(
      `Showing the most recent ${hist.length} of ${history.matchedInWindow} checks in the window`
    );
  for (const w of history?.warnings ?? []) notes.push(w);
  if (instances.length === 0) notes.push("No errors in this scope");

  return {
    generatedAt: now.toISOString(),
    options,
    header: {
      analystName,
      fixture: `${ctx.teamLabel("Home")} v ${ctx.teamLabel("Away")}`,
      matchLabel: ctx.matchLabel,
      masterFileName: ctx.masterFileName,
      sport: ctx.sport,
      checkId: ctx.checkId,
      checkDate: ctx.checkCreatedAt,
      scopeLabel,
      overallAccuracy: result.summary.accuracy,
      scopeAccuracy: scopeMasterRows > 0 ? scopeExact / scopeMasterRows : null,
      counts,
      totalErrors: instances.length,
      excludedByDispute,
      underDispute,
      categories,
      analystAvgAccuracy,
      allAnalystAvgAccuracy: history?.allAnalystAverage?.accuracy ?? null,
      historyChecksUsed: hist.length,
    },
    summary: buildSummary({
      analystName,
      fixture: `${ctx.teamLabel("Home")} v ${ctx.teamLabel("Away")}`,
      sport: ctx.sport,
      checkDate: ctx.checkCreatedAt,
      accuracy: result.summary.accuracy,
      analystAvg: analystAvgAccuracy,
      checksUsed: hist.length,
      allAnalystAvg: history?.allAnalystAverage?.accuracy ?? null,
    }),
    strengths,
    instances,
    trends,
    focus,
    notes,
  };
}

/**
 * Summary lines: who/what/when, then overall accuracy against the analyst's
 * recent average (and the all-analyst average when known).
 */
export function buildSummary(a: {
  analystName: string | null;
  fixture: string;
  sport: string | null;
  checkDate: string | null;
  accuracy: number;
  analystAvg: number | null;
  checksUsed: number;
  allAnalystAvg: number | null;
}): TrainingPlan["summary"] {
  const headline = [
    a.analystName ?? "No analyst",
    a.fixture,
    [a.sport, a.checkDate ? a.checkDate.slice(0, 10) : null].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(" - ");
  let direction: "up" | "down" | "flat" | null = null;
  let deltaPts: number | null = null;
  let sentence = "No earlier checks to compare.";
  if (a.analystAvg != null && a.checksUsed > 0) {
    deltaPts = (a.accuracy - a.analystAvg) * 100;
    const abs = Math.abs(deltaPts);
    const window = `your last ${a.checksUsed} check${a.checksUsed === 1 ? "" : "s"}`;
    if (abs < C.SUMMARY_FLAT_PTS - C.EPSILON) {
      direction = "flat";
      sentence = `In line with ${window}.`;
    } else if (deltaPts > 0) {
      direction = "up";
      sentence = `Up ${abs.toFixed(1)} pts on ${window}.`;
    } else {
      direction = "down";
      sentence = `Down ${abs.toFixed(1)} pts on ${window}.`;
    }
  }
  let accuracyLine = `Accuracy ${pct1(a.accuracy)}. ${sentence}`;
  if (a.allAnalystAvg != null) accuracyLine += ` All analysts average ${pct1(a.allAnalystAvg)}.`;
  return { headline, accuracyLine, direction, deltaPts };
}

/**
 * Strengths: stats in THIS check with accuracy >= 95% (inclusive) and at least
 * STRENGTH_MIN_INSTANCES master instances. Accuracy is the page's per-stat
 * figure (result.byStat). Sorted by instances desc, then accuracy desc.
 */
export function buildStrengths(
  byStat: { stat: string; total: number; exact: number; accuracy: number }[],
  history: HistoryCheck[],
  series?: Record<string, TrendPoint[]>
): StrengthsResult {
  const eligible = byStat.filter((s) => s.total >= C.STRENGTH_MIN_INSTANCES);
  const toItem = (s: (typeof byStat)[number]): StrengthItem => ({
    stat: s.stat,
    key: statKey(s.stat),
    accuracy: s.accuracy,
    instances: s.total,
    consistency: strengthConsistency(statKey(s.stat), history),
    trendPoints: series?.[statKey(s.stat)] ?? null,
  });
  const byCount = (a: { instances: number; accuracy: number; stat: string }, b: typeof a) =>
    b.instances - a.instances || b.accuracy - a.accuracy || a.stat.localeCompare(b.stat);
  const all = eligible
    .filter((s) => s.accuracy >= C.STRENGTH_MIN_ACCURACY - C.EPSILON)
    .map(toItem)
    .sort(byCount);
  const fallback =
    all.length > 0
      ? []
      : eligible
          .map(toItem)
          .sort(
            (a, b) =>
              b.accuracy - a.accuracy ||
              b.instances - a.instances ||
              a.stat.localeCompare(b.stat)
          )
          .slice(0, C.STRENGTH_FALLBACK);
  return { items: all.slice(0, C.STRENGTH_MAX), all, fallback };
}

/**
 * History note for a strength. A history check "counts" when the stat had at
 * least MIN_EVENTS_PER_CHECK master instances; its accuracy is
 * (events - errors) / (events - extras), the same exact / master ratio.
 */
function strengthConsistency(key: string, history: HistoryCheck[]): string | null {
  const withStats = history.filter((h) => h.stats !== null);
  if (withStats.length === 0) return null;
  let counted = 0;
  let hits = 0;
  for (const h of withStats) {
    const c = h.stats![key];
    if (!c) continue;
    const master = c.events - c.byType.extra;
    if (master < C.MIN_EVENTS_PER_CHECK) continue;
    counted += 1;
    if ((c.events - c.errors) / master >= C.STRENGTH_MIN_ACCURACY - C.EPSILON) hits += 1;
  }
  if (hits === 0) return "new strength this check";
  const pct = `${Math.round(C.STRENGTH_MIN_ACCURACY * 100)}%+`;
  const text = `${pct} in ${hits} of last ${counted} checks`;
  return hits / counted >= C.STRENGTH_CONSISTENT_SHARE - C.EPSILON
    ? `consistently ${text}`
    : text;
}

/** Single short line for the degrade notes (empty -> null). */
export function conciseNote(plan: TrainingPlan, maxChars = 160): string | null {
  const notes = [...plan.notes, ...plan.trends.notes].filter(
    (n) => !n.includes("can differ from AI insights")
  );
  if (notes.length === 0) return null;
  const text = notes.join(" | ");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// --------------------------------------------------------------------------
// Message
// --------------------------------------------------------------------------

export function buildDefaultMessage(
  plan: TrainingPlan,
  opts: { senderName: string | null; reviewLink: string | null }
): string {
  const h = plan.header;
  const lines: string[] = [];
  lines.push(`Hi ${h.analystName ?? "there"},`);
  lines.push("");
  lines.push(
    `Training plan for ${h.fixture}${h.matchLabel ? ` (${h.matchLabel})` : ""}. ${plan.summary.accuracyLine}`
  );
  const strengths = plan.strengths.items
    .slice(0, C.STRENGTH_MAX)
    .map((s) => `${s.stat} ${Math.round(s.accuracy * 100)}%`);
  if (strengths.length > 0) lines.push(`Strengths: ${strengths.join(", ")}`);
  const top = plan.focus.slice(0, C.MESSAGE_TOP_FOCUS);
  if (top.length > 0) {
    lines.push(`Focus: ${top.map((f, i) => `${i + 1}) ${f.title}`).join(" ")}`);
  }
  lines.push("");
  lines.push("Full details in the attached workbook.");
  if (opts.reviewLink) lines.push(`Review the check: ${opts.reviewLink}`);
  if (opts.senderName) {
    lines.push("");
    lines.push(`Regards, ${opts.senderName}`);
  }  const text = lines.join("\n");
  return text.length > MESSAGE_MAX_CHARS
    ? `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…`
    : text;
}
