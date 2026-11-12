// sync-deputy.js: 2025 TT sheet support (unique game_keys for the 2025 sheet
// only; 2026/2027 keys byte-for-byte unchanged) using a synthetic workbook.
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-key";
const req = createRequire(import.meta.url);
const sync = req(path.resolve(__dirname, "../../sync-deputy.js"));

const HEADER = ["Date", "Competition", "Round", "Home Team", "Away Team", "Home Allocated", "Away Allocated", "Location", "Additional", "Week", "Month", "Day", "Video"];
const row = (date: string, comp: string, round: string, home: string, away: string, a1: string, a2: string) => [
  date, comp, round, home, away, a1, a2, "AUS", null, 1, "May", "Sat", null,
];

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const colliding = () => [
  row("2025-05-10", "EDFL Div 2 U18.5 2025", "5", "Burnside Heights", "Sunbury Kangaroos", "Jan", "Jerome"),
  row("2025-05-10", "EDFL Div 2 2025", "5", "Burnside Heights", "Sunbury Kangaroos", "Maheshwari", "Maheshwari"),
  row("2025-05-10", "EDFL Div 2 2025", "5", "Burnside Heights", "Sunbury Kangaroos", "Third", "Third"),
  row("2025-05-24", "Tas Men 2025", "1", "NTFA", "NWFL", "Anthony", "Anthony"),
  row("2025-05-24", "Tas Women 2025", "1", "NTFA", "NWFL", "Nathan", "Nathan"),
];

describe("makeTTGameKey", () => {
  it("default (2026/2027) is the legacy key and never suffixes", () => {
    const used = new Set<string>();
    const p = { date: "2026-05-01", home: "A", away: "B", competition: "C", round: "1" };
    expect(sync.makeTTGameKey(p, used, false)).toBe("2026-05-01_A_B");
    expect(sync.makeTTGameKey(p, used, false)).toBe("2026-05-01_A_B");
  });

  it("2025 mode: first keeps the plain key, then Competition, Round, #n", () => {
    const used = new Set<string>();
    const mk = (competition: string | null, round: string | null) =>
      sync.makeTTGameKey({ date: "2025-05-10", home: "A", away: "B", competition, round }, used, true);
    expect(mk("C1", "5")).toBe("2025-05-10_A_B");
    expect(mk("C2", "5")).toBe("2025-05-10_A_B_C2");
    expect(mk("C2", "5")).toBe("2025-05-10_A_B_C2_5");
    expect(mk("C2", "5")).toBe("2025-05-10_A_B_C2_5#2");
    expect(mk(null, null)).toBe("2025-05-10_A_B#2");
    expect(mk(null, null)).toBe("2025-05-10_A_B#3");
  });

  it("is deterministic for the same input order", () => {
    const run = () => {
      const used = new Set<string>();
      return [["X", "1"], ["Y", "1"], ["Y", "1"]].map(([c, r]) =>
        sync.makeTTGameKey({ date: "d", home: "h", away: "a", competition: c, round: r }, used, true)
      );
    };
    expect(run()).toEqual(run());
  });
});

describe("parseTTData with the 2025 sheet", () => {
  it("keeps every colliding 2025 row with unique stable keys", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const buf = workbook({ "2025_TTRawData": colliding() });
    const a = sync.parseTTData(buf, "2025_TTRawData", 2025, { uniqueKeys: true });
    const b = sync.parseTTData(buf, "2025_TTRawData", 2025, { uniqueKeys: true });
    const summary = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('rows read'));
    log.mockRestore();
    expect(a).toHaveLength(5);
    expect(new Set(a.map((r: any) => r.game_key)).size).toBe(5);
    expect(a.map((r: any) => r.game_key)).toEqual(b.map((r: any) => r.game_key));
    expect(a[0].game_key).toBe("2025-05-10_Burnside Heights_Sunbury Kangaroos");
    expect(summary).toContain("rows read 5, parsed 5, skipped 0, collisions suffixed 3, removed by dedupe 0");
    expect(a.every((r: any) => r.season === 2025)).toBe(true);
  });

  it("without uniqueKeys (2026/2027) collisions keep the legacy key", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const buf = workbook({ TTRawData: colliding() });
    const p = sync.parseTTData(buf, "TTRawData", 2026);
    log.mockRestore();
    expect(p.map((r: any) => r.game_key)).toEqual([
      "2025-05-10_Burnside Heights_Sunbury Kangaroos",
      "2025-05-10_Burnside Heights_Sunbury Kangaroos",
      "2025-05-10_Burnside Heights_Sunbury Kangaroos",
      "2025-05-24_NTFA_NWFL",
      "2025-05-24_NTFA_NWFL",
    ]);
  });

  it("a missing sheet throws (the sync loop catches it and only warns)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const buf = workbook({ TTRawData: colliding() });
    expect(() => sync.parseTTData(buf, "2025_TTRawData", 2025, { uniqueKeys: true })).toThrow();
    log.mockRestore();
  });

  it("2025-10-01/02 rows are season 2026 week 1 under the unified rule", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const buf = workbook({ "2025_TTRawData": [row("2025-10-02", "C", "1", "A", "B", "x", "y")] });
    const [r] = sync.parseTTData(buf, "2025_TTRawData", 2025, { uniqueKeys: true });
    log.mockRestore();
    expect([r.season, r.Week]).toEqual([2026, "1"]);
  });
});
