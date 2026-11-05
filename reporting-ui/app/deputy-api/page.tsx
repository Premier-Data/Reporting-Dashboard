"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, RefreshCw, Search, X } from "lucide-react";

import { THEME } from "@/lib/theme";
import {
  getDeputyRosters,
  getDeputyTimesheets,
  type DeputyRosterRow,
  type DeputyTimesheetRow,
} from "@/lib/api/deputy";
import {
  formatAud,
  formatHours2,
  formatRate,
  estimatedHourlyRate,
  summariseByArea,
  summariseByEmployee,
  type Summary,
} from "@/lib/deputy/format";
import {
  currentWeekWedToTue,
  recentWeekPresets,
  recentMonthPresets,
} from "@/lib/deputy/dates";

type Tab = "rosters" | "timesheets";
type SortDir = "asc" | "desc";

// A yes/no pill matching the dark-page badge styling used elsewhere.
function Badge({ value }: { value: boolean | null }) {
  if (value === true) {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
        Yes
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
      No
    </span>
  );
}

// Ordinal suffix for a day-of-month (1 -> "st", 2 -> "nd", 11 -> "th", ...).
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

// Date value is an ISO "yyyy-mm-dd" (date column) — render as e.g.
// "Thu 5th November 2026".
function formatDate(value: string | null): string {
  if (!value) return "-";
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  const weekday = d.toLocaleDateString("en-AU", { weekday: "short" });
  const month = d.toLocaleDateString("en-AU", { month: "long" });
  const day = d.getDate();
  return `${weekday} ${day}${ordinal(day)} ${month} ${d.getFullYear()}`;
}

