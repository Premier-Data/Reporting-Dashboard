"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

// -------------------------
// THEME
// -------------------------
const THEME = {
  panel: "#0f1b2d",
  panelSoft: "#111f35",
  border: "rgba(148,163,184,0.15)",
  text: "#e5e7eb",
  muted: "#94a3b8",
  accent: "#38bdf8",
  success: "#22c55e",
  danger: "#ef4444",
};

// -------------------------
// NORMALISER
// -------------------------
const norm = (v: any) =>
  String(v ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

import type { DeputyShift } from "@/types/deputy";
import type { TTGame } from "@/types/ttgame";

type Props = {
  deputyData: DeputyShift[];
  ttData: TTGame[];
  analystName: string;
}

export default function AverageCodingTimeTrend({
  deputyData,
  ttData,
  analystName,
}: Props) {

  const selected = norm(analystName);
  const SLA = 7;

  // -------------------------
  // BUILD WEEKLY DATA (CORRECT SOURCE)
  // -------------------------
  const chartData = useMemo(() => {
    const weeks = new Map<
      string,
      { week: string; hours: number; games: number }
    >();

    // -------------------------
    // HOURS (ONLY SHIFT DATA)
    // -------------------------
    for (const r of deputyData ?? []) {
      const area = norm(r.area ?? r.area_name);
      const employee = norm(r.employee_name);

      const isValidArea =
        area.includes("home analyst") ||
        area.includes("office analyst");

      if (!isValidArea) continue;
      if (selected !== "all" && employee !== selected) continue;

      const week = String(r.week ?? "").trim();
      if (!week) continue;

      const existing = weeks.get(week) ?? {
        week,
        hours: 0,
        games: 0,
      };
      existing.hours += Number(r.total_hours ?? 0);
      weeks.set(week, existing);
    }

    // -------------------------
    // GAMES (ONLY TT DATA)
    // -------------------------
    for (const r of ttData ?? []) {
      const week = String(r.Week ?? "").trim();
      if (!week) continue;

      const home = norm(r.home_allocated);
      const away = norm(r.away_allocated);

      let games = 0;
      if (home === selected) games += 0.5;
      if (away === selected) games += 0.5;

      if (games === 0) continue;

      const existing = weeks.get(week) ?? {
        week,
        hours: 0,
        games: 0,
      };

      existing.games += games;
      weeks.set(week, existing);
    }

    return Array.from(weeks.values())
      .sort((a, b) => Number(a.week) - Number(b.week))
      .map((w) => ({
        week: w.week,
        hours: Number(w.hours.toFixed(2)),
        games: Number(w.games.toFixed(2)),
        avg: w.games ? w.hours / w.games : 0,
      }));
  }, [deputyData, ttData, selected]);

  // -------------------------
  // OVERALL AVG (CONSISTENT)
  // -------------------------
  const analystAvg = useMemo(() => {
    const hours = chartData.reduce((s, w) => s + w.hours, 0);
    const games = chartData.reduce((s, w) => s + w.games, 0);
    return games ? hours / games : 0;
  }, [chartData]);

  // -------------------------
  // TOOLTIP (USES WEEK ONLY)
  // -------------------------
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;

    console.log("👉 TOOLTIP LABEL:", label);
    console.log("👉 SAMPLE SHIFT ROW:", deputyData?.[0]);

    const d = payload[0].payload;

    return (
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.border}`,
          padding: 12,
          borderRadius: 10,
          color: THEME.text,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          Week {label}
        </div>

        <div>
          Hours: <b>{d.hours.toFixed(2)}</b>
        </div>

        <div>
          Games: <b>{d.games.toFixed(2)}</b>
        </div>

        <div>
          Avg:
          <b
            style={{
              color: d.avg <= SLA ? THEME.success : THEME.danger,
              marginLeft: 4,
            }}
          >
            {d.avg.toFixed(2)} hrs/game
          </b>
        </div>
      </div>
    );
  };

  // -------------------------
  // RENDER
  // -------------------------
  return (
    <div className="h-full w-full flex flex-col min-h-0">
      {/* HEADER */}
      <div
        style={{
          display: "inline-block",
          padding: "8px 12px",
          borderRadius: 10,
          background: THEME.panelSoft,
          border: `1px solid ${THEME.border}`,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 11, color: THEME.muted }}>
          Overall Average
        </div>

        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: analystAvg <= SLA ? THEME.success : THEME.danger,
          }}
        >
          {analystAvg.toFixed(2)} hrs/game
        </div>
      </div>

      {/* CHART */}
      <div className="flex-1 h-full min-h-0 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid stroke={THEME.border} />
            <XAxis dataKey="week" stroke={THEME.muted} />
            <YAxis stroke={THEME.muted} />

            <Tooltip content={<CustomTooltip />} />

            <ReferenceLine
              y={SLA}
              stroke={THEME.danger}
              strokeDasharray="4 4"
            />

            <Line
              type="monotone"
              dataKey="avg"
              stroke={THEME.accent}
              strokeWidth={3}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}