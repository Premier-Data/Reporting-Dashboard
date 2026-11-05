"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw, Search, X } from "lucide-react";

import { THEME } from "@/lib/theme";
import { getDeputyTimesheets, type DeputyTimesheetRow } from "@/lib/api/deputy";
import { formatAud, formatHours2 } from "@/lib/deputy/format";
import { currentWeekWedToTue } from "@/lib/deputy/dates";
import {
  WEEKDAY_ORDER,
  buildEmployeeInsights,
  type EmployeeInsightRow,
  type InsightBucket,
} from "@/lib/deputy/insights";

type SortDir = "asc" | "desc";
// The four Overall metric columns that can drive the row sort (plus "name").
type SortField = "name" | "count" | "totalCost" | "avgCost" | "avgHours";

// The four metric groups, in display order. `metric` selects which bucket
// field each group renders; `format` turns the raw value into display text.
const METRIC_GROUPS = [
  {
    key: "count" as const,
    title: "Number of Shifts",
    sortField: "count" as SortField,
    render: (b: InsightBucket) => String(b.shiftCount),
  },
  {
    key: "totalCost" as const,
    title: "Total Shift Cost",
    sortField: "totalCost" as SortField,
    render: (b: InsightBucket) => formatAud(b.totalCost),
  },
  {
    key: "avgCost" as const,
    title: "Average Shift Cost",
    sortField: "avgCost" as SortField,
    // null average -> en-dash, never NaN / #DIV/0!.
    render: (b: InsightBucket) => (b.avgCost == null ? "–" : formatAud(b.avgCost)),
  },
  {
    key: "avgHours" as const,
    title: "Average Shift Length",
    sortField: "avgHours" as SortField,
    render: (b: InsightBucket) =>
      b.avgHours == null ? "–" : formatHours2(b.avgHours),
  },
];

// Pull the sort key for a given Overall metric field; name sorts by string,
// the rest by the numeric Overall bucket value (nulls sort lowest).
function sortKey(row: EmployeeInsightRow, field: SortField): string | number {
  switch (field) {
    case "count":
      return row.overall.shiftCount;
    case "totalCost":
      return row.overall.totalCost;
    case "avgCost":
      return row.overall.avgCost ?? Number.NEGATIVE_INFINITY;
    case "avgHours":
      return row.overall.avgHours ?? Number.NEGATIVE_INFINITY;
    case "name":
    default:
      return row.employee.toLowerCase();
  }
}