// start_at / end_at are full ISO timestamptz — show just the time of day.
function formatTime(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

// A grouped-totals summary card (area or employee): shifts, total hours, total
// pay per group plus a grand-total footer. Reflects whatever rows are passed
// in, so it tracks the page's date/search filters.
function SummaryCard({
  title,
  groupLabel,
  summary,
  onRowClick,
  activeValue,
}: {
  title: string;
  groupLabel: string;
  summary: Summary;
  /** Called with the group label when a row is clicked (to filter shifts). */
  onRowClick: (value: string) => void;
  /** The currently-filtered label, highlighted in the list. */
  activeValue: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-white text-slate-700 shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Total hours and pay for the selected dates. Click a row to show its
          shifts.
        </p>
      </div>
      <div className="max-h-[40vh] overflow-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-800 text-white">
            <tr>
              <th className="whitespace-nowrap px-3 py-3">{groupLabel}</th>
              <th className="whitespace-nowrap px-3 py-3 text-right">Shifts</th>
              <th className="whitespace-nowrap px-3 py-3 text-right">
                Total hours
              </th>
              <th className="whitespace-nowrap px-3 py-3 text-right">
                Total pay
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-6 text-center text-slate-400"
                >
                  No approved timesheets for the selected dates.
                </td>
              </tr>
            ) : (
              summary.rows.map((s) => (
                <tr
                  key={s.label}
                  onClick={() => onRowClick(s.label)}
                  title={`Show shifts for ${s.label}`}
                  className={`cursor-pointer border-b border-slate-100 transition ${
                    activeValue === s.label
                      ? "bg-sky-50"
                      : "hover:bg-slate-50"
                  }`}
                >
                  <td className="px-3 py-2.5 font-medium text-slate-900">
                    {s.label}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {s.shifts}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatHours2(s.hours)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatAud(s.cost)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {summary.rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900">
                <td className="px-3 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {summary.total.shifts}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {formatHours2(summary.total.hours)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {formatAud(summary.total.cost)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}



export default function DeputyApiPage() {
  const [rosters, setRosters] = useState<DeputyRosterRow[]>([]);
  const [timesheets, setTimesheets] = useState<DeputyTimesheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("rosters");
  const [search, setSearch] = useState("");
  // Exact-match filter set by clicking a summary row (area or employee). Null
  // when inactive. Independent of the free-text `search` box.
  const [rowFilter, setRowFilter] = useState<
    { kind: "area" | "employee"; value: string } | null
  >(null);
  // Default the date filter to the current week (Wednesday -> Tuesday).
  const [{ from: defaultFrom, to: defaultTo }] = useState(() =>
    currentWeekWedToTue()
  );
  const [dateFrom, setDateFrom] = useState(defaultFrom);
  const [dateTo, setDateTo] = useState(defaultTo);
  // Quick-pick presets (computed once): last 26 Wed→Tue weeks and 12 months,
  // newest first. Selecting one sets the From/To range; manual edits flip the
  // dropdowns back to "Custom" (the range no longer matches a preset).
  const [weekPresets] = useState(() => recentWeekPresets(26));
  const [monthPresets] = useState(() => recentMonthPresets(12));
  const selectedWeek =
    weekPresets.find((p) => p.from === dateFrom && p.to === dateTo)?.value ?? "";
  const selectedMonth =
    monthPresets.find((p) => p.from === dateFrom && p.to === dateTo)?.value ?? "";

  function applyPreset(from: string, to: string) {
    setDateFrom(from);
    setDateTo(to);
  }

  const [sortField, setSortField] = useState("date");
  const [sortDirection, setSortDirection] = useState<SortDir>("desc");

  async function fetchAll(sync: boolean) {
    setLoading(true);
    setError(null);
    try {
      const [rosterRows, timesheetRows] = await Promise.all([
        getDeputyRosters(),
        // Only this request asks the server to sync, so a reload syncs once.
        getDeputyTimesheets({ sync }),
      ]);
      setRosters(rosterRows);
      setTimesheets(timesheetRows);
    } catch (err) {
      console.error("Failed loading Deputy data:", err);
      setError(
        err instanceof Error ? err.message : "Unable to load Deputy data."
      );
    } finally {
      setLoading(false);
    }
  }

  // Parameterless wrappers: onClick passes a MouseEvent, so never pass fetchAll directly.
  const load = () => fetchAll(false);
  const reload = () => fetchAll(true);

  useEffect(() => {
    document.title = "Deputy API | Premier Data";
    // Deferred so the effect body doesn't setState synchronously (load() flips
    // loading/error state) — avoids a cascading render, matching the pattern
    // used on the sibling comp-fixtures page.
    queueMicrotask(() => load());
  }, []);

  function sortBy(field: string) {
    if (sortField === field) {
      setSortDirection((cur) => (cur === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }

  const sortArrow = (field: string) =>
    sortField === field ? (sortDirection === "asc" ? " ↑" : " ↓") : "";

  // Reset the sort to the date column when switching tabs so a column that
  // only exists on one tab doesn't linger as the active sort on the other.
  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setSortField("date");
    setSortDirection("desc");
  }

  const visibleRosters = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dir = sortDirection === "asc" ? 1 : -1;
    const filtered = rosters.filter((r) => {
      const date = r.roster_date ?? "";
      if (dateFrom && (!date || date < dateFrom)) return false;
      if (dateTo && (!date || date > dateTo)) return false;
      if (!q) return true;
      return `${r.employee_name ?? ""} ${r.operational_unit_name ?? ""} ${date}`
        .toLowerCase()
        .includes(q);
    });
    const keyOf = (r: DeputyRosterRow): string | number => {
      switch (sortField) {
        case "employee":
          return (r.employee_name ?? "").toLowerCase();
        case "unit":
          return (r.operational_unit_name ?? "").toLowerCase();
        case "total":
          return r.total_time ?? -1;
        case "date":
        default:
          return r.roster_date ?? "";
      }
    };
    return [...filtered].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      return 0;
    });
  }, [rosters, search, dateFrom, dateTo, sortField, sortDirection]);

  const visibleTimesheets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dir = sortDirection === "asc" ? 1 : -1;
    const filtered = timesheets.filter((t) => {
      const date = t.timesheet_date ?? "";
      if (dateFrom && (!date || date < dateFrom)) return false;
      if (dateTo && (!date || date > dateTo)) return false;
      // Exact row-click filter (area or employee) from a summary table.
      if (rowFilter) {
        const field =
          rowFilter.kind === "area"
            ? t.operational_unit_name ?? ""
            : t.employee_name ?? "";
        if (field !== rowFilter.value) return false;
      }
      if (!q) return true;
      return `${t.employee_name ?? ""} ${t.operational_unit_name ?? ""} ${date}`
        .toLowerCase()
        .includes(q);
    });
    const keyOf = (t: DeputyTimesheetRow): string | number => {
      switch (sortField) {
        case "employee":
          return (t.employee_name ?? "").toLowerCase();
        case "unit":
          return (t.operational_unit_name ?? "").toLowerCase();
        case "total":
          return t.total_time ?? -1;
        case "cost":
          return t.cost ?? Number.NEGATIVE_INFINITY;
        case "rate":
          return (
            estimatedHourlyRate(t.cost, t.total_time) ??
            Number.NEGATIVE_INFINITY
          );
        case "date":
        default:
          return t.timesheet_date ?? "";
      }
    };
    return [...filtered].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      return 0;
    });
  }, [timesheets, search, rowFilter, dateFrom, dateTo, sortField, sortDirection]);

  // Per-area and per-employee summaries (total hours + total cost) over the
  // currently-visible timesheets, so they track the selected date range and
  // the search box.
  const areaSummary = useMemo(
    () => summariseByArea(visibleTimesheets),
    [visibleTimesheets]
  );
  const employeeSummary = useMemo(
    () => summariseByEmployee(visibleTimesheets),
    [visibleTimesheets]
  );

  const tabButton = (value: Tab, label: string, count: number) => {
    const active = tab === value;
    return (
      <button
        onClick={() => switchTab(value)}
        className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
          active
            ? "text-white"
            : "border border-slate-700 bg-[#0f1b2d] text-slate-300 hover:bg-slate-800"
        }`}
        style={active ? { background: THEME.accent } : undefined}
      >
        {label}
        <span className="ml-2 text-xs opacity-80">{count}</span>
      </button>
    );
  };

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
              <CalendarClock size={22} className="text-sky-400" />
              Deputy API
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Rostered schedule and approved timesheets synced from Deputy.
              Approved timesheets are those marked time-approved and not
              discarded.
            </p>
          </div>
          <button
            onClick={reload}
            disabled={loading}
            title="Sync latest from Deputy and reload"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
        </div>

        {/* TABS */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {tabButton("rosters", "Rostered Schedule", rosters.length)}
          {tabButton("timesheets", "Approved Timesheets", timesheets.length)}
        </div>

        {/* FILTER BAR — quick month/week pickers + date range + search */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="deputy-month"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              Month
            </label>
            <select
              id="deputy-month"
              value={selectedMonth}
              onChange={(e) => {
                const p = monthPresets.find((m) => m.value === e.target.value);
                if (p) applyPreset(p.from, p.to);
              }}
              className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
            >
              <option value="">Custom…</option>
              {monthPresets.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="deputy-week"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              Week
            </label>
            <select
              id="deputy-week"
              value={selectedWeek}
              onChange={(e) => {
                const p = weekPresets.find((w) => w.value === e.target.value);
                if (p) applyPreset(p.from, p.to);
              }}
              className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
            >
              <option value="">Custom…</option>
              {weekPresets.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="deputy-date-from"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              From
            </label>
            <input
              id="deputy-date-from"
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label
              htmlFor="deputy-date-to"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              To
            </label>
            <input
              id="deputy-date-to"
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
            />
          </div>

          <div className="ml-auto min-w-[300px] flex-1 lg:max-w-md">
            <label
              htmlFor="deputy-search"
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
                id="deputy-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employee, area or date…"
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

        {/* ACTIVE ROW-CLICK FILTER CHIP */}
        {rowFilter && !loading && !error && tab === "timesheets" && (
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400">
              Filtered to {rowFilter.kind === "area" ? "area" : "employee"}:
            </span>
            <button
              type="button"
              onClick={() => setRowFilter(null)}
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-sky-500"
            >
              {rowFilter.value}
              <X size={13} />
            </button>
          </div>
        )}

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

        {/* ROSTERS TABLE */}
        {!loading && !error && tab === "rosters" && (
          <div className="overflow-hidden rounded-xl bg-white text-slate-700 shadow-sm">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="sticky top-0 z-10 bg-slate-800 text-white">
                  <tr>
                    <th
                      onClick={() => sortBy("employee")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 hover:bg-slate-700"
                    >
                      Employee{sortArrow("employee")}
                    </th>
                    <th
                      onClick={() => sortBy("unit")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 hover:bg-slate-700"
                    >
                      Area{sortArrow("unit")}
                    </th>
                    <th
                      onClick={() => sortBy("date")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 hover:bg-slate-700"
                    >
                      Date{sortArrow("date")}
                    </th>
                    <th className="whitespace-nowrap px-3 py-3">Start</th>
                    <th className="whitespace-nowrap px-3 py-3">End</th>
                    <th
                      onClick={() => sortBy("total")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 text-right hover:bg-slate-700"
                    >
                      Total (h){sortArrow("total")}
                    </th>
                    <th className="whitespace-nowrap px-3 py-3">Published</th>
                    <th className="whitespace-nowrap px-3 py-3">Open shift</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRosters.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-3 py-10 text-center text-slate-400"
                      >
                        No rostered shifts.
                      </td>
                    </tr>
                  ) : (
                    visibleRosters.map((r) => (
                      <tr
                        key={r.deputy_id}
                        className="border-b border-slate-100 transition hover:bg-slate-50"
                      >
                        <td className="px-3 py-3 font-medium text-slate-900">
                          {r.employee_name ?? "-"}
                        </td>
                        <td className="px-3 py-3">
                          {r.operational_unit_name ?? "-"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">
                          {formatDate(r.roster_date)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                          {formatTime(r.start_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                          {formatTime(r.end_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                          {formatHours2(r.total_time)}
                        </td>
                        <td className="px-3 py-3">
                          <Badge value={r.published} />
                        </td>
                        <td className="px-3 py-3">
                          <Badge value={r.open_shift} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TIMESHEETS: SUMMARIES (reflect the selected date range + search) */}
        {!loading && !error && tab === "timesheets" && (
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SummaryCard
              title="Summary by area"
              groupLabel="Area"
              summary={areaSummary}
              activeValue={rowFilter?.kind === "area" ? rowFilter.value : null}
              onRowClick={(value) =>
                setRowFilter((cur) =>
                  cur?.kind === "area" && cur.value === value
                    ? null
                    : { kind: "area", value }
                )
              }
            />
            <SummaryCard
              title="Summary by employee"
              groupLabel="Employee"
              summary={employeeSummary}
              activeValue={
                rowFilter?.kind === "employee" ? rowFilter.value : null
              }
              onRowClick={(value) =>
                setRowFilter((cur) =>
                  cur?.kind === "employee" && cur.value === value
                    ? null
                    : { kind: "employee", value }
                )
              }
            />
          </div>
        )}

        {/* TIMESHEETS TABLE */}
        {!loading && !error && tab === "timesheets" && (
          <div className="overflow-hidden rounded-xl bg-white text-slate-700 shadow-sm">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="sticky top-0 z-10 bg-slate-800 text-white">
                  <tr>
                    <th
                      onClick={() => sortBy("employee")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 hover:bg-slate-700"
                    >
                      Employee{sortArrow("employee")}
                    </th>
                    <th
                      onClick={() => sortBy("unit")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 hover:bg-slate-700"
                    >
                      Area{sortArrow("unit")}
                    </th>
                    <th
                      onClick={() => sortBy("date")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 hover:bg-slate-700"
                    >
                      Date{sortArrow("date")}
                    </th>
                    <th className="whitespace-nowrap px-3 py-3">Start</th>
                    <th className="whitespace-nowrap px-3 py-3">End</th>
                    <th
                      onClick={() => sortBy("total")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 text-right hover:bg-slate-700"
                    >
                      Total (h){sortArrow("total")}
                    </th>
                    <th
                      onClick={() => sortBy("cost")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 text-right hover:bg-slate-700"
                    >
                      Total Pay{sortArrow("cost")}
                    </th>
                    <th
                      onClick={() => sortBy("rate")}
                      className="cursor-pointer whitespace-nowrap px-3 py-3 text-right hover:bg-slate-700"
                    >
                      Est. rate /h{sortArrow("rate")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTimesheets.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-3 py-10 text-center text-slate-400"
                      >
                        No approved timesheets.
                      </td>
                    </tr>
                  ) : (
                    visibleTimesheets.map((t) => (
                      <tr
                        key={t.deputy_id}
                        className="border-b border-slate-100 transition hover:bg-slate-50"
                      >
                        <td className="px-3 py-3 font-medium text-slate-900">
                          {t.employee_name ?? "-"}
                        </td>
                        <td className="px-3 py-3">
                          {t.operational_unit_name ?? "-"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">
                          {formatDate(t.timesheet_date)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                          {formatTime(t.start_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                          {formatTime(t.end_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                          {formatHours2(t.total_time)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                          {formatAud(t.cost)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                          {formatRate(t.cost, t.total_time)}
                        </td>
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
