// Board-report summariser: turns the raw deputy_shifts (labour cost + hours)
// and TT_Games (games coded) rows into the handful of roll-ups a board report
// needs, for a chosen date range. Pure functions — no fetching — so they're
// trivially testable and reused by the page.
//
// Source of truth is the SAME Supabase data the Reporting dashboard reads
// (deputy_shifts, TT_Games), so the numbers reconcile with that page. Labour
// cost/hours come from deputy_shifts; games come from TT_Games. The two are
// filtered by their own date fields (shift_date / Date) over the chosen range.

import { calculateKPIs } from "@/lib/analytics";
import { isExcludedAnalystName } from "@/lib/analytics/excludedAnalysts";

// Rows arrive untyped from Supabase (`select("*")`); we read defensively.
export type ShiftRow = Record<string, unknown>;
export type GameRow = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => String(v ?? "").trim();

// The calendar-date part (yyyy-mm-dd) of a date-ish value, or "" if unparseable.
export function isoDate(value: unknown): string {
  const s = str(value);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// Month bucket key ("yyyy-mm") for a date-ish value, or "" if unparseable.
function monthKey(value: unknown): string {
  const iso = isoDate(value);
  return iso ? iso.slice(0, 7) : "";
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString("en-AU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// A single cost area (e.g. "Home Analyst") rolled up over the range.
export type AreaSummary = {
  area: string;
  cost: number;
  hours: number;
  shifts: number;
  /** Share of total labour cost (0–1). */
  costShare: number;
};

export type MonthSummary = {
  key: string; // yyyy-mm
  label: string; // "March 2026"
  cost: number;
  hours: number;
  games: number;
};

export type AnalystSummary = {
  name: string;
  cost: number;
  hours: number;
  games: number;
};

// The weekly fixed cost of the Philippines coding team. Their cost is NOT in
// deputy_shifts (they're a fixed retainer, not Deputy-rostered), so their
// per-game cost is derived from this rate × the number of weeks in the range.
export const PHL_WEEKLY_FIXED_COST = 3800;

// "Incorporated coding" areas — pure coding PLUS the support functions that
// wrap around coding (ops coordination, customer service, QA, quality control).
// Used for a broader cost-per-game that reflects the full cost of delivering a
// coded game, not just the analyst at the keyboard.
const INCORPORATED_CODING_AREAS = new Set([
  "home analyst",
  "office analyst",
  "operations coordinator",
  "customer service",
  "accuracy - qa",
  "quality control",
]);

export type BoardReport = {
  from: string; // yyyy-mm-dd (inclusive)
  to: string; // yyyy-mm-dd (inclusive)
  // Headline KPIs.
  totalCost: number; // Deputy labour cost only (AUS shifts)
  /** Deputy labour cost + the Philippines fixed cost for the period. */
  totalCostWithPhl: number;
  totalHours: number;
  totalGames: number;
  headcount: number; // distinct analysts with a shift in range (excl. placeholders)
  shiftCount: number;
  avgCostPerHour: number;
  avgCostPerGame: number;
  avgHoursPerGame: number;
  // ── AUS coding team (Home + Office analysts in deputy_shifts) ──
  // AUS games are coded by the Home + Office analyst areas, so their per-game
  // figures are measured against AUS games ONLY (not total games).
  pureCodingCost: number; // Home + Office analyst labour cost
  pureCodingHours: number; // Home + Office analyst hours
  ausGames: number; // games coded in AUS over the range
  ausGamesShare: number; // ausGames / total games (0–1)
  ausCostPerGame: number; // pureCodingCost / ausGames
  ausHoursPerGame: number; // pureCodingHours / ausGames
  // "Incorporated coding" — pure coding + support areas (Ops Coordinator,
  // Customer Service, Accuracy-QA, Quality Control). Per-game over AUS games.
  incCodingCost: number;
  incCodingHours: number;
  incCostPerGame: number; // incCodingCost / ausGames
  incHoursPerGame: number; // incCodingHours / ausGames
  // ── Philippines team (fixed cost, not in deputy_shifts) ──
  weeksInRange: number; // (range length in days) / 7
  phlFixedCost: number; // PHL_WEEKLY_FIXED_COST × weeksInRange
  phlGames: number; // games coded in PHL over the range
  phlGamesShare: number; // phlGames / total games (0–1)
  phlCostPerGame: number; // phlFixedCost / phlGames
  // Breakdowns.
  byArea: AreaSummary[]; // biggest cost first
  byMonth: MonthSummary[]; // chronological
  homeVsOffice: { home: number; office: number; other: number }; // labour cost
  gamesByLocation: { aus: number; phl: number; other: number };
  topAnalystsByGames: AnalystSummary[]; // top 10
  topAnalystsByCost: AnalystSummary[]; // top 10
};

// Keep only rows whose date field falls within [from, to] (inclusive). `field`
// is the row's date property name (shift_date for shifts, Date for games).
function inRange(row: Record<string, unknown>, field: string, from: string, to: string): boolean {
  const d = isoDate(row[field]);
  return !!d && d >= from && d <= to;
}

/**
 * Build the full board report for a date range from the raw Supabase rows.
 * `from`/`to` are inclusive yyyy-mm-dd. Shifts drive cost/hours; games drive
 * the games count. Placeholder "PREMIER DATA" shifts/games are excluded from
 * per-analyst roll-ups (matching every other analyst-attributing view) but a
 * placeholder shift's COST still counts toward area/total cost — it's real
 * spend, just not attributable to one person.
 */
export function buildBoardReport(
  shiftRows: ShiftRow[],
  gameRows: GameRow[],
  from: string,
  to: string
): BoardReport {
  const shifts = shiftRows.filter((r) => inRange(r, "shift_date", from, to));
  const games = gameRows.filter((r) => inRange(r, "Date", from, to));
  // Weeks for the PHL fixed cost: inclusive day span / 7.
  const dayMs = 24 * 60 * 60 * 1000;
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  const inclusiveDays =
    Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs >= fromMs
      ? Math.round((toMs - fromMs) / dayMs) + 1
      : 0;
  return summarise(shifts, games, from, to, inclusiveDays / 7);
}

/**
 * Build the board report for a single data WEEK (the Wed→Tue week number
 * carried on deputy_shifts.week / TT_Games.Week). Week numbers RESTART each
 * season, so a week must be qualified by its season — otherwise the two
 * "week 1"s (one per season) merge. When `season` is given, only rows of that
 * season are counted; omit it to keep the legacy number-only behaviour. The
 * period is one week for the PHL fixed cost; from/to are the actual min/max
 * shift dates in that week (for display only).
 */
export function buildWeekReport(
  shiftRows: ShiftRow[],
  gameRows: GameRow[],
  weekNum: number,
  season?: number | null
): BoardReport {
  const w = String(weekNum);
  const matchesSeason = (rowSeason: unknown): boolean =>
    season == null || Number(rowSeason) === season;
  const shifts = shiftRows.filter(
    (r) => String(r.week) === w && matchesSeason(r.season)
  );
  const games = gameRows.filter(
    (r) => String(r.Week) === w && matchesSeason(r.season)
  );
  // Derive a display from/to from the shift dates present (fallback to games).
  const dates = [
    ...shifts.map((r) => isoDate(r.shift_date)),
    ...games.map((r) => isoDate(r.Date)),
  ]
    .filter(Boolean)
    .sort();
  const from = dates[0] ?? "";
  const to = dates[dates.length - 1] ?? "";
  // A data week is one PHL billing week.
  return summarise(shifts, games, from, to, 1);
}

/**
 * Core summariser over ALREADY-FILTERED shift + game rows. `from`/`to` are for
 * display; `weeks` scales the PHL fixed cost (1 for a single week; day-span/7
 * for a date range).
 */
function summarise(
  shifts: ShiftRow[],
  games: GameRow[],
  from: string,
  to: string,
  weeks: number
): BoardReport {
  // Headline cost/hours/headcount via the shared KPI helper (same math the
  // Reporting dashboard uses), mapped to the fields it expects.
  const kpiRows = shifts.map((r) => ({
    employee_name: str(r.employee_name),
    total_hours: num(r.total_hours),
    total_cost: num(r.total_cost),
  }));
  const kpis = calculateKPIs(kpiRows);

  // Headcount = distinct REAL analysts (exclude the "PREMIER DATA" placeholder).
  const realNames = new Set<string>();
  for (const r of shifts) {
    const name = str(r.employee_name);
    if (name && !isExcludedAnalystName(name)) realNames.add(name.toLowerCase());
  }

  // By area.
  const areaMap = new Map<string, AreaSummary>();
  for (const r of shifts) {
    const area = str(r.area_name) || "(unassigned)";
    const a =
      areaMap.get(area) ??
      { area, cost: 0, hours: 0, shifts: 0, costShare: 0 };
    a.cost += num(r.total_cost);
    a.hours += num(r.total_hours);
    a.shifts += 1;
    areaMap.set(area, a);
  }
  const byArea = Array.from(areaMap.values()).sort((x, y) => y.cost - x.cost);
  for (const a of byArea) {
    a.costShare = kpis.totalCost > 0 ? a.cost / kpis.totalCost : 0;
  }

  // Home vs Office analyst (by area name). Track hours too so "pure coding"
  // efficiency can use Home+Office hours as well as cost.
  let home = 0;
  let office = 0;
  let other = 0;
  let homeHours = 0;
  let officeHours = 0;
  // "Incorporated coding" = pure coding + the support areas that wrap around it.
  let incCodingCost = 0;
  let incCodingHours = 0;
  for (const a of byArea) {
    const key = a.area.toLowerCase();
    if (key === "home analyst") {
      home += a.cost;
      homeHours += a.hours;
    } else if (key === "office analyst") {
      office += a.cost;
      officeHours += a.hours;
    } else {
      other += a.cost;
    }
    if (INCORPORATED_CODING_AREAS.has(key)) {
      incCodingCost += a.cost;
      incCodingHours += a.hours;
    }
  }
  // "Pure coding" = the two analyst areas that actually code games (Home +
  // Office). Excludes support areas (Ops, Social, Sales, QA, …) so the per-game
  // figure reflects coding labour only.
  const pureCodingCost = home + office;
  const pureCodingHours = homeHours + officeHours;

  // By month: cost/hours from shifts, games from TT_Games, merged on month key.
  const monthMap = new Map<string, MonthSummary>();
  const getMonth = (key: string): MonthSummary => {
    let m = monthMap.get(key);
    if (!m) {
      m = { key, label: monthLabel(key), cost: 0, hours: 0, games: 0 };
      monthMap.set(key, m);
    }
    return m;
  };
  for (const r of shifts) {
    const mk = monthKey(r.shift_date);
    if (!mk) continue;
    const m = getMonth(mk);
    m.cost += num(r.total_cost);
    m.hours += num(r.total_hours);
  }
  for (const r of games) {
    const mk = monthKey(r.Date);
    if (!mk) continue;
    getMonth(mk).games += 1;
  }
  const byMonth = Array.from(monthMap.values()).sort((x, y) =>
    x.key.localeCompare(y.key)
  );

  // Games by location (AUS / PHL / other).
  let aus = 0;
  let phl = 0;
  let gOther = 0;
  for (const r of games) {
    const loc = str(r.Location).toUpperCase();
    if (loc === "AUS") aus += 1;
    else if (loc === "PHL") phl += 1;
    else gOther += 1;
  }

  // Per-analyst roll-ups (exclude placeholders). Cost/hours from shifts; games
  // from TT_Games counting BOTH allocation sides (home_allocated/away_allocated)
  // so a game an analyst coded on either side is credited to them.
  const analystMap = new Map<string, AnalystSummary>();
  const getAnalyst = (name: string): AnalystSummary => {
    const key = name.toLowerCase();
    let a = analystMap.get(key);
    if (!a) {
      a = { name, cost: 0, hours: 0, games: 0 };
      analystMap.set(key, a);
    }
    return a;
  };
  for (const r of shifts) {
    const name = str(r.employee_name);
    if (!name || isExcludedAnalystName(name)) continue;
    const a = getAnalyst(name);
    a.cost += num(r.total_cost);
    a.hours += num(r.total_hours);
  }
  for (const r of games) {
    // A game lists an allocated analyst per side; credit each distinct real
    // analyst once per game.
    const sides = [str(r.home_allocated), str(r.away_allocated)];
    const credited = new Set<string>();
    for (const side of sides) {
      if (!side || isExcludedAnalystName(side)) continue;
      const key = side.toLowerCase();
      if (credited.has(key)) continue;
      credited.add(key);
      getAnalyst(side).games += 1;
    }
  }
  const analysts = Array.from(analystMap.values());
  const topAnalystsByGames = [...analysts]
    .sort((x, y) => y.games - x.games)
    .slice(0, 10);
  const topAnalystsByCost = [...analysts]
    .sort((x, y) => y.cost - x.cost)
    .slice(0, 10);

  const totalGames = games.length;

  // PHL fixed cost scales with the number of billing weeks in the period.
  const weeksInRange = weeks;
  const phlFixedCost = PHL_WEEKLY_FIXED_COST * weeksInRange;
  const phlGames = phl;

  return {
    from,
    to,
    totalCost: kpis.totalCost,
    totalCostWithPhl: kpis.totalCost + phlFixedCost,
    totalHours: kpis.totalHours,
    totalGames,
    headcount: realNames.size,
    shiftCount: kpis.shiftCount,
    avgCostPerHour: kpis.totalHours > 0 ? kpis.totalCost / kpis.totalHours : 0,
    avgCostPerGame: totalGames > 0 ? kpis.totalCost / totalGames : 0,
    avgHoursPerGame: totalGames > 0 ? kpis.totalHours / totalGames : 0,
    pureCodingCost,
    pureCodingHours,
    ausGames: aus,
    ausGamesShare: totalGames > 0 ? aus / totalGames : 0,
    // Per-game figures use AUS games ONLY — the Home/Office analysts code the
    // AUS games, so dividing by total (AUS+PHL) games would understate cost.
    ausCostPerGame: aus > 0 ? pureCodingCost / aus : 0,
    ausHoursPerGame: aus > 0 ? pureCodingHours / aus : 0,
    incCodingCost,
    incCodingHours,
    incCostPerGame: aus > 0 ? incCodingCost / aus : 0,
    incHoursPerGame: aus > 0 ? incCodingHours / aus : 0,
    weeksInRange,
    phlFixedCost,
    phlGames,
    phlGamesShare: totalGames > 0 ? phl / totalGames : 0,
    phlCostPerGame: phlGames > 0 ? phlFixedCost / phlGames : 0,
    byArea,
    byMonth,
    homeVsOffice: { home, office, other },
    gamesByLocation: { aus, phl, other: gOther },
    topAnalystsByGames,
    topAnalystsByCost,
  };
}

// ── Period-over-period comparison ─────────────────────────────────────────────

// The change in one metric between a current and a previous period. `delta` is
// current − previous; `pct` is the fractional change vs previous (null when the
// previous value is 0, i.e. no meaningful %). `direction` reflects the raw
// movement, independent of whether up is "good".
export type MetricDelta = {
  current: number;
  previous: number;
  delta: number;
  pct: number | null;
  direction: "up" | "down" | "flat";
};

export type BoardComparison = {
  totalCost: MetricDelta;
  totalCostWithPhl: MetricDelta;
  totalHours: MetricDelta;
  totalGames: MetricDelta;
  ausGames: MetricDelta;
  ausCostPerGame: MetricDelta;
  ausHoursPerGame: MetricDelta;
  incCostPerGame: MetricDelta;
  incHoursPerGame: MetricDelta;
  phlGames: MetricDelta;
  phlCostPerGame: MetricDelta;
};

function delta(current: number, previous: number): MetricDelta {
  const d = current - previous;
  const pct = previous !== 0 ? d / previous : null;
  const direction = d > 0.0001 ? "up" : d < -0.0001 ? "down" : "flat";
  return { current, previous, delta: d, pct, direction };
}

/**
 * Compare a current board report against a previous one, metric by metric.
 * Returns the per-metric movement (delta + % change + direction) for the
 * figures shown on the board report.
 */
export function compareReports(
  current: BoardReport,
  previous: BoardReport
): BoardComparison {
  return {
    totalCost: delta(current.totalCost, previous.totalCost),
    totalCostWithPhl: delta(
      current.totalCostWithPhl,
      previous.totalCostWithPhl
    ),
    totalHours: delta(current.totalHours, previous.totalHours),
    totalGames: delta(current.totalGames, previous.totalGames),
    ausGames: delta(current.ausGames, previous.ausGames),
    ausCostPerGame: delta(current.ausCostPerGame, previous.ausCostPerGame),
    ausHoursPerGame: delta(current.ausHoursPerGame, previous.ausHoursPerGame),
    incCostPerGame: delta(current.incCostPerGame, previous.incCostPerGame),
    incHoursPerGame: delta(current.incHoursPerGame, previous.incHoursPerGame),
    phlGames: delta(current.phlGames, previous.phlGames),
    phlCostPerGame: delta(current.phlCostPerGame, previous.phlCostPerGame),
  };
}
