"use client";

import { useMemo, useState } from "react";
import { buildWeekRanges, weekOptionLabel } from "@/lib/analytics/weekLabels";
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

// -------------------------
// THEME
// -------------------------
const THEME = {
  bg: "#0b1220",
  panel: "#0f1b2d",
  panelSoft: "#111f35",
  border: "rgba(148,163,184,0.15)",
  text: "#e5e7eb",
  muted: "#94a3b8",
  accent: "#38bdf8",
  success: "#22c55e",
  warn: "#f59e0b",
  danger: "#ef4444",
};

// -------------------------
// HELPERS
// -------------------------
const norm = (v: any) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

const title = (v: string) =>
  (v || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

// -------------------------
// GLOW BAR SHAPE
// -------------------------
const GlowBar = (props: any) => {
  const { x, y, width, height, fill, isActive } = props;

  return (
    <g>
      {/* base bar */}
      <rect x={x} y={y} width={width} height={height} fill={fill} rx={6} />

      {/* glow overlay */}
      {isActive && (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill={fill}
          rx={6}
          filter="url(#glow)"
          opacity={0.9}
        />
      )}
    </g>
  );
};

export default function TTGames({ data }: { data: any[] }) {
  const [week, setWeek] = useState("all");
  const [month, setMonth] = useState("all");
  const [analyst, setAnalyst] = useState("all");

  // -------------------------
  // NORMALISE ROWS
  // -------------------------
  const rows = useMemo(() => {
    return (data ?? []).map((r) => ({
      week: String(r.week ?? r.Week ?? "").trim(),
      date: r.Date,
      season: r.season,
      month: norm(r.column11 ?? r.Column11),
      home: norm(r.home_allocated),
      away: norm(r.away_allocated),
      location: norm(r.location ?? r.Location),
    }));
  }, [data]);

  // -------------------------
  // FILTER OPTIONS
  // -------------------------
  const weeks = useMemo(() => {
    const set = new Set(rows.map((r) => r.week).filter(Boolean));
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, [rows]);

  const weekRanges = useMemo(() => buildWeekRanges(rows), [rows]);

  const MONTH_ORDER = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december",
  ];

  const months = useMemo(() => {
    const set = new Set(rows.map((r) => r.month));
    return Array.from(set).sort(
      (a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b)
    );
  }, [rows]);

  // -------------------------
  // FILTERED DATA
  // -------------------------
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const matchWeek = week === "all" || r.week === week;
      const matchMonth = month === "all" || r.month === norm(month);
      const matchAnalyst =
        analyst === "all" || r.home === analyst || r.away === analyst;

      return matchWeek && matchMonth && matchAnalyst;
    });
  }, [rows, week, month, analyst]);

  // -------------------------
  // CHART DATA
  // -------------------------
  const chartData = useMemo(() => {
    const map = new Map<string, any>();

    filtered.forEach((r) => {
      const weekKey = r.week || "Unknown";
      const gameKey = `${r.home}-${r.away}-${r.location}`;

      const existing =
        map.get(weekKey) ?? {
          week: weekKey,
          AUS: 0,
          PHL: 0,
          Mixed: 0,
          gamesSet: new Set<string>(),
        };

      existing.gamesSet.add(gameKey);

      const isAus = r.location.includes("aus");
      const isPhl = r.location.includes("phl");

      if (isAus && isPhl) existing.Mixed++;
      else if (isAus) existing.AUS++;
      else if (isPhl) existing.PHL++;

      map.set(weekKey, existing);
    });

    return Array.from(map.values())
      .map((w) => ({
        week: w.week,
        AUS: w.AUS,
        PHL: w.PHL,
        Mixed: w.Mixed,
        games: w.gamesSet.size,
      }))
      .sort((a, b) => Number(a.week) - Number(b.week));
  }, [filtered]);

  // -------------------------
  // SUMMARY
  // -------------------------
  const summary = useMemo(() => {
    return chartData.reduce(
      (acc, w) => {
        acc.AUS += w.AUS;
        acc.PHL += w.PHL;
        acc.Mixed += w.Mixed;
        acc.games += w.AUS + w.PHL + w.Mixed;
        return acc;
      },
      { AUS: 0, PHL: 0, Mixed: 0, games: 0 }
    );
  }, [chartData]);

  // -------------------------
  // TOOLTIP
  // -------------------------
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active) return null;

    return (
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.border}`,
          color: THEME.text,
        }}
        className="p-3 rounded-lg text-sm"
      >
        <div className="font-semibold mb-1">Week {label}</div>
        {payload?.map((p: any) => (
          <div key={p.name} style={{ color: THEME.muted }}>
            {p.name}: <b style={{ color: THEME.text }}>{p.value}</b>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ background: THEME.bg, color: THEME.text }} className="p-6 rounded-2xl space-y-5">

      {/* -------------------------
          GLOW FILTER + GRADIENTS
      ------------------------- */}
      <svg width="0" height="0">
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <linearGradient id="gradAUS" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4ade80" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#16a34a" stopOpacity={0.85} />
          </linearGradient>

          <linearGradient id="gradPHL" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#d97706" stopOpacity={0.85} />
          </linearGradient>

          <linearGradient id="gradMixed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.85} />
          </linearGradient>
        </defs>
      </svg>

      {/* HEADER */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-xl font-semibold">TT Games</h2>
          <p style={{ color: THEME.muted }} className="text-sm">
            Weekly allocation breakdown by region
          </p>
        </div>

        <div
          style={{
            background: THEME.panel,
            border: `1px solid ${THEME.border}`,
          }}
          className="text-xs px-3 py-1 rounded-full"
        >
          Total: {summary.games}
        </div>
      </div>

      {/* FILTERS */}
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.border}`,
        }}
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
              {weekOptionLabel(`Week ${w}`, weekRanges.get(w))}
            </option>
          ))}
        </select>

        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ background: THEME.panelSoft, color: THEME.text }}
          className="border px-3 py-2 text-sm rounded-lg"
        >
          <option value="all">All Months</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {title(m)}
            </option>
          ))}
        </select>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }} className="p-4 rounded-xl">
          Total: {summary.games}
        </div>
        <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}`, color: THEME.success }} className="p-4 rounded-xl">
          AUS: {summary.AUS}
        </div>
        <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}`, color: THEME.warn }} className="p-4 rounded-xl">
          PHL: {summary.PHL}
        </div>
        <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}`, color: THEME.accent }} className="p-4 rounded-xl">
          Mixed: {summary.Mixed}
        </div>
      </div>

      {/* CHART */}
      <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}` }} className="p-4 rounded-2xl">

        <div className="mb-3">
          <h3 className="text-sm font-semibold">Weekly Allocation Trend</h3>
          <p style={{ color: THEME.muted }} className="text-xs">
            Stacked view with hover glow interaction
          </p>
        </div>

        <div className="h-[380px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barCategoryGap={20}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
              <XAxis dataKey="week" tick={{ fill: THEME.muted, fontSize:17 }} />
              <YAxis tick={{ fill: THEME.muted, fontSize: 17 }} />
              <Tooltip content={<CustomTooltip />} />
              <Legend />

              <Bar dataKey="AUS" stackId="a" fill="url(#gradAUS)" shape={<GlowBar />} />
              <Bar dataKey="PHL" stackId="a" fill="url(#gradPHL)" shape={<GlowBar />} />
              <Bar dataKey="Mixed" stackId="a" fill="url(#gradMixed)" shape={<GlowBar />} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}