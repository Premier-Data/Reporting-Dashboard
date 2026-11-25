// sync-deputy.js: SoccerData "Finalised Time" (last column) -> completed_date.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-key";
const req = createRequire(import.meta.url);
const sync = req(path.resolve(__dirname, "../../sync-deputy.js"));

describe("parseCompletedDate", () => {
  it("parses dd/mm/yyyy h:mm text (day first)", () => {
    expect(sync.parseCompletedDate("23/11/2026 22:41")).toBe("2026-11-23");
    expect(sync.parseCompletedDate("24/11/2026 9:50")).toBe("2026-11-24");
    expect(sync.parseCompletedDate("20/11/2026 13:36:05")).toBe("2026-11-20");
    expect(sync.parseCompletedDate("  17/11/2026 18:04 ")).toBe("2026-11-17");
  });
  it("parses d/m/yyyy without a time", () => {
    expect(sync.parseCompletedDate("5/1/2027")).toBe("2027-01-05");
    expect(sync.parseCompletedDate("03/04/2027")).toBe("2027-04-03");
  });
  it("parses Excel serials and keeps the wall-clock date", () => {
    expect(sync.parseCompletedDate(46350.62847222222)).toBe("2026-11-24");
    expect(sync.parseCompletedDate(46350.99999)).toBe("2026-11-24");
    expect(sync.parseCompletedDate("46350.4")).toBe("2026-11-24");
  });
  it("parses ISO text and Date objects", () => {
    expect(sync.parseCompletedDate("2026-11-24T09:50:00")).toBe("2026-11-24");
    expect(sync.parseCompletedDate("2026-11-24")).toBe("2026-11-24");
    expect(sync.parseCompletedDate(new Date(2026, 10, 24, 9, 50))).toBe("2026-11-24");
  });
  it("returns null for blanks and non-dates", () => {
    for (const v of [null, undefined, "", "   ", "End", "Finalised Time", "31/02/2026", "13/13/2026", "1/1/1999", 0, NaN, {}]) {
      expect(sync.parseCompletedDate(v)).toBeNull();
    }
  });
});

describe("parseSoccerData completed_date", () => {
  const HEADER = ["Date", "Competition", "Round", "Home Team", "Away Team", "Home Allocated", "Away Allocated", "VideoURL", "Location", "Finalised Time"];
  const serial = (y: number, m: number, d: number, frac = 0) => Date.UTC(y, m - 1, d) / 86400000 + 25569 + frac;
  function book(rows: unknown[][], completionRows?: unknown[][]): Buffer {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), "SoccerData");
    if (completionRows) {
      const head = Array.from({ length: 19 }, (_, i) => `c${i}`);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...completionRows]), "Completion Times");
    }
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }
  const row = (date: number, home: string, away: string, fin: unknown) => [
    date, "U15 Frem Cup", 1, home, away, "A", "A", "http://x/1.mp4", "VN", fin,
  ];

  it("uses the last column on the same row and keys by the unchanged game_key", () => {
    const buf = book([
      row(serial(2026, 11, 17), "Sarpsborg 08", "Roskilde", serial(2026, 11, 17, 0.75)),
      row(serial(2026, 11, 17), "Taastrup FC", "FASE Szczecin", "20/11/2026 21:07"),
      row(serial(2026, 11, 17), "Derby County", "BK FREM Future", null),
      row(serial(2026, 11, 17), "Roskilde", "FASE Szczecin", "not a date"),
    ]);
    const out = sync.parseSoccerData(buf, undefined);
    expect(out.map((g: { completed_date: string | null }) => g.completed_date)).toEqual(["2026-11-17", "2026-11-20", null, null]);
    expect(out[0].game_key).toBe("2026-11-17_U15 Frem Cup_1_Sarpsborg 08_Roskilde");
    expect(out[0].completed_season).toBe(2027);
    expect(out[0].completed_week).toBe(7);
  });

  it("prefers the last column over Completion Times and falls back to it when blank", () => {
    const d = serial(2026, 10, 7);
    const ct = (home: string, away: string, done: number) => {
      const r: unknown[] = Array(19).fill(null);
      r[2] = d; r[6] = home; r[7] = away; r[18] = done;
      return r;
    };
    const buf = book(
      [row(d, "Alpha", "Beta", serial(2026, 11, 20)), row(d, "Gamma", "Delta", null)],
      [ct("Alpha", "Beta", serial(2026, 10, 9)), ct("Gamma", "Delta", serial(2026, 10, 10))]
    );
    const out = sync.parseSoccerData(buf, sync.parseCompletionTimes(buf));
    expect(out.map((g: { completed_date: string | null }) => g.completed_date)).toEqual(["2026-11-20", "2026-10-10"]);
  });

  it("works for older tabs with no last column at all", () => {
    const buf = book([[serial(2026, 10, 7), "NPL", 1, "H", "A", "x", "x", "u", "AUS"]]);
    const out = sync.parseSoccerData(buf, undefined);
    expect(out).toHaveLength(1);
    expect(out[0].completed_date).toBeNull();
  });
});
