import { describe, it, expect } from "vitest";
import {
  type SoccerGameRow,
  buildSoccerOpsReport,
  soccerLocationKey,
  soccerSeasons,
} from "./opsSoccer";
import { buildWeekOneAnchors, soccerWeekFor } from "./soccerWeeks";

let n = 0;
function s(p: Partial<SoccerGameRow>): SoccerGameRow {
  n += 1;
  return {
    game_key: `s${n}`,
    Date: "2026-03-25",
    season: 2026,
    week: 99,
    home_allocated: "A",
    away_allocated: "B",
    Location: "VN",
    ...p,
  };
}

// TT Week 1 earliest 2026-03-26 (Thu) -> anchor Wednesday 2026-03-25.
const TT = [
  { season: 2026, Week: "1", Date: "2026-03-27" },
  { season: 2026, Week: "1", Date: "2026-03-26" },
  { season: 2026, Week: "2", Date: "2026-03-20" },
];

// Verbatim copy of the pre-refactor SoccerGames.tsx logic (reference oracle).
function legacyWeekFor(r: Record<string, unknown>, ttData: Record<string, unknown>[]) {
  const DAY = 86400000;
  const min: Record<number, string> = {};
  for (const t of ttData) {
    const se = Number(t.season);
    const w = Number(t.week ?? t.Week);
    const iso = String(t.Date ?? "").slice(0, 10);
    if (!Number.isFinite(se) || w !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    if (!min[se] || iso < min[se]) min[se] = iso;
  }
  const anchors: Record<number, number> = {};
  for (const [se, iso] of Object.entries(min)) {
    const d = new Date(`${iso}T00:00:00Z`);
    anchors[Number(se)] = d.getTime() - ((d.getUTCDay() - 3 + 7) % 7) * DAY;
  }
  const anchor = anchors[Number(r.season)];
  const iso = String(r.Date ?? "").slice(0, 10);
  if (anchor != null && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const ms = new Date(`${iso}T00:00:00Z`).getTime();
    return ms < anchor ? 0 : Math.floor((ms - anchor) / (7 * DAY)) + 1;
  }
  const w = Number(r.week);
  return Number.isFinite(w) ? w : null;
}

describe("soccerWeekFor", () => {
  it("matches the Soccer card's legacy logic for many dates and fallbacks", () => {
    const anchors = buildWeekOneAnchors(TT);
    const rows: Record<string, unknown>[] = [];
    for (let d = 0; d < 120; d++) {
      const iso = new Date(Date.UTC(2026, 1, 20 + d)).toISOString().slice(0, 10);
      rows.push({ season: 2026, Date: iso, week: 7 });
    }
    rows.push(
      { season: 2025, Date: "2025-05-01", week: 4 }, // no anchor -> stored week
      { season: 2026, Date: null, week: 3 },
      { season: 2025, Date: null, week: "x" }
    );
    for (const r of rows) expect(soccerWeekFor(r, anchors)).toBe(legacyWeekFor(r, TT));
  });

  it("anchors Week 1 on the Wednesday and puts earlier dates in Week 0", () => {
    const a = buildWeekOneAnchors(TT);
    expect(soccerWeekFor({ season: 2026, Date: "2026-03-24" }, a)).toBe(0);
    expect(soccerWeekFor({ season: 2026, Date: "2026-03-25" }, a)).toBe(1);
    expect(soccerWeekFor({ season: 2026, Date: "2026-03-31" }, a)).toBe(1);
    expect(soccerWeekFor({ season: 2026, Date: "2026-04-01" }, a)).toBe(2);
  });
});

describe("soccerLocationKey", () => {
  it("keeps clean codes and sends everything else to Mixed", () => {
    expect(soccerLocationKey(" vn ")).toBe("VN");
    expect(soccerLocationKey("AUS")).toBe("AUS");
    expect(soccerLocationKey("AUS/ VN")).toBe("Mixed");
    expect(soccerLocationKey("")).toBe("Mixed");
    expect(soccerLocationKey(null)).toBe("Mixed");
  });
});

describe("buildSoccerOpsReport", () => {
  it("counts half games per side and 1 when same analyst on both", () => {
    const rows = [
      s({ home_allocated: "Aaron", away_allocated: "Z1" }),
      s({ home_allocated: "Z2", away_allocated: "Aaron" }),
      s({ home_allocated: "Bob", away_allocated: "Bob" }),
    ];
    const r = buildSoccerOpsReport(rows, TT, 2026);
    const a = r.analysts.find((x) => x.name === "Aaron")!;
    expect([a.home, a.away, a.total, a.weekly[1]]).toEqual([1, 1, 1, 1]);
    const b = r.analysts.find((x) => x.name === "Bob")!;
    expect([b.home, b.away, b.total, b.weekly[1]]).toEqual([1, 1, 1, 1]);
  });

  it("location rows plus Mixed equal Total for every week, ordered by size", () => {
    const rows = [
      s({ Location: "VN" }),
      s({ Location: "VN" }),
      s({ Location: "VN", Date: "2026-04-01" }),
      s({ Location: "AUS", Date: "2026-04-01" }),
      s({ Location: "AUS/ VN", Date: "2026-04-09" }),
      s({ Location: "PHL", Date: "2026-04-09" }),
      s({ Location: null, Date: "2026-04-09" }),
    ];
    const r = buildSoccerOpsReport(rows, TT, 2026);
    expect(r.locations.map((l) => l.key)).toEqual(["VN", "AUS", "PHL", "Mixed"]);
    for (const w of r.weeks) {
      const sum = r.locations.reduce((t, l) => t + (l.byWeek[w.week] ?? 0), 0);
      expect(sum).toBe(r.totalsByWeek[w.week]);
    }
    expect(r.locations.reduce((t, l) => t + l.total, 0)).toBe(r.totals.all);
    expect(r.totals.all).toBe(rows.length);
  });

  it("buckets weeks like the card and labels by week-ending Saturday", () => {
    const rows = [
      s({ Date: "2026-03-20" }), // Week 0
      s({ Date: "2026-03-28" }), // Week 1
      s({ Date: "2026-04-02" }), // Week 2
    ];
    const r = buildSoccerOpsReport(rows, TT, 2026);
    expect(r.weeks.map((w) => [w.week, w.label])).toEqual([
      [0, "Sat 21-Mar"],
      [1, "Sat 28-Mar"],
      [2, "Sat 04-Apr"],
    ]);
    expect(r.totalsByWeek).toEqual({ 0: 1, 1: 1, 2: 1 });
  });

  it("falls back to the stored week when the season has no TT anchor", () => {
    const r = buildSoccerOpsReport([s({ season: 2030, week: 5, Date: "2030-04-10" })], TT, 2030);
    expect(r.weeks.map((w) => w.week)).toEqual([5]);
  });

  it("filters by season and lists seasons newest first", () => {
    const rows = [s({}), s({ season: 2025, Date: "2025-04-02" }), s({ season: 2027 })];
    expect(soccerSeasons(rows)).toEqual([2027, 2026, 2025]);
    expect(buildSoccerOpsReport(rows, TT, 2026).totals.all).toBe(1);
  });

  it("excludes ZZ from analyst rows but counts it in totals; shows PREMIER DATA", () => {
    const rows = [
      s({ home_allocated: "ZZ", away_allocated: "PREMIER DATA" }),
      s({ home_allocated: " ", away_allocated: "Cat" }),
    ];
    const r = buildSoccerOpsReport(rows, TT, 2026);
    expect(r.analysts.map((a) => a.name).sort()).toEqual(["Cat", "PREMIER DATA"]);
    expect(r.excluded.placeholderHalfGames).toBe(0.5);
    expect(r.totalsByWeek[1]).toBe(2);
  });

  it("skips rows that cannot be bucketed", () => {
    const r = buildSoccerOpsReport([s({ Date: null }), s({})], TT, 2026);
    expect(r.excluded.skippedRows).toBe(1);
    expect(r.totals.all).toBe(1);
  });
});
