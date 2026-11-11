"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";

import type { DeputyShift } from "@/types/deputy";
import type { TTGame } from "@/types/ttgame";

type Props = {
  analystA: string;
  analystB: string;
  shifts: DeputyShift[];
  games: TTGame[];
};

export default function ComparisonTrendCharts({
  analystA,
  analystB,
  shifts,
  games,
}: Props) {
  const hoursData = useMemo(() => {
    const map = new Map<
      string,
      { week: string; a: number; b: number }
    >();

    shifts.forEach((shift) => {
      const week = String(
        shift.week ??
        shift.week_name ??
        shift.week_start ??
        "Unknown"
      );

      if (!map.has(week)) {
        map.set(week, {
          week,
          a: 0,
          b: 0,
        });
      }

      const row = map.get(week)!;

      if (shift.employee_name === analystA) {
        row.a += shift.total_hours;
      }

      if (shift.employee_name === analystB) {
        row.b += shift.total_hours;
      }
    });

    return [...map.values()];
  }, [analystA, analystB, shifts]);

  const gamesData = useMemo(() => {
    const map = new Map<
      string,
      { week: string; a: number; b: number }
    >();

    games.forEach((game) => {
const week = game.Week ?? "Unknown";
      if (!map.has(week)) {
        map.set(week, {
          week,
          a: 0,
          b: 0,
        });
      }

      const row = map.get(week)!;

      if (game.home_allocated === analystA)
        row.a++;

      if (game.away_allocated === analystA)
        row.a++;

      if (game.home_allocated === analystB)
        row.b++;

      if (game.away_allocated === analystB)
        row.b++;
    });

    return [...map.values()];
  }, [games, analystA, analystB]);

  return (
    <div className="grid grid-cols-2 gap-8">

      <div className="rounded-xl border border-slate-700 bg-[#0f172a] p-6">
        <h2 className="mb-5 text-xl font-semibold">
          Hours per Week
        </h2>

        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={hoursData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="week" />
            <YAxis />
            <Tooltip />
            <Legend />

            <Line
              dataKey="a"
              name={analystA}
              stroke="#22c55e"
              strokeWidth={3}
            />

            <Line
              dataKey="b"
              name={analystB}
              stroke="#3b82f6"
              strokeWidth={3}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded-xl border border-slate-700 bg-[#0f172a] p-6">
        <h2 className="mb-5 text-xl font-semibold">
          Games per Week
        </h2>

        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={gamesData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="week" />
            <YAxis />
            <Tooltip />
            <Legend />

            <Line
              dataKey="a"
              name={analystA}
              stroke="#22c55e"
              strokeWidth={3}
            />

            <Line
              dataKey="b"
              name={analystB}
              stroke="#3b82f6"
              strokeWidth={3}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

    </div>
  );
}