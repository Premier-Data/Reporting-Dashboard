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
  /** (i) persistent: rate >= 20% in a check = a "hit" */
  ERROR_RATE_THRESHOLD: 0.2,
  /** (i) needs >= 3 counted checks (current included) */
  PERSISTENT_MIN_CHECKS: 3,
  /** (i) hits / counted checks must be > 0.5 */
  PERSISTENT_MAJORITY: 0.5,
  /** (ii) recent = last 3 counted points (current included) */
  WORSENING_RECENT_POINTS: 3,
  /** (ii) needs >= 2 earlier counted points */
  WORSENING_MIN_EARLIER_POINTS: 2,
  /** (ii) each side needs >= 10 pooled events */
  WORSENING_MIN_POOLED_EVENTS: 10,
  /** (ii) recent pooled rate - earlier pooled rate >= 10 percentage points */
  WORSENING_DELTA: 0.1,
  /**
   * Tolerance for comparing rates (floating point): a delta of 0.0999999999
   * from rounding counts as exactly 0.10, and the same tolerance is used for
   * the 20% error-rate threshold. Rates are ratios of small integers, so any
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
  MAX_FOCUS_ITEMS: 5,
  /** a non-trending error type becomes a focus item at >= 3 errors */
  FOCUS_TYPE_MIN_ERRORS: 3,
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
  title: string;
  why: string;
  drill: string;
  errorType: ErrorType;
  priority: number;
  trendKinds: TrendKind[];
  instanceKeys: string[];
}

