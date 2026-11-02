"use client";

// Soccer Analyst Profile
// ──────────────────────
// Mirrors the AFL analyst-profile STRUCTURE (hero, leagues/competitions,
// clubs/teams, games list) but sourced from soccer_games only — kept entirely
// separate from AFL/TT. Metrics (ratings, coding speed, trends) are
// intentionally omitted; this is the games/clubs/competitions view.
//
// Half-game credit: a game credits 0.5 to its home-allocated analyst and 0.5
// to its away-allocated analyst (same person both sides = 1.0).

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import Card from "@/components/UI/Card";
import LeagueBreakdown from "../analyst-profile/LeagueBreakdown";
import TeamBreakdown from "../analyst-profile/TeamBreakdown";
import { getAnalystImage, getAnalystInitials } from "../analyst-profile/analystImages";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/components/auth/AuthContext";
import type { TeamMetric } from "@/types/analyst";

const PAGE_SIZE = 1000;

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
};

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

const fmtGames = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

async function fetchAll<T>(table: string): Promise<T[]> {
  let from = 0;
  let all: T[] = [];
  while (true) {
    const { data, error } = await supabase.from(table).select("*").range(from, from + PAGE_SIZE - 1);
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

export default function SoccerProfilePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0b1220] p-10 text-white">Loading…</div>}>
      <SoccerProfileContent />
    </Suspense>
  );
}

