"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import dynamic from "next/dynamic";

import AnalystHero from "./AnalystHero";
import ExecutiveSummary from "./ExecutiveSummary";
import LeagueBreakdown from "./LeagueBreakdown";
import TeamBreakdown from "./TeamBreakdown";
// Trend charts pull in recharts — load lazily so it stays out of the initial
// profile bundle and only downloads when the charts render.
const trendLoading = () => (
  <div className="flex h-full items-center justify-center text-sm text-slate-400">
    Loading chart…
  </div>
);
const AverageCodingTimeTrend = dynamic(() => import("./AverageCodingTimeTrend"), {
  ssr: false,
  loading: trendLoading,
});
const GamesCompletedTrend = dynamic(() => import("./GamesCompletedTrend"), {
  ssr: false,
  loading: trendLoading,
});
const HoursPerWeekTrend = dynamic(() => import("./HoursPerWeekTrend"), {
  ssr: false,
  loading: trendLoading,
});
import DashboardChartCard from "./DashboardChartCard";
import { buildAnalystBenchmark } from "@/lib/analytics/buildAnalystBenchmark";
import AttributeRatings from "./AttributeRatings";
import type { DeputyShift } from "@/types/deputy";
import type { TTGame } from "@/types/ttgame";
import { supabase } from "@/lib/supabase";
import { analystShifts, getDeputyShifts } from "@/lib/api/deputyShifts";
import DeputyLoadError from "@/components/DeputyLoadError";
import { buildAnalystMetrics } from "@/lib/analytics/buildAnalystMetrics";
import { getCompAllocationGames } from "@/lib/api/compFixtures";
import type { AnalystMetrics } from "@/types/analyst";
import { useAuth } from "@/components/auth/AuthContext";

export default function AnalystProfilePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0b1220] text-white p-10">Loading...</div>}>
      <AnalystProfileContent />
    </Suspense>
  );
}

function AnalystProfileContent() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  // Analyst-role users only see their own profile: hide the analyst switcher,
  // compare and dashboard controls.
  const isAnalystRole = user?.role === "analyst";
  const analystParam = searchParams.get("analyst");
  // Analyst-role users are locked to their own allocated name; admins use the
  // ?analyst= param (or "All").
  const initialAnalyst =
    isAnalystRole && user?.analyst_name?.trim()
      ? user.analyst_name.trim()
      : analystParam ?? "All";
  const [selectedAnalyst, setSelectedAnalyst] = useState(initialAnalyst);

  // Keep an analyst-role user pinned to their own profile even if the URL
  // param changes or auth loads after first render.
  useEffect(() => {
    if (isAnalystRole && user?.analyst_name?.trim()) {
      setSelectedAnalyst(user.analyst_name.trim());
    }
  }, [isAnalystRole, user?.analyst_name]);
  const [analysts, setAnalysts] = useState<AnalystMetrics[]>([]);
  const [shifts, setShifts] = useState<DeputyShift[]>([]);
  const [games, setGames] = useState<TTGame[]>([]);
  const [teamLogoMap, setTeamLogoMap] = useState<Record<string, string>>({});
  const [affiliations, setAffiliations] =
    useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [gameSortField, setGameSortField] = useState("Week");
  const [gameSortDir, setGameSortDir] = useState<"asc" | "desc">("desc");

  const PAGE_SIZE = 1000;

  // -------------------------
  // FETCH ALL ROWS
  // -------------------------
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

  // -------------------------
  // LOAD DATA
  // -------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);

let shiftsData: DeputyShift[];
      try {
        shiftsData = analystShifts(await getDeputyShifts({ force: reloadKey > 0 }));
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
        return;
      }
