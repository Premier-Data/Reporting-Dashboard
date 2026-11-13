"use client";

// Soccer games — weekly games tracker shown as a sub-tab of the TT Games tab.
// Source: soccer_games (SoccerData sheet). Kept entirely separate from the
// Aussie Rules TT_Games view.
//
// Weeks are bucketed by game DATE using the unified Wed->Tue season rule
// (lib/analytics/season.ts): season N Week 1 starts on the Wednesday on/before
// 1 Oct of year N-1. The stored soccer_games season/week are only a fallback.
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { supabase } from "@/lib/supabase";
import { soccerSeasonFor, soccerWeekFor } from "@/lib/analytics/soccerWeeks";
import { buildWeekRanges, weekOptionLabel } from "@/lib/analytics/weekLabels";

type Row = Record<string, unknown>;

const THEME = {
  bg: "#0b1220",
  panel: "#0f1b2d",
  panelSoft: "#111f35",
  border: "rgba(148,163,184,0.15)",
  text: "#e5e7eb",
  muted: "#94a3b8",
};
const PALETTE = ["#38bdf8", "#22c55e", "#f59e0b", "#a78bfa", "#ef4444", "#14b8a6"];

export default function SoccerGames({
  season,
}: {
  /** "all" or a season year, e.g. "2027". */
  season: string;
}) {
  const [games, setGames] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [week, setWeek] = useState("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let all: Row[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("soccer_games")
          .select("season,week,Date,Location,Competition")
          .order("game_key", { ascending: true })
          .range(from, from + 999);
        if (error || !data || data.length === 0) break;
        all = all.concat(data as Row[]);
        if (data.length < 1000) break;
        from += 1000;
      }
      if (!cancelled) {
        setGames(all);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const seasonRows = useMemo(
    () => games.filter((r) => season === "all" || String(soccerSeasonFor(r)) === season),
    [games, season]
  );

  const rows = useMemo(
    () =>
      seasonRows
        .map((r) => ({
          week: soccerWeekFor(r),
          date: r.Date,
          season: soccerSeasonFor(r),
          loc: String(r.Location ?? "").trim().toUpperCase() || "Unknown",
        }))
        .filter((r) => r.week != null) as { week: number; loc: string }[],
    [seasonRows]
  );

  const weeks = useMemo(
    () => [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b),
    [rows]
  );
  const weekRanges = useMemo(() => buildWeekRanges(rows), [rows]);
  const locations = useMemo(() => [...new Set(rows.map((r) => r.loc))].sort(), [rows]);

  // Reset an out-of-range week when the season changes.
  useEffect(() => {
    if (week !== "all" && !weeks.includes(Number(week))) setWeek("all");
  }, [weeks, week]);

  const filtered = useMemo(
    () => rows.filter((r) => week === "all" || r.week === Number(week)),
    [rows, week]
  );

  const chartData = useMemo(() => {
    const map = new Map<number, Record<string, number>>();
    for (const r of filtered) {
      const e = map.get(r.week) ?? { week: r.week };
      e[r.loc] = (e[r.loc] ?? 0) + 1;
      map.set(r.week, e);
    }
    return [...map.values()].sort((a, b) => a.week - b.week);
  }, [filtered]);

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of filtered) t[r.loc] = (t[r.loc] ?? 0) + 1;
    return t;
  }, [filtered]);

  const colour = (loc: string) => PALETTE[locations.indexOf(loc) % PALETTE.length];
  const weekLabel = (w: number) => `Week ${w}`;

  return (
    <div style={{ background: THEME.bg, color: THEME.text }} className="p-6 rounded-2xl space-y-5">
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-xl font-semibold">Soccer Games</h2>
          <p style={{ color: THEME.muted }} className="text-sm">
            Weekly games by location (separate from Aussie Rules)
          </p>
        </div>
        <div
          style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }}
          className="text-xs px-3 py-1 rounded-full"
        >
          Total: {filtered.length}
        </div>
      </div>

      <div
        style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }}
        className="flex gap-2 p-3 rounded-xl"
      >
        <select
          value={week}
          onChange={(e) => setWeek(e.target.value)}
          style={{ background: THEME.panelSoft, color: THEME.text }}
          className="border px-3 py-2 text-sm rounded-lg"
        >
          <option value="all">All Weeks</option>
          {weeks.map((w) => (
            <option key={w} value={w}>
              {weekOptionLabel(weekLabel(w), weekRanges.get(String(w)))}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div style={{ color: THEME.muted }} className="text-sm">Loading soccer games…</div>
      ) : (
        <>
          {filtered.length === 0 && (
            <div style={{ color: THEME.muted }} className="text-sm">
              No soccer games for this season
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }} className="p-4 rounded-xl">
              Total: {filtered.length}
            </div>
            {locations.map((l) => (
              <div
                key={l}
                style={{ background: THEME.panel, border: `1px solid ${THEME.border}`, color: colour(l) }}
                className="p-4 rounded-xl"
              >
                {l}: {totals[l] ?? 0}
              </div>
            ))}
          </div>

          <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }} className="p-4 rounded-2xl">
            <div className="mb-3">
              <h3 className="text-sm font-semibold">Weekly Games Trend</h3>
              <p style={{ color: THEME.muted }} className="text-xs">Games per week, stacked by location</p>
            </div>
            <div className="h-[380px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barCategoryGap={20}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                  <XAxis dataKey="week" tick={{ fill: THEME.muted, fontSize: 14 }} />
                  <YAxis tick={{ fill: THEME.muted, fontSize: 14 }} />
                  <Tooltip
                    contentStyle={{ background: THEME.panel, border: `1px solid ${THEME.border}`, color: THEME.text }}
                    labelFormatter={(w) => weekLabel(Number(w))}
                  />
                  <Legend />
                  {locations.map((l) => (
                    <Bar key={l} dataKey={l} stackId="a" fill={colour(l)} radius={[4, 4, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div
            style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }}
            className="p-4 rounded-2xl overflow-auto max-h-[360px]"
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: THEME.muted }} className="text-left">
                  <th className="py-1 pr-4">Week</th>
                  {locations.map((l) => (
                    <th key={l} className="py-1 pr-4 text-right">{l}</th>
                  ))}
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((r) => (
                  <tr key={r.week} style={{ borderTop: `1px solid ${THEME.border}` }}>
                    <td className="py-1 pr-4">{weekLabel(r.week)}</td>
                    {locations.map((l) => (
                      <td key={l} className="py-1 pr-4 text-right tabular-nums">{r[l] ?? 0}</td>
                    ))}
                    <td className="py-1 text-right font-semibold tabular-nums">
                      {locations.reduce((s, l) => s + (r[l] ?? 0), 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
