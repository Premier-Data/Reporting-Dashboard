// Excel export of the weekly games/cost summary (last 4 weeks), laid out like
// the manual summary sheet: one column per week, coloured blocks for AUS footy,
// AUS soccer, Manila (PHL) and Vietnam, then OS totals.
//
// Game "credit" is in half-game units: a game whose Location is mixed
// ("PHL/ AUS") counts 0.5 to each location. AUS costs include the 15%
// entitlements uplift; OS (PHL / VN) costs are the sheet's fixed weekly costs.

export type SummaryWeek = {
  week: number;
  start: Date;
  end: Date;
  footyGames: number; // total footy games in the week
  soccerGames: number; // total soccer games in the week
  footyAus: number; // footy credit by location
  footyPhl: number;
  soccerAus: number; // soccer credit by location
  soccerPhl: number;
  soccerVn: number;
  footyCost: number; // AUS Aussie Rules cost (incl. 15%)
  soccerCost: number; // AUS Soccer cost (incl. 15%)
  phlCost: number; // Philippines weekly OS cost
  vnCost: number; // Vietnam weekly OS cost
};

const GREY = "FFD9D9D9";
const BLUE = "FFB4C7E7";
const PEACH = "FFF8CBAD";
const GREEN = "FFE2EFDA";

export async function exportWeeklySummary(weeks: SummaryWeek[], season: number) {
  if (weeks.length === 0) {
    alert("No weekly data to export for this season yet.");
    return;
  }
  // Loaded on demand so exceljs stays out of the main bundle.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Weekly Summary");

  ws.getColumn(1).width = 30;
  weeks.forEach((_, i) => (ws.getColumn(i + 2).width = 16));

  const MONEY = '"$"#,##0.00';
  const per = (num: number, den: number): number | string => (den > 0 ? num / den : "–");

  type R = {
    label: string;
    values: (w: SummaryWeek) => number | string | Date;
    fmt?: string;
    fill?: string;
    bold?: boolean;
  };

  const rows: (R | null)[] = [
    { label: "Start Date", values: (w) => w.start, fmt: "d-mmm", bold: true },
    { label: "End Date", values: (w) => w.end, fmt: "d-mmm", bold: true },
    { label: "Total Games Completed", values: (w) => w.footyGames + w.soccerGames, fmt: "0", bold: true },
    { label: "Footy Games Coded", values: (w) => w.footyGames, fmt: "0", bold: true },
    { label: "Soccer Games Coded", values: (w) => w.soccerGames, fmt: "0", bold: true },
    null,
    { label: "Games Coded (AUS)", values: () => "", bold: true },
    { label: "Footy", values: (w) => w.footyAus, fmt: "0.0", fill: GREY, bold: true },
    { label: "Footy Cost", values: (w) => w.footyCost, fmt: MONEY, fill: GREY, bold: true },
    { label: "AUS Cost per game", values: (w) => per(w.footyCost, w.footyAus), fmt: MONEY, fill: GREY, bold: true },
    { label: "Soccer", values: (w) => w.soccerAus, fmt: "0.0", fill: BLUE, bold: true },
    { label: "Soccer Cost*", values: (w) => w.soccerCost, fmt: MONEY, fill: BLUE },
    { label: "AUS Cost per game", values: (w) => per(w.soccerCost, w.soccerAus), fmt: MONEY, fill: BLUE, bold: true },
    { label: "Games Completed (AUS)", values: (w) => w.footyAus + w.soccerAus, fmt: "0.0", bold: true },
    { label: "Weekly Cost", values: (w) => w.footyCost + w.soccerCost, fmt: MONEY, bold: true },
    { label: "Games Coded (Manila)", values: () => "", fill: PEACH, bold: true },
    { label: "Footy", values: (w) => w.footyPhl, fmt: "0.0", fill: PEACH, bold: true },
    { label: "Soccer", values: (w) => w.soccerPhl, fmt: "0.0", fill: PEACH, bold: true },
    { label: "Games Completed (PHL)", values: (w) => w.footyPhl + w.soccerPhl, fmt: "0.0", fill: PEACH },
    { label: "Weekly Cost", values: (w) => w.phlCost, fmt: MONEY, fill: PEACH, bold: true },
    { label: "PHL Cost per game", values: (w) => per(w.phlCost, w.footyPhl + w.soccerPhl), fmt: MONEY, fill: PEACH, bold: true },
    { label: "Games Coded (Vietnam)", values: () => "", fill: GREEN, bold: true },
    { label: "Soccer", values: (w) => w.soccerVn, fmt: "0.0", fill: GREEN, bold: true },
    { label: "Weekly Cost", values: (w) => w.vnCost, fmt: MONEY, fill: GREEN, bold: true },
    { label: "VN Cost per game", values: (w) => per(w.vnCost, w.soccerVn), fmt: MONEY, fill: GREEN, bold: true },
    { label: "Total OS Cost", values: (w) => w.phlCost + w.vnCost, fmt: MONEY, bold: true },
    { label: "OS Games per week", values: (w) => w.footyPhl + w.soccerPhl + w.soccerVn, fmt: "0.0", bold: true },
    {
      label: "OS Game Rate",
      values: (w) => per(w.phlCost + w.vnCost, w.footyPhl + w.soccerPhl + w.soccerVn),
      fmt: MONEY,
      bold: true,
    },
  ];

  rows.forEach((r, idx) => {
    const row = ws.getRow(idx + 1);
    if (!r) return;
    row.getCell(1).value = r.label;
    weeks.forEach((w, i) => {
      const c = row.getCell(i + 2);
      c.value = r.values(w) as ExcelJS_Value;
      if (r.fmt && typeof c.value !== "string") c.numFmt = r.fmt;
      c.alignment = { horizontal: "right" };
    });
    for (let col = 1; col <= weeks.length + 1; col++) {
      const c = row.getCell(col);
      if (r.bold) c.font = { bold: true };
      if (r.fill) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r.fill } };
      c.border = { bottom: { style: "hair", color: { argb: "FFBFBFBF" } } };
    }
  });

  const noteRow = rows.length + 2;
  ws.getCell(noteRow, 1).value =
    "* AUS costs (Aussie Rules / Soccer areas) include 15% entitlements. PHL / VN costs are the OS Team weekly costs (no uplift). Mixed-location games are split 0.5 per location.";
  ws.getCell(noteRow, 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };

  const first = weeks[0].week;
  const last = weeks[weeks.length - 1].week;
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `weekly-summary_${season}_wk${first}-${last}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type ExcelJS_Value = string | number | Date;
