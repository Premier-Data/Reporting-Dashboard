// Pure aggregation for the Operations reporting "Games" tab.
// No React / supabase imports so it can be unit tested directly.
// Season and week are derived from each row's Date (unified Wed->Tue rule in
// season.ts); the stored season / Week columns are only a fallback.
import { seasonWeekOfIso } from "./season";

// ---- Tunable constants -------------------------------------------------
// Weekly cell colour bands (games completed by one analyst in one week).
// Checked in order, first match wins. 4 itself is blue.
export const WEEK_BANDS: ReadonlyArray<{
  min: number;
  key: "blue" | "green" | "amber";
  label: string;
}> = [
  { min: 4, key: "blue", label: "4+" },
  { min: 3.5, key: "green", label: "3.5 to under 4" },
  { min: 3, key: "amber", label: "3 to under 3.5" },
];

// Allocation names left out of the analyst rows (lowercase). "PREMIER DATA" is
// deliberately NOT here: it shows as a normal analyst row on this tab.
export const PLACEHOLDER_ANALYSTS: readonly string[] = ["zz"];

export type TTGameRow = {
  game_key: string;
  Date: string | null; // yyyy-mm-dd
  Week: string | number | null;
  season: number | null;
  home_allocated: string | null;
  away_allocated: string | null;
  Location: string | null;
};

export type LocationBucket = "AUS" | "PHL" | "MIXED" | "OTHER";
export type WeekBand = "blue" | "green" | "amber" | "none";

export type OpsGamesWeek = { week: number; label: string; saturday: string };
export type OpsGamesLocationRow = {
  key: string; // clean code (AUS, PHL, IND, ...) or "Mixed"
  byWeek: Record<number, number>;
  total: number;
};
export type OpsGamesAnalystRow = {
  name: string;
  home: number;
  away: number;
  total: number; // (home + away) / 2
  weekly: Record<number, number>;
};
export type OpsGamesReport = {
  season: number;
  weeks: OpsGamesWeek[];
  analysts: OpsGamesAnalystRow[];
  totalsByWeek: Record<number, number>;
  ausByWeek: Record<number, number>;
  phlByWeek: Record<number, number>;
  mixedByWeek: Record<number, number>;
  pctAusByWeek: Record<number, number | null>;
  /** Clean single-code locations (AUS first, then total desc), then Mixed last (if any). */
  locations: OpsGamesLocationRow[];
  totals: {
    all: number;
    aus: number;
    phl: number;
    mixed: number; // combined / unrecognised location (clean codes like IND have their own row)
    mixedOrOther: number; // alias of mixed
    pctAus: number | null;
  };
  excluded: { placeholderHalfGames: number; skippedRows: number };
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAY_MS = 86400000;

function parseIso(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

function toIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Saturday ending the Wed->Tue week that contains `isoDate` (yyyy-mm-dd). */
export function saturdayOfWedTueWeek(isoDate: string): string {
  const t = parseIso(isoDate);
  if (t === null) return "";
  const dow = new Date(t).getUTCDay(); // Sun = 0
  let off = 6 - dow;
  if (off > 3) off -= 7;
  return toIso(t + off * DAY_MS);
}

export function formatSaturdayLabel(iso: string): string {
  const t = parseIso(iso);
  if (t === null) return "";
  const d = new Date(t);
  return `Sat ${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}`;
}

export function normaliseLocation(raw: string | null | undefined): LocationBucket {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return "OTHER";
  const aus = s.includes("AUS");
  const phl = s.includes("PHL");
  if (aus && phl) return "MIXED";
  if (s === "AUS") return "AUS";
  if (s === "PHL") return "PHL";
  return "OTHER";
}

export const OPS_MIXED_KEY = "Mixed";

/** A clean single location code (2-5 letters, e.g. AUS / PHL / IND), else "Mixed". */
export function aussieLocationKey(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2,5}$/.test(s) ? s : OPS_MIXED_KEY;
}

export function bandForWeekValue(v: number): WeekBand {
  for (const b of WEEK_BANDS) if (v >= b.min) return b.key;
  return "none";
}

/** 0..1 position of `total` within [min, max]; degenerate range gives 1. */
export function totalScale(total: number, min: number, max: number): number {
  if (max <= min) return 1;
  return Math.min(1, Math.max(0, (total - min) / (max - min)));
}

function seasonOf(r: TTGameRow): number | null {
  const d = seasonWeekOfIso(r.Date);
  if (d) return d.season;
  const s = Number(r.season);
  return r.season !== null && r.season !== undefined && Number.isFinite(s) ? s : null;
}

export function seasonsFromGames(rows: TTGameRow[]): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    const s = seasonOf(r);
    if (s !== null) set.add(s);
  }
  return [...set].sort((a, b) => b - a);
}

