"use client";

// Push Activity — a compact, single-row-per-push table of every score the
// Cloudflare Worker sends to the TT (JADE) production endpoint. Backed by the
// Worker's KV log (/api/push-log), so it works on the deployed site from any
// device. Designed for hundreds of rows: dense table, one line each, no bulk.

import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Loader2, AlertTriangle, RefreshCw } from "lucide-react";

import { getPushLog, type PushLogEntry } from "@/lib/api/playhq";

const POLL_MS = 5_000;

function cleanReply(s: string): string {
  return (s ?? "").replace(/^"+|"+$/g, "");
}

// The worker now sends a clean "Home vs Away" (grade suffix already stripped),
// plus separate grade + round. Just normalise the "vs" separator for display.
function shortMatch(match: string): string {
  return (match ?? "").replace(/\s+vs\s+/i, " v ");
}

// Compact round label: "Round 2" -> "R2", finals keep their short form.
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

// Compact time: "10:19:14" (today) — just the clock, since rows are frequent.
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export default function PushLogPage() {
  const [entries, setEntries] = useState<PushLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [live, setLive] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const data = await getPushLog(ctrl.signal);
      if (ctrl.signal.aborted) return;
      setEntries(data);
      setError(null);
      setLastRefresh(new Date());
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Failed to load push log.");
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, live]);

  const okCount = entries.filter((e) => e.ok).length;

  return (
    <div className="min-h-full bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      <div className="mx-auto w-full max-w-5xl px-3 py-5 md:px-4">
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
              title={live ? "Auto-refresh on — tap to pause" : "Paused — tap to resume"}
            >
              <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-red-400" : "bg-slate-500"}`} />
              {live ? "LIVE" : "Paused"}
            </button>
          </div>
        </div>

        {/* Status line */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
          <span>{entries.length} pushes</span>
          <span className="text-emerald-400">{okCount} ok</span>
          {entries.length - okCount > 0 && (
            <span className="text-red-400">{entries.length - okCount} failed</span>
          )}
          {lastRefresh && <span className="ml-auto">updated {clock(lastRefresh.toISOString())}</span>}
        </div>

        {/* Body */}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-400">
            No pushes recorded yet. Entries appear here when a game is live.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full border-collapse text-[12px] tabular-nums">
              <thead className="sticky top-0 bg-[#0d1526] text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-white/10">
                  <th className="px-2 py-1.5 font-semibold">Time</th>
                  <th className="px-2 py-1.5 font-semibold">Grade</th>
                  <th className="px-2 py-1.5 font-semibold">Rnd</th>
                  <th className="px-2 py-1.5 font-semibold">Match</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Score</th>
                  <th className="px-2 py-1.5 font-semibold">PlayHQ → TT</th>
                  <th className="px-2 py-1.5 text-center font-semibold">Score</th>
                  <th className="px-2 py-1.5 text-center font-semibold">Team</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const sReply = cleanReply(e.scoreReply);
                  const tReply = cleanReply(e.teamReply);
                  return (
                    <tr
                      key={`${e.ts}-${e.id}-${i}`}
                      className="border-b border-white/5 hover:bg-white/[0.03]"
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-500">
                        {clock(e.ts)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1">
                        {e.grade ? (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              e.grade === "Women's"
                                ? "bg-fuchsia-500/15 text-fuchsia-300"
                                : "bg-sky-500/15 text-sky-300"
                            }`}
                          >
                            {e.grade}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-400" title={e.round || ""}>
                        {shortRound(e.round) || "—"}
                      </td>
                      <td className="max-w-[180px] truncate px-2 py-1 font-medium text-slate-200" title={shortMatch(e.match)}>
                        {shortMatch(e.match)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-sky-300">
                        {e.score}
                      </td>
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
                      <td className="px-2 py-1 text-center text-[10px] text-slate-500">
                        {tReply || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-center text-[10px] text-slate-600">
          Auto-refreshes every {POLL_MS / 1000}s · pushes fire from the worker each minute
        </p>
      </div>
    </div>
  );
}