const gamesData = await fetchAll<TTGame>("TT_Games");

      // Merge comp-fixture allocations (home/away team-side analyst) so a
      // fixture shows in an analyst's profile when they're allocated to either
      // side — even if it isn't in TT_Games (or has no allocation there yet).
      // We only ADD an allocation the TT_Games set doesn't already carry (same
      // game_key + side + analyst), so games aren't double-counted.
      try {
        const compGames = await getCompAllocationGames();
        if (compGames.length > 0) {
          const norm = (v: unknown) =>
            String(v ?? "").trim().toLowerCase();
          // Existing (game_key|side|analyst) tuples from TT_Games.
          const existing = new Set<string>();
          for (const g of gamesData) {
            const gk = norm(g.game_key);
            if (g.home_allocated)
              existing.add(`${gk}|home|${norm(g.home_allocated)}`);
            if (g.away_allocated)
              existing.add(`${gk}|away|${norm(g.away_allocated)}`);
          }

          let nextId = -1; // synthetic negative ids so they don't clash
          for (const cg of compGames) {
            const gk = norm(cg.game_key);
            const side = cg.home_allocated ? "home" : "away";
            const analyst = cg.home_allocated ?? cg.away_allocated ?? "";
            const tupleKey = `${gk}|${side}|${norm(analyst)}`;
            if (existing.has(tupleKey)) continue; // already counted
            existing.add(tupleKey);

            gamesData.push({
              id: nextId--,
              downloadPercent: null,
              fileSizeBytes: null,
              Week: cg.Week,
              Date: cg.Date,
              Competition: cg.Competition,
              Round: cg.Round,
              home_team: cg.home_team,
              away_team: cg.away_team,
              home_allocated: cg.home_allocated,
              away_allocated: cg.away_allocated,
              expected_day: null,
              game_key: cg.game_key,
              videoURL: cg.videoURL,
            });
          }
        }
      } catch (err) {
        // Comp allocations are supplementary — never block the profile.
        console.error("Failed merging comp-fixture allocations:", err);
      }

      // Fetch team logos from Supabase
      try {
        // Only fetch teams that actually have a logo. The teams table has
        // >1000 rows (one per distinct team name), which would hit Supabase's
        // default 1000-row cap and silently drop most clubs; filtering to
        // non-null logo_url keeps the result small and complete.
        const { data: teamsData, error: teamsError } = await supabase
          .from("teams")
          .select("team_name, logo_url")
          .not("logo_url", "is", null);

        if (!teamsError && teamsData) {
          const logoMap: Record<string, string> = {};
          for (const row of teamsData) {
            if (row.team_name && row.logo_url) {
              logoMap[row.team_name.trim().toLowerCase()] = row.logo_url;
            }
          }
          setTeamLogoMap(logoMap);
        }
      } catch {
        // Logos are non-critical; leave the map empty if the fetch fails.
      }

      // Fetch analyst → team affiliations
      try {
        const { data: affiliationData, error: affiliationError } =
          await supabase
            .from("analyst_team_affiliations")
            .select("analyst_name, teams ( team_name )");

        if (!affiliationError && affiliationData) {
          const map = new Map<string, string[]>();

          for (const row of affiliationData as any[]) {
            const name = row.analyst_name?.trim().toLowerCase();
            const team = row.teams?.team_name?.trim();

            if (!name || !team) continue;

            const existing = map.get(name) ?? [];
            if (!existing.includes(team)) existing.push(team);
            map.set(name, existing);
          }

          setAffiliations(map);
        }
      } catch {
        // Affiliations are supplementary — fail quietly
      }

      if (cancelled) return;
      setShifts(shiftsData);
      setGames(gamesData);

      const analystData =
        buildAnalystBenchmark(
          buildAnalystMetrics(
            shiftsData,
            gamesData
          )
        );
      setAnalysts(analystData);

      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // -------------------------
  // DROPDOWN LIST
  // -------------------------
  const analystList = useMemo(() => {
    return [
      "All",
      ...analysts
        .map((a) => a.name)
        .sort((a, b) => a.localeCompare(b)),
    ];
  }, [analysts]);

  // -------------------------
  // ACTIVE ANALYST
  // -------------------------
  const activeData = useMemo(() => {
    if (!analysts.length) return null;

    if (selectedAnalyst === "All") return analysts[0];

    // Match by exact name, then case-insensitively. IMPORTANT: do NOT fall
    // back to another analyst — if there's no match (e.g. the analyst has no
    // coded games yet), return null so we show an empty state rather than
    // someone else's profile.
    const target = selectedAnalyst.trim().toLowerCase();
    return (
      analysts.find((a) => a.name === selectedAnalyst) ||
      analysts.find((a) => a.name.trim().toLowerCase() === target) ||
      null
    );
  }, [selectedAnalyst, analysts]);


  // -------------------------
  // FILTERING (CRITICAL FIX)
  // -------------------------
const filteredShifts = useMemo(() => {
  if (selectedAnalyst === "All") return shifts;

  return shifts.filter(
    (shift) => shift.employee_name === selectedAnalyst
  );
}, [shifts, selectedAnalyst]);