export function latestSeason(rows: TTGameRow[]): number | null {
  return seasonsFromGames(rows)[0] ?? null;
}

function isPlaceholder(name: string): boolean {
  const n = name.trim().toLowerCase();
  // "PH1".."PH8" / "AUS" are 2025-sheet placeholders (no real analyst yet).
  return PLACEHOLDER_ANALYSTS.includes(n) || /^ph\d+$/.test(n) || n === "aus";
}

function weekNumber(r: TTGameRow): number | null {
  const d = seasonWeekOfIso(r.Date);
  if (d) return d.week;
  if (r.Week === null || r.Week === undefined || r.Week === "") return null;
  const n = Number(r.Week);
  return Number.isFinite(n) ? n : null;
}

/** Sport-neutral game used by the shared aggregation core. */
export type GameEntry = {
  week: number | null;
  date: string | null; // yyyy-mm-dd
  home: string | null;
  away: string | null;
  loc: string; // already-bucketed location key
};

export type GamesCore = {
  weeks: OpsGamesWeek[];
  analysts: OpsGamesAnalystRow[];
  totalsByWeek: Record<number, number>;
  locByWeek: Record<string, Record<number, number>>;
  locTotals: Record<string, number>;
  all: number;
  excluded: { placeholderHalfGames: number; skippedRows: number };
};

/**
 * Shared core: each side of a game is worth 0.5 for its analyst (same analyst
 * on both sides = 1). Week columns span min..max week seen, labelled by the
 * most common week-ending Saturday of that week's game dates.
 */
export function aggregateGames(entries: GameEntry[], locKeys: readonly string[] = []): GamesCore {
  const byName = new Map<string, OpsGamesAnalystRow>();
  const totalsByWeek: Record<number, number> = {};
  const locByWeek: Record<string, Record<number, number>> = {};
  const locTotals: Record<string, number> = {};
  for (const k of locKeys) {
    locByWeek[k] = {};
    locTotals[k] = 0;
  }
  const satVotes = new Map<number, Map<string, number>>();
  let skippedRows = 0;
  let placeholderHalfGames = 0;
  let all = 0;

  const credit = (raw: string | null, week: number, side: "home" | "away") => {
    const name = (raw ?? "").trim();
    if (!name) return;
    if (isPlaceholder(name)) {
      placeholderHalfGames += 0.5;
      return;
    }
    const key = name.toLowerCase();
    let a = byName.get(key);
    if (!a) {
      a = { name, home: 0, away: 0, total: 0, weekly: {} };
      byName.set(key, a);
    }
    a[side] += 1;
    a.weekly[week] = (a.weekly[week] ?? 0) + 0.5;
  };

  for (const r of entries) {
    const week = r.week;
    const t = r.date ? parseIso(r.date) : null;
    if (week === null || t === null) {
      skippedRows += 1;
      continue;
    }
    const sat = saturdayOfWedTueWeek(r.date as string);
    let votes = satVotes.get(week);
    if (!votes) satVotes.set(week, (votes = new Map()));
    votes.set(sat, (votes.get(sat) ?? 0) + 1);

    credit(r.home, week, "home");
    credit(r.away, week, "away");

    totalsByWeek[week] = (totalsByWeek[week] ?? 0) + 1;
    all += 1;
    const lw = (locByWeek[r.loc] ??= {});
    lw[week] = (lw[week] ?? 0) + 1;
    locTotals[r.loc] = (locTotals[r.loc] ?? 0) + 1;
  }

  const weekNums = [...satVotes.keys()];
  const weeks: OpsGamesWeek[] = [];
  if (weekNums.length > 0) {
    const lo = Math.min(...weekNums);
    const hi = Math.max(...weekNums);
    for (let w = lo; w <= hi; w++) {
      const votes = satVotes.get(w);
      let saturday = "";
      if (votes) {
        let best = -1;
        for (const [sat, n] of votes) {
          if (n > best || (n === best && sat > saturday)) {
            best = n;
            saturday = sat;
          }
        }
      }
      weeks.push({ week: w, saturday, label: saturday ? formatSaturdayLabel(saturday) : `Week ${w}` });
      totalsByWeek[w] ??= 0;
      for (const lw of Object.values(locByWeek)) lw[w] ??= 0;
    }
  }

  const analysts = [...byName.values()];
  for (const a of analysts) a.total = (a.home + a.away) / 2;
  analysts.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  return {
    weeks,
    analysts,
    totalsByWeek,
    locByWeek,
    locTotals,
    all,
    excluded: { placeholderHalfGames, skippedRows },
  };
}

