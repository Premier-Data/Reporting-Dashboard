"use client";

// Weekly Report — a per-week matrix (built by lib/analytics/weeklyReportBuild.ts) of costs and hours by area, grouped into
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
import {
  mapFixtureWeekSoccer,
  mapFixtureWeekTT,
  seasonOfDate,
  seasonsFromDates,
  seasonWeekRange,
  unionSeasons,
} from "@/lib/analytics/season";
import { buildWeeklyReport, GROUP_ORDER, type Group } from "@/lib/analytics/weeklyReportBuild";
import { supabase } from "@/lib/supabase";
import type { SummaryWeek } from "@/lib/exports/weeklySummaryExcel";
import { getDeputyShiftAggregates } from "@/lib/api/deputyShifts";
import DeputyLoadError from "@/components/DeputyLoadError";

type Row = Record<string, unknown>;

// Whole dollars, rounded UP to the nearest dollar.
const money = (v: number) =>
  v === 0
    ? "–"
    : `$${Math.ceil(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
// Whole hours (rounded to nearest).
const hours = (v: number) =>
  Math.round(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });

const GROUP_LABEL: Record<Group, string> = {
  aussie: "Aussie Rules",
  soccer: "Soccer",
  os: "OS Team",
  other: "Other",
};

export default function WeeklyReport({
  ttData,
}: {
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
          .order("game_key", { ascending: true })
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

  // Deputy shift rows: ONLY from the Deputy API (name-free view) via the shared
  // data layer, lib/api/deputyShifts.ts. There is no fallback to any other source; a failure shows
  // an error state with a retry.
  const [shiftRows, setShiftRows] = useState<Row[]>([]);
  const [shiftState, setShiftState] = useState<"loading" | "ok" | "error">("loading");
  const [shiftError, setShiftError] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setShiftState("loading");
    (async () => {
      try {
        const rows = await getDeputyShiftAggregates({ force: reloadKey > 0 });
        if (cancelled) return;
        setShiftRows(rows as unknown as Row[]);
        setShiftState("ok");
      } catch (e) {
        if (cancelled) return;
        setShiftError(e instanceof Error ? e.message : String(e));
        setShiftState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
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

  // Games rows: derive season/week from Date (same rule as Deputy).
  const ttRows = useMemo(() => mapFixtureWeekTT(ttData), [ttData]);
  const soccerRows = useMemo(() => mapFixtureWeekSoccer(soccerGames), [soccerGames]);

  // Season list = union of every source, newest first. The picked season is
  // kept apart from the default so a user choice is never overridden when the
  // union grows after the shifts load.
  const seasonYears = useMemo(
    () =>
      unionSeasons(
        seasonsFromDates(shiftRows, "shift_date"),
        seasonsFromDates(ttRows, "Date"),
        seasonsFromDates(soccerRows, "Date")
      ),
    [shiftRows, ttRows, soccerRows]
  );
  const [picked, setPicked] = useState<number | null>(null);
  const season = picked ?? seasonYears[0] ?? seasonOfDate(new Date());
  const [view, setView] = useState<"week" | "month">("week");

  const report = useMemo(
    () => buildWeeklyReport({ season, monthly: view === "month", shifts: shiftRows, tt: ttRows, soccer: soccerRows, osTeam }),
    [shiftRows, ttRows, soccerRows, osTeam, season, view]
  );
  // Weekly form for the Excel export (reuses `report` when already weekly).
  const altWeekly = useMemo(
    () =>
      view === "week"
        ? null
        : buildWeeklyReport({ season, monthly: false, shifts: shiftRows, tt: ttRows, soccer: soccerRows, osTeam }),
    [shiftRows, ttRows, soccerRows, osTeam, season, view]
  );
  const weeklyReport = view === "week" ? report : altWeekly!;

  const exportWeeks = () => {
    // Last 4 weeks that have data.
    const w = weeklyReport;
    const last = (w.weeks as number[]).slice(-4);
    const DAY_MS = 86400000;
    const weeksOut: SummaryWeek[] = last.map((wk) => {
      const startMs = seasonWeekRange(season, wk).start.getTime();
      return {
        week: wk,
        start: new Date(startMs),
        end: new Date(startMs + 6 * DAY_MS),
        footyGames: w.aflGames[wk] ?? 0,
        soccerGames: w.socGames[wk] ?? 0,
        footyAus: w.footyCred.AUS[wk] ?? 0,
        footyPhl: w.footyCred.PHL[wk] ?? 0,
        soccerAus: w.socCred.AUS[wk] ?? 0,
        soccerPhl: w.socCred.PHL[wk] ?? 0,
        soccerVn: w.socCred.VN[wk] ?? 0,
        // AUS (Deputy) costs carry the 15% entitlements uplift; OS costs don't.
        footyCost: (w.subCost.aussie[wk] ?? 0) * 1.15,
        soccerCost: (w.subCost.soccer[wk] ?? 0) * 1.15,
        phlCost: w.phlCost[wk] ?? 0,
        vnCost: w.vnCost[wk] ?? 0,
      };
    });
    void import("@/lib/exports/weeklySummaryExcel").then((m) => m.exportWeeklySummary(weeksOut, season));
  };

  if (shiftState === "error") {
    return (
      <div style={{ marginTop: 20 }}>
        <DeputyLoadError message={shiftError} onRetry={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }
  if (shiftState === "loading") {
    return (
      <div style={{ marginTop: 20 }} className="text-sm text-slate-500">
        Loading Deputy data...
      </div>
    );
  }

  const { weeks, weekDates, areasByGroup, cost, hrs, aflGames, socGames, subCost, subHrs, grandCost, grandHrs, ausGames, phlGames, pureAvgTime, pureCostPerGame, phlCostPerGame, totalCodingCostPerGame, totalBlendedCostPerGame, socAvgTime, socCostPerGame } = report;
  const cols: (string | number)[] = ["total", ...weeks];

  const cellCls = "border-b border-slate-100 px-3 py-1.5 text-right tabular-nums whitespace-nowrap";
  // First column (area/row labels) is sticky-left so it stays visible when
  // scrolling the week columns horizontally. Needs an opaque bg to cover cells
  // sliding under it.
  // Label column has a fixed 320px width so the Total column can stick right
  // beside it (left-[320px]) and both stay put while scrolling across weeks.
  const labelCls = "sticky left-0 z-10 w-[320px] min-w-[320px] max-w-[320px] border-b border-slate-100 bg-white px-3 py-1.5 text-left whitespace-nowrap";
  const totalCol = "sticky left-[320px] z-10 bg-slate-50 font-semibold border-r border-slate-200";

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
          <p className="text-[11px] text-slate-400">
            Source: Deputy API
          </p>
        </div>
        <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={exportWeeks}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          Export last 4 weeks (Excel)
        </button>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
          View
          <select
            value={view}
            onChange={(e) => setView(e.target.value as "week" | "month")}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 outline-none focus:border-blue-500"
          >
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </label>
        {seasonYears.length > 0 && (
          <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
            Season
            <select
              value={season}
              onChange={(e) => setPicked(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 outline-none focus:border-blue-500"
            >
              {seasonYears.map((y) => (
                <option key={y} value={y}>
                  {y} season
                </option>
              ))}
            </select>
          </label>
        )}
        </div>
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
                      className="sticky left-[320px] top-0 z-30 border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-right"
                    >
                      <div className="font-bold text-slate-800">Total</div>
                    </th>
                  );
                }
                // Column dates come from the ACTUAL data for that week (min =
                // start, max = end), so each season's own week anchoring shows
                // correctly.
                if (view === "month") {
                  const [yy, mm] = String(col).split("-");
                  const label = new Date(Date.UTC(Number(yy), Number(mm) - 1, 1)).toLocaleDateString("en-AU", {
                    month: "short",
                    year: "numeric",
                    timeZone: "UTC",
                  });
                  return (
                    <th
                      key={String(col)}
                      className="sticky top-0 z-20 border-b border-slate-200 bg-white px-3 py-2 text-right"
                    >
                      <div className="font-semibold text-slate-700">{label}</div>
                    </th>
                  );
                }
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
                      {`Week ${col}`}
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
              <td className="sticky left-0 z-10 w-[320px] min-w-[320px] max-w-[320px] bg-slate-800 px-3 py-2 text-left font-bold">Grand Total Costs</td>
              {cols.map((col) => (
                <td key={String(col)} className={`${cellCls} ${col === "total" ? "sticky left-[320px] z-10 bg-slate-900" : ""}`}>
                  {money(grandCost[col] ?? 0)}
                </td>
              ))}
            </tr>
            <tr className="bg-slate-700 text-white">
              <td className="sticky left-0 z-10 bg-slate-700 px-3 py-2 text-left font-bold">Grand Total Hours</td>
              {cols.map((col) => (
                <td key={String(col)} className={`${cellCls} ${col === "total" ? "sticky left-[320px] z-10 bg-slate-800" : ""}`}>
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
            {([
              { label: "Aussie Rules", section: true },
              { label: "Aussie Rules Games", data: aflGames, fmt: (v: number) => String(v), bold: true },
              { label: "AUS Games", data: ausGames, fmt: (v: number) => String(v) },
              { label: "PHL Games", data: phlGames, fmt: (v: number) => String(v) },
              { label: "Pure avg coding time (hrs/game)", data: pureAvgTime, fmt: (v: number) => (v ? v.toFixed(2) : "–") },
              { label: "AUS pure coding cost per game", data: pureCostPerGame, fmt: (v: number) => money(v), hl: true },
              { label: "PHL cost per game", data: phlCostPerGame, fmt: (v: number) => money(v), hl: true },
              { label: "Total AUS Coding cost per game (incl. 15%)", data: totalCodingCostPerGame, fmt: (v: number) => money(v), hl: true },
              { label: "Total blended cost per game (AUS + PHL games)", data: totalBlendedCostPerGame, fmt: (v: number) => money(v), hl: true },
              { label: "Soccer", section: true },
              { label: "Soccer Games", data: socGames, fmt: (v: number) => String(v), bold: true },
              { label: "Soccer avg time (hrs/game)", data: socAvgTime, fmt: (v: number) => (v ? v.toFixed(2) : "–") },
              { label: "Soccer cost per game (VN)", data: socCostPerGame, fmt: (v: number) => money(v), hl: true },
            ] as {
              label: string;
              section?: boolean;
              data?: Record<string, number>;
              fmt?: (v: number) => string;
              bold?: boolean;
              hl?: boolean;
            }[]).map((row) =>
              row.section ? (
                <tr key={row.label} className="bg-sky-50">
                  <td className="sticky left-0 z-10 bg-sky-50 px-3 py-1 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    {row.label}
                  </td>
                  <td colSpan={cols.length} className="bg-sky-50" />
                </tr>
              ) : (
                <tr
                  key={row.label}
                  className={`border-b border-slate-100 hover:bg-slate-50 ${row.bold ? "font-semibold" : ""} ${row.hl ? "bg-yellow-100 font-semibold" : ""}`}
                >
                  <td className={`${labelCls} ${row.hl ? "!bg-yellow-100" : ""}`}>{row.label}</td>
                  {cols.map((col) => (
                    <td key={String(col)} className={`${cellCls} ${col === "total" ? totalCol : ""}`}>
                      {row.fmt!(row.data![col] ?? 0)}
                    </td>
                  ))}
                </tr>
              )
            )}
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
    v === 0 ? "–" : `$${Math.ceil(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const hoursFmt = (v: number) =>
    Math.round(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

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