const filteredGames = useMemo(() => {
  if (selectedAnalyst === "All") return games;

  return games.filter(
    (game) =>
      game.home_allocated === selectedAnalyst ||
      game.away_allocated === selectedAnalyst
  );
}, [games, selectedAnalyst]);

  // -------------------------
  // LOADING STATE
  // -------------------------
  if (loadError) {
    return (
      <div className="min-h-screen bg-[#0b1220] p-10">
        <DeputyLoadError message={loadError} onRetry={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b1220] text-white p-10">
        Loading analysts...
      </div>
    );
  }

  // -------------------------
  // MAIN RENDER
  // -------------------------
  return (
    <div className="min-h-screen bg-[#0b1220] p-6 text-slate-200">

      {/* TOP FILTER — hidden for analyst-role users (own profile only) */}
      {!isAnalystRole && (
      <div className="max-w-7xl mx-auto mb-6 flex items-center justify-between">
        {/* BACK TO DASHBOARD */}
        <Link
          href="/"
          className="
      inline-flex
      items-center
      gap-2
      rounded-lg
      border
      border-slate-700
      bg-[#0f1b2d]
      px-4
      py-2
      text-sm
      font-medium
      text-slate-200
      transition
      hover:border-sky-500/50
      hover:bg-slate-800
      hover:text-white
    "
        >
          <span aria-hidden="true">←</span>
          Back to Dashboard
        </Link>

        <Link
          href="/analyst-compare"
          className="
        inline-flex
        items-center
        gap-2
        rounded-lg
        border
        border-slate-700
        bg-[#0f1b2d]
        px-4
        py-2
        text-sm
        font-medium
        text-slate-200
        transition
        hover:border-sky-500/50
        hover:bg-slate-800
    "
        >
          Compare Analysts
        </Link>

        {/* ANALYST FILTER */}
        <select
          value={selectedAnalyst}
          onChange={(e) => setSelectedAnalyst(e.target.value)}
          className="
    relative
    z-[9999]
    rounded-lg
    border
    border-slate-700
    bg-[#0f1b2d]
    px-3
    py-2
    text-sm
    text-slate-200
    focus:outline-none
    focus:ring-1
    focus:ring-sky-400
  "
        >
          {analystList.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      )}

      {/* CONTENT */}
      <div className="max-w-7xl mx-auto space-y-6">

        {activeData ? (
          <>
            <div className="relative z-20">
              <AnalystHero
                data={activeData}
                affiliatedTeams={
                  affiliations.get(
                    activeData.name.trim().toLowerCase()
                  ) ?? []
                }
                logoMap={teamLogoMap}
              />
            </div>

            <div className="relative z-10">
              <ExecutiveSummary data={activeData} />
            </div>

            <div className="relative z-10">
              <AttributeRatings ratings={activeData.ratings} />
            </div>

            {/* TOP METRICS ROW (ALL IN ONE LINE) */}
            <div className="grid grid-cols-3 gap-6 items-stretch">

              <DashboardChartCard title="Ave Weekly Coding Speed">
                <div className="h-[260px]">
                  <AverageCodingTimeTrend
                    deputyData={shifts}
                    ttData={games}
                    analystName={selectedAnalyst}
                  />
                </div>
              </DashboardChartCard>

              <DashboardChartCard title="Games Completed Per Week">
                <div className="h-[260px]">
                  <GamesCompletedTrend
                    data={games}
                    analystName={selectedAnalyst}
                  />
                </div>
              </DashboardChartCard>

              <DashboardChartCard title="Hours Per Week">
                <HoursPerWeekTrend
                  deputyData={filteredShifts}
                />
              </DashboardChartCard>

            </div>

            {/* LEAGUE + TEAM */}
            <div className="grid grid-cols-2 gap-6 items-stretch">
              <div className="h-full">
                <LeagueBreakdown data={activeData.competitions} />
              </div>

              <div className="h-full">
                <TeamBreakdown data={activeData.teams} logoMap={teamLogoMap} />
              </div>
            </div>

            {/* CODED GAMES */}
            {filteredGames.length > 0 && (() => {
              const [gameSort, setGameSort] = [gameSortField, setGameSortField];
              const [gameDir, setGameDir] = [gameSortDir, setGameSortDir];

              const sortedGames = [...filteredGames].sort((a, b) => {
                const dir = gameDir === "asc" ? 1 : -1;
                switch (gameSort) {
                  case "Week": return (Number(a.Week) - Number(b.Week)) * dir;
                  case "Competition": return (a.Competition ?? "").localeCompare(b.Competition ?? "") * dir;
                  case "Round": return (Number(a.Round) - Number(b.Round)) * dir;
                  case "home_team": return (a.home_team ?? "").localeCompare(b.home_team ?? "") * dir;
                  case "away_team": return (a.away_team ?? "").localeCompare(b.away_team ?? "") * dir;
                  case "role": {
                    const name = activeData?.name ?? selectedAnalyst;
                    const roleA = a.home_allocated === name && a.away_allocated === name ? "Both" : a.home_allocated === name ? "Home" : "Away";
                    const roleB = b.home_allocated === name && b.away_allocated === name ? "Both" : b.home_allocated === name ? "Home" : "Away";
                    return roleA.localeCompare(roleB) * dir;
                  }
                  default: return 0;
                }
              });

              const handleGameSort = (field: string) => {
                if (gameSort === field) {
                  setGameDir(gameDir === "asc" ? "desc" : "asc");
                } else {
                  setGameSortField(field);
                  setGameDir("asc");
                }
              };

              const SortIcon = ({ field }: { field: string }) => {
                if (gameSort !== field) return null;
                return <span>{gameDir === "asc" ? " ▲" : " ▼"}</span>;
              };

              return (
                <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-5">
                  <h3 className="mb-4 text-lg font-bold text-white">
                    Games Coded ({filteredGames.length})
                  </h3>

                  <div className="overflow-hidden rounded-lg border border-slate-700">
                    <table className="w-full table-fixed text-left text-xs">
                      <colgroup>
                        <col className="w-[8%]" />
                        <col className="w-[25%]" />
                        <col className="w-[8%]" />
                        <col className="w-[22%]" />
                        <col className="w-[22%]" />
                        <col className="w-[15%]" />
                      </colgroup>
                      <thead className="bg-slate-800 text-slate-400 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 cursor-pointer hover:text-white" onClick={() => handleGameSort("Week")}>
                            Wk<SortIcon field="Week" />
                          </th>
                          <th className="px-3 py-2 cursor-pointer hover:text-white" onClick={() => handleGameSort("Competition")}>
                            Competition<SortIcon field="Competition" />
                          </th>
                          <th className="px-3 py-2 cursor-pointer hover:text-white" onClick={() => handleGameSort("Round")}>
                            Rnd<SortIcon field="Round" />
                          </th>
                          <th className="px-3 py-2 cursor-pointer hover:text-white" onClick={() => handleGameSort("home_team")}>
                            Home<SortIcon field="home_team" />
                          </th>
                          <th className="px-3 py-2 cursor-pointer hover:text-white" onClick={() => handleGameSort("away_team")}>
                            Away<SortIcon field="away_team" />
                          </th>
                          <th className="px-3 py-2 cursor-pointer hover:text-white" onClick={() => handleGameSort("role")}>
                            Role<SortIcon field="role" />
                          </th>
                        </tr>
                      </thead>
                    </table>
                    <div className="max-h-[400px] overflow-y-auto">
                      <table className="w-full table-fixed text-left text-xs">
                        <colgroup>
                          <col className="w-[8%]" />
                          <col className="w-[25%]" />
                          <col className="w-[8%]" />
                          <col className="w-[22%]" />
                          <col className="w-[22%]" />
                          <col className="w-[15%]" />
                        </colgroup>
                        <tbody>
                          {sortedGames.map((game, i) => {
                            const name = activeData?.name ?? selectedAnalyst;
                            const isHome = game.home_allocated === name;
                            const isAway = game.away_allocated === name;
                            const role = isHome && isAway ? "Both" : isHome ? "Home" : "Away";

                            return (
                              <tr
                                key={`${game.game_key}-${i}`}
                                className="border-t border-slate-700 hover:bg-slate-800"
                              >
                                <td className="px-3 py-2 text-sky-400 font-semibold">{game.Week}</td>
                                <td className="px-3 py-2 truncate text-slate-400">{game.Competition}</td>
                                <td className="px-3 py-2 text-slate-400">{game.Round}</td>
                                <td className="px-3 py-2 truncate">{game.home_team}</td>
                                <td className="px-3 py-2 truncate">{game.away_team}</td>
                                <td className="px-3 py-2">
                                  <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                                    role === "Both"
                                      ? "bg-emerald-500/20 text-emerald-300"
                                      : role === "Home"
                                        ? "bg-sky-500/20 text-sky-300"
                                        : "bg-amber-500/20 text-amber-300"
                                  }`}>
                                    {role}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}

          </>
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-[#0f1b2d] p-10 text-center">
            <p className="text-lg font-semibold text-slate-200">
              {selectedAnalyst && selectedAnalyst !== "All"
                ? `No coded data yet for ${selectedAnalyst}`
                : "No analyst data available"}
            </p>
            <p className="mt-1 text-sm text-slate-400">
              This profile has no games or shifts recorded yet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}