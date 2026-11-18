// Excel export of one check's dispute results (one sheet).
// disputeResultsModel() is a pure data -> cell model function that drives both
// the workbook writer and the tests. exceljs is loaded on demand and the
// download is client-side only (static export friendly).

import { defaultMapCategory } from "@/lib/comparison/json-adapter";
import { XLSX_MIME } from "@/lib/exports/trainingPlanExcel";

// Structural subset of Dispute (lib/api/disputes.ts). Not imported from there
// because that module creates the Supabase client at import time.
export interface ExportDispute {
  id: number;
  stat: string | null;
  code_time: number | null;
  reason: string | null;
  category: string | null;
  status: "open" | "confirmed" | "denied";
  resolution_note: string | null;
}

export interface DisputeResultsInput {
  match: string;
  master: string;
  analyst: string;
  /** Already formatted dd/mm/yyyy (as shown in the Disputes table). */
  date: string;
  disputes: ExportDispute[];
  /** Label for a flag category (disputeCategoryLabel from lib/api/disputes). */
  categoryLabel: (category: string | null) => string;
}

export const RESULT_LABEL: Record<ExportDispute["status"], string> = {
  confirmed: "Analyst Correct",
  denied: "Master Correct",
  open: "Open",
};

export const DISPUTE_COLUMNS = [
  { header: "Timestamp", width: 11 },
  { header: "Statistic", width: 28 },
  { header: "Statistic Category", width: 18 },
  { header: "Dispute Category", width: 24 },
  { header: "Reason", width: 44 },
  { header: "Result", width: 16 },
  // Resolution Notes spans this and the remaining header-strip columns.
  { header: "Resolution Notes", width: 16 },
  { header: "", width: 16 },
  { header: "", width: 16 },
  { header: "", width: 14 },
] as const;
/** Number of sheet columns (A..J). Resolution Notes is merged G:J. */
export const SHEET_COLS = DISPUTE_COLUMNS.length;

export const ANALYST_CORRECT_NOTE =
  "Analyst Correct % = disputes resolved as Analyst Correct divided by RESOLVED disputes " +
  "(open disputes are excluded from the denominator), rounded to a whole percent. " +
  "n/a when nothing is resolved yet.";

export interface DisputeResultRow {
  timestamp: string;
  statistic: string;
  statCategory: string;
  disputeCategory: string;
  reason: string;
  result: string;
  resolutionNotes: string;
}

export interface DisputeResultsModel {
  fileName: string;
  title: string;
  strip: { label: string; value: string | number }[];
  total: number;
  resolved: number;
  open: number;
  correct: number;
  /** Whole-percent fraction (0.23) or null when nothing is resolved. */
  correctFraction: number | null;
  correctText: string;
  headers: string[];
  rows: DisputeResultRow[];
  footer: string;
  correctNote: string;
}

/** Seconds -> hh:mm:ss (hours not wrapped at 24). Null/invalid -> "". */
export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Windows-safe "<Match> - Dispute results.xlsx". */
export function disputeResultsFileName(match: string): string {
  const safe = (match || "Check")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return `${safe || "Check"} - Dispute results.xlsx`;
}

/** Merge the analyst's reason / supervisor's note into the two note cells.
 * Blank notes become "". Kept as a function so extra note sources can be
 * appended later as separate lines. */
export function mergeNotes(
  ...parts: (string | null | undefined)[]
): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Stat category for a dispute's stat label (Passing / Shots / ...). Disputes
 * store the plural label ("Long Passes Unsuccessful") but the shared keyword
 * classifier matches singular words, so singularise each word first. */
export function statCategoryOf(stat: string): string {
  const singular = stat
    .split(/\s+/)
    .map((w) =>
      /(ss|ies)$/i.test(w)
        ? w
        : /(ch|sh|x|ss)es$/i.test(w)
          ? w.slice(0, -2)
          : /s$/i.test(w)
            ? w.slice(0, -1)
            : w
    )
    .join(" ");
  return defaultMapCategory(undefined, singular);
}