export interface TrendsResult {
  level: "stat" | "category" | "none";
  items: TrendItem[];
  notes: string[];
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

function flagPoints(
  points: TrendPoint[],
  scopeRank: number | null,
  scopeErrors: number
): TrendReason[] {
  const reasons: TrendReason[] = [];
  const counted = points.filter((p) => p.counted);

  // (i) persistent
  if (counted.length >= C.PERSISTENT_MIN_CHECKS) {
    const hits = counted.filter(
      (p) => (p.rate ?? 0) >= C.ERROR_RATE_THRESHOLD - C.EPSILON
    ).length;
    if (hits / counted.length > C.PERSISTENT_MAJORITY) {
      reasons.push({
        kind: "persistent",
        text: `Error rate ${pct0(C.ERROR_RATE_THRESHOLD)} or higher in ${hits} of the last ${counted.length} checks`,
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
      r.rate - e.rate >= C.WORSENING_DELTA - C.EPSILON
    ) {
      reasons.push({
        kind: "worsening",
        text: `Error rate rose from ${pct0(e.rate)} (earlier ${earlier.length} checks) to ${pct0(r.rate)} (last ${recent.length} checks)`,
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
        text: `${ordinal(scopeRank)} most errors in this check (${scopeErrors}) and also had errors in ${seen} of the last ${hist.length} checks`,
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

  const items: TrendItem[] = [];
  for (const e of entries) {
    const scopeErrors = e.scope?.errors ?? 0;
    const reasons = flagPoints(e.points, rankOf.get(e.key) ?? null, scopeErrors);
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
  return { level, items, notes };
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

export function buildFocus(args: {
  instances: PlanInstance[];
  trends: TrendsResult;
  options: PlanOptions;
  history: HistoryCheck[];
}): FocusItem[] {
  const { instances, trends } = args;
  type Cand = Omit<FocusItem, "rank">;
  const cands: Cand[] = [];
  const covered = new Set<string>();
  const level = trends.level;

  const keyOfInstance = (i: PlanInstance) =>
    statKey(level === "category" ? i.category : i.stat);

  for (const item of trends.items) {
    const mine = instances.filter((i) => keyOfInstance(i) === item.key);
    if (mine.length === 0) continue;
    const counts = emptyByType();
    for (const i of mine) counts[i.type] += 1;
    const dom = dominantType(counts);
    const flags = new Set(item.reasons.map((r) => r.kind));
    const histPts = item.points.filter((p) => !p.isCurrent && p.events > 0);
    const histErr = histPts.filter((p) => p.errors > 0).length;
    const clause = histErr > 0 ? `, ${histErr} of last ${histPts.length} checks` : "";
    const title = `Review ${item.label} ${TYPE_PHRASE[dom]}: ${counts[dom]} ${TYPE_NOUN[dom]} errors in this game${clause}`;
    let why = `${mine.length} error${mine.length === 1 ? "" : "s"} in this scope. ${item.reasons.map((r) => r.text).join("; ")}.`;
    if (dom === "wrong_player") {
      const also = mine.filter((i) => i.type === "wrong_stat" && i.alsoWrongPlayer).length;
      if (also > 0) why += ` (+${also} wrong-stat rows also had the wrong player)`;
    }
    mine.forEach((i) => covered.add(i.key));
    cands.push({
      id: `${level}:${item.key}`,
      kind: level === "category" ? "category" : "stat",
      title,
      why,
      drill: drillFor(
        level === "stat" ? item.label : null,
        level === "category" ? item.label : null,
        dom
      ),
      errorType: dom,
      priority:
        mine.length +
        5 * (flags.has("persistent") ? 1 : 0) +
        4 * (flags.has("worsening") ? 1 : 0) +
        2 * (flags.has("top_this_check") ? 1 : 0),
      trendKinds: Array.from(flags),
      instanceKeys: mine.map((i) => i.key),
    });
  }

  for (const t of ERROR_TYPE_ORDER) {
    const mine = instances.filter((i) => i.type === t);
    if (mine.length < C.FOCUS_TYPE_MIN_ERRORS) continue;
    const inCovered = mine.filter((i) => covered.has(i.key)).length;
    if (inCovered / mine.length >= C.FOCUS_COVERAGE_SKIP - C.EPSILON) continue;
    let why = `${mine.length} ${TYPE_NOUN[t]} errors in this scope across several stats.`;
    if (t === "wrong_player") {
      const also = instances.filter((i) => i.type === "wrong_stat" && i.alsoWrongPlayer).length;
      if (also > 0) why += ` (+${also} wrong-stat rows also had the wrong player)`;
    }
    cands.push({
      id: `type:${t}`,
      kind: "errorType",
      title: `Reduce ${TYPE_NOUN[t]} errors: ${mine.length} in this game`,
      why,
      drill: drillFor(null, null, t),
      errorType: t,
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
  return cands
    .slice(0, C.MAX_FOCUS_ITEMS)
    .map((c, i) => ({ rank: i + 1, ...c }));
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
  const focus = buildFocus({ instances, trends, options, history: hist });

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
    instances,
    trends,
    focus,
    notes,
  };
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
    `Here is your recommended training plan for ${h.fixture}${h.matchLabel ? ` (${h.matchLabel})` : ""}.`
  );
  lines.push(`Overall accuracy: ${pct1(h.overallAccuracy)}`);
  const breakdown = ERROR_TYPE_ORDER.map(
    (t) => `${ERROR_TYPE_LABEL[t]} ${h.counts[t]}`
  ).join(", ");
  lines.push(`Errors in scope (${h.scopeLabel}): ${h.totalErrors} (${breakdown})`);
  const top = plan.focus.slice(0, C.MESSAGE_TOP_FOCUS);
  if (top.length > 0) {
    lines.push("");
    lines.push("Top focus areas:");
    top.forEach((f, i) => lines.push(`${i + 1}. ${f.title}`));
  }
  lines.push("");
  lines.push("Full plan attached as Excel.");
  if (opts.reviewLink) lines.push(`Review the check: ${opts.reviewLink}`);
  if (opts.senderName) {
    lines.push("");
    lines.push(`Regards, ${opts.senderName}`);
  }
  const text = lines.join("\n");
  return text.length > MESSAGE_MAX_CHARS
    ? `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…`
    : text;
}
