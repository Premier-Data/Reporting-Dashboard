"use client";

// Weekly Report — a per-week matrix of costs and hours by area, grouped into
// AUSSIE RULES / SOCCER / OS TEAM (cost-only, from os_team) / OTHER, for a chosen season. Mirrors the source
// spreadsheet layout:
//   • Columns: Total + each week, with Start (Wed) / End (Tue) of week dates.
//   • Each sport group: a Games row (Aussie Rules ← TT_Games, Soccer ←
//     soccer_games), then its area rows, then group subtotals (Costs + Hours).
//   • Area rows are driven dynamically by the area_name values in the data.
//
// Area → group mapping is by name prefix:
//   "Aussie Rules …"  → Aussie Rules
//   "Soccer …" / "Soccer Games" → Soccer
//   everything else (Customer Service, Data/AI, Sales, Social Media) → Other
//
// Soccer is kept entirely separate from Aussie Rules (games counts included).

import { useEffect, useMemo, useState } from "react";
import { seasonsFromTT } from "@/lib/analytics/season";
import { supabase } from "@/lib/supabase";

type Row = Record<string, unknown>;

const money = (v: number) =>
  v === 0
    ? "–"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (v: number) =>
  v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// A valid week number, INCLUDING 0 (pre-season). Returns null for a missing or
// non-numeric week so a blank cell isn't silently counted as Week 0.
const weekOf = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });

type Group = "aussie" | "soccer" | "os" | "other";
const GROUP_LABEL: Record<Group, string> = {
  aussie: "Aussie Rules",
  soccer: "Soccer",
  os: "OS Team",
  other: "Other",
};
// "os" sits before the catch-all "other" group.
const GROUP_ORDER: Group[] = ["aussie", "soccer", "os", "other"];

function groupOf(area: string): Group {
  const a = area.trim().toLowerCase();
  if (a.startsWith("aussie rules")) return "aussie";
  if (a.startsWith("soccer")) return "soccer";
  return "other";
}

