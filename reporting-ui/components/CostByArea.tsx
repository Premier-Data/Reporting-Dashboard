"use client";

import { useMemo, useState, useEffect } from "react";
import { buildWeekRanges, weekOptionLabel } from "@/lib/analytics/weekLabels";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export default function CostByArea({ data }: { data: any[] }) {
  const [selectedWeek, setSelectedWeek] = useState("all");

  // -------------------------
  // GET ALL AVAILABLE WEEKS
  // -------------------------
  const weekRanges = useMemo(
    () => buildWeekRanges((data ?? []).map((r) => ({ week: r.week, date: r.shift_date }))),
    [data]
  );

  const weeks = useMemo(() => {
    const uniqueWeeks = Array.from(
      new Set(
        (data ?? [])
          .map((row) => String(row.week ?? "").trim())
          .filter(Boolean)
      )
    );

    return uniqueWeeks.sort((a, b) => {
      // Handles values such as:
      // Week 1, Week 2, Week 10
      // or numeric strings such as 1, 2, 10
      const aNumber = Number(a.match(/\d+/)?.[0] ?? 0);
      const bNumber = Number(b.match(/\d+/)?.[0] ?? 0);

      return bNumber - aNumber;
    });
  }, [data]);

  // -------------------------
  // KEEP SELECTED WEEK VALID
  // -------------------------
  useEffect(() => {
    if (
      selectedWeek !== "all" &&
      !weeks.includes(selectedWeek)
    ) {
      setSelectedWeek("all");
    }
  }, [weeks, selectedWeek]);

  // -------------------------
  // FILTER BY SELECTED WEEK
  // -------------------------
  const filteredData = useMemo(() => {
    if (selectedWeek === "all") {
      return data ?? [];
    }

    return (data ?? []).filter(
      (row) =>
        String(row.week ?? "").trim() === selectedWeek
    );
  }, [data, selectedWeek]);

  // -------------------------
  // GROUP COST BY AREA
  // -------------------------
  const grouped = useMemo(() => {
    const acc: Record<
      string,
      {
        area: string;
        cost: number;
      }
    > = {};

    filteredData.forEach((row) => {
      const area = String(row.area_name || "Unknown").trim();

      if (!acc[area]) {
        acc[area] = {
          area,
          cost: 0,
        };
      }

      acc[area].cost += Number(row.total_cost) || 0;
    });

    return Object.values(acc)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
  }, [filteredData]);

  // -------------------------
  // MONEY FORMATTER
  // -------------------------
  const formatMoney = (value: any) =>
    `$${Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  return (
    <div className="w-full rounded-2xl bg-white p-6 shadow-sm border border-zinc-100">
      {/* HEADER */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-800">
            Cost by Area
          </h3>

          <p className="text-sm text-zinc-500">
            {selectedWeek === "all"
              ? "Labour cost distribution across all weeks"
              : `Labour cost distribution for ${selectedWeek}`}
          </p>
        </div>

        {/* WEEK FILTER */}
        <select
          value={selectedWeek}
          onChange={(e) => setSelectedWeek(e.target.value)}
          className="
            min-w-[160px]
            rounded-lg
            border
            border-zinc-200
            bg-white
            px-3
            py-2
            text-sm
            font-medium
            text-zinc-700
            outline-none
            transition
            hover:border-zinc-300
            focus:border-indigo-500
            focus:ring-2
            focus:ring-indigo-100
          "
        >
          <option value="all">
            All Weeks
          </option>

          {weeks.map((week) => (
            <option key={week} value={week}>
              {weekOptionLabel(/^\d+$/.test(week) ? `Week ${week}` : week, weekRanges.get(week))}
            </option>
          ))}
        </select>
      </div>

      {/* CHART */}
      <div
        style={{
          width: "100%",
          height: 360,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <ResponsiveContainer width="99%" height="100%">
          <BarChart
            data={grouped}
            barCategoryGap="25%"
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#f1f5f9"
              vertical={false}
            />

            <XAxis
              dataKey="area"
              tick={{
                fontSize: 12,
                fill: "#64748b",
              }}
              axisLine={false}
              tickLine={false}
              interval={0}
              angle={-20}
              textAnchor="end"
              height={60}
            />

            <YAxis
              tick={{
                fontSize: 12,
                fill: "#64748b",
              }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) =>
                Number(value).toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })
              }
            />

            <Tooltip
              cursor={{
                fill: "rgba(99, 102, 241, 0.08)",
              }}
              contentStyle={{
                borderRadius: "12px",
                border: "1px solid #e5e7eb",
                boxShadow:
                  "0 10px 25px rgba(0,0,0,0.08)",
              }}
              formatter={(value: any) => [
                formatMoney(value),
                "Cost",
              ]}
            />

            <defs>
              <linearGradient
                id="costGradient"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="#6366f1"
                />
                <stop
                  offset="100%"
                  stopColor="#ef4444"
                />
              </linearGradient>
            </defs>

            <Bar
              dataKey="cost"
              fill="url(#costGradient)"
              radius={[8, 8, 0, 0]}
              maxBarSize={50}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}