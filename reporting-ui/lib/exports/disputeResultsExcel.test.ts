import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildDisputeResultsWorkbook,
  disputeResultsFileName,
  disputeResultsModel,
  formatTimestamp,
  mergeNotes,
  statCategoryOf,
  type ExportDispute,
} from "./disputeResultsExcel";

let id = 0;
const d = (o: Partial<ExportDispute> = {}): ExportDispute => ({
  id: ++id,
  stat: "Long Passes Unsuccessful",
  code_time: 10,
  reason: "reason",
  category: "timing_comparison",
  status: "open",
  resolution_note: null,
  ...o,
});
const run = (disputes: ExportDispute[]) =>
  disputeResultsModel({
    match: "Avondale v Altona Magic",
    master: "Will Purssey",
    analyst: "Tri Nguyen",
    date: "07/11/2026",
    disputes,
    categoryLabel: (c) => (c === "timing_comparison" ? "Timing/Comparison Error" : "Uncategorised"),
  });

describe("analyst correct %", () => {
  it("uses resolved disputes only as the denominator", () => {
    const m = run([
      d({ status: "confirmed" }),
      d({ status: "denied" }),
      d({ status: "open" }),
      d({ status: "open" }),
    ]);
    expect(m.total).toBe(4);
    expect(m.resolved).toBe(2);
    expect(m.correctText).toBe("50%");
    expect(m.correctFraction).toBe(0.5);
  });
  it("rounds to a whole percent", () => {
    const ds = [
      ...Array.from({ length: 3 }, () => d({ status: "confirmed" })),
      ...Array.from({ length: 10 }, () => d({ status: "denied" })),
    ];
    expect(run(ds).correctText).toBe("23%"); // 3/13 = 23.08%
    expect(run([d({ status: "confirmed" }), d({ status: "denied" }), d({ status: "denied" })]).correctText).toBe("33%");
  });
  it("is n/a with nothing resolved", () => {
    const m = run([d(), d()]);
    expect(m.correctText).toBe("n/a");
    expect(m.correctFraction).toBeNull();
    expect(m.total).toBe(2);
  });
  it("total includes open", () => {
    const m = run([d({ status: "confirmed" }), d()]);
    expect(m.strip.find((s) => s.label === "Total Disputes")?.value).toBe(2);
    expect(m.footer).toBe("Resolved: 1, Open: 1, Analyst Correct: 1");
  });
});

describe("formatTimestamp", () => {
  it("formats seconds as hh:mm:ss", () => {
    expect(formatTimestamp(34)).toBe("00:00:34");
    expect(formatTimestamp(2254)).toBe("00:37:34");
    expect(formatTimestamp(0)).toBe("00:00:00");
  });
  it("handles over an hour and fractions", () => {
    expect(formatTimestamp(3600 + 5 * 60 + 9)).toBe("01:05:09");
    expect(formatTimestamp(7384.9)).toBe("02:03:04");
  });
  it("blank when missing", () => {
    expect(formatTimestamp(null)).toBe("");
  });
});

describe("rows", () => {
  it("sorts by timestamp ascending, nulls last", () => {
    const m = run([d({ code_time: 300 }), d({ code_time: null }), d({ code_time: 20 })]);
    expect(m.rows.map((r) => r.timestamp)).toEqual(["00:00:20", "00:05:00", ""]);
  });
  it("maps result labels, category and notes", () => {
    const m = run([
      d({ status: "confirmed", resolution_note: "  Agreed  ", reason: "Too early" }),
      d({ status: "denied", code_time: 11, stat: "Short Passes Successful" }),
      d({ status: "open", code_time: 12 }),
    ]);
    expect(m.rows.map((r) => r.result)).toEqual(["Analyst Correct", "Master Correct", "Open"]);
    expect(m.rows[0].resolutionNotes).toBe("Agreed");
    expect(m.rows[0].reason).toBe("Too early");
    expect(m.rows[0].statCategory).toBe("Passing");
    expect(m.rows[0].disputeCategory).toBe("Timing/Comparison Error");
  });
  it("derives stat category from plural stat labels", () => {
    expect(statCategoryOf("Crosses Successful")).toBe("Passing");
    expect(statCategoryOf("Through Balls Unsuccessful")).toBe("Passing");
    expect(statCategoryOf("Shots On Target")).toBe("Shots");
    expect(statCategoryOf("Tackles")).toBe("General Play");
  });
  it("mergeNotes joins non-empty parts on separate lines", () => {
    expect(mergeNotes("a", null, "  ", "b")).toBe("a\nb");
    expect(mergeNotes(undefined)).toBe("");
  });
});

describe("file name", () => {
  it("sanitises Windows-illegal characters", () => {
    expect(disputeResultsFileName("A v B")).toBe("A v B - Dispute results.xlsx");
    expect(disputeResultsFileName('A/B: "C"?')).toBe("A_B_ _C_ - Dispute results.xlsx");
    expect(disputeResultsFileName("")).toBe("Check - Dispute results.xlsx");
  });
});

describe("workbook", () => {
  it("writes the template layout", async () => {
    const m = run([d({ code_time: 2254, status: "confirmed", resolution_note: "ok" }), d({ code_time: 5 })]);
    const buf = await buildDisputeResultsWorkbook(m);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws.getCell("A1").value).toBe("Avondale v Altona Magic");
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => ws.getCell(2, c).value)).toEqual([
      "Master", "Will Purssey", "Analyst", "Tri Nguyen", "Date", "07/11/2026",
      "Total Disputes", 2, "Analyst Correct", "100%",
    ]);
    expect(ws.getCell("A3").value).toBe("Timestamp");
    expect(ws.getCell("A4").value).toBe("00:00:05");
    expect(ws.getCell("A5").value).toBe("00:37:34");
    expect(ws.getCell("F5").value).toBe("Analyst Correct");
    expect(ws.getCell("G5").value).toBe("ok");
  });
});
