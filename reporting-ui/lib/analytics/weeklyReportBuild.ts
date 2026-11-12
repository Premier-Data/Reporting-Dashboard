// Pure builder for the Weekly Report matrix (moved out of components/WeeklyReport.tsx
// so it can be unit tested). Season/week come from the unified rule in
// lib/analytics/season.ts: shifts, TT and soccer rows are expected to be
// already derived (aggregates from lib/api/deputyShifts, mapFixtureWeekTT/Soccer).

import { parseIsoDate, seasonWeekRange } from "@/lib/analytics/season";

type Row = Record<string, unknown>;

export type Group = "aussie" | "soccer" | "os" | "other";
// "os" sits before the catch-all "other" group.
export const GROUP_ORDER: Group[] = ["aussie", "soccer", "os", "other"];

export function groupOf(area: string): Group {
  const a = area.trim().toLowerCase();
  if (a.startsWith("aussie rules")) return "aussie";
  if (a.startsWith("soccer")) return "soccer";
  return "other";
}

const DAY_MS = 86400000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// A finite week number, or null for a missing / non-numeric week.
const weekOf = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export type WeeklyReportInput = {
  season: number;
  monthly: boolean;
  shifts: ReadonlyArray<Row>;
  tt: ReadonlyArray<Row>;
  soccer: ReadonlyArray<Row>;
  osTeam: ReadonlyArray<Row>;
};

/**
 * Is an os_team row's cost active in `week` of `season`? The row starts at
 * `start_date` when present. Legacy rows (before migration 009) carry only
 * start_season 2026 + start_week counted from 2026-03-25; they are converted to
 * that date so results are identical before and after 009. No start_season
 * means no limit.
 */
export function osActive(r: Row, season: number, week: number): boolean {
  const ss = r.start_season == null || r.start_season === "" ? null : Number(r.start_season);
  if (ss == null || !Number.isFinite(ss)) return true; // no start limit
  const sw = r.start_week == null || r.start_week === "" ? NaN : Number(r.start_week);
  let startMs: number;
  const sd = parseIsoDate(r.start_date);
  if (sd) startMs = sd.getTime();
  else if (ss === 2026 && Number.isFinite(sw)) startMs = Date.UTC(2026, 2, 25) + (sw - 1) * 7 * DAY_MS;
  else startMs = seasonWeekRange(ss, Number.isFinite(sw) ? sw : 1).start.getTime();
  return seasonWeekRange(season, week).start.getTime() >= startMs;
}

