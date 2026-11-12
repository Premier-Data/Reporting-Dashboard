"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";

// -------------------------
// THEME
// -------------------------
const THEME = {
  border: "rgba(148,163,184,0.15)",
  muted: "#94a3b8",
  text: "#e5e7eb",
  success: "#22c55e",
  danger: "#ef4444",
  panelSoft: "#111f35",
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

// -------------------------
// TYPES
// -------------------------
import { weekBucket, withWeekLabels } from "@/lib/analytics/gameWeekIndex";
import type { TTGame } from "@/types/ttgame";

type Props = {
  data: TTGame[];
  analystName: string;
}

// -------------------------
// COMPONENT
// -------------------------
export default function GamesCompletedTrend({
  data,
  analystName = "all",
}: Props) {
  const selected = norm(analystName);
  const isAll = analystName === "all";

  // -------------------------
  // BUILD DATA
  // -------------------------
  const chartData = useMemo(() => {
    const weeks = new Map<
      string,
      { idx: number; season: number; week: number; Games: number }
    >();

    (data ?? []).forEach((r) => {
      const b = weekBucket(r);
      if (!b) return;

      const match = isAll
        ? true
        : norm(r.home_allocated) === selected ||
        norm(r.away_allocated) === selected;

      if (!match) return;

      const existing =
        weeks.get(b.key) ??
        { idx: b.idx, season: b.season, week: b.week, Games: 0 };

      let credit = 0;

      if (isAll) {
        credit = 1;
      } else {
        if (norm(r.home_allocated) === selected) credit += 1;
        if (norm(r.away_allocated) === selected) credit += 1;
        credit = credit / 2;
      }

      existing.Games += credit;
      weeks.set(b.key, existing);
    });

    return withWeekLabels(
      Array.from(weeks.values()).sort((a, b) => a.idx - b.idx)
    ).map((w) => ({
      week: w.label,
      Games: Number(w.Games.toFixed(2)),
    }));
  }, [data, selected, isAll]);

  // -------------------------
  // OVERALL AVERAGE
  // -------------------------
  const overallAvg = useMemo(() => {
    if (!chartData.length) return 0;

    const total = chartData.reduce((sum, w) => sum + w.Games, 0);
    return total / chartData.length;
  }, [chartData]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;

    return (
      <div
        style={{
          background: "#0f1b2d",
          border: "1px solid rgba(148,163,184,0.2)",
          borderRadius: 12,
          padding: "10px 12px",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>
          {label}
        </div>

        <div
          style={{
            color: "#e5e7eb",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {payload[0].value} Games
        </div>
      </div>
    );
  };
  // -------------------------
  // UI
  // -------------------------
  return (
    <div className="h-full w-full flex flex-col min-h-0">

      {/* TOP STATS */}
      <div className="mb-3">
        <div
          style={{
            display: "inline-block",
            padding: "10px 14px",
            borderRadius: 10,
            background: THEME.panelSoft,
            border: `1px solid ${THEME.border}`,
          }}
        >
          <div style={{ fontSize: 12, color: THEME.muted }}>
            Overall Avg Games / Week
          </div>

          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: overallAvg >= 3 ? THEME.success : THEME.danger,
            }}
          >
            {overallAvg.toFixed(2)}
          </div>
        </div>
      </div>

      {/* CHART */}
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={THEME.border} />

            <XAxis dataKey="week" stroke={THEME.muted} />
            <YAxis stroke={THEME.muted} />

            <Tooltip content={<CustomTooltip />} />

            <Bar dataKey="Games" radius={[6, 6, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={
                    entry.Games >= 3
                      ? THEME.success
                      : THEME.danger
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

    </div>
  );
}