export default function DeputyInsightsPage() {
  const [timesheets, setTimesheets] = useState<DeputyTimesheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Default the date filter to the current week (Wednesday -> Tuesday).
  const [{ from: defaultFrom, to: defaultTo }] = useState(() =>
    currentWeekWedToTue()
  );
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);
  // Default sort: employee name ascending.
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDir>("asc");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const rows = await getDeputyTimesheets();
      setTimesheets(rows);
    } catch (err) {
      console.error("Failed loading Deputy data:", err);
      setError(
        err instanceof Error ? err.message : "Unable to load Deputy data."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    document.title = "Deputy Insights | Premier Data";
    // Deferred so the effect body doesn't setState synchronously (load() flips
    // loading/error state) — matches the deputy-api page pattern.
    queueMicrotask(() => load());
  }, []);

  function sortBy(field: SortField) {
    if (sortField === field) {
      setSortDirection((cur) => (cur === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      // Name defaults ascending; numeric metrics default descending (largest
      // first is the useful first glance).
      setSortDirection(field === "name" ? "asc" : "desc");
    }
  }

  const sortArrow = (field: SortField) =>
    sortField === field ? (sortDirection === "asc" ? " ↑" : " ↓") : "";

  // Filter by date range + employee search, aggregate, then sort. Recomputes
  // whenever the loaded data, range, search, or sort changes.
  const insightRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = timesheets.filter((t) => {
      const date = t.timesheet_date ?? "";
      if (dateFrom && (!date || date < dateFrom)) return false;
      if (dateTo && (!date || date > dateTo)) return false;
      if (!q) return true;
      return (t.employee_name ?? "").toLowerCase().includes(q);
    });

    const rows = buildEmployeeInsights(filtered);

    const dir = sortDirection === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const ka = sortKey(a, sortField);
      const kb = sortKey(b, sortField);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      // Stable tiebreak by name so equal metrics stay name-ordered.
      return a.employee.localeCompare(b.employee, undefined, {
        sensitivity: "base",
      });
    });
  }, [timesheets, search, dateFrom, dateTo, sortField, sortDirection]);

  // Shared sticky-left styling for the frozen Employee column. Opaque bg so
  // body/header text underneath stays hidden during horizontal scroll.
  const stickyHeadCol =
    "sticky left-0 z-30 bg-slate-800 whitespace-nowrap px-3 py-3 text-left";
  const stickyBodyCol =
    "sticky left-0 z-10 bg-white px-3 py-2.5 font-medium text-slate-900 whitespace-nowrap";

  return (
    <div
      className="min-h-screen p-6 text-slate-200"
      style={{ background: THEME.bg }}
    >
      <div className="w-full">
        {/* HEADER */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
              <BarChart3 size={22} className="text-sky-400" />
              Deputy Insights
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Employee shift analytics for the selected dates. Number of shifts,
              total and average shift cost, and average shift length — broken
              down by weekday — from approved timesheets.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            title="Reload from Deputy"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
        </div>

        {/* FILTER BAR — date range + free-text employee search */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="insights-date-from"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              From
            </label>
            <input
              id="insights-date-from"
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label
              htmlFor="insights-date-to"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              To
            </label>
            <input
              id="insights-date-to"
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
            />
          </div>

          <div className="ml-auto min-w-[300px] flex-1 lg:max-w-md">
            <label
              htmlFor="insights-search"
              className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-300"
            >
              Search
            </label>
            <div className="relative">
              <Search
                size={18}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sky-400"
              />
              <input
                id="insights-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employee…"
                className="w-full rounded-lg border-2 border-slate-600 bg-[#0f1b2d] py-2.5 pl-10 pr-9 text-sm text-slate-100 placeholder:text-slate-400 shadow-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* LOADING */}
        {loading && (
          <div className="mb-6 flex items-center gap-2 rounded-2xl border border-slate-700 bg-[#0f1b2d] p-5 text-sm text-slate-400">
            <RefreshCw size={14} className="animate-spin" />
            Loading Deputy data…
          </div>
        )}

        {/* ERROR */}
        {error && !loading && (
          <div className="mb-6 rounded-2xl border border-amber-700/50 bg-amber-950/40 p-5 text-sm text-amber-200">
            <p className="font-semibold">Couldn&apos;t load Deputy data</p>
            <p className="mt-1 text-amber-300/80">{error}</p>
            <button
              onClick={load}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        )}

        {/* INSIGHTS MATRIX */}
        {!loading && !error && (
          <div className="overflow-hidden rounded-xl bg-white text-slate-700 shadow-sm">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="text-white">
                  {/* Row 1: Employee (rowSpan 2) + four group spans. */}
                  <tr>
                    <th
                      rowSpan={2}
                      onClick={() => sortBy("name")}
                      className={`${stickyHeadCol} top-0 z-40 cursor-pointer border-r border-slate-700 align-bottom hover:bg-slate-700`}
                    >
                      Employee{sortArrow("name")}
                    </th>
                    {METRIC_GROUPS.map((g) => (
                      <th
                        key={g.key}
                        colSpan={8}
                        className="sticky top-0 z-20 whitespace-nowrap border-l border-slate-700 bg-slate-900 px-3 py-2.5 text-center font-semibold"
                      >
                        {g.title}
                      </th>
                    ))}
                  </tr>
                  {/* Row 2: Overall + 7 day names under each group. */}
                  <tr>
                    {METRIC_GROUPS.map((g) => (
                      <GroupSubHeader
                        key={g.key}
                        onSortOverall={() => sortBy(g.sortField)}
                        sortArrow={sortArrow(g.sortField)}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {insightRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={1 + METRIC_GROUPS.length * 8}
                        className="px-3 py-10 text-center text-slate-400"
                      >
                        No approved timesheets for the selected dates.
                      </td>
                    </tr>
                  ) : (
                    insightRows.map((row) => (
                      <tr
                        key={row.employee}
                        className="border-b border-slate-100 transition hover:bg-slate-50"
                      >
                        <td className={stickyBodyCol}>{row.employee}</td>
                        {METRIC_GROUPS.map((g) => (
                          <GroupCells key={g.key} row={row} render={g.render} />
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Row-2 sub-header for one metric group: an Overall column (sortable) plus the
// seven day-name columns in Saturday-first order. Sticky just below row 1.
function GroupSubHeader({
  onSortOverall,
  sortArrow,
}: {
  onSortOverall: () => void;
  sortArrow: string;
}) {
  return (
    <>
      <th
        onClick={onSortOverall}
        className="sticky top-[41px] z-20 cursor-pointer whitespace-nowrap border-l border-slate-700 bg-slate-800 px-3 py-2.5 text-right hover:bg-slate-700"
      >
        Overall{sortArrow}
      </th>
      {WEEKDAY_ORDER.map((day) => (
        <th
          key={day}
          className="sticky top-[41px] z-20 whitespace-nowrap bg-slate-800 px-3 py-2.5 text-right font-medium"
        >
          {day}
        </th>
      ))}
    </>
  );
}

// Body cells for one metric group: Overall + the seven weekday values, each
// rendered via the group's formatter (null averages already render "–").
function GroupCells({
  row,
  render,
}: {
  row: EmployeeInsightRow;
  render: (b: InsightBucket) => string;
}) {
  return (
    <>
      <td className="whitespace-nowrap border-l border-slate-200 px-3 py-2.5 text-right font-semibold tabular-nums">
        {render(row.overall)}
      </td>
      {WEEKDAY_ORDER.map((day) => (
        <td
          key={day}
          className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-600"
        >
          {render(row.byWeekday[day])}
        </td>
      ))}
    </>
  );
}