function SoccerProfileContent() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isAnalystRole = user?.role === "analyst";
  const analystParam = searchParams.get("analyst");
  const initialAnalyst =
    isAnalystRole && user?.analyst_name?.trim()
      ? user.analyst_name.trim()
      : analystParam ?? "All";

  const [selectedAnalyst, setSelectedAnalyst] = useState(initialAnalyst);
  const [games, setGames] = useState<SoccerGame[]>([]);
  const [teamLogoMap, setTeamLogoMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [gameSort, setGameSort] = useState<string>("Week");
  const [gameDir, setGameDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (isAnalystRole && user?.analyst_name?.trim()) {
      setSelectedAnalyst(user.analyst_name.trim());
    }
  }, [isAnalystRole, user?.analyst_name]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const g = await fetchAll<SoccerGame>("soccer_games");
      setGames(g);
      // Club logos (same teams table the AFL profile uses).
      try {
        const { data: teamsData } = await supabase
          .from("teams")
          .select("team_name, logo_url")
          .not("logo_url", "is", null);
        if (teamsData) {
          const map: Record<string, string> = {};
          for (const row of teamsData as { team_name: string; logo_url: string }[]) {
            if (row.team_name && row.logo_url) map[row.team_name.trim().toLowerCase()] = row.logo_url;
          }
          setTeamLogoMap(map);
        }
      } catch {
        /* logos non-critical */
      }
      setLoading(false);
    }
    load();
  }, []);

  // Distinct analysts (anyone allocated on either side), for the dropdown.
  const analystList = useMemo(() => {
    const set = new Set<string>();
    for (const g of games) {
      if (g.home_allocated) set.add(g.home_allocated.trim());
      if (g.away_allocated) set.add(g.away_allocated.trim());
    }
    return ["All", ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [games]);

  // Games for the selected analyst (either side). "All" = every game.
  const analystGames = useMemo(() => {
    if (selectedAnalyst === "All") return games;
    const t = norm(selectedAnalyst);
    return games.filter((g) => norm(g.home_allocated) === t || norm(g.away_allocated) === t);
  }, [games, selectedAnalyst]);

  // Half-game credit helper for the current analyst on one game.
  const creditFor = (g: SoccerGame): number => {
    if (selectedAnalyst === "All") return 1; // count each game once in "All"
    const t = norm(selectedAnalyst);
    let c = 0;
    if (norm(g.home_allocated) === t) c += 0.5;
    if (norm(g.away_allocated) === t) c += 0.5;
    return c;
  };

  // Competitions breakdown ({ competition -> games }), half-game credited.
  const competitions = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of analystGames) {
      const comp = g.Competition?.trim() || "Unknown";
      m[comp] = (m[comp] ?? 0) + creditFor(g);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analystGames, selectedAnalyst]);

  // Clubs breakdown ({ club -> { count, league } }). A game touches two clubs
  // (home + away); each gets the analyst's credit for that game.
  const teams = useMemo(() => {
    const m: Record<string, TeamMetric> = {};
    for (const g of analystGames) {
      const credit = creditFor(g);
      const league = g.Competition?.trim() || "Unknown";
      for (const club of [g.home_team, g.away_team]) {
        const name = club?.trim();
        if (!name) continue;
        if (!m[name]) m[name] = { count: 0, league };
        m[name].count += credit;
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analystGames, selectedAnalyst]);

  // Total games (half-game credited) for the header.
  const totalGames = useMemo(
    () => analystGames.reduce((s, g) => s + creditFor(g), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analystGames, selectedAnalyst]
  );

  const sortedGames = useMemo(() => {
    const dir = gameDir === "asc" ? 1 : -1;
    const name = norm(selectedAnalyst);
    const roleOf = (g: SoccerGame) => {
      const h = norm(g.home_allocated) === name;
      const a = norm(g.away_allocated) === name;
      return h && a ? "Both" : h ? "Home" : a ? "Away" : "";
    };
    return [...analystGames].sort((a, b) => {
      switch (gameSort) {
        case "Week": return ((Number(a.week) || 0) - (Number(b.week) || 0)) * dir;
        case "Competition": return (a.Competition ?? "").localeCompare(b.Competition ?? "") * dir;
        case "Round": return ((Number(a.Round) || 0) - (Number(b.Round) || 0)) * dir;
        case "home_team": return (a.home_team ?? "").localeCompare(b.home_team ?? "") * dir;
        case "away_team": return (a.away_team ?? "").localeCompare(b.away_team ?? "") * dir;
        case "role": return roleOf(a).localeCompare(roleOf(b)) * dir;
        default: return 0;
      }
    });
  }, [analystGames, gameSort, gameDir, selectedAnalyst]);

  const handleGameSort = (field: string) => {
    if (gameSort === field) setGameDir(gameDir === "asc" ? "desc" : "asc");
    else {
      setGameSort(field);
      setGameDir("asc");
    }
  };
  const SortIcon = ({ field }: { field: string }) =>
    gameSort !== field ? null : <span>{gameDir === "asc" ? " ▲" : " ▼"}</span>;

  if (loading) {
    return <div className="min-h-screen bg-[#0b1220] p-10 text-white">Loading soccer analysts…</div>;
  }

  const displayName = selectedAnalyst === "All" ? "All analysts" : selectedAnalyst;
  const img = selectedAnalyst === "All" ? "" : getAnalystImage(selectedAnalyst);
  const initials = selectedAnalyst === "All" ? "ALL" : getAnalystInitials(selectedAnalyst);

  return (
    <div className="min-h-screen bg-[#0b1220] p-6 text-slate-200">
      {/* TOP FILTER */}
      {!isAnalystRole && (
        <div className="mx-auto mb-6 flex max-w-7xl items-center justify-between gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0f1b2d] px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-sky-500/50 hover:bg-slate-800 hover:text-white"
          >
            <span aria-hidden="true">←</span> Back to Dashboard
          </Link>
          <Link
            href="/analyst-profile"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0f1b2d] px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-sky-500/50 hover:bg-slate-800"
          >
            AFL Profiles
          </Link>
          <select
            value={selectedAnalyst}
            onChange={(e) => setSelectedAnalyst(e.target.value)}
            className="rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            {analystList.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mx-auto max-w-7xl space-y-6">
        {/* HERO (simple — no metrics) */}
        <Card>
          <div className="flex items-center gap-5">
            <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-2xl ring-2 ring-slate-700">
              {img ? (
                <img src={img} alt={displayName} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-slate-800 text-lg font-bold text-slate-300">
                  {initials}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-sky-400">
                Soccer Analyst Profile
              </div>
              <h1 className="text-2xl font-bold text-white">{displayName}</h1>
              <p className="mt-1 text-sm text-slate-400">
                {fmtGames(totalGames)} soccer game{totalGames === 1 ? "" : "s"} ·{" "}
                {Object.keys(competitions).length} competition
                {Object.keys(competitions).length === 1 ? "" : "s"} ·{" "}
                {Object.keys(teams).length} club{Object.keys(teams).length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        </Card>

        {/* COMPETITIONS + CLUBS */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="h-full">
            <LeagueBreakdown data={competitions} />
          </div>
          <div className="h-full">
            <TeamBreakdown data={teams} logoMap={teamLogoMap} />
          </div>
        </div>

        {/* GAMES LIST */}
        {sortedGames.length > 0 ? (
          <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-5">
            <h3 className="mb-4 text-lg font-bold text-white">
              Soccer Games ({sortedGames.length})
            </h3>
            <div className="overflow-hidden rounded-lg border border-slate-700">
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full table-fixed text-left text-xs">
                  <colgroup>
                    <col className="w-[7%]" />
                    <col className="w-[22%]" />
                    <col className="w-[7%]" />
                    <col className="w-[22%]" />
                    <col className="w-[22%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                  <thead className="sticky top-0 bg-slate-800 text-slate-400">
                    <tr>
                      <th className="cursor-pointer px-3 py-2 hover:text-white" onClick={() => handleGameSort("Week")}>
                        Wk<SortIcon field="Week" />
                      </th>
                      <th className="cursor-pointer px-3 py-2 hover:text-white" onClick={() => handleGameSort("Competition")}>
                        Competition<SortIcon field="Competition" />
                      </th>
                      <th className="cursor-pointer px-3 py-2 hover:text-white" onClick={() => handleGameSort("Round")}>
                        Rnd<SortIcon field="Round" />
                      </th>
                      <th className="cursor-pointer px-3 py-2 hover:text-white" onClick={() => handleGameSort("home_team")}>
                        Home<SortIcon field="home_team" />
                      </th>
                      <th className="cursor-pointer px-3 py-2 hover:text-white" onClick={() => handleGameSort("away_team")}>
                        Away<SortIcon field="away_team" />
                      </th>
                      <th className="cursor-pointer px-3 py-2 hover:text-white" onClick={() => handleGameSort("role")}>
                        {selectedAnalyst === "All" ? "Allocated" : "Role"}
                        <SortIcon field="role" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedGames.map((game, i) => {
                      const name = norm(selectedAnalyst);
                      const isHome = norm(game.home_allocated) === name;
                      const isAway = norm(game.away_allocated) === name;
                      const role =
                        selectedAnalyst === "All"
                          ? [game.home_allocated, game.away_allocated].filter(Boolean).join(" / ") || "—"
                          : isHome && isAway
                            ? "Both"
                            : isHome
                              ? "Home"
                              : "Away";
                      return (
                        <tr key={`${game.game_key}-${i}`} className="border-t border-slate-700 hover:bg-slate-800">
                          <td className="px-3 py-2 text-slate-300">{game.week ?? "—"}</td>
                          <td className="truncate px-3 py-2 text-slate-300" title={game.Competition ?? ""}>
                            {game.Competition ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-slate-400">{game.Round ?? "—"}</td>
                          <td className="truncate px-3 py-2 text-slate-200" title={game.home_team ?? ""}>
                            {game.home_team ?? "—"}
                          </td>
                          <td className="truncate px-3 py-2 text-slate-200" title={game.away_team ?? ""}>
                            {game.away_team ?? "—"}
                          </td>
                          <td className="truncate px-3 py-2 text-slate-300" title={role}>
                            {role}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-10 text-center text-slate-500">
            No soccer games for this analyst.
          </div>
        )}
      </div>
    </div>
  );
}
