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
  conciseNote,
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
          {conciseNote(plan) && (
            <div className="text-xs text-slate-500">{conciseNote(plan)}</div>
          )}

          {/* Summary */}
          <section className="rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-500">{plan.summary.headline}</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
              <span className="text-2xl font-bold text-slate-900">{pct(h.overallAccuracy)}</span>
              <span
                className={`text-sm font-medium ${
                  plan.summary.direction === "up"
                    ? "text-emerald-700"
                    : plan.summary.direction === "down"
                      ? "text-red-600"
                      : "text-slate-700"
                }`}
              >
                {plan.summary.accuracyLine.replace(/^Accuracy [\d.]+%\.\s*/, "")}
              </span>
            </div>
            {(h.underDispute > 0 || h.excludedByDispute > 0) && (
              <div className="mt-1 text-xs text-slate-500">
                {h.underDispute > 0 && <>Under dispute: {h.underDispute}. </>}
                {h.excludedByDispute > 0 && <>Excluded (analyst correct): {h.excludedByDispute}.</>}
              </div>
            )}
          </section>

          {/* Strengths */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">
              Strengths (95-100% accuracy)
            </h3>
            {plan.strengths.items.length === 0 ? (
              <div className="text-xs text-slate-600">
                No stats at 95%+ this check (min {C.STRENGTH_MIN_INSTANCES} instances)
                {plan.strengths.fallback.length > 0 && (
                  <>
                    . Best:{" "}
                    {plan.strengths.fallback
                      .map((s) => `${s.stat} ${pct(s.accuracy)} (${s.instances})`)
                      .join(", ")}
                  </>
                )}
              </div>
            ) : (
              <ul className="space-y-1">
                {plan.strengths.items.map((s) => (
                  <li key={s.key} className="flex flex-wrap items-center gap-x-3 text-xs">
                    <span className="font-semibold text-slate-900">{s.stat}</span>
                    <span className="text-emerald-700">{pct(s.accuracy)}</span>
                    <span className="text-slate-500">{s.instances} instances</span>
                    {s.consistency && <span className="text-slate-600">{s.consistency}</span>}
                    {s.trendPoints && <TrendSparkline points={s.trendPoints} width={80} height={18} />}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Focus */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Key focus areas</h3>
            {plan.focus.length === 0 && (
              <div className="text-xs text-slate-500">No focus areas for this scope.</div>
            )}
            <div className="space-y-2">
              {plan.focus.map((f) => (
                <div key={f.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="font-semibold text-slate-900">
                    {f.rank}. {f.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-600">
                    {f.accuracy != null && <span>Accuracy {pct(f.accuracy)}</span>}
                    {f.trendText && <span>{f.trendText}</span>}
                    {f.trendPoints && <TrendSparkline points={f.trendPoints} width={80} height={18} />}
                  </div>
                  <div className="mt-1 text-xs italic text-slate-700">Practice: {f.drill}</div>
                  {f.examples.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
                      {f.examples.map((i) => (
                        <li key={i.key} className="flex items-center gap-2">
                          <span className="tabular-nums">{i.timeLabel}</span>
                          <span>{ERROR_TYPE_LABEL[i.type]}:</span>
                          <span>
                            expected {i.expected ? `${i.expected.team} ${i.expected.player}` : "-"},
                            coded {i.coded ? `${i.coded.team} ${i.coded.player}` : "-"}
                            {i.codedStat && i.codedStat !== i.stat ? ` as ${i.codedStat}` : ""}
                          </span>
                          {onWatch && (
                            <button
                              title="Watch"
                              aria-label="Watch clip"
                              onClick={() => {
                                onWatch(i.startSeconds);
                                onClose();
                              }}
                              className="text-slate-600 hover:text-slate-900"
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
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Appendix: full instance list, collapsed, not printed */}
          <details className="rounded-xl border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-800">
              All instances ({plan.instances.length})
              <span className="ml-2 text-xs font-normal text-slate-500">
                {ERROR_TYPE_ORDER.filter((t) => h.counts[t] > 0)
                  .map((t) => `${ERROR_TYPE_LABEL[t]} ${h.counts[t]}`)
                  .join(", ")}
              </span>
            </summary>
            <div className="mt-3">
              {plan.instances.length === 0 && (
                <div className="text-xs text-slate-500">No errors in this scope.</div>
              )}
              {ERROR_TYPE_ORDER.map((t) => {
                const rows = plan.instances.filter((i) => i.type === t);
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
            </div>
          </details>
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
