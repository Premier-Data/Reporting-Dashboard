"use client";

// Push Activity — a live console of every score/team-list push the Cloudflare
// Worker sends to the TT (JADE) production endpoint. Backed by the Worker's
// KV-stored log (/api/push-log), so it works on the deployed GitHub Pages site
// from any device (phone, another computer) with no local terminal needed.
//
// The cron pushes live fixtures every minute; this page polls the log every
// few seconds and shows newest-first, with each push's match, score, the TT
// URL it hit, and TT's reply (✓ when accepted).

import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Loader2, AlertTriangle, RefreshCw, CheckCircle2, XCircle } from "lucide-react";

import { getPushLog, type PushLogEntry } from "@/lib/api/playhq";

const POLL_MS = 5_000;

function cleanReply(s: string): string {
  // TT replies are JSON strings like "\"ok\"" — strip the wrapping quotes.
  return (s ?? "").replace(/^"+|"+$/g, "");
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
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
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <Radio size={20} className="text-sky-400" />
              Push Activity
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Live feed of scores sent to the JADE production endpoint.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              live
                ? "bg-red-500/20 text-red-300 ring-1 ring-red-500/40"
                : "bg-white/10 text-slate-300 ring-1 ring-white/15"
            }`}
            title={live ? "Auto-refresh on — tap to pause" : "Auto-refresh paused — tap to resume"}
          >
            <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-red-400" : "bg-slate-500"}`} />
            {live ? "LIVE" : "Paused"}
          </button>
        </div>

        {/* Status bar */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
          <span>{entries.length} recent push{entries.length === 1 ? "" : "es"}</span>
          <span className="text-emerald-400">{okCount} accepted</span>
          {lastRefresh && <span>updated {lastRefresh.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>}
          <button
            type="button"
            onClick={load}
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-slate-300 transition hover:bg-white/10"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {/* Body */}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin" /> Loading push log…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-400">
            No pushes recorded yet. The worker pushes live fixtures every minute —
            entries will appear here when a game is in progress.
          </div>
        ) : (
          <ul className="space-y-2">
            {entries.map((e, i) => {
              const reply = cleanReply(e.scoreReply);
              return (
                <li
                  key={`${e.ts}-${e.id}-${i}`}
                  className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {e.ok ? (
                          <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />
                        ) : (
                          <XCircle size={16} className="shrink-0 text-red-400" />
                        )}
                        <span className="truncate text-sm font-semibold text-slate-100">
                          {e.match || e.id}
                        </span>
                      </div>
                      <div className="mt-1 pl-6 font-mono text-sm tabular-nums text-sky-300">
                        {e.score}
                      </div>
                    </div>
                    <span className="shrink-0 text-right text-[11px] text-slate-500">
                      {timeLabel(e.ts)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] text-slate-500">
                    <span
                      className={`rounded px-1.5 py-0.5 font-semibold ${
                        e.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                      }`}
                    >
                      score: {reply || "—"}
                    </span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5">
                      team: {cleanReply(e.teamReply) || "—"}
                    </span>
                    <span className="truncate">{e.endpoint}/PlayHQScoreUpdate</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-6 text-center text-[11px] text-slate-600">
          Auto-refreshes every {POLL_MS / 1000}s · pushes fire from the worker cron each minute
        </p>
      </div>
    </div>
  );
}
