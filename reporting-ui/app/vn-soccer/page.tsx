"use client";

// VN / Soccer reporting
// ─────────────────────
// Two views over the SoccerData + VNTeam sheets (synced to soccer_games and
// vn_team):
//   1. Completions by week — who coded which soccer game each week, using the
//      same Wed→Tue season weeks as the rest of reporting (soccer_games.week is
//      derived from the date in sync-deputy.js).
//   2. VN cost per game — each VN member's fixed weekly wage divided by the
//      games they completed, both per week and across the whole selection.
//
// Season + single Week filter mirror the Reporting dashboard.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { seasonsFromTT } from "@/lib/analytics/season";

const PAGE_SIZE = 1000;

async function fetchAll<T>(table: string): Promise<T[]> {
  let from = 0;
  let all: T[] = [];
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error(`Error fetching ${table}:`, error);
      break;
    }
    if (!data || data.length === 0) break;
    all = all.concat(data as T[]);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

type SoccerGame = {
  game_key: string;
  Date: string | null;
  Competition: string | null;
  Round: string | null;
  home_team: string | null;
  away_team: string | null;
  home_allocated: string | null;
  away_allocated: string | null;
  Location: string | null;
  season: number | null;
  week: number | null;
  // Completion date (when the fixture was actually finished) + its derived
  // season/week. "Games completed each week" buckets by THESE, not the fixture
  // date. Null when the game has no matching completion time (excluded).
  completed_date: string | null;
  completed_season: number | null;
  completed_week: number | null;
};

type VnMember = { name: string; weekly_wage: number | null };

const fmtMoney = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Game counts are in half-game units (0.5 per side), so show a ".5" when
// present but keep whole numbers clean.
const fmtGames = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(1);

