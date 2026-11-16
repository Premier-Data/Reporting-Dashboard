import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildTrainingPlanWorkbook, trainingPlanFileName, trainingPlanSheets } from "./trainingPlanExcel";
import { buildTrainingPlan, type HistoryInput, type TrainingPlan } from "@/lib/comparison/trainingPlan";
import type { ComparisonRow, Instance } from "@/lib/comparison/xml-compare";

let n = 0;
const inst = (o: Partial<Instance> = {}): Instance => {
  n += 1;
  return { id: `e${n}`, start: 10 + n, end: 14 + n, mid: 12 + n, team: "Home", playerNumber: 4, playerRaw: "4", stat: "Tackles", category: "Defence", code: "c", ...o };
};
const missed = (stat: string): ComparisonRow => ({ status: "missed", master: inst({ stat }), analyst: null, timeDelta: null });
const exact = (stat: string): ComparisonRow => ({ status: "exact", master: inst({ stat }), analyst: inst({ stat }), timeDelta: 0 });

function makePlan(opts: { withHistory?: boolean; videoUrl?: string | null; stat?: string } = {}): TrainingPlan {
  const stat = opts.stat ?? "Tackles";
  const rows = [...Array.from({ length: 4 }, () => missed(stat)), ...Array.from({ length: 6 }, () => exact(stat))];
  const history: HistoryInput | null = opts.withHistory
    ? {
        checks: [1, 2].map((id) => ({
          id,
          createdAt: `2025-05-0${id}T00:00:00Z`,
          matchLabel: null,
          accuracy: 0.7,
          summary: { masterTotal: 10, exact: 6, missed: 4, extra: 0, wrongPlayer: 0, wrongStat: 0, wrongTeam: 0 },
          categories: [],
          stats: { [stat.toLowerCase()]: { events: 10, errors: 4, byType: { missed: 4, extra: 0, wrong_player: 0, wrong_stat: 0, wrong_team: 0 } } },
          category: null,
        })),
        allAnalystAverage: null,
        warnings: [],
      }
    : null;
  return buildTrainingPlan(
    {
      result: {
        rows,
        tolerance: 3,
        summary: { masterTotal: 10, analystTotal: 6, exact: 6, wrongStat: 0, wrongPlayer: 0, wrongTeam: 0, missed: 4, extra: 0, accuracy: 0.6, avgTimeDrift: 0 },
        byCategory: [{ category: "Defence", total: 10, exact: 6, accuracy: 0.6 }],
        byStat: [],
        byTeam: [],
      },
      scopeRows: rows,
    },
    history,
    {
      analystName: "Sam",
      checkId: 9,
      checkCreatedAt: "2025-06-01T00:00:00Z",
      sport: "afl",
      matchLabel: "R1",
      masterFileName: "m.xml",
      videoUrl: opts.videoUrl === undefined ? "https://v.example/a.mp4" : opts.videoUrl,
      checkCategory: null,
      teamLabel: (t) => t,
      scopeFilters: { team: "all", category: "all", stat: "all" },
      reviewBaseUrl: "https://app.example/accuracy-compare",
      disputes: [],
    },
    { scope: "filters", window: { mode: "checks", n: 10 }, now: new Date("2025-06-02T00:00:00Z") }
  );
}

describe("trainingPlanSheets", () => {
  it("has the four sheets in order with the documented columns", () => {
    const plan = makePlan({ withHistory: true });
    const sheets = trainingPlanSheets(plan);
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Focus", "Instances", "Trends"]);
    const byName = Object.fromEntries(sheets.map((s) => [s.name, s]));
    expect(byName.Instances.columns.map((c) => c.header)).toEqual([
      "Type", "Time", "Stat (expected)", "Stat (coded)", "Category", "Expected team", "Expected player", "Coded team", "Coded player",
      "Also wrong player", "Also wrong team", "Time delta (s)", "Dispute", "Video link", "Review link",
    ]);
    expect(byName.Instances.rows).toHaveLength(plan.instances.length);
    expect(byName.Focus.rows).toHaveLength(plan.focus.length);
    expect(byName.Focus.columns.map((c) => c.header)).toEqual(["#", "Focus", "Why", "Suggested practice", "Error type", "Flags", "Instances"]);
    const pts = plan.trends.items[0].points.length;
    expect(byName.Trends.columns).toHaveLength(5 + pts);
    expect(byName.Trends.columns[byName.Trends.columns.length - 1].header).toBe("This check");
  });

  it("carries hyperlinks on link cells and leaves them empty without links", () => {
    const linked = trainingPlanSheets(makePlan()).find((s) => s.name === "Instances")!;
    expect(linked.rows[0].video).toMatchObject({ hyperlink: expect.stringContaining("#t=") });
    expect(linked.rows[0].review).toMatchObject({ hyperlink: expect.stringContaining("check=9") });
    const bare = trainingPlanSheets(makePlan({ videoUrl: null })).find((s) => s.name === "Instances")!;
    expect(bare.rows[0].video).toBeNull();
  });

  it("builds a safe file name", () => {
    expect(trainingPlanFileName(makePlan())).toBe("Training plan - Sam - check 9 - 2025-06-02.xlsx");
  });
});

describe("workbook round trip", () => {
  it("writes and reads back the same sheets and row counts, with formula-looking text kept as a string", async () => {
    const plan = makePlan({ withHistory: true, stat: "=SUM(A1)" });
    const buffer = await buildTrainingPlanWorkbook(plan);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Focus", "Instances", "Trends"]);
    const inst = wb.getWorksheet("Instances")!;
    expect(inst.rowCount).toBe(plan.instances.length + 1); // header + rows
    const statCell = inst.getRow(2).getCell(3).value;
    expect(statCell).toBe("=SUM(A1)");
    expect(typeof statCell).toBe("string");
    const focus = wb.getWorksheet("Focus")!;
    expect(focus.rowCount).toBe(plan.focus.length + 1);
  });
});