export type AnalystGameStats = {
  /** Sides coded as the home team. */
  home: number;
  /** Sides coded as the away team. */
  away: number;
  /** Games where the analyst coded BOTH sides (counted in home and away). */
  both: number;
  /** Distinct games where the analyst coded at least one side. */
  involved: number;
  /** (home + away) / 2: the same definition as the Operations Games tab. */
  total: number;
};

const nameKey = (v: unknown): string =>
  String(v ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Per-analyst game totals for the analyst profile. Built on aggregateGames so
 * the definition (each side = 0.5 game, same analyst on both sides = 1) is the
 * Operations Games tab's. `season` null = all seasons. Season comes from the
 * row's Date (unified rule), not the stored column.
 */
export function analystGameStats(
  rows: ReadonlyArray<TTGameRow>,
  analystName: string,
  season: number | null = null
): AnalystGameStats {
  const target = nameKey(analystName);
  const out: AnalystGameStats = { home: 0, away: 0, both: 0, involved: 0, total: 0 };
  if (!target || isPlaceholder(target)) return out;
  const entries: GameEntry[] = [];
  for (const r of rows) {
    if (season !== null && seasonOf(r) !== season) continue;
    const h = nameKey(r.home_allocated) === target;
    const a = nameKey(r.away_allocated) === target;
    if (!h && !a) continue;
    out.involved += 1;
    if (h && a) out.both += 1;
    entries.push({
      week: weekNumber(r) ?? 0, // week is irrelevant to the totals; keep undated rows
      date: r.Date ?? "1970-01-01",
      home: h ? analystName : null,
      away: a ? analystName : null,
      loc: "",
    });
  }
  const row = aggregateGames(entries).analysts[0];
  if (row) {
    out.home = row.home;
    out.away = row.away;
    out.total = row.total;
  }
  return out;
}

export function buildOpsGamesReport(rows: TTGameRow[], season: number): OpsGamesReport {
  const entries: GameEntry[] = [];
  for (const r of rows) {
    if (seasonOf(r) !== season) continue;
    entries.push({
      week: weekNumber(r),
      date: r.Date,
      home: r.home_allocated,
      away: r.away_allocated,
      loc: aussieLocationKey(r.Location),
    });
  }
  const core = aggregateGames(entries, ["AUS", "PHL", OPS_MIXED_KEY]);
  const { weeks, totalsByWeek } = core;
  const ausByWeek = core.locByWeek.AUS;
  const pctAusByWeek: Record<number, number | null> = {};
  for (const w of weeks) {
    const tot = totalsByWeek[w.week];
    pctAusByWeek[w.week] = tot > 0 ? ausByWeek[w.week] / tot : null;
  }
  const aus = core.locTotals.AUS;
  const keys = Object.keys(core.locTotals);
  const singles = keys
    .filter((k) => k !== OPS_MIXED_KEY && core.locTotals[k] > 0)
    .sort((a, b) => {
      if (a === "AUS") return -1;
      if (b === "AUS") return 1;
      return core.locTotals[b] - core.locTotals[a] || a.localeCompare(b);
    });
  const ordered = core.locTotals[OPS_MIXED_KEY] > 0 ? [...singles, OPS_MIXED_KEY] : singles;
  return {
    season,
    weeks,
    analysts: core.analysts,
    totalsByWeek,
    ausByWeek,
    phlByWeek: core.locByWeek.PHL,
    mixedByWeek: core.locByWeek[OPS_MIXED_KEY],
    pctAusByWeek,
    locations: ordered.map((key) => ({ key, byWeek: core.locByWeek[key], total: core.locTotals[key] })),
    totals: {
      all: core.all,
      aus,
      phl: core.locTotals.PHL,
      mixed: core.locTotals[OPS_MIXED_KEY],
      mixedOrOther: core.locTotals[OPS_MIXED_KEY],
      pctAus: core.all > 0 ? aus / core.all : null,
    },
    excluded: core.excluded,
  };
}