export function disputeResultsModel(input: DisputeResultsInput): DisputeResultsModel {
  const sorted = [...input.disputes].sort((a, b) => {
    const ta = a.code_time ?? Number.POSITIVE_INFINITY;
    const tb = b.code_time ?? Number.POSITIVE_INFINITY;
    return ta === tb ? a.id - b.id : ta - tb;
  });

  const total = sorted.length;
  const resolved = sorted.filter((d) => d.status !== "open").length;
  const correct = sorted.filter((d) => d.status === "confirmed").length;
  const open = total - resolved;
  const correctFraction = resolved > 0 ? Math.round((correct / resolved) * 100) / 100 : null;
  const correctText = correctFraction == null ? "n/a" : `${Math.round(correctFraction * 100)}%`;

  const rows: DisputeResultRow[] = sorted.map((d) => ({
    timestamp: formatTimestamp(d.code_time),
    statistic: d.stat ?? "",
    statCategory: d.stat ? statCategoryOf(d.stat) : "",
    disputeCategory: input.categoryLabel(d.category),
    reason: mergeNotes(d.reason),
    result: RESULT_LABEL[d.status] ?? d.status,
    resolutionNotes: mergeNotes(d.resolution_note),
  }));

  return {
    fileName: disputeResultsFileName(input.match),
    title: input.match,
    strip: [
      { label: "Master", value: input.master },
      { label: "Analyst", value: input.analyst },
      { label: "Date", value: input.date },
      { label: "Total Disputes", value: total },
      { label: "Analyst Correct", value: correctText },
    ],
    total,
    resolved,
    open,
    correct,
    correctFraction,
    correctText,
    headers: DISPUTE_COLUMNS.slice(0, 7).map((c) => c.header),
    rows,
    footer: `Resolved: ${resolved}, Open: ${open}, Analyst Correct: ${correct}`,
    correctNote: ANALYST_CORRECT_NOTE,
  };
}

const THIN = { style: "thin" as const };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const GREY = {
  type: "pattern" as const,
  pattern: "solid" as const,
  fgColor: { argb: "FFD9D9D9" },
};

export async function buildDisputeResultsWorkbook(
  model: DisputeResultsModel
): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Dispute results");
  ws.columns = DISPUTE_COLUMNS.map((c) => ({ width: c.width }));

  // Row 1: title
  ws.mergeCells(1, 1, 1, SHEET_COLS);
  const title = ws.getCell(1, 1);
  title.value = model.title;
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: "center", vertical: "middle" };
  for (let c = 1; c <= SHEET_COLS; c++) ws.getCell(1, c).border = BORDER;

  // Row 2: header strip, label (grey) / value (white) pairs.
  model.strip.forEach((item, i) => {
    const label = ws.getCell(2, i * 2 + 1);
    const value = ws.getCell(2, i * 2 + 2);
    label.value = item.label;
    label.font = { bold: true };
    label.fill = GREY;
    value.value = item.value;
    value.alignment = { horizontal: "left" };
    label.border = BORDER;
    value.border = BORDER;
  });
  ws.getCell(2, 10).note = model.correctNote;
  ws.getCell(2, 9).note = model.correctNote;

  // Row 3: column headers; Resolution Notes spans G:J.
  model.headers.forEach((h, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = GREY;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  ws.mergeCells(3, 7, 3, SHEET_COLS);
  for (let c = 1; c <= SHEET_COLS; c++) {
    ws.getCell(3, c).border = BORDER;
    ws.getCell(3, c).fill = GREY;
  }

  // Data rows.
  model.rows.forEach((r, idx) => {
    const rowNo = 4 + idx;
    const values = [
      r.timestamp,
      r.statistic,
      r.statCategory,
      r.disputeCategory,
      r.reason,
      r.result,
      r.resolutionNotes,
    ];
    values.forEach((v, i) => {
      ws.getCell(rowNo, i + 1).value = v;
    });
    ws.mergeCells(rowNo, 7, rowNo, SHEET_COLS);
    for (let c = 1; c <= SHEET_COLS; c++) {
      const cell = ws.getCell(rowNo, c);
      cell.border = BORDER;
      cell.alignment = { vertical: "top", wrapText: true, horizontal: c === 1 ? "center" : "left" };
    }
    // Merged/wrapped cells don't auto-height: estimate from the longest text.
    const lines = Math.max(
      1,
      ...[
        [r.reason, DISPUTE_COLUMNS[4].width],
        [
          r.resolutionNotes,
          DISPUTE_COLUMNS[6].width + DISPUTE_COLUMNS[7].width + DISPUTE_COLUMNS[8].width + DISPUTE_COLUMNS[9].width,
        ],
      ].map(([t, w]) =>
        String(t)
          .split("\n")
          .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (Number(w) * 0.95))), 0)
      )
    );
    if (lines > 1) ws.getRow(rowNo).height = 15 * lines;
  });

  // Summary line below the table (not new columns).
  const footerRow = 4 + model.rows.length + 1;
  ws.getCell(footerRow, 1).value = model.footer;
  ws.getCell(footerRow, 1).font = { italic: true, color: { argb: "FF666666" } };
  ws.getCell(footerRow + 1, 1).value = model.correctNote;
  ws.getCell(footerRow + 1, 1).font = { italic: true, color: { argb: "FF666666" } };

  ws.views = [{ state: "frozen", ySplit: 3 }];
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function downloadDisputeResultsExcel(
  input: DisputeResultsInput
): Promise<void> {
  const model = disputeResultsModel(input);
  const buffer = await buildDisputeResultsWorkbook(model);
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = model.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
