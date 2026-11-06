// Pure aggregation for the Operations reporting "Games" tab.
// No React / supabase imports so it can be unit tested directly.

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
  totals: {
    all: number;
    aus: number;
    phl: number;
    mixed: number; // location neither clearly AUS nor PHL
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
  return PLACEHOLDER_ANALYSTS.includes(name.trim().toLowerCase());
}

function weekNumber(r: TTGameRow): number | null {
  if (r.Week === null || r.Week === undefined || r.Week === "") return null;
  const n = Number(r.Week);
  return Number.isFinite(n) ? n : null;
}

export function buildOpsGamesReport(rows: TTGameRow[], season: number): OpsGamesReport {
  const byName = new Map<string, OpsGamesAnalystRow>();
  const totalsByWeek: Record<number, number> = {};
  const ausByWeek: Record<number, number> = {};
  const phlByWeek: Record<number, number> = {};
  const mixedByWeek: Record<number, number> = {};
  // week -> Saturday -> row count (for the label mode)
  const satVotes = new Map<number, Map<string, number>>();
  let skippedRows = 0;
  let placeholderHalfGames = 0;
  let all = 0;
  let aus = 0;
  let phl = 0;
  let mixedOrOther = 0;

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

  for (const r of rows) {
    if (seasonOf(r) !== season) continue;
    const week = weekNumber(r);
    const t = r.Date ? parseIso(r.Date) : null;
    if (week === null || t === null) {
      skippedRows += 1;
      continue;
    }
    const sat = saturdayOfWedTueWeek(r.Date as string);
    let votes = satVotes.get(week);
    if (!votes) satVotes.set(week, (votes = new Map()));
    votes.set(sat, (votes.get(sat) ?? 0) + 1);

    credit(r.home_allocated, week, "home");
    credit(r.away_allocated, week, "away");

    totalsByWeek[week] = (totalsByWeek[week] ?? 0) + 1;
    all += 1;
    const loc = normaliseLocation(r.Location);
    if (loc === "AUS") {
      ausByWeek[week] = (ausByWeek[week] ?? 0) + 1;
      aus += 1;
    } else if (loc === "PHL") {
      phlByWeek[week] = (phlByWeek[week] ?? 0) + 1;
      phl += 1;
    } else {
      mixedByWeek[week] = (mixedByWeek[week] ?? 0) + 1;
      mixedOrOther += 1;
    }
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
      ausByWeek[w] ??= 0;
      phlByWeek[w] ??= 0;
      mixedByWeek[w] ??= 0;
    }
  }

  const pctAusByWeek: Record<number, number | null> = {};
  for (const w of weeks) {
    const tot = totalsByWeek[w.week];
    pctAusByWeek[w.week] = tot > 0 ? ausByWeek[w.week] / tot : null;
  }

  const analysts = [...byName.values()];
  for (const a of analysts) a.total = (a.home + a.away) / 2;
  analysts.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  return {
    season,
    weeks,
    analysts,
    totalsByWeek,
    ausByWeek,
    phlByWeek,
    mixedByWeek,
    pctAusByWeek,
    totals: { all, aus, phl, mixed: mixedOrOther, mixedOrOther, pctAus: all > 0 ? aus / all : null },
    excluded: { placeholderHalfGames, skippedRows },
  };
}
