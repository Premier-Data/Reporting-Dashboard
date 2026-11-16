"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Download,
  ExternalLink,
  GraduationCap,
  Loader2,
  Play,
  Printer,
  Send,
  X,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import type { ComparisonResult, ComparisonRow } from "@/lib/comparison/xml-compare";
import {
  ERROR_TYPE_LABEL,
  ERROR_TYPE_ORDER,
  TRAINING_TREND_CONSTANTS as C,
  buildDefaultMessage,
  type HistoryWindow,
  type PlanContext,
  type PlanScope,
  type TrainingPlan,
} from "@/lib/comparison/trainingPlan";
import { downloadTrainingPlanExcel } from "@/lib/exports/trainingPlanExcel";
import {
  AnalystNotFoundError,
  MESSAGE_MAX_CHARS,
  canSendTrainingPlan,
  sendTrainingPlanToAnalyst,
} from "@/lib/exports/trainingPlanSend";
import { useTrainingPlan } from "./useTrainingPlan";
import TrendSparkline from "./TrendSparkline";
import TrainingPlanPrintView from "./TrainingPlanPrintView";

export interface TrainingPlanPanelProps {
  open: boolean;
  onClose: () => void;
  result: ComparisonResult;
  scopeRows: ComparisonRow[];
  context: Omit<PlanContext, "reviewBaseUrl">;
  onWatch?: (seconds: number) => void;
}

const WINDOW_OPTIONS: { value: string; label: string }[] = [
  { value: "checks:5", label: "Last 5 checks" },
  { value: "checks:10", label: "Last 10 checks" },
  { value: "checks:20", label: "Last 20 checks" },
  { value: "days:30", label: "Last 30 days" },
  { value: "days:90", label: "Last 90 days" },
  { value: "days:180", label: "Last 180 days" },
];

const RENDER_CAP = 200;
const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);

export default function TrainingPlanPanel(props: TrainingPlanPanelProps) {
  if (!props.open) return null;
  return <Drawer {...props} />;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; to: string }
  | { kind: "error"; message: string };