const norm = (v: unknown) =>
  String(v ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export default function VnSoccerPage() {
  const [games, setGames] = useState<SoccerGame[]>([]);
  const [vn, setVn] = useState<VnMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<string>("all");
  const [week, setWeek] = useState<string>("all");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [g, v] = await Promise.all([
        fetchAll<SoccerGame>("soccer_games"),
        fetchAll<VnMember>("vn_team"),
      ]);
      setGames(g);
      setVn(v);
      setLoading(false);
    })();
  }, []);

  // Source of truth = SoccerData (every game, by its FIXTURE date). No
  // completion-time filtering — all games count, bucketed by fixture season/week.
  const seasonInfo = useMemo(() => seasonsFromTT(games), [games]);

  // Season with the MOST games — a better default than "latest year", since a
  // brand-new season may hold only a week or two.
  const biggestSeason = useMemo(() => {
    const counts = new Map<number, number>();
    for (const g of games) {
      const s = Number(g.season);
      if (Number.isFinite(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestN = -1;
    for (const [s, n] of counts) {
      if (n > bestN) {
        bestN = n;
        best = s;
      }
    }
    return best;
  }, [games]);

  useEffect(() => {
    if (season === "all" && biggestSeason != null) {
      setSeason(String(biggestSeason));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biggestSeason]);

  // Reset week when season changes (week numbers restart each season).
  useEffect(() => {
    setWeek("all");
  }, [season]);

  const seasonGames = useMemo(() => {
    if (season === "all") return games;
    if (season === "unknown") {
      return games.filter((g) => g.season == null || !Number.isFinite(Number(g.season)));
    }
    const yr = Number(season);
    return games.filter((g) => Number(g.season) === yr);
  }, [games, season]);

  const weekOptions = useMemo(() => {
    const set = new Set<number>();
    for (const g of seasonGames) {
      const w = Number(g.week);
      if (Number.isFinite(w)) set.add(w);
    }
    return [...set].sort((a, b) => a - b);
  }, [seasonGames]);

  const scopedGames = useMemo(() => {
    if (week === "all") return seasonGames;
    const w = Number(week);
    return seasonGames.filter((g) => Number(g.week) === w);
  }, [seasonGames, week]);

  // VN wage lookup (normalised name -> weekly wage).
  const wageByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of vn) m.set(norm(r.name), Number(r.weekly_wage) || 0);
    return m;
  }, [vn]);

  // Is an allocated name a VN team member?
  const isVn = (name: string | null) => !!name && wageByName.has(norm(name));

  // ── Completions by week (who coded what) ──
  // Each game credits its allocated analyst(s). Home/away are usually the same
  // person here, so we credit distinct allocated names once per game.
  const completions = useMemo(() => {
    // week -> analyst -> game credit. Each game has TWO sides; each side is
    // 0.5 of a game. Home-allocated gets 0.5, away-allocated gets 0.5 — so the
    // same person on both sides = 1.0, two different people = 0.5 each.
    const byWeek = new Map<number, Map<string, number>>();
    const credit = (wkMap: Map<string, number>, name: string | null) => {
      const n = name?.trim();
      if (!n) return;
      wkMap.set(n, (wkMap.get(n) ?? 0) + 0.5);
    };
    for (const g of scopedGames) {
      const wk = Number(g.week);
      if (!Number.isFinite(wk)) continue;
      if (!g.home_allocated && !g.away_allocated) continue;
      if (!byWeek.has(wk)) byWeek.set(wk, new Map());
      const wkMap = byWeek.get(wk)!;
      credit(wkMap, g.home_allocated);
      credit(wkMap, g.away_allocated);
    }
    return [...byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([wk, analysts]) => ({
        week: wk,
        analysts: [...analysts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        total: [...analysts.values()].reduce((s, n) => s + n, 0),
      }));
  }, [scopedGames]);

  // ── Games coded per analyst (ALL soccer analysts, not just VN) ──
  // Soccer games only — kept entirely separate from AFL/TT totals. Half-game
  // credit: home-allocated 0.5 + away-allocated 0.5 per game.
  const gamesByAnalyst = useMemo(() => {
    const tally = new Map<string, number>();
    const credit = (name: string | null) => {
      const n = name?.trim();
      if (!n) return;
      tally.set(n, (tally.get(n) ?? 0) + 0.5);
    };
    for (const g of scopedGames) {
      credit(g.home_allocated);
      credit(g.away_allocated);
    }
    return [...tally.entries()]
      .map(([name, games]) => ({ name, games, isVn: isVn(name) }))
      .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedGames, wageByName]);

  // ── VN cost per game ──
  // For each VN member: games completed, weeks active (distinct weeks they
  // coded in), total wage = weekly_wage × weeks active, avg cost/game =
  // total wage / games. Weekly avg = weekly_wage / games that week.
  const vnBreakdown = useMemo(() => {
    // member -> { games, weeks:Set, perWeek: Map<week, games> }
    // Each game side = 0.5. A member credited on both sides of one game gets
    // 1.0; a single side gets 0.5.
    const acc = new Map<string, { games: number; weeks: Set<number>; perWeek: Map<number, number> }>();
    const creditMember = (name: string | null, wk: number) => {
      const n = name?.trim();
      if (!n || !isVn(n)) return;
      const key = norm(n);
      if (!acc.has(key)) acc.set(key, { games: 0, weeks: new Set(), perWeek: new Map() });
      const a = acc.get(key)!;
      a.games += 0.5;
      if (Number.isFinite(wk)) {
        a.weeks.add(wk);
        a.perWeek.set(wk, (a.perWeek.get(wk) ?? 0) + 0.5);
      }
    };
    for (const g of scopedGames) {
      const wk = Number(g.week);
      creditMember(g.home_allocated, wk);
      creditMember(g.away_allocated, wk);
    }
    return vn
      .map((member) => {
        const key = norm(member.name);
        const a = acc.get(key);
        const wage = Number(member.weekly_wage) || 0;
        const gamesTotal = a?.games ?? 0;
        const weeksActive = a?.weeks.size ?? 0;
        const totalWage = wage * weeksActive;
        const avgCostPerGame = gamesTotal > 0 ? totalWage / gamesTotal : null;
        // Per-week rows for this member.
        const perWeek = a
          ? [...a.perWeek.entries()]
              .sort((x, y) => x[0] - y[0])
              .map(([wk, gc]) => ({
                week: wk,
                games: gc,
                avgCostPerGame: gc > 0 ? wage / gc : null,
              }))
          : [];
        return {
          name: member.name,
          weeklyWage: wage,
          gamesTotal,
          weeksActive,
          totalWage,
          avgCostPerGame,
          perWeek,
        };
      })
      .sort((a, b) => b.gamesTotal - a.gamesTotal || a.name.localeCompare(b.name));
  }, [scopedGames, vn, wageByName]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 p-8 text-slate-600">
        Loading VN / Soccer…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-6xl p-6 lg:p-8">
        {/* Header + filters */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">VN / Soccer</h1>
            <p className="mt-1 text-sm text-slate-600">
              Soccer completions by week and Vietnam team cost per game.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {(seasonInfo.years.length > 0 || seasonInfo.hasUnknown) && (
              <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
                Season
                <select
                  value={season}
                  onChange={(e) => setSeason(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="all">All seasons</option>
                  {seasonInfo.years.map((y) => (
                    <option key={y} value={String(y)}>
                      {y} season
                    </option>
                  ))}
                  {seasonInfo.hasUnknown && <option value="unknown">Unknown</option>}
                </select>
              </label>
            )}

            <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
              Week
              <select
                value={week}
                onChange={(e) => setWeek(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none focus:border-blue-500"
              >
                <option value="all">All weeks</option>
                {weekOptions.map((w) => (
                  <option key={w} value={String(w)}>
                    Week {w}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Summary cards */}
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard label="Soccer games" value={String(scopedGames.length)} />
          <SummaryCard label="VN members" value={String(vn.length)} />
          <SummaryCard
            label="Weeks in view"
            value={String(weekOptions.length === 0 ? 0 : week === "all" ? weekOptions.length : 1)}
          />
          <SummaryCard
            label="Total weekly pool"
            value={fmtMoney(vn.reduce((s, m) => s + (Number(m.weekly_wage) || 0), 0))}
          />
        </div>

        {/* GAMES CODED PER ANALYST (all soccer analysts) */}
        <section className="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Soccer games coded — by analyst
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Soccer only (separate from AFL). Half-game credit: 0.5 per side, so
              two analysts on one game get 0.5 each. VN members marked in green.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="w-10 px-4 py-2.5 text-right">#</th>
                  <th className="px-4 py-2.5">Analyst</th>
                  <th className="px-4 py-2.5 text-right">Games coded</th>
                </tr>
              </thead>
              <tbody>
                {gamesByAnalyst.map((a, i) => (
                  <tr key={a.name} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">{i + 1}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-800">
                      <span
                        className={
                          a.isVn
                            ? "inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-emerald-700"
                            : ""
                        }
                        title={a.isVn ? "VN team member" : undefined}
                      >
                        {a.name}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                      {fmtGames(a.games)}
                    </td>
                  </tr>
                ))}
                {gamesByAnalyst.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                      No soccer games in this selection.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* VN COST PER GAME */}
        <section className="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              VN Team — cost per game
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Avg cost/game = (weekly wage × weeks active) ÷ games completed, over the current selection.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2.5">Member</th>
                  <th className="px-4 py-2.5 text-right">Weekly wage</th>
                  <th className="px-4 py-2.5 text-right">Games</th>
                  <th className="px-4 py-2.5 text-right">Weeks active</th>
                  <th className="px-4 py-2.5 text-right">Total wage</th>
                  <th className="px-4 py-2.5 text-right">Avg cost / game</th>
                </tr>
              </thead>
              <tbody>
                {vnBreakdown.map((m) => (
                  <tr key={m.name} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{m.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {fmtMoney(m.weeklyWage)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{fmtGames(m.gamesTotal)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{m.weeksActive}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {fmtMoney(m.totalWage)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                      {m.avgCostPerGame == null ? "—" : fmtMoney(m.avgCostPerGame)}
                    </td>
                  </tr>
                ))}
                {vnBreakdown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                      No VN team data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* COMPLETIONS BY WEEK */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Completions by week
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Soccer games coded per analyst each week (Wed→Tue weeks).
            </p>
          </div>

          {completions.length === 0 ? (
            <div className="px-5 py-8 text-center text-slate-400">
              No soccer games in this selection.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {completions.map((row) => (
                <div key={row.week} className="px-5 py-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-800">
                      Week {row.week}
                    </span>
                    <span className="text-xs font-medium text-slate-500">
                      {fmtGames(row.total)} game{row.total === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {row.analysts.map((a) => (
                      <span
                        key={a.name}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                          isVn(a.name)
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                        title={isVn(a.name) ? "VN team member" : undefined}
                      >
                        {a.name}
                        <span className="rounded-full bg-white/70 px-1.5 font-bold">
                          {fmtGames(a.count)}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}
