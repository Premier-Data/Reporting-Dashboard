// Excel export of a training plan (sheets: Summary, Strengths, Focus, Instances, Trends).
// trainingPlanSheets() is a pure sheet model that drives both the workbook
// writer and the tests. exceljs is loaded on demand.

import {
  ERROR_TYPE_LABEL,
  TRAINING_TREND_CONSTANTS as C,
  type PlanInstance,
  type TrainingPlan,
} from "@/lib/comparison/trainingPlan";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SheetCell = string | number | null | { text: string; hyperlink: string };
export interface SheetModel {
  name: string;
  columns: { header: string; key: string; width: number }[];
  rows: Record<string, SheetCell>[];
  /** keys whose numeric cells are formatted as percent */
  percentKeys?: string[];
}

const pct1 = (n: number | null) => (n == null ? "" : `${(n * 100).toFixed(1)}%`);
const signedPts = (n: number | null) =>
  n == null ? "" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)} pts`;

export function trainingPlanSheets(plan: TrainingPlan): SheetModel[] {
  const h = plan.header;
  const w = plan.options.window;
  const windowLabel = w.mode === "checks" ? `Last ${w.n} checks` : `Last ${w.days} days`;

  // Summary: concise, incl. strengths and focus
  const kv: [string, SheetCell][] = [
    ["Analyst", h.analystName ?? ""],
    ["Fixture", h.fixture],
    ["Match label", h.matchLabel ?? ""],
    ["Master file", h.masterFileName ?? ""],
    ["Sport", h.sport ?? ""],
    ["Check ID", h.checkId ?? "Unsaved comparison"],
    ["Check date", h.checkDate ?? ""],
    ["Generated", plan.generatedAt],
    ["Scope", h.scopeLabel],
    ["History window", windowLabel],
    ["Checks used", h.historyChecksUsed],
    ["Overall accuracy", pct1(h.overallAccuracy)],
    ["Analyst average", pct1(h.analystAvgAccuracy)],
    ["All-analyst average", pct1(h.allAnalystAvgAccuracy)],
    ["Summary", plan.summary.accuracyLine],
    ...(Object.keys(ERROR_TYPE_LABEL) as (keyof typeof ERROR_TYPE_LABEL)[]).map(
      (t): [string, SheetCell] => [ERROR_TYPE_LABEL[t], h.counts[t]]
    ),
    ["Excluded by dispute (analyst correct)", h.excludedByDispute],
    ["Under dispute", h.underDispute],
  ];
  const blank = (): Record<string, SheetCell> => ({ a: null, b: null, c: null, d: null, e: null });
  const summaryRows: Record<string, SheetCell>[] = kv.map(([a, b]) => ({
    ...blank(),
    a,
    b,
  }));
  summaryRows.push(blank());
  summaryRows.push({ ...blank(), a: "Strengths (95%+ accuracy)", b: "Accuracy", c: "Instances", d: "History" });
  if (plan.strengths.items.length === 0) {
    summaryRows.push({
      ...blank(),
      a: `No stats at 95%+ this check (min ${C.STRENGTH_MIN_INSTANCES} instances)`,
    });
    for (const s of plan.strengths.fallback)
      summaryRows.push({ ...blank(), a: `Best: ${s.stat}`, b: pct1(s.accuracy), c: s.instances, d: s.consistency ?? "" });
  }
  for (const s of plan.strengths.items)
    summaryRows.push({ ...blank(), a: s.stat, b: pct1(s.accuracy), c: s.instances, d: s.consistency ?? "" });
  summaryRows.push(blank());
  summaryRows.push({ ...blank(), a: "Key focus areas", b: "Accuracy", c: "Trend", d: "Practice" });
  if (plan.focus.length === 0) summaryRows.push({ ...blank(), a: "No focus areas for this scope." });
  for (const f of plan.focus)
    summaryRows.push({ ...blank(), a: `${f.rank}. ${f.title}`, b: pct1(f.accuracy), c: f.trendText, d: f.drill });
  summaryRows.push(blank());
  summaryRows.push({
    ...blank(),
    a: "Category",
    b: "This check",
    c: "Analyst average",
    d: "All-analyst average",
    e: "Delta vs analyst",
  });
  for (const c of h.categories) {
    summaryRows.push({
      a: c.category,
      b: pct1(c.accuracy),
      c: pct1(c.analystAvg),
      d: pct1(c.allAnalystAvg),
      e: signedPts(c.deltaVsAnalyst),
    });
  }
  const noteList = [...plan.notes, ...plan.trends.notes];
  if (noteList.length > 0) {
    summaryRows.push(blank());
    summaryRows.push({ ...blank(), a: "Notes" });
    for (const n of noteList) summaryRows.push({ ...blank(), a: n });
  }
  const summary: SheetModel = {
    name: "Summary",
    columns: [
      { header: "Training plan", key: "a", width: 44 },
      { header: "Value", key: "b", width: 30 },
      { header: "", key: "c", width: 30 },
      { header: "", key: "d", width: 50 },
      { header: "", key: "e", width: 18 },
    ],
    rows: summaryRows,
  };

  // Strengths: every stat at 95%+ (min instances), not just the top 5
  const strengthRows = plan.strengths.all.length > 0 ? plan.strengths.all : plan.strengths.fallback;
  const strengths: SheetModel = {
    name: "Strengths",
    columns: [
      { header: "Stat", key: "stat", width: 28 },
      { header: "Accuracy", key: "acc", width: 11 },
      { header: "Instances", key: "n", width: 11 },
      { header: "Qualifies (95%+)", key: "q", width: 16 },
      { header: "History", key: "hist", width: 44 },
    ],
    rows: strengthRows.map((s) => ({
      stat: s.stat,
      acc: pct1(s.accuracy),
      n: s.instances,
      q: plan.strengths.all.length > 0 ? "Yes" : "No (best available)",
      hist: s.consistency ?? "",
    })),
  };

  // Focus (max FOCUS_MAX) with example instances
  const exampleText = (i: PlanInstance): SheetCell => {
    const text = `${i.timeLabel} ${ERROR_TYPE_LABEL[i.type]}: expected ${
      i.expected ? `${i.expected.team} ${i.expected.player}` : "-"
    }, coded ${i.coded ? `${i.coded.team} ${i.coded.player}` : "-"}${
      i.codedStat && i.codedStat !== i.stat ? ` as ${i.codedStat}` : ""
    }`;
    return i.videoLink ? { text, hyperlink: i.videoLink } : text;
  };
  const focus: SheetModel = {
    name: "Focus",
    columns: [
      { header: "#", key: "rank", width: 5 },
      { header: "Focus", key: "title", width: 40 },
      { header: "Accuracy", key: "acc", width: 11 },
      { header: "Trend", key: "trend", width: 40 },
      { header: "Error types", key: "why", width: 26 },
      { header: "Suggested practice", key: "drill", width: 60 },
      { header: "Instances", key: "n", width: 11 },
      { header: "Example 1", key: "ex0", width: 46 },
      { header: "Example 2", key: "ex1", width: 46 },
      { header: "Example 3", key: "ex2", width: 46 },
    ],
    rows: plan.focus.map((f) => ({
      rank: f.rank,
      title: f.title,
      acc: pct1(f.accuracy),
      trend: f.trendText,
      why: f.why,
      drill: f.drill,
      n: f.instanceKeys.length,
      ex0: f.examples[0] ? exampleText(f.examples[0]) : null,
      ex1: f.examples[1] ? exampleText(f.examples[1]) : null,
      ex2: f.examples[2] ? exampleText(f.examples[2]) : null,
    })),
  };
  // Instances
  const link = (text: string, url: string | null): SheetCell =>
    url ? { text, hyperlink: url } : null;
  const instances: SheetModel = {
    name: "Instances",
    columns: [
      { header: "Type", key: "type", width: 14 },
      { header: "Time", key: "time", width: 8 },
      { header: "Stat (expected)", key: "stat", width: 24 },
      { header: "Stat (coded)", key: "coded", width: 24 },
      { header: "Category", key: "category", width: 18 },
      { header: "Expected team", key: "eTeam", width: 18 },
      { header: "Expected player", key: "ePlayer", width: 16 },
      { header: "Coded team", key: "cTeam", width: 18 },
      { header: "Coded player", key: "cPlayer", width: 16 },
      { header: "Also wrong player", key: "alsoPlayer", width: 12 },
      { header: "Also wrong team", key: "alsoTeam", width: 12 },
      { header: "Time delta (s)", key: "delta", width: 12 },
      { header: "Dispute", key: "dispute", width: 14 },
      { header: "Video link", key: "video", width: 14 },
      { header: "Review link", key: "review", width: 14 },
    ],
    rows: plan.instances.map((i) => ({
      type: ERROR_TYPE_LABEL[i.type],
      time: i.timeLabel,
      stat: i.stat,
      coded: i.codedStat ?? "",
      category: i.category,
      eTeam: i.expected?.team ?? "",
      ePlayer: i.expected?.player ?? "",
      cTeam: i.coded?.team ?? "",
      cPlayer: i.coded?.player ?? "",
      alsoPlayer: i.alsoWrongPlayer ? "Yes" : "No",
      alsoTeam: i.alsoWrongTeam ? "Yes" : "No",
      delta: i.timeDelta == null ? null : Math.round(i.timeDelta * 100) / 100,
      dispute: i.dispute.state === "open" ? "Under dispute" : i.dispute.state === "denied" ? "Denied" : "",
      video: link("Watch", i.videoLink),
      review: link("Review", i.reviewLink),
    })),
  };

  // Trends
  const pointCols = (plan.trends.items[0]?.points ?? []).map((p, idx) => ({
    header: p.isCurrent ? "This check" : `${p.date} #${p.checkId}`,
    key: `p${idx}`,
    width: 14,
  }));
  const trends: SheetModel = {
    name: "Trends",
    columns: [
      { header: "Item", key: "item", width: 26 },
      { header: "Level", key: "level", width: 10 },
      { header: "Flags", key: "flags", width: 26 },
      { header: "Why flagged", key: "why", width: 70 },
      { header: "Errors now", key: "now", width: 11 },
      ...pointCols,
    ],
    rows: plan.trends.items.map((t) => {
      const row: Record<string, SheetCell> = {
        item: t.label,
        level: t.level,
        flags: t.reasons.map((r) => r.kind).join(", "),
        why: t.reasons.map((r) => r.text).join("; "),
        now: t.currentErrors,
      };
      t.points.forEach((p, idx) => {
        row[`p${idx}`] = p.counted && p.rate != null ? p.rate : null;
      });
      return row;
    }),
    percentKeys: pointCols.map((c) => c.key),
  };

  return [summary, strengths, focus, instances, trends];
}

export function trainingPlanFileName(plan: TrainingPlan): string {
  const h = plan.header;
  const ident = h.checkId != null ? `check ${h.checkId}` : h.matchLabel || "unsaved";
  const date = (plan.generatedAt || "").slice(0, 10);
  const raw = `Training plan - ${h.analystName || "analyst"} - ${ident} - ${date}.xlsx`;
  return raw.replace(/[^\w. -]+/g, "_");
}

export async function buildTrainingPlanWorkbook(
  plan: TrainingPlan
): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  for (const sheet of trainingPlanSheets(plan)) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));
    for (const r of sheet.rows) ws.addRow(r);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const key of sheet.percentKeys ?? []) ws.getColumn(key).numFmt = "0%";
    ws.eachRow((row) => {
      row.alignment = { vertical: "top", wrapText: true };
    });
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function downloadTrainingPlanExcel(plan: TrainingPlan): Promise<void> {
  const buffer = await buildTrainingPlanWorkbook(plan);
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = trainingPlanFileName(plan);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
