// Excel export of the Disputes dashboard table (one sheet). exceljs is loaded
// on demand and the download is client-side only (static export friendly).

import type { AnalystDisputeRow } from "@/lib/analytics/disputeDashboard";
import { percentText } from "@/lib/analytics/disputeOutcome";
import { XLSX_MIME } from "@/lib/exports/trainingPlanExcel";

export const DASHBOARD_HEADERS = [
  "Analyst",
  "Checks",
  "Disputes created",
  "Resolved",
  "Open",
  "Analyst correct",
  "Master correct",
  "Analyst correct %",
  "Master correct %",
  "Avg disputes per check",
] as const;

/** Header + body rows (analysts then the totals row) as plain cell values. */
export function dashboardSheetRows(
  rows: AnalystDisputeRow[],
  totals: AnalystDisputeRow
): (string | number)[][] {
  const line = (r: AnalystDisputeRow): (string | number)[] => [
    r.analyst,
    r.checks,
    r.total,
    r.resolved,
    r.open,
    r.analystCorrect,
    r.masterCorrect,
    percentText(r.analystPct),
    percentText(r.masterPct),
    r.avgPerCheck == null ? "n/a" : Math.round(r.avgPerCheck * 100) / 100,
  ];
  return [[...DASHBOARD_HEADERS], ...rows.map(line), line(totals)];
}

export async function downloadDisputeDashboardExcel(
  rows: AnalystDisputeRow[],
  totals: AnalystDisputeRow,
  fileLabel: string
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Disputes dashboard");
  const data = dashboardSheetRows(rows, totals);
  data.forEach((r) => ws.addRow(r));
  ws.columns = DASHBOARD_HEADERS.map((_, i) => ({ width: i === 0 ? 28 : 18 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(data.length).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.addRow([]);
  ws.addRow([
    "Percentages = outcome count / RESOLVED disputes (open excluded). Avg per check = disputes / all of the analyst's active checks in the filter.",
  ]);
  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Disputes dashboard - ${fileLabel}.xlsx`.replace(/[<>:"/\\|?*]+/g, "_");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
