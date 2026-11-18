"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import SortableTh from "@/components/UI/SortableTh";
import { useTableSort, type SortColumn } from "@/lib/tableSort";
import {
  buildDisputeDashboard,
  CHECK_GROUP_LABELS,
  type AnalystDisputeRow,
  type CheckGroup,
  type DashboardCheck,
  type DashboardDispute,
  type SportFilterValue,
} from "@/lib/analytics/disputeDashboard";
import { percentText } from "@/lib/analytics/disputeOutcome";

type Key =
  | "analyst"
  | "checks"
  | "total"
  | "resolved"
  | "open"
  | "analystCorrect"
  | "masterCorrect"
  | "analystPct"
  | "masterPct"
  | "avg";

const COLUMNS: Record<Key, SortColumn<AnalystDisputeRow>> = {
  analyst: { value: (r) => r.analyst },
  checks: { value: (r) => r.checks, defaultDir: "desc" },
  total: { value: (r) => r.total, defaultDir: "desc" },
  resolved: { value: (r) => r.resolved, defaultDir: "desc" },
  open: { value: (r) => r.open, defaultDir: "desc" },
  analystCorrect: { value: (r) => r.analystCorrect, defaultDir: "desc" },
  masterCorrect: { value: (r) => r.masterCorrect, defaultDir: "desc" },
  analystPct: { value: (r) => r.analystPct, defaultDir: "desc" },
  masterPct: { value: (r) => r.masterPct, defaultDir: "desc" },
  avg: { value: (r) => r.avgPerCheck, defaultDir: "desc" },
};

const GROUP_ORDER: CheckGroup[] = ["all", "specific", "full", "golden", "other"];
const TH = "px-3 py-2.5 text-right text-xs font-semibold text-slate-500";

