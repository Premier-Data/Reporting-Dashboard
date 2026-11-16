import { describe, expect, it } from "vitest";
import type {
  ComparisonResult,
  ComparisonRow,
  Instance,
  MatchStatus,
} from "./xml-compare";
import { formatTime } from "./xml-compare";
import type { Dispute } from "@/lib/api/disputes";
import type { AccuracyCheckMeta } from "@/lib/api/accuracyChecks";
import {
  ERROR_TYPE_ORDER,
  TRAINING_TREND_CONSTANTS as C,
  buildDefaultMessage,
  buildFocus,
  buildReviewLink,
  buildTrainingPlan,
  buildVideoLink,
  classifyRow,
  countStats,
  detectTrends,
  disputeOutcomeForRow,
  makeDisputeExclude,
  normCat,
  selectHistoryChecks,
  type HistoryCheck,
  type HistoryInput,
  type PlanContext,
  type PlanOptions,
  type StatCounts,
} from "./trainingPlan";
import { drillFor, DEFAULT_DRILLS } from "./trainingPlanDrills";

let uid = 0;
function inst(over: Partial<Instance> = {}): Instance {
  uid += 1;
  return {
    id: `i${uid}`,
    start: 10 + uid,
    end: 14 + uid,
    mid: 12 + uid,
    team: "Home",
    playerNumber: 7,
    playerRaw: "Home 7",
    stat: "Tackles",
    category: "Defence",
    code: "c",
    ...over,
  };
}
function row(
  status: MatchStatus,
  m: Partial<Instance> | null,
  a: Partial<Instance> | null,
  extra: Partial<ComparisonRow> = {}
): ComparisonRow {
  return {
    status,
    master: m ? inst(m) : null,
    analyst: a ? inst(a) : null,
    timeDelta: status === "missed" || status === "extra" ? null : 1,
    ...extra,
  };
}
/** `events` rows of a stat, `errors` of which have the given type. */
function statRows(stat: string, events: number, errors: number, type: MatchStatus = "missed"): ComparisonRow[] {
  const out: ComparisonRow[] = [];
  for (let i = 0; i < events; i++) {
    if (i < errors) {
      out.push(
        type === "extra"
          ? row("extra", null, { stat })
          : row(type, { stat }, type === "missed" ? null : { stat })
      );
    } else out.push(row("exact", { stat }, { stat }));
  }
  return out;
}
function result(rows: ComparisonRow[]): ComparisonResult {
  const exact = rows.filter((r) => r.status === "exact").length;
  const masterTotal = rows.filter((r) => r.master).length;
  return {
    rows,
    tolerance: 3,
    summary: {
      masterTotal,
      analystTotal: rows.filter((r) => r.analyst).length,
      exact,
      wrongStat: 0,
      wrongPlayer: 0,
      wrongTeam: 0,
      missed: 0,
      extra: 0,
      accuracy: masterTotal ? exact / masterTotal : 0,
      avgTimeDrift: 0,
    },
    byCategory: [{ category: "Defence", total: masterTotal, exact, accuracy: masterTotal ? exact / masterTotal : 0 }],
    byStat: [],
    byTeam: [],
  };
}
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  analystName: "Sam",
  checkId: 5,
  checkCreatedAt: "2025-06-01T00:00:00Z",
  sport: "afl",
  matchLabel: "Round 1",
  masterFileName: "master.xml",
  videoUrl: "https://v.example/game.mp4",
  checkCategory: null,
  teamLabel: (t) => (t === "Home" ? "Lions" : t === "Away" ? "Tigers" : t),
  scopeFilters: { team: "all", category: "all", stat: "all" },
  reviewBaseUrl: "https://app.example/accuracy-compare",
  disputes: [],
  ...over,
});
const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  scope: "filters",
  window: { mode: "checks", n: 10 },
  now: new Date("2025-06-02T00:00:00Z"),
  ...over,
});
function plan(rows: ComparisonRow[], o: { scopeRows?: ComparisonRow[]; history?: HistoryInput | null; ctx?: Partial<PlanContext>; options?: Partial<PlanOptions> } = {}) {
  return buildTrainingPlan(
    { result: result(rows), scopeRows: o.scopeRows ?? rows },
    o.history ?? null,
    ctx(o.ctx),
    opts(o.options)
  );
}
function dispute(over: Partial<Dispute>): Dispute {
  return {
    id: 1,
    created_at: "2025-06-01T00:00:00Z",
    check_id: 5,
    instance_id: "x",
    side: "master",
    stat: "Tackles",
    player: "#7",
    team: "Home",
    code_time: 0,
    raised_by: null,
    reason: "because",
    category: null,
    status: "open",
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}
function toCounts(events: number, errors: number): StatCounts {
  return { events, errors, byType: { missed: errors, extra: 0, wrong_player: 0, wrong_stat: 0, wrong_team: 0 } };
}
function hc(id: number, day: number, stats: Record<string, [number, number]> | null, over: Partial<HistoryCheck> = {}): HistoryCheck {
  return {
    id,
    createdAt: `2025-05-${String(day).padStart(2, "0")}T00:00:00Z`,
    matchLabel: null,
    accuracy: 0.8,
    summary: { masterTotal: 0, exact: 0, missed: 0, extra: 0, wrongPlayer: 0, wrongStat: 0, wrongTeam: 0 },
    categories: [],
    stats: stats ? Object.fromEntries(Object.entries(stats).map(([k, [e, x]]) => [k, toCounts(e, x)])) : null,
    category: null,
    ...over,
  };
}
const hist = (checks: HistoryCheck[]): HistoryInput => ({ checks, allAnalystAverage: null, warnings: [] });
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

describe("grouping and fields", () => {
  const rows = [
    row("exact", {}, {}),
    row("missed", { stat: "Goal" }, null),
    row("extra", null, { stat: "Mark" }),
    row("wrong_player", { playerNumber: 9 }, { playerNumber: 3 }),
    row("wrong_stat", { stat: "Tackles" }, { stat: "Hit Out" }, { alsoWrongPlayer: true }),
    row("wrong_team", { team: "Home" }, { team: "Away" }),
  ];
  it("lists one instance per error type and no exact rows", () => {
    const p = plan(rows);
    expect(p.instances.map((i) => i.type).sort()).toEqual([...ERROR_TYPE_ORDER].sort());
    expect(p.header.totalErrors).toBe(5);
    expect(p.header.counts).toEqual({ missed: 1, extra: 1, wrong_player: 1, wrong_stat: 1, wrong_team: 1 });
    expect(classifyRow(rows[0])).toBeNull();
  });
  it("orders by error type then time", () => {
    const p = plan(rows);
    const order = p.instances.map((i) => ERROR_TYPE_ORDER.indexOf(i.type));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("fills the instance fields", () => {
    const p = plan(rows);
    const w = p.instances.find((i) => i.type === "wrong_player")!;
    const src = rows[3];
    expect(w.timeLabel).toBe(formatTime(src.master!.mid));
    expect(w.startSeconds).toBe(src.master!.start);
    expect(w.expected).toEqual({ team: "Lions", player: "#9" });
    expect(w.coded).toEqual({ team: "Lions", player: "#3" });
    expect(w.timeDelta).toBe(1);
    const extra = p.instances.find((i) => i.type === "extra")!;
    expect(extra.stat).toBe("Mark");
    expect(extra.expected).toBeNull();
  });
  it("keeps wrong_stat with alsoWrongPlayer as one wrong_stat and sets alsoWrongTeam", () => {
    const r = [row("wrong_stat", { stat: "Tackles", team: "Home" }, { stat: "Hit Out", team: "Away" }, { alsoWrongPlayer: true })];
    const p = plan(r);
    expect(p.instances).toHaveLength(1);
    expect(p.instances[0].type).toBe("wrong_stat");
    expect(p.instances[0].alsoWrongPlayer).toBe(true);
    expect(p.instances[0].alsoWrongTeam).toBe(true);
    expect(p.instances[0].stat).toBe("Tackles");
    expect(p.instances[0].codedStat).toBe("Hit Out");
    const other = plan(rows).instances.filter((i) => i.type !== "wrong_stat");
    expect(other.every((i) => !i.alsoWrongTeam)).toBe(true);
  });
  it("does not mutate its inputs", () => {
    const frozen = deepFreeze([...rows.map((r) => ({ ...r }))]);
    expect(() => plan(frozen)).not.toThrow();
  });
  it("skips rows with no master and no analyst", () => {
    const p = plan([row("missed", null, null), ...rows]);
    expect(p.notes.some((n) => n.includes("1 rows skipped"))).toBe(true);
  });
});

describe("links", () => {
  it("builds video links", () => {
    expect(buildVideoLink("https://v/x.mp4", 65.9)).toBe("https://v/x.mp4#t=65");
    expect(buildVideoLink("https://v/x.mp4#t=5", 9)).toBe("https://v/x.mp4#t=9");
    expect(buildVideoLink("", 9)).toBeNull();
    expect(buildVideoLink("not a url", 9)).toBeNull();
    expect(buildVideoLink("javascript:alert(1)", 9)).toBeNull();
  });
  it("builds review links", () => {
    expect(buildReviewLink("https://a/b", null, 1, "x")).toBeNull();
    expect(buildReviewLink(null, 3, 1, "x")).toBeNull();
    expect(buildReviewLink("https://a/b", 3, 12, "Hit Out")).toBe("https://a/b?check=3&seek=12&stat=Hit+Out");
  });
  it("puts links on instances", () => {
    const p = plan([row("missed", { stat: "Goal" }, null)]);
    expect(p.instances[0].videoLink).toMatch(/#t=\d+$/);
    expect(p.instances[0].reviewLink).toContain("check=5");
    const none = plan([row("missed", { stat: "Goal" }, null)], { ctx: { videoUrl: null, reviewBaseUrl: null } });
    expect(none.instances[0].videoLink).toBeNull();
    expect(none.instances[0].reviewLink).toBeNull();
  });
});

describe("disputes", () => {
  const m = row("missed", { stat: "Goal" }, null);
  const e = row("extra", null, { stat: "Mark" });
  it("excludes a row with a confirmed dispute on the master side", () => {
    const p = plan([m, e], { ctx: { disputes: [dispute({ instance_id: m.master!.id, side: "master", status: "confirmed" })] } });
    expect(p.instances.map((i) => i.type)).toEqual(["extra"]);
    expect(p.header.excludedByDispute).toBe(1);
  });
  it("excludes a row with a confirmed dispute on the analyst side", () => {
    const p = plan([m, e], { ctx: { disputes: [dispute({ instance_id: e.analyst!.id, side: "analyst", status: "confirmed" })] } });
    expect(p.instances.map((i) => i.type)).toEqual(["missed"]);
    expect(p.header.excludedByDispute).toBe(1);
  });
  it("keeps open disputes marked, and denied disputes unmarked", () => {
    const p = plan([m, e], {
      ctx: {
        disputes: [
          dispute({ id: 1, instance_id: m.master!.id, side: "master", status: "open" }),
          dispute({ id: 2, instance_id: e.analyst!.id, side: "analyst", status: "denied" }),
        ],
      },
    });
    expect(p.instances.find((i) => i.type === "missed")!.dispute.state).toBe("open");
    expect(p.instances.find((i) => i.type === "extra")!.dispute.state).toBe("denied");
    expect(p.header.underDispute).toBe(1);
    expect(p.header.totalErrors).toBe(2);
  });
  it("matches ID-less instances by side, stat, team and code time", () => {
    const d = dispute({ instance_id: "gone", side: "master", stat: "goal", team: "home", code_time: m.master!.mid + 0.4, status: "confirmed" });
    expect(disputeOutcomeForRow(m, [d])).toBe("confirmed");
    expect(disputeOutcomeForRow(m, [{ ...d, code_time: m.master!.mid + 0.6 }])).toBe("none");
  });
  it("ignores deleted disputes and ranks confirmed over open over denied", () => {
    const base = { instance_id: m.master!.id, side: "master" as const };
    expect(disputeOutcomeForRow(m, [dispute({ ...base, status: "confirmed", deleted_at: "x" })])).toBe("none");
    expect(
      disputeOutcomeForRow(m, [
        dispute({ ...base, status: "denied" }),
        dispute({ ...base, id: 2, status: "open" }),
        dispute({ ...base, id: 3, status: "confirmed" }),
      ])
    ).toBe("confirmed");
  });
  it("removes confirmed rows from both events and errors in countStats", () => {
    const rows = statRows("Tackles", 6, 2);
    const excl = makeDisputeExclude([dispute({ instance_id: rows[0].master!.id, status: "confirmed" })]);
    const counts = countStats(rows, excl).tackles;
    expect(counts.events).toBe(5);
    expect(counts.errors).toBe(1);
    expect(countStats(rows, () => false).tackles.events).toBe(6);
  });
});

describe("scope", () => {
  const all = [...statRows("Tackles", 3, 2), ...statRows("Goal", 3, 1)];
  const scoped = all.filter((r) => r.master!.stat === "Goal");
  it("uses scopeRows for filters and result rows for all", () => {
    const f = plan(all, { scopeRows: scoped, options: { scope: "filters" } });
    const a = plan(all, { scopeRows: scoped, options: { scope: "all" } });
    expect(f.header.totalErrors).toBe(1);
    expect(a.header.totalErrors).toBe(3);
    expect(f.instances).toHaveLength(f.header.totalErrors);
    expect(a.header.scopeLabel).toBe("All instances");
  });
  it("computes scopeAccuracy excluding extras and null at zero", () => {
    const p = plan([row("exact", {}, {}), row("missed", {}, null), row("extra", null, {})]);
    expect(p.header.scopeAccuracy).toBeCloseTo(0.5);
    expect(plan([row("extra", null, {})]).header.scopeAccuracy).toBeNull();
  });
  it("keeps overall accuracy unchanged", () => {
    const r = result(all);
    const p = buildTrainingPlan({ result: r, scopeRows: all }, null, ctx(), opts());
    expect(p.header.overallAccuracy).toBe(r.summary.accuracy);
  });
});

const noExclude = () => false;
function trends(allRows: ComparisonRow[], history: HistoryCheck[], scopeRows = allRows) {
  return detectTrends({ allRows, scopeRows, byCategory: result(allRows).byCategory, exclude: noExclude, currentDate: "2025-06-01" }, history);
}
const kinds = (t: ReturnType<typeof trends>, key: string) => t.items.find((i) => i.key === key)?.reasons.map((r) => r.kind) ?? [];

describe("trends", () => {
  it("flags persistent when hits exceed half of >= 3 counted checks", () => {
    const history = [hc(1, 1, { tackles: [10, 3] }), hc(2, 2, { tackles: [10, 3] })];
    expect(kinds(trends(statRows("Tackles", 10, 3), history), "tackles")).toContain("persistent");
  });
  it("does not flag persistent with fewer than the minimum counted checks", () => {
    const history = [hc(1, 1, { tackles: [10, 5] })];
    expect(kinds(trends(statRows("Tackles", 10, 5), history), "tackles")).not.toContain("persistent");
  });
  it("does not count a check below the minimum events", () => {
    const history = [hc(1, 1, { tackles: [4, 4] }), hc(2, 2, { tackles: [4, 4] })];
    const t = trends(statRows("Tackles", 10, 5), history);
    expect(kinds(t, "tackles")).not.toContain("persistent");
    const t2 = trends(statRows("Tackles", 10, 5), [hc(1, 1, { tackles: [4, 4] }), hc(2, 2, { tackles: [10, 5] }), hc(3, 3, { tackles: [10, 5] })]);
    expect(t2.items[0].points[0].counted).toBe(false);
    expect(t2.items[0].points.map((p) => p.isCurrent)).toEqual([false, false, false, true]);
  });
  it("flags worsening at a delta of exactly 0.10 (floating point safe) but not 0.09", () => {
    expect(0.3 - 0.2).toBeLessThan(C.WORSENING_DELTA); // the raw subtraction would miss the boundary
    const earlier = [hc(1, 1, { tackles: [10, 2] }), hc(2, 2, { tackles: [10, 2] })];
    const recent = [hc(3, 3, { tackles: [10, 3] }), hc(4, 4, { tackles: [10, 3] })];
    expect(kinds(trends(statRows("Tackles", 10, 3), [...earlier, ...recent]), "tackles")).toContain("worsening");

    const e9 = [hc(1, 1, { tackles: [100, 20] }), hc(2, 2, { tackles: [100, 20] })];
    const r9 = [hc(3, 3, { tackles: [100, 29] }), hc(4, 4, { tackles: [100, 29] })];
    expect(kinds(trends(statRows("Tackles", 100, 29), [...e9, ...r9]), "tackles")).not.toContain("worsening");
  });
  it("does not flag worsening with too few earlier points or pooled events", () => {
    const h = [hc(1, 1, { tackles: [10, 0] }), hc(2, 2, { tackles: [10, 5] }), hc(3, 3, { tackles: [10, 5] })];
    expect(kinds(trends(statRows("Tackles", 10, 5), h), "tackles")).not.toContain("worsening");
  });
  it("flags top_this_check with >= 3 errors and a history error, in tie order", () => {
    const rows = [...statRows("Tackles", 6, 4), ...statRows("Goal", 6, 4), ...statRows("Mark", 6, 3), ...statRows("Kick", 6, 3)];
    const history = [hc(1, 1, { tackles: [6, 1], goal: [6, 1], mark: [6, 1], kick: [6, 1] })];
    const t = trends(rows, history);
    // Goal and Tackles tie on errors and events; label asc puts Goal first. Mark ranks 3rd (label asc over Kick? Kick < Mark).
    expect(kinds(t, "goal")).toContain("top_this_check");
    expect(kinds(t, "tackles")).toContain("top_this_check");
    expect(kinds(t, "kick")).toContain("top_this_check");
    expect(kinds(t, "mark")).not.toContain("top_this_check");
    expect(t.items.find((i) => i.key === "goal")!.reasons[0].text).toContain("1st most errors");
    // without a history error nothing is flagged
    const none = trends(rows, [hc(1, 1, { tackles: [6, 0], goal: [6, 0], mark: [6, 0], kick: [6, 0] })]);
    expect(none.items.filter((i) => i.reasons.some((r) => r.kind === "top_this_check"))).toHaveLength(0);
  });
  it("needs >= 3 errors for top_this_check", () => {
    const t = trends(statRows("Tackles", 6, 2), [hc(1, 1, { tackles: [6, 1] })]);
    expect(kinds(t, "tackles")).not.toContain("top_this_check");
  });
  it("can give several reasons and orders the series oldest to current", () => {
    const history = [hc(1, 1, { tackles: [10, 3] }), hc(2, 2, { tackles: [10, 3] })];
    const t = trends(statRows("Tackles", 10, 4), history);
    const item = t.items[0];
    expect(item.reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(["persistent", "top_this_check"]));
    expect(item.points.map((p) => p.checkId)).toEqual([1, 2, null]);
    expect(item.reasons[0].text).toContain(`${Math.round(C.ERROR_RATE_THRESHOLD * 100)}%`);
  });
  it("keeps persistent/worsening flags and series identical under a scope filter", () => {
    const rows = [...statRows("Tackles", 10, 4), ...statRows("Goal", 10, 1)];
    const history = [hc(1, 1, { tackles: [10, 3], goal: [10, 1] }), hc(2, 2, { tackles: [10, 3], goal: [10, 1] })];
    const full = trends(rows, history);
    const filtered = trends(rows, history, rows.filter((r) => r.master!.stat === "Goal"));
    const strip = (t: ReturnType<typeof trends>) => t.items.map((i) => ({ k: i.key, r: i.reasons.filter((x) => x.kind !== "top_this_check").map((x) => x.kind), p: i.points }));
    const f = strip(full).find((x) => x.k === "tackles");
    expect(f?.r).toContain("persistent");
    expect(strip(filtered).find((x) => x.k === "tackles")).toEqual(f);
    // rule (iii) and byType reflect the scope rows
    expect(filtered.items.find((i) => i.key === "tackles")?.currentErrors).toBe(0);
  });
  it("merges stat keys by case and whitespace", () => {
    const t = trends(statRows(" Tackles ", 10, 4), [hc(1, 1, { tackles: [10, 3] }), hc(2, 2, { tackles: [10, 3] })]);
    expect(t.items[0].key).toBe("tackles");
  });
});

describe("degradation", () => {
  const rows = [...statRows("Tackles", 6, 3)];
  it("level none and a note with no history", () => {
    const p = plan(rows, { history: null });
    expect(p.trends.level).toBe("none");
    expect(p.notes.join(" ")).toMatch(/History not loaded|No earlier checks/);
    expect(p.instances.length).toBe(3);
    expect(p.focus.length).toBeGreaterThan(0);
    const empty = plan(rows, { history: hist([]) });
    expect(empty.notes.join(" ")).toContain("No earlier checks found for Sam");
  });
  it("uses category level when no check has stats", () => {
    const cat = (id: number, day: number) => hc(id, day, null, { categories: [{ category: "Defence", total: 10, exact: 6 }] });
    const p = plan(rows, { history: hist([cat(1, 1), cat(2, 2), cat(3, 3)]) });
    expect(p.trends.level).toBe("category");
    expect(p.trends.notes.join(" ")).toContain("Per-stat history not available; showing category-level trends");
    expect(p.trends.items[0].label).toBe("Defence");
  });
  it("mixes: stat level with null checks omitted and a note", () => {
    const p = plan(rows, { history: hist([hc(1, 1, null), hc(2, 2, { tackles: [10, 3] }), hc(3, 3, { tackles: [10, 3] })]) });
    expect(p.trends.level).toBe("stat");
    expect(p.trends.notes.join(" ")).toContain("left out");
    expect(p.trends.items[0].points).toHaveLength(3);
  });
  it("notes confirmed disputes at category level", () => {
    const cat = (id: number, day: number) => hc(id, day, null, { categories: [{ category: "Defence", total: 10, exact: 6 }] });
    const rs = statRows("Tackles", 6, 3);
    const p = plan(rs, { history: hist([cat(1, 1), cat(2, 2)]), ctx: { disputes: [dispute({ instance_id: rs[0].master!.id, status: "confirmed" })] } });
    expect(p.notes.join(" ")).toContain("not adjusted for resolved disputes");
  });
  it("adds the AI insights and truncation notes", () => {
    const p = plan(rows, { history: { ...hist([hc(1, 1, { tackles: [10, 3] })]), matchedInWindow: 35 }, options: { window: { mode: "days", days: 90 } } });
    expect(p.notes.join(" ")).toContain("can differ from AI insights");
    expect(p.notes.join(" ")).toContain("Showing the most recent 1 of 35 checks in the window");
  });
  it("says so when there are no errors", () => {
    const p = plan([row("exact", {}, {})]);
    expect(p.notes).toContain("No errors in this scope");
    expect(p.focus).toHaveLength(0);
  });
});

describe("focus", () => {
  it("links stat items to every scope instance of the stat and caps at 5", () => {
    const rows = [
      ...statRows("Tackles", 10, 5, "wrong_player"),
      ...statRows("Goal", 10, 4),
      ...statRows("Mark", 10, 4),
      ...statRows("Kick", 10, 4),
      ...statRows("Hand", 10, 4),
      ...statRows("Run", 10, 4),
      ...statRows("Block", 10, 4),
    ];
    const hs = (n: number) => hc(n, n, { tackles: [10, 4], goal: [10, 4], mark: [10, 4], kick: [10, 4], hand: [10, 4], run: [10, 4], block: [10, 4] });
    const p = plan(rows, { history: hist([hs(1), hs(2), hs(3)]) });
    expect(p.focus.length).toBeLessThanOrEqual(C.MAX_FOCUS_ITEMS);
    const tackles = p.focus.find((f) => f.id === "stat:tackles")!;
    expect(tackles.kind).toBe("stat");
    expect(tackles.instanceKeys).toHaveLength(5);
    expect(tackles.errorType).toBe("wrong_player");
    expect(tackles.title).toContain("Tackles attribution");
    expect(tackles.title).toContain("3 of last 3 checks");
    const keys = new Set(p.instances.map((i) => i.key));
    for (const f of p.focus) for (const k of f.instanceKeys) expect(keys.has(k)).toBe(true);
    expect(p.focus.map((f) => f.rank)).toEqual(p.focus.map((_, i) => i + 1));
  });
  it("scores priority and orders descending", () => {
    const rows = [...statRows("Tackles", 10, 5), ...statRows("Goal", 10, 4)];
    const hs = (n: number) => hc(n, n, { tackles: [10, 4], goal: [10, 0] });
    const p = plan(rows, { history: hist([hs(1), hs(2)]) });
    const t = p.focus.find((f) => f.id === "stat:tackles")!;
    // 5 errors + persistent 5 + top_this_check 2
    expect(t.priority).toBe(5 + 5 + 2);
    const prios = p.focus.map((f) => f.priority);
    expect([...prios].sort((a, b) => b - a)).toEqual(prios);
  });
  it("adds an error-type item only when not already covered", () => {
    // 3 missed spread across stats with no trends => type item
    const rows = [...statRows("A", 2, 1), ...statRows("B", 2, 1), ...statRows("C", 2, 1)];
    const p = plan(rows);
    const t = p.focus.find((f) => f.id === "type:missed")!;
    expect(t.kind).toBe("errorType");
    expect(t.priority).toBeCloseTo(0.8 * 3);
    // covered: a trending stat holds all the missed instances
    const rows2 = statRows("Tackles", 10, 4);
    const hs = (n: number) => hc(n, n, { tackles: [10, 4] });
    const p2 = plan(rows2, { history: hist([hs(1), hs(2)]) });
    expect(p2.focus.some((f) => f.id === "type:missed")).toBe(false);
  });
  it("applies the coverage threshold at 0.7", () => {
    // 10 wrong_stat instances: stat X holds 7 (70%) and is trending; Y holds 3.
    const rows = [...statRows("X", 10, 7, "wrong_stat"), ...statRows("Y", 10, 3, "wrong_stat")];
    const h = (n: number) => hc(n, n, { x: [10, 7], y: [10, 0] });
    const p = plan(rows, { history: hist([h(1), h(2)]) });
    expect(p.focus.some((f) => f.id === "stat:x")).toBe(true);
    expect(p.focus.some((f) => f.id === "type:wrong_stat")).toBe(false); // 7/10 >= 0.7 skipped
    const rows2 = [...statRows("X", 10, 6, "wrong_stat"), ...statRows("Y", 10, 4, "wrong_stat")];
    const h2 = (n: number) => hc(n, n, { x: [10, 6], y: [10, 0] });
    const p2 = plan(rows2, { history: hist([h2(1), h2(2)]) });
    expect(p2.focus.some((f) => f.id === "type:wrong_stat")).toBe(true); // 6/10 < 0.7 kept
  });
  it("mentions wrong-stat rows that also had the wrong player", () => {
    const rows = [
      ...statRows("Tackles", 3, 3, "wrong_player"),
      row("wrong_stat", { stat: "Tackles" }, { stat: "Hit Out" }, { alsoWrongPlayer: true }),
    ];
    const p = plan(rows);
    expect(p.focus.find((f) => f.id === "type:wrong_player")!.why).toContain("+1 wrong-stat rows also had the wrong player");
  });
  it("drillFor picks the most specific rule and falls back to the default", () => {
    expect(drillFor("Tackles", null, "missed")).toMatch(/second pass/);
    expect(drillFor("Goal", null, "missed")).toBe(DEFAULT_DRILLS.missed);
    expect(drillFor(null, null, "wrong_player")).toMatch(/roster/);
  });
  it("buildFocus returns [] with no instances", () => {
    expect(buildFocus({ instances: [], trends: { level: "none", items: [], notes: [] }, options: opts(), history: [] })).toEqual([]);
  });
});

describe("selectHistoryChecks", () => {
  const meta = (id: number, day: number, over: Partial<AccuracyCheckMeta> = {}) =>
    ({
      id,
      created_at: `2025-05-${String(day).padStart(2, "0")}T00:00:00Z`,
      analyst_name: "Sam",
      accuracy: 0.8,
      sport: "afl",
      category: null,
      ...over,
    }) as AccuracyCheckMeta;
  const ref = { date: new Date("2025-06-01T00:00:00Z"), sport: "afl" as const, category: null, excludeCheckId: null as number | null, analystName: "sam" };
  it("filters by analyst, sport, accuracy, current id and date", () => {
    const metas = [
      meta(1, 1),
      meta(2, 2, { analyst_name: "Other" }),
      meta(3, 3, { sport: "football" }),
      meta(4, 4, { sport: null }),
      meta(5, 5, { accuracy: null as unknown as number }),
      meta(6, 6),
      meta(7, 7, { created_at: "2025-07-01T00:00:00Z" }),
    ];
    const { selected } = selectHistoryChecks(metas, { mode: "checks", n: 10 }, { ...ref, excludeCheckId: 6 });
    expect(selected.map((m) => m.id)).toEqual([1, 4]);
  });
  it("windows by checks and by days, capping at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => meta(i + 1, (i % 28) + 1, { created_at: new Date(Date.UTC(2025, 4, 1) + i * 3_600_000).toISOString() }));
    expect(selectHistoryChecks(many, { mode: "checks", n: 5 }, ref).selected.map((m) => m.id)).toEqual([26, 27, 28, 29, 30]);
    expect(selectHistoryChecks(many, { mode: "checks", n: 99 }, ref).selected).toHaveLength(20);
    const d = selectHistoryChecks(many, { mode: "days", days: 90 }, ref);
    expect(d.selected).toHaveLength(20);
    expect(d.matchedInWindow).toBe(30);
    const none = selectHistoryChecks(many, { mode: "days", days: 1 }, ref);
    expect(none.selected).toHaveLength(0);
  });
  it("treats legacy null category as full_game in both directions", () => {
    expect(normCat(null)).toBe("full_game");
    const metas = [meta(1, 1, { category: "full_game" }), meta(2, 2, { category: null }), meta(3, 3, { category: "golden_accuracy" }), meta(4, 4, { category: "specific_stats" })];
    const ids = (cat: string | null) => selectHistoryChecks(metas, { mode: "checks", n: 10 }, { ...ref, category: cat }).selected.map((m) => m.id);
    expect(ids(null)).toEqual([1, 2]);
    expect(ids("full_game")).toEqual([1, 2]);
    expect(ids("golden_accuracy")).toEqual([3]);
    expect(ids("specific_stats")).toEqual([4]);
  });
});

describe("default message", () => {
  it("lists accuracy, counts, top focus titles, attachment note and link, within the cap", () => {
    const rows = [...statRows("Tackles", 10, 5), ...statRows("Goal", 10, 4)];
    const p = plan(rows, { history: hist([hc(1, 1, { tackles: [10, 4], goal: [10, 4] }), hc(2, 2, { tackles: [10, 4], goal: [10, 4] })]) });
    const msg = buildDefaultMessage(p, { senderName: "Boss", reviewLink: "https://a/b?check=5" });
    expect(msg).toContain("Overall accuracy");
    expect(msg).toContain("Missed 9");
    expect(msg).toContain(`1. ${p.focus[0].title}`);
    expect(msg).toContain("Full plan attached as Excel");
    expect(msg).toContain("https://a/b?check=5");
    expect(msg).not.toContain(`${C.MESSAGE_TOP_FOCUS + 1}. `);
    expect(msg.length).toBeLessThanOrEqual(4000);
  });
});
