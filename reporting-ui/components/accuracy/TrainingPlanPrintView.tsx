"use client";

import { createPortal } from "react-dom";
import {
  ERROR_TYPE_LABEL,
  ERROR_TYPE_ORDER,
  type TrainingPlan,
} from "@/lib/comparison/trainingPlan";

const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);

/**
 * Print-only, light, single-column version of the plan. Rendered through a
 * portal into document.body ONLY while printing; the CSS in app/globals.css
 * (scoped with body:has(#training-plan-print-root)) hides the rest of the page
 * and this root's screen display. No header/nav/aside elements (the global
 * print rules hide those).
 */
export default function TrainingPlanPrintView({ plan }: { plan: TrainingPlan }) {
  if (typeof document === "undefined") return null;
  const h = plan.header;
  return createPortal(
    <div id="training-plan-print-root" className="print-document p-6 text-sm">
      <h1 className="text-xl font-bold">Recommended training plan</h1>
      <div className="mt-1 text-slate-700">
        {h.analystName ?? "Analyst"} - {h.fixture}
        {h.matchLabel ? ` (${h.matchLabel})` : ""}
      </div>
      <div className="text-xs text-slate-500">
        {h.masterFileName ? `Master: ${h.masterFileName} - ` : ""}
        {h.checkId != null ? `Check #${h.checkId}` : "Unsaved comparison"}
        {h.checkDate ? ` - ${h.checkDate.slice(0, 10)}` : ""} - Scope: {h.scopeLabel}
      </div>

      <div className="print-keep mt-4">
        <div>
          Overall accuracy <strong>{pct(h.overallAccuracy)}</strong>
          {h.analystAvgAccuracy != null && <> - analyst average {pct(h.analystAvgAccuracy)}</>}
          {h.allAnalystAvgAccuracy != null && <> - all analysts {pct(h.allAnalystAvgAccuracy)}</>}
        </div>
        <div>
          {ERROR_TYPE_ORDER.map((t) => `${ERROR_TYPE_LABEL[t]}: ${h.counts[t]}`).join("   ")}
        </div>
        {(h.excludedByDispute > 0 || h.underDispute > 0) && (
          <div className="text-xs text-slate-500">
            Excluded by dispute: {h.excludedByDispute} - Under dispute: {h.underDispute}
          </div>
        )}
      </div>

      <h2 className="mt-5 text-base font-semibold">Focus areas</h2>
      {plan.focus.length === 0 && <div className="text-slate-500">No focus areas.</div>}
      {plan.focus.map((f) => (
        <div key={f.id} className="print-keep mt-2">
          <div className="font-semibold">
            {f.rank}. {f.title}
          </div>
          <div>{f.why}</div>
          <div className="italic">Practice: {f.drill}</div>
        </div>
      ))}

      <h2 className="mt-5 text-base font-semibold">Trending stats</h2>
      {plan.trends.items.length === 0 ? (
        <div className="text-slate-500">{plan.trends.notes.join(" ") || "None flagged."}</div>
      ) : (
        <table className="mt-1 w-full border-collapse text-xs">
          <thead>
            <tr className="text-left">
              <th className="border-b py-1">Item</th>
              <th className="border-b py-1">Why flagged</th>
              <th className="border-b py-1">Error rate by check (oldest to current)</th>
            </tr>
          </thead>
          <tbody>
            {plan.trends.items.map((t) => (
              <tr key={t.key} className="align-top">
                <td className="border-b py-1 pr-2">{t.label}</td>
                <td className="border-b py-1 pr-2">{t.reasons.map((r) => r.text).join("; ")}</td>
                <td className="border-b py-1">
                  {t.points.map((p) => (p.counted ? pct(p.rate) : "-")).join(" / ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-5 text-base font-semibold">Instances</h2>
      {ERROR_TYPE_ORDER.map((t) => {
        const rows = plan.instances.filter((i) => i.type === t);
        if (rows.length === 0) return null;
        return (
          <div key={t} className="mt-3">
            <h3 className="font-semibold">
              {ERROR_TYPE_LABEL[t]} ({rows.length})
            </h3>
            <table className="mt-1 w-full border-collapse text-xs">
              <thead>
                <tr className="text-left">
                  <th className="border-b py-1">Time</th>
                  <th className="border-b py-1">Stat</th>
                  <th className="border-b py-1">Expected</th>
                  <th className="border-b py-1">Coded</th>
                  <th className="border-b py-1">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.key} className="align-top">
                    <td className="border-b py-0.5 pr-2">{i.timeLabel}</td>
                    <td className="border-b py-0.5 pr-2">
                      {i.stat}
                      {i.codedStat && i.codedStat !== i.stat ? ` (coded ${i.codedStat})` : ""}
                    </td>
                    <td className="border-b py-0.5 pr-2">
                      {i.expected ? `${i.expected.team} ${i.expected.player}` : "-"}
                    </td>
                    <td className="border-b py-0.5 pr-2">
                      {i.coded ? `${i.coded.team} ${i.coded.player}` : "-"}
                    </td>
                    <td className="border-b py-0.5">
                      {[
                        i.alsoWrongPlayer ? "also wrong player" : "",
                        i.alsoWrongTeam ? "also wrong team" : "",
                        i.dispute.state === "open" ? "under dispute" : "",
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {plan.notes.length > 0 && (
        <div className="mt-5 text-xs text-slate-500">
          {plan.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}