function fmtAvg(v: number | null): string {
  return v == null ? "\u2014" : (Math.round(v * 100) / 100).toFixed(2);
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" title={hint}>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}

export default function DisputesDashboard({
  disputes,
  checks,
  sport,
  group: groupProp,
  onGroupChange,
  onSelectAnalyst,
}: {
  /** Optional controlled check-type group (shared with the page filter). */
  group?: CheckGroup;
  onGroupChange?: (g: CheckGroup) => void;
  disputes: readonly DashboardDispute[];
  checks: readonly DashboardCheck[];
  sport: SportFilterValue;
  /** Optional: jump to the Disputes tab filtered to this analyst. */
  onSelectAnalyst?: (analyst: string) => void;
}) {
  const [localGroup, setLocalGroup] = useState<CheckGroup>("all");
  const group = groupProp ?? localGroup;
  const setGroup = onGroupChange ?? setLocalGroup;
  const [search, setSearch] = useState("");

  const data = useMemo(
    () => buildDisputeDashboard(disputes, checks, { sport, categoryGroup: group }),
    [disputes, checks, sport, group]
  );
  // Group counts do not depend on the selected group, so they drive which
  // segments are shown ("Other" only when such checks exist).
  const { groupCounts } = data;

  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? data.rows.filter((r) => r.analyst.toLowerCase().includes(q)) : data.rows),
    [data.rows, q]
  );
  const { rows, sort } = useTableSort<AnalystDisputeRow, Key>(filtered, {
    columns: COLUMNS,
    initialKey: "total",
    initialDir: "desc",
    tiebreak: (a, b) => a.analyst.localeCompare(b.analyst),
  });

  async function exportXlsx() {
    try {
      const { downloadDisputeDashboardExcel } = await import("@/lib/exports/disputeDashboardExcel");
      await downloadDisputeDashboardExcel(
        rows,
        data.totals,
        `${CHECK_GROUP_LABELS[group]} - ${sport === "all" ? "All sports" : sport}`
      );
    } catch (e) {
      console.error("Dashboard export failed:", e);
      alert("Export failed. Please try again.");
    }
  }

  const t = data.totals;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5" role="group" aria-label="Check type">
          {GROUP_ORDER.filter((g) => g !== "other" || groupCounts.other.checks > 0 || group === "other").map(
            (g) => (
              <button
                key={g}
                onClick={() => setGroup(g)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  group === g
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {CHECK_GROUP_LABELS[g]}
                <span className="ml-1.5 opacity-70">{groupCounts[g].checks}</span>
              </button>
            )
          )}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search analyst…"
          className="ml-auto w-56 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-500"
        />
        <button
          onClick={exportXlsx}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Download size={13} /> Export
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card label="Total disputes" value={String(t.total)} />
        <Card
          label="Analyst correct"
          value={percentText(t.analystPct)}
          hint="Disputes resolved in the analyst's favour / resolved disputes"
        />
        <Card
          label="Master correct"
          value={percentText(t.masterPct)}
          hint="Disputes resolved in the master's favour / resolved disputes"
        />
        <Card
          label="Avg disputes per check"
          value={fmtAvg(t.avgPerCheck)}
          hint="Disputes created / all active checks in the filter (including checks with no disputes)"
        />
        <Card label="Analysts" value={String(data.rows.length)} />
      </div>

      {data.rows.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          No checks or disputes for this filter.
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <SortableTh sort={sort} sortKey="analyst" className="w-auto px-3 py-2.5 text-left text-xs font-semibold text-slate-500">
                  Analyst
                </SortableTh>
                <SortableTh sort={sort} sortKey="checks" className={`${TH} w-20`}>
                  <span title="All of the analyst's active checks in this filter, including checks with no disputes">
                    Checks
                  </span>
                </SortableTh>
                <SortableTh sort={sort} sortKey="total" className={`${TH} w-24`}>Disputes</SortableTh>
                <SortableTh sort={sort} sortKey="resolved" className={`${TH} w-24`}>Resolved</SortableTh>
                <SortableTh sort={sort} sortKey="open" className={`${TH} w-20`}>Open</SortableTh>
                <SortableTh sort={sort} sortKey="analystCorrect" className={`${TH} w-24`}>Analyst ✓</SortableTh>
                <SortableTh sort={sort} sortKey="masterCorrect" className={`${TH} w-24`}>Master ✓</SortableTh>
                <SortableTh sort={sort} sortKey="analystPct" className={`${TH} w-24`}>Analyst %</SortableTh>
                <SortableTh sort={sort} sortKey="masterPct" className={`${TH} w-24`}>Master %</SortableTh>
                <SortableTh sort={sort} sortKey="avg" className={`${TH} w-28`}>
                  <span title="Disputes created / the analyst's checks">Avg / check</span>
                </SortableTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.key}
                  onClick={onSelectAnalyst ? () => onSelectAnalyst(r.analyst) : undefined}
                  className={`border-b border-slate-100 ${onSelectAnalyst ? "cursor-pointer hover:bg-slate-50" : ""}`}
                >
                  <td className="truncate px-3 py-2.5 font-medium text-slate-800">{r.analyst}</td>
                  <Num v={r.checks} />
                  <Num v={r.total} />
                  <Num v={r.resolved} />
                  <Num v={r.open} />
                  <Num v={r.analystCorrect} />
                  <Num v={r.masterCorrect} />
                  <td className="px-3 py-2.5 text-right tabular-nums">{percentText(r.analystPct)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{percentText(r.masterPct)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtAvg(r.avgPerCheck)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td className="px-3 py-2.5">All analysts</td>
                <Num v={t.checks} />
                <Num v={t.total} />
                <Num v={t.resolved} />
                <Num v={t.open} />
                <Num v={t.analystCorrect} />
                <Num v={t.masterCorrect} />
                <td className="px-3 py-2.5 text-right tabular-nums">{percentText(t.analystPct)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{percentText(t.masterPct)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtAvg(t.avgPerCheck)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Percentages are out of resolved disputes (open ones are excluded); n/a means nothing is resolved yet.
        Avg / check = disputes created ÷ all of the analyst&apos;s active checks in this filter, including checks with
        no disputes. All statuses are counted, so the Open/Resolved filter does not apply here.
      </p>
    </div>
  );
}

function Num({ v }: { v: number }) {
  return <td className="px-3 py-2.5 text-right tabular-nums">{v}</td>;
}