function Drawer({ onClose, result, scopeRows, context, onWatch }: TrainingPlanPanelProps) {
  const { user } = useAuth();
  const [scope, setScope] = useState<PlanScope>("filters");
  const [windowKey, setWindowKey] = useState(`checks:${C.DEFAULT_HISTORY_CHECKS}`);
  const [includeStats, setIncludeStats] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [printing, setPrinting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendText, setSendText] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });

  const win: HistoryWindow = useMemo(() => {
    const [mode, v] = windowKey.split(":");
    return mode === "days"
      ? { mode: "days", days: Number(v) }
      : { mode: "checks", n: Number(v) };
  }, [windowKey]);

  const { plan, status, progress, error, warnings } = useTrainingPlan(
    { open: true, result, scopeRows, context },
    { scope, window: win, includeStats }
  );

  // Esc closes (the send dialog handles its own Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sendOpen) setSendOpen(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, sendOpen]);

  // Print: wait for the print view to mount, print, reset on afterprint.
  useEffect(() => {
    if (!printing) return;
    const reset = () => setPrinting(false);
    window.addEventListener("afterprint", reset);
    const safety = window.setTimeout(reset, 60_000);
    const raf = window.requestAnimationFrame(() => {
      try {
        window.print();
      } catch (err) {
        console.error("Print failed", err);
        setExportError("Printing is not available in this browser");
        reset();
      }
    });
    return () => {
      window.removeEventListener("afterprint", reset);
      window.clearTimeout(safety);
      window.cancelAnimationFrame(raf);
    };
  }, [printing]);

  const canSend = canSendTrainingPlan(user?.role);
  const analystName = plan.header.analystName;
  const focusKeys = useMemo(() => {
    const f = plan.focus.find((x) => x.id === focusId);
    return f ? new Set(f.instanceKeys) : null;
  }, [plan, focusId]);

  const onExport = async () => {
    setExportError(null);
    try {
      await downloadTrainingPlanExcel(plan);
    } catch (err) {
      console.error(err);
      setExportError(
        `Could not build the Excel file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const openSend = () => {
    const base = `${window.location.origin}${window.location.pathname}`;
    const link = plan.header.checkId != null ? `${base}?check=${plan.header.checkId}` : null;
    setSendText(
      buildDefaultMessage(plan, {
        senderName: user?.analyst_name?.trim() || user?.username || null,
        reviewLink: link,
      })
    );
    setSendState({ kind: "idle" });
    setSendOpen(true);
  };

  const doSend = async () => {
    if (!user || !analystName) return;
    setSendState({ kind: "sending" });
    try {
      const res = await sendTrainingPlanToAnalyst({
        sender: { id: user.id, role: user.role },
        plan,
        text: sendText,
        analystName,
        checkId: plan.header.checkId,
      });
      setSendState({
        kind: "sent",
        to: res.recipient.analystName || res.recipient.username,
      });
    } catch (err) {
      setSendState({
        kind: "error",
        message:
          err instanceof AnalystNotFoundError || err instanceof Error
            ? err.message
            : "Failed to send",
      });
    }
  };

  const h = plan.header;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/40 no-print" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Training plan"
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-3xl flex-col bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
          <GraduationCap size={20} className="mt-0.5 text-slate-600" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900">Recommended training plan</h2>
            <div className="truncate text-xs text-slate-600">
              {h.analystName ?? "No analyst"} - {h.fixture}
              {h.matchLabel ? ` (${h.matchLabel})` : ""}
            </div>
            <div className="truncate text-xs text-slate-500">
              {h.checkId != null ? `Check #${h.checkId}` : "Unsaved comparison"}
              {h.checkDate ? ` - ${h.checkDate.slice(0, 10)}` : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close training plan"
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {/* Options */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="tp-scope"
                checked={scope === "filters"}
                onChange={() => setScope("filters")}
              />
              Current filters
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="tp-scope"
                checked={scope === "all"}
                onChange={() => setScope("all")}
              />
              All instances
            </label>
            <select
              value={windowKey}
              onChange={(e) => setWindowKey(e.target.value)}
              aria-label="History window"
              className="rounded border border-slate-300 px-1.5 py-1"
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={includeStats}
                onChange={(e) => setIncludeStats(e.target.checked)}
              />
              Per-stat history (re-grades earlier checks)
            </label>
          </div>
          <div className="text-xs text-slate-500">Scope: {h.scopeLabel}</div>

          {/* Status */}
          {status === "loading" && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Loader2 size={14} className="animate-spin" />
              {progress
                ? `Analysing check ${Math.min(progress.done + 1, progress.total)} of ${progress.total}...`
                : "Loading history..."}
            </div>
          )}
          {status === "error" && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              History could not be loaded: {error}. The plan below uses this check only.
            </div>
          )}
          {(warnings.length > 0 || plan.notes.length > 0 || plan.trends.notes.length > 0) && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-500">
              {[...plan.notes, ...plan.trends.notes].map((n, i) => (
                <li key={`n${i}`}>{n}</li>
              ))}
            </ul>
          )}

          {/* Header card */}
          <section className="rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <div className="text-2xl font-bold text-slate-900">{pct(h.overallAccuracy)}</div>
                <div className="text-xs text-slate-500">Overall accuracy</div>
              </div>
              <div className="text-xs text-slate-600">
                Analyst average {pct(h.analystAvgAccuracy)} ({h.historyChecksUsed} checks) - All
                analysts {pct(h.allAnalystAvgAccuracy)}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {ERROR_TYPE_ORDER.map((t) => (
                <span key={t} className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-700">
                  {ERROR_TYPE_LABEL[t]}: {h.counts[t]}
                </span>
              ))}
              {h.underDispute > 0 && (
                <span className="rounded bg-amber-100 px-2 py-1 text-amber-800">
                  Under dispute: {h.underDispute}
                </span>
              )}
              {h.excludedByDispute > 0 && (
                <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-800">
                  Excluded (analyst correct): {h.excludedByDispute}
                </span>
              )}
            </div>
            {h.categories.length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="py-1">Category</th>
                    <th>This check</th>
                    <th>Analyst avg</th>
                    <th>All analysts</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {h.categories.map((c) => (
                    <tr key={c.category} className="border-t border-slate-100">
                      <td className="py-1">{c.category}</td>
                      <td>{pct(c.accuracy)}</td>
                      <td>{pct(c.analystAvg)}</td>
                      <td>{pct(c.allAnalystAvg)}</td>
                      <td
                        className={
                          c.deltaVsAnalyst == null
                            ? ""
                            : c.deltaVsAnalyst < 0
                              ? "text-red-600"
                              : "text-emerald-600"
                        }
                      >
                        {c.deltaVsAnalyst == null
                          ? "-"
                          : `${c.deltaVsAnalyst >= 0 ? "+" : ""}${(c.deltaVsAnalyst * 100).toFixed(1)} pts`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Focus */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Focus areas</h3>
            {plan.focus.length === 0 && (
              <div className="text-xs text-slate-500">No focus areas for this scope.</div>
            )}
            <div className="space-y-2">
              {plan.focus.map((f) => (
                <div key={f.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="font-semibold text-slate-900">
                    {f.rank}. {f.title}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">{f.why}</div>
                  <div className="mt-1 text-xs italic text-slate-700">Practice: {f.drill}</div>
                  <button
                    onClick={() => setFocusId(focusId === f.id ? null : f.id)}
                    className="mt-2 text-xs font-semibold text-slate-700 underline"
                  >
                    {focusId === f.id ? "Show all instances" : `Show ${f.instanceKeys.length} instances`}
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Trends */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Trending stats</h3>
            {plan.trends.items.length === 0 ? (
              <div className="text-xs text-slate-500">Nothing flagged.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="py-1">{plan.trends.level === "category" ? "Category" : "Stat"}</th>
                    <th>Why flagged</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.trends.items.map((t) => (
                    <tr key={t.key} className="border-t border-slate-100 align-top">
                      <td className="py-1 pr-2 font-medium">{t.label}</td>
                      <td className="pr-2">{t.reasons.map((r) => r.text).join("; ")}</td>
                      <td>
                        <TrendSparkline points={t.points} />
                        <div className="text-[10px] text-slate-500">
                          {t.points.map((p) => (p.counted ? pct(p.rate) : "-")).join(" / ")}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Instances */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Instances</h3>
            {plan.instances.length === 0 && (
              <div className="text-xs text-slate-500">No errors in this scope.</div>
            )}
            {ERROR_TYPE_ORDER.map((t) => {
              const all = plan.instances.filter((i) => i.type === t);
              const rows = focusKeys ? all.filter((i) => focusKeys.has(i.key)) : all;
              if (rows.length === 0) return null;
              const shown = showAll[t] ? rows : rows.slice(0, RENDER_CAP);
              return (
                <div key={t} className="mb-3">
                  <div className="mb-1 text-xs font-semibold text-slate-700">
                    {ERROR_TYPE_LABEL[t]} ({rows.length})
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {shown.map((i) => (
                        <tr key={i.key} className="border-t border-slate-100 align-top">
                          <td className="py-1 pr-2 tabular-nums">{i.timeLabel}</td>
                          <td className="pr-2">
                            {i.stat}
                            {i.codedStat && i.codedStat !== i.stat && (
                              <span className="text-slate-500"> (coded {i.codedStat})</span>
                            )}
                            {i.alsoWrongPlayer && (
                              <span className="ml-1 rounded bg-slate-100 px-1">+ wrong player</span>
                            )}
                            {i.alsoWrongTeam && (
                              <span className="ml-1 rounded bg-slate-100 px-1">+ wrong team</span>
                            )}
                            {i.dispute.state === "open" && (
                              <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">
                                Under dispute
                              </span>
                            )}
                          </td>
                          <td className="pr-2">
                            {i.expected ? `${i.expected.team} ${i.expected.player}` : "-"}
                          </td>
                          <td className="pr-2">
                            {i.coded ? `${i.coded.team} ${i.coded.player}` : "-"}
                          </td>
                          <td className="whitespace-nowrap">
                            {onWatch && (
                              <button
                                title="Watch"
                                aria-label="Watch clip"
                                onClick={() => {
                                  onWatch(i.startSeconds);
                                  onClose();
                                }}
                                className="mr-1 text-slate-600 hover:text-slate-900"
                              >
                                <Play size={12} />
                              </button>
                            )}
                            {i.videoLink && (
                              <a
                                href={i.videoLink}
                                target="_blank"
                                rel="noreferrer"
                                title="Open video"
                                className="text-slate-600 hover:text-slate-900"
                              >
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > RENDER_CAP && !showAll[t] && (
                    <button
                      onClick={() => setShowAll((s) => ({ ...s, [t]: true }))}
                      className="mt-1 text-xs font-semibold underline"
                    >
                      Show all {rows.length}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        </div>

        {/* Footer */}
        <div className="no-print border-t border-slate-200 px-5 py-3">
          {exportError && <div className="mb-2 text-xs text-red-600">{exportError}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onExport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            >
              <Download size={14} /> Export Excel
            </button>
            <button
              onClick={() => {
                setExportError(null);
                setPrinting(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            >
              <Printer size={14} /> Export PDF
            </button>
            {canSend && (
              <button
                onClick={openSend}
                disabled={!analystName}
                title={analystName ? "Send to analyst" : "No analyst on this comparison"}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                <Send size={14} /> Send to analyst
              </button>
            )}
          </div>
        </div>
      </aside>

      {sendOpen && (
        <div className="fixed inset-0 z-[45] flex items-center justify-center bg-slate-900/50 p-4 no-print">
          <div
            role="dialog"
            aria-label="Send training plan"
            className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl"
          >
            <h3 className="text-sm font-semibold text-slate-900">
              Send to {analystName ?? "analyst"}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Sent as a direct message with the Excel attached. Use Export PDF to share a PDF
              separately.
            </p>
            <textarea
              value={sendText}
              onChange={(e) => setSendText(e.target.value)}
              rows={10}
              maxLength={MESSAGE_MAX_CHARS}
              disabled={sendState.kind === "sending" || sendState.kind === "sent"}
              className="mt-3 w-full rounded border border-slate-300 p-2 text-xs"
            />
            <div className="text-right text-[10px] text-slate-400">
              {sendText.length}/{MESSAGE_MAX_CHARS}
            </div>
            {sendState.kind === "error" && (
              <div className="mt-2 text-xs text-red-600">{sendState.message}</div>
            )}
            {sendState.kind === "sent" && (
              <div className="mt-2 text-xs text-emerald-700">
                Sent to {sendState.to}.{" "}
                <Link href="/messages" className="underline">
                  Open messages
                </Link>
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setSendOpen(false)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold"
              >
                {sendState.kind === "sent" ? "Close" : "Cancel"}
              </button>
              {sendState.kind !== "sent" && (
                <button
                  onClick={doSend}
                  disabled={sendState.kind === "sending"}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {sendState.kind === "sending" && <Loader2 size={12} className="animate-spin" />}
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {printing && <TrainingPlanPrintView plan={plan as TrainingPlan} />}
    </>
  );
}