export function buildWeeklyReport(input: WeeklyReportInput) {
  const { season, monthly, osTeam } = input;
  const shifts = input.shifts.filter((r) => num(r.season) === season);
  const afl = input.tt.filter((r) => num(r.season) === season);
  const soc = input.soccer.filter((r) => num(r.season) === season);

  // View: "week" columns are week numbers; "month" columns are "YYYY-MM" keys
  // taken from each record's real date. `keyOf` maps a record to its column key
  // (null = unusable).
  const keyOf = (w: number | null, iso: unknown): string | number | null => {
    if (!monthly) return w;
    const s = String(iso ?? "").slice(0, 7);
    return /^\d{4}-\d{2}$/.test(s) ? s : null;
  };
  const weekSet = new Set<string | number>();
  const weekNumSet = new Set<number>(); // always real week numbers (for OS cost)
  const weekDates: Record<string, { min: string; max: string }> = {};
  const noteDate = (w: string | number, iso: unknown) => {
    const s = String(iso ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
    const d = weekDates[w];
    if (!d) weekDates[w] = { min: s, max: s };
    else {
      if (s < d.min) d.min = s;
      if (s > d.max) d.max = s;
    }
  };
  for (const r of shifts) {
    const w = weekOf(r.week);
    if (w != null) weekNumSet.add(w);
    const k = keyOf(w, r.shift_date);
    if (k != null) { weekSet.add(k); noteDate(k, r.shift_date); }
  }
  for (const r of afl) {
    const w = weekOf(r.Week ?? r.week);
    if (w != null) weekNumSet.add(w);
    const k = keyOf(w, r.Date);
    if (k != null) { weekSet.add(k); noteDate(k, r.Date); }
  }
  // Soccer week is derived from Date by the loader (mapFixtureWeekSoccer).
  for (const r of soc) {
    const w = weekOf(r.week);
    if (w != null) weekNumSet.add(w);
    const k = keyOf(w, r.Date);
    if (k != null) { weekSet.add(k); noteDate(k, r.Date); }
  }
  const weeks = [...weekSet].sort((a, b) =>
    monthly ? String(a).localeCompare(String(b)) : Number(a) - Number(b)
  );
  // Week view: label each week from the season rule, so a week with only costs
  // or only games is still dated correctly.
  if (!monthly) {
    for (const w of weeks) {
      const { start, end } = seasonWeekRange(season, Number(w));
      weekDates[w] = { min: isoDay(start), max: isoDay(end) };
    }
  }

  // Areas by group.
  const areasByGroup: Record<Group, string[]> = { aussie: [], soccer: [], os: [], other: [] };
  const seen = new Set<string>();
  for (const r of shifts) {
    const a = String(r.area_name ?? "").trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    areasByGroup[groupOf(a)].push(a);
  }
  for (const g of GROUP_ORDER) areasByGroup[g].sort((a, b) => a.localeCompare(b));

  // cost/hrs per area per week (+ total).
  const cost: Record<string, Record<string, number>> = {};
  const hrs: Record<string, Record<string, number>> = {};
  for (const a of seen) {
    cost[a] = { total: 0 };
    hrs[a] = { total: 0 };
  }
  for (const r of shifts) {
    const a = String(r.area_name ?? "").trim();
    if (!a) continue;
    const w = keyOf(weekOf(r.week), r.shift_date);
    if (w == null) continue;
    const c = num(r.total_cost);
    const h = num(r.total_hours);
    cost[a][w] = (cost[a][w] ?? 0) + c;
    cost[a].total += c;
    hrs[a][w] = (hrs[a][w] ?? 0) + h;
    hrs[a].total += h;
  }

  // ── OS team rows ──
  // One row per location (its members' weekly costs summed) plus a separate
  // "<Location> - Bank Fee" row where the sheet lists one. Pushed AFTER the
  // alphabetical sort above so locations stay grouped with their fee row.
  const osLabel = (r: Row): string =>
    String(r.kind) === "fee" ? `${r.location} - Bank Fee` : String(r.location);
  const osLabels = [...new Map(
    osTeam.map((r) => [osLabel(r), { loc: String(r.location), fee: String(r.kind) === "fee" }])
  ).entries()]
    .sort((a, b) => a[1].loc.localeCompare(b[1].loc) || Number(a[1].fee) - Number(b[1].fee))
    .map(([label]) => label);
  for (const label of osLabels) {
    cost[label] = { total: 0 };
    hrs[label] = { total: 0 }; // no hours for OS; keeps the shared maths simple
    areasByGroup.os.push(label);
  }
  for (const r of osTeam) {
    const label = osLabel(r);
    const weekly = num(r.weekly_cost);
    for (const w of weekNumSet) {
      if (!osActive(r, season, w)) continue;
      cost[label].total += weekly;
      if (!monthly) {
        cost[label][w] = (cost[label][w] ?? 0) + weekly;
      } else {
        // Monthly view: spread the week's cost evenly over its 7 days and
        // credit each day to the month it falls in (totals still reconcile).
        const startMs = seasonWeekRange(season, w).start.getTime();
        for (let d = 0; d < 7; d++) {
          const mk = new Date(startMs + d * DAY_MS).toISOString().slice(0, 7);
          cost[label][mk] = (cost[label][mk] ?? 0) + weekly / 7;
        }
      }
    }
  }

  // Games per week per sport.
  const aflGames: Record<string, number> = { total: afl.length };
  const socGames: Record<string, number> = { total: soc.length };
  for (const r of afl) { const w = keyOf(weekOf(r.Week ?? r.week), r.Date); if (w != null) aflGames[w] = (aflGames[w] ?? 0) + 1; }
  for (const r of soc) { const w = keyOf(weekOf(r.week), r.Date); if (w != null) socGames[w] = (socGames[w] ?? 0) + 1; }

  const colKeys = ["total", ...weeks] as (string | number)[];

  // Group subtotals (cost + hours) per week + total.
  const subCost: Record<Group, Record<string, number>> = { aussie: {}, soccer: {}, os: {}, other: {} };
  const subHrs: Record<Group, Record<string, number>> = { aussie: {}, soccer: {}, os: {}, other: {} };
  for (const g of GROUP_ORDER) {
    for (const key of colKeys) {
      subCost[g][key] = areasByGroup[g].reduce((s, a) => s + (cost[a][key] ?? 0), 0);
      subHrs[g][key] = areasByGroup[g].reduce((s, a) => s + (hrs[a][key] ?? 0), 0);
    }
  }

  // Grand totals.
  const grandCost: Record<string, number> = {};
  const grandHrs: Record<string, number> = {};
  for (const key of colKeys) {
    grandCost[key] = GROUP_ORDER.reduce((s, g) => s + subCost[g][key], 0);
    grandHrs[key] = GROUP_ORDER.reduce((s, g) => s + subHrs[g][key], 0);
  }

  // ── Coding per game (Aussie Rules / TT_Games) ──
  // Games split by TT_Games.Location (AUS / PHL). Pure coding = the Home +
  // Office Analyst areas only; per-game figures divide by AUS games.
  const ausGames: Record<string, number> = { total: 0 };
  const phlGames: Record<string, number> = { total: 0 };
  for (const r of afl) {
    const w = keyOf(weekOf(r.Week ?? r.week), r.Date);
    const loc = String(r.Location ?? "").trim().toUpperCase();
    const bucket = loc === "AUS" ? ausGames : loc === "PHL" ? phlGames : null;
    if (!bucket) continue;
    bucket.total += 1;
    if (w != null) bucket[w] = (bucket[w] ?? 0) + 1;
  }
  const pureAreas = [...seen].filter((a) => {
    const k = a.toLowerCase();
    return k === "aussie rules - home analyst" || k === "aussie rules - office analyst";
  });
  const pureCost: Record<string, number> = {};
  const pureHrs: Record<string, number> = {};
  const pureAvgTime: Record<string, number> = {};
  const pureCostPerGame: Record<string, number> = {};
  for (const key of colKeys) {
    pureCost[key] = pureAreas.reduce((s, a) => s + (cost[a][key] ?? 0), 0);
    pureHrs[key] = pureAreas.reduce((s, a) => s + (hrs[a][key] ?? 0), 0);
    const g = ausGames[key] ?? 0;
    pureAvgTime[key] = g > 0 ? pureHrs[key] / g : 0;
    pureCostPerGame[key] = g > 0 ? pureCost[key] / g : 0;
  }
  // PHL coding cost = the Philippines OS rows (team + bank fee). Vietnam is not
  // a coding-games team so it's excluded.
  const phlLabels = osLabels.filter((l) => l.toLowerCase().startsWith("philippines"));
  const phlCost: Record<string, number> = {};
  for (const key of colKeys) {
    phlCost[key] = phlLabels.reduce((s, l) => s + (cost[l][key] ?? 0), 0);
  }

  // Game CREDIT by location (for the Excel summary). A mixed Location
  // ("PHL/ AUS") splits credit evenly across the locations present.
  const splitLoc = (v: unknown): string[] => {
    const s = String(v ?? "").toUpperCase();
    return ["AUS", "PHL", "VN"].filter((k) => s.includes(k));
  };
  const footyCred: Record<string, Record<string, number>> = { AUS: {}, PHL: {}, VN: {} };
  const socCred: Record<string, Record<string, number>> = { AUS: {}, PHL: {}, VN: {} };
  const addCred = (tgt: Record<string, Record<string, number>>, r: Row, key: string | number | null) => {
    if (key == null) return;
    const locs = splitLoc(r.Location);
    for (const l of locs) tgt[l][key] = (tgt[l][key] ?? 0) + 1 / locs.length;
  };
  for (const r of afl) addCred(footyCred, r, keyOf(weekOf(r.Week ?? r.week), r.Date));
  for (const r of soc) addCred(socCred, r, keyOf(weekOf(r.week), r.Date));
  // Vietnam OS cost per column, used in the Soccer per-game figures.
  const vnLabels = osLabels.filter((l) => l.toLowerCase().startsWith("vietnam"));
  const vnCost: Record<string, number> = {};
  for (const key of colKeys) {
    vnCost[key] = vnLabels.reduce((s, l) => s + (cost[l][key] ?? 0), 0);
  }
  const phlCostPerGame: Record<string, number> = {};
  for (const key of colKeys) {
    const pc = phlLabels.reduce((s, l) => s + (cost[l][key] ?? 0), 0);
    const pg = phlGames[key] ?? 0;
    phlCostPerGame[key] = pg > 0 ? pc / pg : 0;
  }
  // Total coding cost per game = Home + Office Analyst, Live Games, Operations
  // Coordinator, QA/ Accuracy and Supervising (Aussie Rules) / AUS games.
  const totalCodingSuffixes = ["home analyst", "office analyst", "live games", "operations coordinator", "qa/ accuracy", "supervising"];
  const totalCodingAreas = [...seen].filter((a) => {
    const k = a.toLowerCase();
    return k.startsWith("aussie rules") && totalCodingSuffixes.some((s) => k.endsWith(s));
  });
  const totalCodingCostPerGame: Record<string, number> = {};
  const totalBlendedCostPerGame: Record<string, number> = {};
  for (const key of colKeys) {
    const c = totalCodingAreas.reduce((s, a) => s + (cost[a][key] ?? 0), 0);
    const g = ausGames[key] ?? 0;
    // +15% to account for entitlements (AUS staff only).
    const ausCost = c * 1.15;
    totalCodingCostPerGame[key] = g > 0 ? ausCost / g : 0;
    // Blended = (AUS coding cost incl. 15% + PHL cost incl. bank fee) / (AUS + PHL games).
    const pc = phlLabels.reduce((s, l) => s + (cost[l][key] ?? 0), 0);
    const pg = phlGames[key] ?? 0;
    totalBlendedCostPerGame[key] = g + pg > 0 ? (ausCost + pc) / (g + pg) : 0;
  }

  // Soccer per-game figures: Soccer group hours / soccer games, and Vietnam OS
  // cost (no 15% uplift) / soccer games. 0 when there are no games.
  const socAvgTime: Record<string, number> = {};
  const socCostPerGame: Record<string, number> = {};
  for (const key of colKeys) {
    const g = socGames[key] ?? 0;
    socAvgTime[key] = g > 0 ? (subHrs.soccer[key] ?? 0) / g : 0;
    socCostPerGame[key] = g > 0 ? (vnCost[key] ?? 0) / g : 0;
  }

  return { weeks, weekDates, areasByGroup, cost, hrs, aflGames, socGames, subCost, subHrs, grandCost, grandHrs, ausGames, phlGames, pureAvgTime, pureCostPerGame, phlCostPerGame, totalCodingCostPerGame, totalBlendedCostPerGame, socAvgTime, socCostPerGame, vnCost, phlCost, footyCred, socCred };
}

export type WeeklyReportModel = ReturnType<typeof buildWeeklyReport>;
