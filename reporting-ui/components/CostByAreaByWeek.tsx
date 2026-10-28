"use client";

import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  Line,
} from "recharts";

// -------------------------
// THEME
// -------------------------
const THEME = {
  bg: "#ffffff",
  grid: "rgba(15, 23, 42, 0.06)",
  text: "#0B2E4F",
  subtext: "#64748B",
  border: "#E6EEF5",
  primary: "#1F6FEB",
  line: "#0F172A",
};

const COLORS = [
  "#1F6FEB",
  "#0EA5E9",
  "#22C55E",
  "#F59E0B",
  "#EF4444",
  "#A855F7",
];

// -------------------------
// FORMAT
// -------------------------
const formatMoney = (v: any) =>
  `$${Number(v || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;

// -------------------------
// WEEK HELPERS
// -------------------------
// Use the AUTHORITATIVE week + season columns from the data (set by the sync),
// NOT a synthetic "weeks since a base date" count. The old approach counted
// weeks from a hardcoded 18 Mar 2026, which is why 30 Sep showed as W28 instead
// of the sheet's W1. Weeks restart each season, so (season, week) is the key.
const dmy = (d: Date) =>
  d.toLocaleDateString("en-AU", { day: "2-digit", month: "short" });

function getMonthLabel(date: Date) {
  return date.toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
  });
}

// -------------------------
// TOOLTIP
// -------------------------
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  const total = payload.find((p: any) => p.dataKey === "total");

  return (
    <div
      style={{
        background: "#0B2E4F",
        color: "#fff",
        padding: "12px 14px",
        borderRadius: 12,
        fontSize: 12,
        minWidth: 180,
        boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      }}
    >
      <div style={{ marginBottom: 8, opacity: 0.8 }}>{label}</div>

{payload
  .filter((p: any) => p.dataKey !== "total")
  .sort((a: any, b: any) =>
    a.dataKey.localeCompare(b.dataKey)
  )
  .map((p: any, i: number) => (
    <div
      key={i}
      style={{
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <span style={{ opacity: 0.75 }}>{p.dataKey}</span>
      <span style={{ fontWeight: 600 }}>
        {formatMoney(p.value)}
      </span>
    </div>
))}

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: "1px solid rgba(255,255,255,0.15)",
          display: "flex",
          justifyContent: "space-between",
          fontWeight: 700,
        }}
      >
        <span>Total</span>
        <span>{formatMoney(total?.value || 0)}</span>
      </div>
    </div>
  );
}

// -------------------------
// MAIN COMPONENT
// -------------------------
export default function CostByAreaByWeek({
  data,
}: {
  data: any[];
}) {
  const [view, setView] = useState<"day" | "week" | "month">("week");

  const { chartData, areas } = useMemo(() => {
    const groupedMap: Record<string, any> = {};
    // Per week-label ordering + date range, keyed by label.
    const weekMeta: Record<string, { season: number; week: number; min: string; max: string }> = {};
    // Per day-label -> ISO date, for chronological day sorting.
    const dayMeta: Record<string, string> = {};

    data.forEach((row) => {
      const iso = row.shift_date ? String(row.shift_date).slice(0, 10) : null;
      const date = iso ? new Date(`${iso}T00:00:00`) : null;
      if (!date || Number.isNaN(date.getTime())) return;

      const area = row.area_name || "Unknown";

      let label: string;
      if (view === "day") {
        // One bucket per calendar day. Label e.g. "Wed 30 Sep".
        label = date.toLocaleDateString("en-AU", {
          weekday: "short",
          day: "2-digit",
          month: "short",
        });
        dayMeta[label] = iso!;
      } else if (view === "week") {
        // Authoritative week + season from the row (set by the sync).
        const season = Number(row.season);
        const week = Number(row.week);
        const hasSeason = Number.isFinite(season);
        const wk = Number.isFinite(week) ? week : 0;
        // Label carries the season so the two "Week 1"s (one per season) never
        // merge, e.g. "2027 W1".
        label = hasSeason ? `${season} W${wk}` : `W${wk}`;

        const m = weekMeta[label];
        if (!m) {
          weekMeta[label] = {
            season: hasSeason ? season : 0,
            week: wk,
            min: iso!,
            max: iso!,
          };
        } else {
          if (iso! < m.min) m.min = iso!;
          if (iso! > m.max) m.max = iso!;
        }
      } else {
        label = getMonthLabel(date);
      }

      const key = `${label}_${area}`;
      if (!groupedMap[key]) {
        groupedMap[key] = { label, area, cost: 0 };
      }
      groupedMap[key].cost += Number(row.total_cost) || 0;
    });

    const grouped = Object.values(groupedMap);

const labels =
  view === "day"
    ? Array.from(new Set(grouped.map((g: any) => g.label)))
        // Chronological by the day's ISO date.
        .sort((a, b) => (dayMeta[a] < dayMeta[b] ? -1 : dayMeta[a] > dayMeta[b] ? 1 : 0))
    : view === "week"
    ? Array.from(new Set(grouped.map((g: any) => g.label)))
        // Sort by season, then by week number — never by a synthetic index.
        .sort((a, b) => {
          const ma = weekMeta[a];
          const mb = weekMeta[b];
          if (ma.season !== mb.season) return ma.season - mb.season;
          return ma.week - mb.week;
        })
    : Array.from(
        new Set(grouped.map((g: any) => g.label))
      ).sort(
        (a, b) =>
          new Date(`1 ${a}`).getTime() -
          new Date(`1 ${b}`).getTime()
      );

const areas = Array.from(
  new Set(grouped.map((g: any) => g.area))
).sort();

    const chartData = labels.map((label) => {
      // For week view, append the week's real date range (from the data) to the
      // axis label, e.g. "2027 W1 (30 Sep–06 Oct)".
      let period = label;
      if (view === "week") {
        const m = weekMeta[label];
        if (m) {
          period = `${label} (${dmy(new Date(`${m.min}T00:00:00`))}–${dmy(
            new Date(`${m.max}T00:00:00`)
          )})`;
        }
      }

      const row: any = {
        period,
      };

      let total = 0;

      areas.forEach((area) => {
        const found = grouped.find(
          (g: any) =>
            g.label === label &&
            g.area === area
        );

        const value = found ? found.cost : 0;

        row[area] = value;
        total += value;
      });

      row.total = total;

      return row;
    });

    return {
      chartData,
      areas,
    };
  }, [data, view]);

  return (
    <div
      style={{
        width: "100%",
        height: 520,
        background: THEME.bg,
        borderRadius: 16,
        padding: 18,
        border: `1px solid ${THEME.border}`,
        boxShadow: "0 6px 18px rgba(15,23,42,0.06)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: THEME.text,
            }}
          >
            Cost by Area (
            {view === "day" ? "Daily" : view === "week" ? "Weekly" : "Monthly"})
          </div>

          <div
            style={{
              fontSize: 12,
              color: THEME.subtext,
            }}
          >
            Stacked breakdown by area with total trend overlay
          </div>
        </div>

        {/* Toggle */}
        <div
          style={{
            display: "flex",
            background: "#F1F5F9",
            borderRadius: 10,
            padding: 4,
          }}
        >
          {([
            { key: "day", label: "Daily" },
            { key: "week", label: "Weekly" },
            { key: "month", label: "Monthly" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setView(opt.key)}
              style={{
                padding: "8px 18px",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                background: view === opt.key ? THEME.primary : "transparent",
                color: view === opt.key ? "#fff" : THEME.text,
                fontWeight: 600,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={420}>
        <BarChart
          data={chartData}
          margin={{
            top: 10,
            right: 20,
            left: 10,
            bottom: 80,
          }}
          barCategoryGap="20%"
        >
          <CartesianGrid
            stroke={THEME.grid}
            vertical={false}
          />

          <Legend
            verticalAlign="top"
            align="right"
            iconType="circle"
            wrapperStyle={{
              fontSize: 12,
              color: THEME.subtext,
            }}
          />

          <XAxis
            dataKey="period"
            tick={{
              fontSize: 11,
              fill: THEME.subtext,
            }}
            interval={0}
            angle={-35}
            textAnchor="end"
            height={70}
          />

          <YAxis
            tick={{
              fontSize: 11,
              fill: THEME.subtext,
            }}
            tickFormatter={formatMoney}
          />

          <Tooltip content={<CustomTooltip />} />

          {areas.map((area, i) => (
            <Bar
              key={area}
              dataKey={area}
              stackId="a"
              fill={COLORS[i % COLORS.length]}
              radius={[4, 4, 0, 0]}
              barSize={40}
            />
          ))}

          <Line
            type="monotone"
            dataKey="total"
            stroke={THEME.line}
            strokeWidth={2}
            dot={{ r: 2 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}