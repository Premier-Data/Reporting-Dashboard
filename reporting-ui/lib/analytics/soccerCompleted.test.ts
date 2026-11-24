import { describe, expect, it } from "vitest";
import { buildPutInVsCompleted, completedSeasonWeek, isoToDmy } from "./soccerCompleted";

describe("isoToDmy", () => {
  it("formats dd/mm/yyyy and dashes a missing date", () => {
    expect(isoToDmy("2026-10-07")).toBe("07/10/2026");
    expect(isoToDmy("2026-10-07T09:30:00Z")).toBe("07/10/2026");
    expect(isoToDmy(null)).toBe("\u2013");
    expect(isoToDmy("")).toBe("\u2013");
  });
});
import { seasonWeekOfIso } from "./season";

// Season 2027 Week 1 starts Wed 2026-09-30 (Wed on/before 1 Oct 2026).
// W1 = 30 Sep..6 Oct, W2 = 7..13 Oct, W3 = 14..20 Oct.
const g = (Date: string, completed_date: string | null = null) => ({ Date, completed_date });

describe("buildPutInVsCompleted", () => {
  it("counts put-in and completed per week independently", () => {
    const rows = [
      g("2026-10-01", "2026-10-02"), // W1 -> W1
      g("2026-10-02", "2026-10-08"), // W1 -> W2
      g("2026-10-03"), // W1, not completed
      g("2026-10-08", "2026-10-09"), // W2 -> W2
    ];
    const r = buildPutInVsCompleted(rows, 2027);
    expect(r.byWeek[1]).toMatchObject({ putIn: 3, completed: 1, completedSameWeek: 1, notCompleted: 1 });
    expect(r.byWeek[2]).toMatchObject({ putIn: 1, completed: 2, completedSameWeek: 1, notCompleted: 0 });
    expect(r.totals).toEqual({ putIn: 4, completed: 3, completedSameWeek: 2, notCompleted: 1 });
  });

  it("counts a later-week completion in the completed week only", () => {
    const r = buildPutInVsCompleted([g("2026-10-01", "2026-10-15")], 2027);
    expect(r.byWeek[1]).toMatchObject({ putIn: 1, completed: 0, completedSameWeek: 0 });
    expect(r.byWeek[3]).toMatchObject({ putIn: 0, completed: 1 });
  });

  it("treats a missing completed date as not completed", () => {
    const r = buildPutInVsCompleted([g("2026-10-01"), { Date: "2026-10-01", completed_date: "" }], 2027);
    expect(r.totals).toEqual({ putIn: 2, completed: 0, completedSameWeek: 0, notCompleted: 2 });
  });

  it("uses Wed->Tue boundaries (Tue 6 Oct is W1, Wed 7 Oct is W2)", () => {
    const r = buildPutInVsCompleted([g("2026-10-01", "2026-10-06"), g("2026-10-01", "2026-10-07")], 2027);
    expect(r.byWeek[1].completed).toBe(1);
    expect(r.byWeek[2].completed).toBe(1);
  });

  it("matches the unified week rule", () => {
    expect(completedSeasonWeek({ completed_date: "2026-10-14" })).toEqual(seasonWeekOfIso("2026-10-14"));
  });

  it("buckets by the completed date's own season", () => {
    // Put in Sat 26 Sep 2026 (season 2026 last week), completed Thu 1 Oct 2026 (season 2027 W1).
    const rows = [g("2026-09-26", "2026-10-01")];
    expect(buildPutInVsCompleted(rows, 2026).totals).toMatchObject({ putIn: 1, completed: 0, notCompleted: 0 });
    expect(buildPutInVsCompleted(rows, 2027).byWeek[1]).toMatchObject({ putIn: 0, completed: 1 });
  });

  it("falls back to stored completed_season/week only when there is no completed date", () => {
    expect(completedSeasonWeek({ completed_date: null, completed_season: 2027, completed_week: 4 })).toEqual({
      season: 2027,
      week: 4,
    });
    expect(completedSeasonWeek({ completed_date: "garbage", completed_season: 2027, completed_week: 4 })).toBeNull();
  });
});