export default function WeeklyReport({
  deputyData,
  ttData,
}: {
  deputyData: Row[];
  ttData: Row[];
}) {
  // Soccer games are fetched here (self-contained tab) so the Soccer group's
  // Games row stays separate from Aussie Rules (TT_Games).
  const [soccerGames, setSoccerGames] = useState<Row[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let all: Row[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("soccer_games")
          .select("season,week,Date")
          .range(from, from + 999);
        if (error || !data || data.length === 0) break;
        all = all.concat(data as Row[]);
        if (data.length < 1000) break;
        from += 1000;
      }
      if (!cancelled) setSoccerGames(all);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // OS (offshore) team: fixed weekly cost per person from the "OS Team" sheet
  // (synced to os_team). Cost-only — there are no hours or games for this group.
  // Each row carries start_season/start_week; the cost only counts from there on.
  const [osTeam, setOsTeam] = useState<Row[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("os_team").select("*");
      // If the table isn't there yet the OS section simply doesn't render.
      if (!cancelled && !error && data) setOsTeam(data as Row[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const seasonInfo = useMemo(() => seasonsFromTT(ttData as { season?: number | null }[]), [ttData]);
  const defaultSeason = seasonInfo.years.includes(2027)
    ? 2027
    : seasonInfo.years[0] ?? new Date().getFullYear();
  const [season, setSeason] = useState<number>(defaultSeason);

  const report = useMemo(() => {
    const shifts = deputyData.filter((r) => num(r.season) === season);
    const afl = ttData.filter((r) => num(r.season) === season);
    const soc = soccerGames.filter((r) => num(r.season) === season);

    // Weeks across shifts + both game sets, AND the actual date range each week
    // covers (min/max of the real shift + game dates). Week anchoring differs
    // per season (2026 weeks start in late March; 2027 weeks start late Sep), so
    // the column dates are taken straight from the data, NOT a season formula.
    const weekSet = new Set<number>();
    const weekDates: Record<number, { min: string; max: string }> = {};
    const noteDate = (w: number, iso: unknown) => {
      const s = String(iso ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
      const d = weekDates[w];
      if (!d) weekDates[w] = { min: s, max: s };
      else {
        if (s < d.min) d.min = s;
        if (s > d.max) d.max = s;
      }
    };
    for (const r of shifts) { const w = weekOf(r.week); if (w != null) { weekSet.add(w); noteDate(w, r.shift_date); } }
    for (const r of afl) { const w = weekOf(r.Week ?? r.week); if (w != null) { weekSet.add(w); noteDate(w, r.Date); } }

    // Soccer's stored week uses the October season formula, which doesn't match
    // this season's sheet-defined weeks (2026 weeks start late March). So bucket
    // each soccer game by DATE onto the same Wed→Tue anchoring as the Deputy/TT
    // data: Week 1 starts on the Wednesday on-or-before the earliest Week 1
    // date; anything earlier is Week 0 (pre-season). Falls back to the stored
    // week only if the season has no Week 1 data to anchor on.
    const wk1 = weekDates[1];
    let anchorMs: number | null = null;
    if (wk1) {
      const d = new Date(`${wk1.min}T00:00:00Z`);
      const back = (d.getUTCDay() - 3 + 7) % 7; // 3 = Wednesday
      anchorMs = d.getTime() - back * 86400000;
    }
    const socWeek = (r: Row): number | null => {
      const iso = String(r.Date ?? "").slice(0, 10);
      if (anchorMs != null && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        const ms = new Date(`${iso}T00:00:00Z`).getTime();
        return ms < anchorMs ? 0 : Math.floor((ms - anchorMs) / (7 * 86400000)) + 1;
      }
      return weekOf(r.week);
    };
    for (const r of soc) { const w = socWeek(r); if (w != null) { weekSet.add(w); noteDate(w, r.Date); } }
    const weeks = [...weekSet].sort((a, b) => a - b);

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
      const w = weekOf(r.week);
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
    // "<Location> - Bank Fee" row where the sheet lists one. A row's cost only
    // counts in weeks at/after its start season+week (earlier seasons: nothing;
    // later seasons: every week). Pushed AFTER the alphabetical sort above so
    // locations stay grouped with their fee row beneath them.
    const osActive = (r: Row, w: number): boolean => {
      const ss = r.start_season == null ? null : Number(r.start_season);
      if (ss == null || !Number.isFinite(ss)) return true; // no start limit
      const sw = r.start_week == null ? 0 : Number(r.start_week);
      return season > ss || (season === ss && w >= sw);
    };
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
      for (const w of weeks) {
        if (!osActive(r, w)) continue;
        cost[label][w] = (cost[label][w] ?? 0) + weekly;
        cost[label].total += weekly;
      }
    }

    // Games per week per sport.
    const aflGames: Record<string, number> = { total: afl.length };
    const socGames: Record<string, number> = { total: soc.length };
    for (const r of afl) { const w = weekOf(r.Week ?? r.week); if (w != null) aflGames[w] = (aflGames[w] ?? 0) + 1; }
    for (const r of soc) { const w = socWeek(r); if (w != null) socGames[w] = (socGames[w] ?? 0) + 1; }

    // Group subtotals (cost + hours) per week + total.
    const subCost: Record<Group, Record<string, number>> = { aussie: {}, soccer: {}, os: {}, other: {} };
    const subHrs: Record<Group, Record<string, number>> = { aussie: {}, soccer: {}, os: {}, other: {} };
    for (const g of GROUP_ORDER) {
      for (const key of ["total", ...weeks] as (string | number)[]) {
        subCost[g][key] = areasByGroup[g].reduce((s, a) => s + (cost[a][key] ?? 0), 0);
        subHrs[g][key] = areasByGroup[g].reduce((s, a) => s + (hrs[a][key] ?? 0), 0);
      }
    }

    // Grand totals.
    const grandCost: Record<string, number> = {};
    const grandHrs: Record<string, number> = {};
    for (const key of ["total", ...weeks] as (string | number)[]) {
      grandCost[key] = GROUP_ORDER.reduce((s, g) => s + subCost[g][key], 0);
      grandHrs[key] = GROUP_ORDER.reduce((s, g) => s + subHrs[g][key], 0);
    }

    // ── Coding per game (Aussie Rules / TT_Games) ──
    // Games split by TT_Games.Location (AUS / PHL). Pure coding = the Home +
    // Office Analyst areas only; per-game figures divide by AUS games because
    // those analysts code the AUS games (PHL is a separate fixed-cost team).
    const ausGames: Record<string, number> = { total: 0 };
    const phlGames: Record<string, number> = { total: 0 };
    for (const r of afl) {
      const w = weekOf(r.Week ?? r.week);
      const loc = String(r.Location ?? "").trim().toUpperCase();
      const bucket = loc === "AUS" ? ausGames : loc === "PHL" ? phlGames : null;
      if (!bucket) continue;
      bucket.total += 1;
      if (w != null) bucket[w] = (bucket[w] ?? 0) + 1;
    }
    const pureAreas = [...seen].filter((a) => {
      const k = a.toLowerCase();
      return k === "home analyst" || k === "office analyst";
    });
    const pureCost: Record<string, number> = {};
    const pureHrs: Record<string, number> = {};
    const pureAvgTime: Record<string, number> = {};
    const pureCostPerGame: Record<string, number> = {};
    for (const key of ["total", ...weeks] as (string | number)[]) {
      pureCost[key] = pureAreas.reduce((s, a) => s + (cost[a][key] ?? 0), 0);
      pureHrs[key] = pureAreas.reduce((s, a) => s + (hrs[a][key] ?? 0), 0);
      const g = ausGames[key] ?? 0;
      pureAvgTime[key] = g > 0 ? pureHrs[key] / g : 0;
      pureCostPerGame[key] = g > 0 ? pureCost[key] / g : 0;
    }

    return { weeks, weekDates, areasByGroup, cost, hrs, aflGames, socGames, subCost, subHrs, grandCost, grandHrs, ausGames, phlGames, pureAvgTime, pureCostPerGame };
  }, [deputyData, ttData, soccerGames, osTeam, season]);

  const { weeks, weekDates, areasByGroup, cost, hrs, aflGames, socGames, subCost, subHrs, grandCost, grandHrs, ausGames, phlGames, pureAvgTime, pureCostPerGame } = report;
  const cols: (string | number)[] = ["total", ...weeks];

  const cellCls = "border-b border-slate-100 px-3 py-1.5 text-right tabular-nums whitespace-nowrap";
  // First column (area/row labels) is sticky-left so it stays visible when
  // scrolling the week columns horizontally. Needs an opaque bg to cover cells
  // sliding under it.
  const labelCls = "sticky left-0 z-10 border-b border-slate-100 bg-white px-3 py-1.5 text-left whitespace-nowrap";
  const totalCol = "bg-slate-50 font-semibold";

  // Games source per group (Aussie Rules ← TT, Soccer ← soccer_games, Other none).
  const gamesFor = (g: Group): Record<string, number> | null =>
    g === "aussie" ? aflGames : g === "soccer" ? socGames : null;

  return (
    <div style={{ marginTop: 20 }}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Weekly Report</h2>
          <p className="text-xs text-slate-500">
            Costs &amp; hours by area, grouped by sport, per week. Soccer kept
            separate from Aussie Rules.
          </p>
        </div>
        {seasonInfo.years.length > 0 && (
          <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
            Season
            <select
              value={season}
              onChange={(e) => setSeason(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 outline-none focus:border-blue-500"
            >
              {seasonInfo.years.map((y) => (
                <option key={y} value={y}>
                  {y} season
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Scroll BOTH ways inside a capped-height box so the header row and the
          area-label column stay pinned (sticky) — no losing the headers at the
          bottom of a tall table. */}
      <div className="max-h-[72vh] overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              {/* Top-left corner cell: sticky on BOTH axes so it never scrolls. */}
              <th className="sticky left-0 top-0 z-30 border-b border-slate-200 bg-white px-3 py-2 text-left" />
              {cols.map((col) => {
                if (col === "total") {
                  return (
                    <th
                      key="total"
                      className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-3 py-2 text-right"
                    >
                      <div className="font-bold text-slate-800">Total</div>
                    </th>
                  );
                }
                // Column dates come from the ACTUAL data for that week (min =
                // start, max = end), so each season's own week anchoring shows
                // correctly.
                const wd = weekDates[Number(col)];
                const start = wd ? new Date(`${wd.min}T00:00:00Z`) : null;
                const end = wd ? new Date(`${wd.max}T00:00:00Z`) : null;
                return (
                  <th
                    key={String(col)}
                    className="sticky top-0 z-20 border-b border-slate-200 bg-white px-3 py-2 text-right"
                  >
                    <div className="font-normal text-slate-500">{start ? fmtDate(start) : ""}</div>
                    <div className="font-normal text-slate-500">{end ? fmtDate(end) : ""}</div>
                    <div className="mt-0.5 font-semibold text-slate-700">
                      {Number(col) === 0 ? "Pre-season" : `Week ${col}`}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {GROUP_ORDER.map((g) => {
              const areas = areasByGroup[g];
              if (areas.length === 0) return null;
              const games = gamesFor(g);
              return (
                <GroupSection
                  key={g}
                  label={GROUP_LABEL[g]}
                  areas={areas}
                  cols={cols}
                  cost={cost}
                  hrs={hrs}
                  subCost={subCost[g]}
                  subHrs={subHrs[g]}
                  games={games}
                  cellCls={cellCls}
                  labelCls={labelCls}
                  totalCol={totalCol}
                  showHours={g !== "os"}
                  showUplift={g !== "os"}
                />
              );
            })}

            {/* GRAND TOTALS — first cell sticky-left with matching dark bg. */}
            <tr className="bg-slate-800 text-white">
              <td className="sticky left-0 z-10 bg-slate-800 px-3 py-2 text-left font-bold">Grand Total Costs</td>
              {cols.map((col) => (
                <td key={String(col)} className={`${cellCls} ${col === "total" ? "bg-slate-900" : ""}`}>
                  {money(grandCost[col] ?? 0)}
                </td>
              ))}
            </tr>
            <tr className="bg-slate-700 text-white">
              <td className="sticky left-0 z-10 bg-slate-700 px-3 py-2 text-left font-bold">Grand Total Hours</td>
              {cols.map((col) => (
                <td key={String(col)} className={`${cellCls} ${col === "total" ? "bg-slate-800" : ""}`}>
                  {hours(grandHrs[col] ?? 0)}
                </td>
              ))}
            </tr>

            {/* CODING PER GAME — Aussie Rules games by location, and pure
                coding (Home + Office Analyst) time/cost per AUS game. */}
            <tr className="bg-sky-600 text-white">
              <td className="sticky left-0 z-10 bg-sky-600 px-3 py-1.5 text-left font-bold uppercase tracking-wide">
                Coding per game
              </td>
              <td colSpan={cols.length} className="bg-sky-600" />
            </tr>
            {[
              { label: "Games", data: aflGames, fmt: (v: number) => String(v), bold: true },
              { label: "AUS Games", data: ausGames, fmt: (v: number) => String(v) },
              { label: "PHL Games", data: phlGames, fmt: (v: number) => String(v) },
              { label: "Pure avg coding time (hrs/game)", data: pureAvgTime, fmt: (v: number) => (v ? v.toFixed(2) : "–") },
              { label: "Pure coding cost per game", data: pureCostPerGame, fmt: (v: number) => money(v), hl: true },
              { label: "Total x15%", data: pureCostPerGame, fmt: (v: number) => money(v * 1.15), mult: true },
            ].map((row) => (
              <tr
                key={row.label}
                className={`border-b border-slate-100 hover:bg-slate-50 ${row.bold ? "font-semibold" : ""} ${row.hl ? "bg-yellow-100 font-semibold" : ""}`}
              >
                <td className={`${labelCls} ${row.hl ? "!bg-yellow-100" : ""}`}>{row.label}</td>
                {cols.map((col) => (
                  <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
                    {row.fmt(row.data[col] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupSection({
  label,
  areas,
  cols,
  cost,
  hrs,
  subCost,
  subHrs,
  games,
  cellCls,
  labelCls,
  totalCol,
  showHours = true,
  showUplift = true,
}: {
  showHours?: boolean;
  showUplift?: boolean;
  label: string;
  areas: string[];
  cols: (string | number)[];
  cost: Record<string, Record<string, number>>;
  hrs: Record<string, Record<string, number>>;
  subCost: Record<string, number>;
  subHrs: Record<string, number>;
  games: Record<string, number> | null;
  cellCls: string;
  labelCls: string;
  totalCol: string;
}) {
  const money = (v: number) =>
    v === 0 ? "–" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const hoursFmt = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <>
      {/* Group banner — label cell sticky-left, rest filled so the colour
          spans the full (scrolled) width. */}
      <tr className="bg-sky-600 text-white">
        <td className="sticky left-0 z-10 bg-sky-600 px-3 py-1.5 text-left font-bold uppercase tracking-wide">
          {label}
        </td>
        <td colSpan={cols.length} className="bg-sky-600" />
      </tr>

      {/* Games (per sport) */}
      {games && (
        <tr className="border-b border-slate-200 font-semibold text-slate-800">
          <td className={labelCls}>Games</td>
          {cols.map((col) => (
            <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
              {games[col] ?? 0}
            </td>
          ))}
        </tr>
      )}

      {/* Costs */}
      <tr className="bg-sky-50">
        <td className="sticky left-0 z-10 bg-sky-50 px-3 py-1 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
          Costs
        </td>
        <td colSpan={cols.length} className="bg-sky-50" />
      </tr>
      {areas.map((area) => (
        <tr key={`c-${area}`} className="border-b border-slate-100 hover:bg-slate-50">
          <td className={labelCls}>{area}</td>
          {cols.map((col) => (
            <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
              {money(cost[area]?.[col] ?? 0)}
            </td>
          ))}
        </tr>
      ))}
      <tr className="border-y border-slate-300 font-semibold text-slate-900">
        <td className={labelCls}>{label} — Total Costs</td>
        {cols.map((col) => (
          <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
            {money(subCost[col] ?? 0)}
          </td>
        ))}
      </tr>
      {showUplift && (
        <tr className="border-b-2 border-slate-300 font-semibold text-slate-700">
          <td className={labelCls}>{label} — Costs (15%)</td>
          {cols.map((col) => (
            <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
              {money((subCost[col] ?? 0) * 1.15)}
            </td>
          ))}
        </tr>
      )}

      {/* Hours */}
      {showHours && (<>
      <tr className="bg-sky-50">
        <td className="sticky left-0 z-10 bg-sky-50 px-3 py-1 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
          Hours
        </td>
        <td colSpan={cols.length} className="bg-sky-50" />
      </tr>
      {areas.map((area) => (
        <tr key={`h-${area}`} className="border-b border-slate-100 hover:bg-slate-50">
          <td className={labelCls}>{area}</td>
          {cols.map((col) => (
            <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
              {hoursFmt(hrs[area]?.[col] ?? 0)}
            </td>
          ))}
        </tr>
      ))}
      <tr className="border-y border-slate-300 font-semibold text-slate-900">
        <td className={labelCls}>{label} — Total Hours</td>
        {cols.map((col) => (
          <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
            {hoursFmt(subHrs[col] ?? 0)}
          </td>
        ))}
      </tr>
      </>)}
    </>
  );
}
