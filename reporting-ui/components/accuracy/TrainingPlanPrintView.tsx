"use client";

import { createPortal } from "react-dom";
import {
  ERROR_TYPE_LABEL,
  TRAINING_TREND_CONSTANTS as C,
  conciseNote,
  type TrainingPlan,
} from "@/lib/comparison/trainingPlan";
import TrendSparkline from "./TrendSparkline";

const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);

/**
 * Print-only, light, single-column version of the plan: summary, strengths and
 * the key focus areas (aimed at one A4 page). The full instance list is NOT
 * printed (it is in the on-screen appendix and the Excel export). Rendered
 * through a portal into document.body ONLY while printing; the CSS in
 * app/globals.css (scoped with body:has(#training-plan-print-root)) hides the
 * rest of the page and this root's screen display. No header/nav/aside
 * elements (the global print rules hide those).
 */
export default function TrainingPlanPrintView({ plan }: { plan: TrainingPlan }) {
  if (typeof document === "undefined") return null;
  const h = plan.header;
  const note = conciseNote(plan);
  return createPortal(
    <div id="training-plan-print-root" className="print-document p-6 text-sm">
      <h1 className="text-xl font-bold">Recommended training plan</h1>
      <div className="mt-1 text-slate-700">
        {h.analystName ?? "Analyst"} - {h.fixture}
        {h.matchLabel ? ` (${h.matchLabel})` : ""}
      </div>
      <div className="text-xs text-slate-500">
        {h.checkId != null ? `Check #${h.checkId}` : "Unsaved comparison"}
        {h.checkDate ? ` - ${h.checkDate.slice(0, 10)}` : ""} - Scope: {h.scopeLabel}
      </div>
      <div className="print-keep mt-3">{plan.summary.accuracyLine}</div>

      <h2 className="mt-4 text-base font-semibold">Strengths (95-100% accuracy)</h2>
      {plan.strengths.items.length === 0 ? (
        <div className="text-slate-600">
          No stats at 95%+ this check (min {C.STRENGTH_MIN_INSTANCES} instances)
          {plan.strengths.fallback.length > 0 &&
            `. Best: ${plan.strengths.fallback.map((s) => `${s.stat} ${pct(s.accuracy)}`).join(", ")}`}
        </div>
      ) : (
        <ul className="list-disc pl-5">
          {plan.strengths.items.map((s) => (
            <li key={s.key} className="print-keep">
              <strong>{s.stat}</strong> {pct(s.accuracy)} ({s.instances} instances)
              {s.consistency ? ` - ${s.consistency}` : ""}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-4 text-base font-semibold">Key focus areas</h2>
      {plan.focus.length === 0 && <div className="text-slate-500">No focus areas.</div>}
      {plan.focus.map((f) => (
        <div key={f.id} className="print-keep mt-2">
          <div className="font-semibold">
            {f.rank}. {f.title}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-xs">
            {f.accuracy != null && <span>Accuracy {pct(f.accuracy)}</span>}
            {f.trendText && <span>{f.trendText}</span>}
            {f.trendPoints && <TrendSparkline points={f.trendPoints} width={80} height={18} />}
          </div>
          <div className="italic">Practice: {f.drill}</div>
          <ul className="list-disc pl-5 text-xs">
            {f.examples.map((i) => (
              <li key={i.key}>
                {i.timeLabel} {ERROR_TYPE_LABEL[i.type]}: expected{" "}
                {i.expected ? `${i.expected.team} ${i.expected.player}` : "-"}, coded{" "}
                {i.coded ? `${i.coded.team} ${i.coded.player}` : "-"}
                {i.codedStat && i.codedStat !== i.stat ? ` as ${i.codedStat}` : ""}
                {i.videoLink ? ` - ${i.videoLink}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {note && <div className="mt-4 text-xs text-slate-500">{note}</div>}
    </div>,
    document.body
  );
}