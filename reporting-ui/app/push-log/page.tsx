"use client";

// Push Activity — a compact, sortable, filterable table of every score the
// Cloudflare Worker sends to the TT (JADE) production endpoint. Backed by the
// Worker's KV log (/api/push-log), so it works on the deployed site from any
// device. Built for 20+ competitions and hundreds of rows: one line each,
// sort by any column header, filter by competition + free-text search.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Radio,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Search,
} from "lucide-react";

import {
  getPushLog,
  getRoundSummary,
  type PushLogEntry,
  type RoundSummary,
} from "@/lib/api/playhq";
import { statusChip } from "@/lib/round-summary/roundSummary";

const POLL_MS = 5_000;

function cleanReply(s: string): string {
  return (s ?? "").replace(/^"+|"+$/g, "");
}
function shortMatch(match: string): string {
  return (match ?? "").replace(/\s+vs\s+/i, " v ");
}
function shortRound(round: string | undefined): string {
  const n = (round ?? "").trim();
  if (!n) return "";
  const m = n.match(/round\s*(\d+)/i);
  if (m) return `R${m[1]}`;
  if (/grand\s*final/i.test(n)) return "GF";
  if (/prelim/i.test(n)) return "PF";
  if (/semi/i.test(n)) return "SF";
  if (/qualif/i.test(n)) return "QF";
  if (/elim/i.test(n)) return "EF";
  return n;
}
function roundNum(round: string | undefined): number {
  const m = (round ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : 9999;
}
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

type SortKey = "ts" | "competition" | "round" | "match" | "status";
type SortDir = "asc" | "desc";

export default function PushLogPage() {
  const [entries, setEntries] = useState<PushLogEntry[]>([]);
  const [summary, setSummary] = useState<RoundSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [live, setLive] = useState(true);
  const [compFilter, setCompFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("ts");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Fetch the log (which owns the page's error surface) and the summary board
    // together on the one poll; allSettled so a summary failure never blanks the
    // log and vice-versa. The summary keeps its previous board on rejection.
    const [logRes, summaryRes] = await Promise.allSettled([
      getPushLog(ctrl.signal),
      getRoundSummary(ctrl.signal),
    ]);
    if (ctrl.signal.aborted) return;
    if (logRes.status === "fulfilled") {
      setEntries(logRes.value);
      setError(null);
      setLastRefresh(new Date());
    } else {
      const e = logRes.reason;
      setError(e instanceof Error ? e.message : "Failed to load push log.");
    }
    if (summaryRes.status === "fulfilled") {
      setSummary(summaryRes.value);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, live]);

  // Distinct competitions present, for the filter dropdown.
  const competitions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.competition) set.add(e.competition);
    return Array.from(set).sort();
  }, [entries]);

  // Apply filter + search, then sort.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = entries.filter((e) => {
      if (compFilter !== "all" && (e.competition ?? "") !== compFilter) return false;
      if (!q) return true;
      return (
        (e.match ?? "").toLowerCase().includes(q) ||
        (e.competition ?? "").toLowerCase().includes(q) ||
        (e.round ?? "").toLowerCase().includes(q) ||
        String(e.ttId ?? "").includes(q) ||
        (e.playhqId ?? "").toLowerCase().includes(q)
      );
    });
    const dir = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "ts": cmp = a.ts.localeCompare(b.ts); break;
        case "competition": cmp = (a.competition ?? "").localeCompare(b.competition ?? ""); break;
        case "round": cmp = roundNum(a.round) - roundNum(b.round); break;
        case "match": cmp = (a.match ?? "").localeCompare(b.match ?? ""); break;
        case "status": cmp = Number(a.ok) - Number(b.ok); break;
      }
      return cmp * dir;
    });
    return list;
  }, [entries, compFilter, query, sortKey, sortDir]);

  const okCount = rows.filter((e) => e.ok).length;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "ts" ? "desc" : "asc");
    }
  };

  const SortHead = ({ k, label, className = "" }: { k: SortKey; label: string; className?: string }) => (
    <th className={`px-2 py-1.5 font-semibold ${className}`}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:text-slate-200"
      >
        {label}
        {sortKey === k &&
          (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );

  return (
    <div className="min-h-full bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      <div className="mx-auto w-full max-w-6xl px-3 py-5 md:px-4">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-lg font-bold">
            <Radio size={18} className="text-sky-400" />
            Push Activity
          </h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              aria-label="Refresh"
              className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10"
            >
              <RefreshCw size={13} /> Refresh
            </button>
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
                live ? "bg-red-500/20 text-red-300 ring-1 ring-red-500/40" : "bg-white/10 text-slate-300 ring-1 ring-white/15"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-red-400" : "bg-slate-500"}`} />
              {live ? "LIVE" : "Paused"}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select
            value={compFilter}
            onChange={(e) => setCompFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-[#0d1526] px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
          >
            <option value="all">All competitions ({competitions.length})</option>
            {competitions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search team, round, id…"
              className="w-full rounded-md border border-white/10 bg-[#0d1526] py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
          {(compFilter !== "all" || query) && (
            <button
              type="button"
              onClick={() => { setCompFilter("all"); setQuery(""); }}
              className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-[11px] text-slate-400">
            {rows.length} shown · <span className="text-emerald-400">{okCount} ok</span>
            {lastRefresh && <> · updated {clock(lastRefresh.toISOString())}</>}
          </span>
        </div>

        {/* Round summary — latest round per division, every fixture, latest
            score. Scannable for 40+ divisions so the operator doesn't scroll
            hundreds of log rows below. Sourced from the Worker's grade feed +
            push-log join, NOT derived from the log table below. */}
        {summary !== null && (
          <section className="mb-5">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-200">Round summary</h2>
              <span className="text-[11px] text-slate-500">
                Latest round per division · latest score for every fixture
              </span>
            </div>

            {summary.rounds.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-slate-400">
                No divisions to summarise yet.
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {summary.rounds.map((div) => (
                  <div
                    key={div.gradeId}
                    className="overflow-hidden rounded-lg border border-white/10 bg-white/5"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
                      <span className="truncate text-xs font-semibold text-slate-200" title={div.competition}>
                        {div.competition || "—"}
                      </span>
                      {div.roundShort && (
                        <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
                          {div.roundShort}
                        </span>
                      )}
                    </div>
                    {div.fixtures.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-slate-500">No fixtures in this round.</div>
                    ) : (
                      <table className="w-full border-collapse text-[12px] tabular-nums">
                        <tbody>
                          {div.fixtures.map((f) => {
                            const pushed = f.lastPushTs !== null;
                            const rejected = f.ok === false;
                            return (
                              <tr key={f.id} className="border-b border-white/5 last:border-0">
                                <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-400" title={div.round}>
                                  {div.roundShort || "—"}
                                </td>
                                <td
                                  className="max-w-[150px] truncate px-3 py-1 font-medium text-slate-200"
                                  title={shortMatch(f.match)}
                                >
                                  {shortMatch(f.match)}
                                </td>
                                <td className="px-2 py-1">
                                  <span
                                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusChip(f.status)}`}
                                  >
                                    {f.status}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-2 py-1 text-right">
                                  {pushed ? (
                                    <span
                                      className={`font-mono ${rejected ? "text-red-300" : "text-sky-300"}`}
                                    >
                                      {rejected && (
                                        <AlertTriangle size={11} className="mr-1 inline align-[-1px]" />
                                      )}
                                      {f.score || "—"}
                                    </span>
                                  ) : (
                                    <span className="italic text-slate-500">not pushed yet</span>
                                  )}
                                </td>
                                <td className="whitespace-nowrap px-3 py-1 text-right font-mono text-[11px] text-slate-500">
                                  {pushed ? clock(f.lastPushTs as string) : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="mt-2 text-[10px] text-slate-600">
              Shows the latest score still held in the push log (last 100 pushes). A fixture
              pushed earlier that has scrolled out of the log reads &ldquo;not pushed yet&rdquo;.
            </p>
          </section>
        )}

        {/* Body */}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-400">
            {entries.length === 0
              ? "No pushes recorded yet. Entries appear here when a game is live."
              : "No rows match the current filter."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full border-collapse text-[12px] tabular-nums">
              <thead className="sticky top-0 bg-[#0d1526] text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-white/10">
                  <SortHead k="ts" label="Time" />
                  <SortHead k="competition" label="Competition" />
                  <SortHead k="round" label="Rnd" />
                  <SortHead k="match" label="Match" />
                  <th className="px-2 py-1.5 text-right font-semibold">Score</th>
                  <th className="px-2 py-1.5 font-semibold">PlayHQ → TT</th>
                  <SortHead k="status" label="Score" className="text-center" />
                  <th className="px-2 py-1.5 text-center font-semibold">Team</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => {
                  const sReply = cleanReply(e.scoreReply);
                  const tReply = cleanReply(e.teamReply);
                  return (
                    <tr key={`${e.ts}-${e.id}-${i}`} className="border-b border-white/5 hover:bg-white/[0.03]">
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-500">{clock(e.ts)}</td>
                      <td className="max-w-[160px] truncate px-2 py-1 text-slate-300" title={e.competition || ""}>
                        {e.competition || "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-400" title={e.round || ""}>
                        {shortRound(e.round) || "—"}
                      </td>
                      <td className="max-w-[170px] truncate px-2 py-1 font-medium text-slate-200" title={shortMatch(e.match)}>
                        {shortMatch(e.match)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-sky-300">{e.score}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-400">
                        <span title={e.playhqId}>{(e.playhqId || e.id).slice(0, 8)}</span>
                        <span className="mx-1 text-slate-600">→</span>
                        <span className={e.ttId != null ? "text-sky-300" : "text-slate-600"}>
                          {e.ttId != null ? e.ttId : "—"}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-center">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            e.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                          }`}
                        >
                          {sReply || "—"}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-center text-[10px] text-slate-500">{tReply || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-center text-[10px] text-slate-600">
          Auto-refreshes every {POLL_MS / 1000}s · click a column header to sort · filter by competition or search
        </p>
      </div>
    </div>
  );
}
