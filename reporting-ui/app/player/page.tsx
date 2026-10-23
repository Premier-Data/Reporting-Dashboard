"use client";

// Player profile page, opened by clicking a player in the Live Scores team
// lists. Reads the player id from the URL (?id=<playerId>) and shows that
// player's COMPLETE PlayHQ career — career totals + every game ever played —
// sourced LIVE from PlayHQ's public player-statistics endpoint, proxied through
// OUR Cloudflare Worker (getPlayerCareer). Static-export friendly: one HTML
// file that reads the id client-side (same pattern as teamlists), so the
// useSearchParams consumer MUST sit inside a <Suspense> boundary.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  Loader2,
  AlertTriangle,
  Trophy,
  Target,
  Award,
  BarChart3,
} from "lucide-react";

import { getPlayerCareer, type CareerProfile } from "@/lib/api/players";

// One dark-theme summary card (icon + label + value).
function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-extrabold tabular-nums text-slate-100">
        {value}
      </div>
    </div>
  );
}

// Readable label + icon for a career/per-game stat type. Known AFL types get a
// friendly label; unknown types fall back to a title-cased version of the raw
// type so new stat types surface gracefully rather than being dropped.
function statLabel(type: string): string {
  switch (type) {
    case "APPEARANCE":
      return "Appearances";
    case "GOAL_COUNT":
      return "Goals";
    case "BEST_PLAYER":
      return "Best on Ground";
    default:
      return type
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function statIcon(type: string): React.ReactNode {
  switch (type) {
    case "APPEARANCE":
      return <BarChart3 size={14} />;
    case "GOAL_COUNT":
      return <Trophy size={14} />;
    case "BEST_PLAYER":
      return <Award size={14} />;
    default:
      return <Target size={14} />;
  }
}

// A readable date like "16 Oct 2026", or "—" when absent/unparseable.
function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Per-game stat value by type, or "—" when the player has no entry for it.
function gameStat(
  stats: CareerProfile["games"][number]["stats"],
  type: string
): string {
  const hit = stats.find((s) => s.type === type);
  return hit ? String(hit.value) : "—";
}

function PlayerProfileInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") ?? "";

  const [profile, setProfile] = useState<CareerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Client-side filters for the per-game history table. "all" = no filter.
  // These only scope the TABLE below — the career totals cards stay career-wide.
  const [seasonFilter, setSeasonFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("all");

  const back = () => router.back();

  useEffect(() => {
    let cancelled = false;
    if (!id) {
      setError("No player selected.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await getPlayerCareer(id);
        if (cancelled) return;
        if (!data) {
          setError("Player not found.");
          setProfile(null);
        } else {
          setProfile(data);
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load player.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Reset filters whenever a different player loads, so a selection from the
  // previous player doesn't carry over.
  useEffect(() => {
    setSeasonFilter("all");
    setTeamFilter("all");
  }, [id]);

  const displayName = useMemo(() => {
    if (!profile) return "";
    const full = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim();
    return full || "Unknown player";
  }, [profile]);

  // Distinct non-null seasons, preserving the games' order (already
  // most-recent-first), for the Year/Season filter.
  const seasonOptions = useMemo(() => {
    const seen: string[] = [];
    for (const g of profile?.games ?? []) {
      if (g.season && !seen.includes(g.season)) seen.push(g.season);
    }
    return seen;
  }, [profile]);

  // Distinct non-null teams, sorted alphabetically, for the Team filter.
  const teamOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const g of profile?.games ?? []) {
      if (g.team) seen.add(g.team);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [profile]);

  // The table rows after applying both filters (AND). Totals are unaffected.
  const filteredGames = useMemo(() => {
    return (profile?.games ?? []).filter(
      (g) =>
        (seasonFilter === "all" || g.season === seasonFilter) &&
        (teamFilter === "all" || g.team === teamFilter)
    );
  }, [profile, seasonFilter, teamFilter]);

  // A public profile with no career data (private or empty) → friendly state,
  // not a crash.
  const isEmpty =
    profile != null &&
    profile.games.length === 0 &&
    profile.totals.length === 0;

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      {/* Top bar with back arrow */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-[#0B1220]/90 px-3 py-3 backdrop-blur">
        <button
          type="button"
          onClick={back}
          aria-label="Back"
          className="rounded-lg p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft size={22} />
        </button>
        <span className="text-sm font-semibold">Player</span>
      </div>

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin" /> Loading career…
          </div>
        ) : error || !profile ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />{" "}
            {error ?? "Player not found."}
          </div>
        ) : (
          <>
            {/* Identity header */}
            <div className="mb-5 border-b border-white/10 pb-4">
              <h1 className="text-2xl font-extrabold text-slate-100">
                {displayName}
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Full PlayHQ career
              </p>
            </div>

            {isEmpty ? (
              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-400">
                No public career data for this player (the profile may be
                private).
              </div>
            ) : (
              <>
                {/* Career totals */}
                {profile.totals.length > 0 && (
                  <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {profile.totals.map((t) => (
                      <StatCard
                        key={t.type}
                        icon={statIcon(t.type)}
                        label={statLabel(t.type)}
                        value={t.value}
                      />
                    ))}
                  </div>
                )}

                {/* Full per-game career history */}
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Career history
                  <span className="font-normal normal-case text-slate-500">
                    {profile.games.length > 0 &&
                    filteredGames.length !== profile.games.length
                      ? `showing ${filteredGames.length} of ${profile.games.length} games`
                      : `${profile.games.length} game${
                          profile.games.length === 1 ? "" : "s"
                        }`}
                  </span>
                </div>

                {/* Client-side filters: Year/Season + Team. Hidden when there
                    are no games to filter. */}
                {profile.games.length > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-400">
                      Season
                      <select
                        value={seasonFilter}
                        onChange={(e) => setSeasonFilter(e.target.value)}
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-white/30"
                      >
                        <option value="all">All seasons</option>
                        {seasonOptions.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-400">
                      Team
                      <select
                        value={teamFilter}
                        onChange={(e) => setTeamFilter(e.target.value)}
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-white/30"
                      >
                        <option value="all">All teams</option>
                        {teamOptions.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {profile.games.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-slate-400">
                    No games on record.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-400">
                          <th className="whitespace-nowrap px-3 py-2 font-semibold">
                            Match
                          </th>
                          <th className="whitespace-nowrap px-3 py-2 font-semibold">
                            Round
                          </th>
                          <th className="whitespace-nowrap px-3 py-2 font-semibold">
                            Date
                          </th>
                          <th className="whitespace-nowrap px-3 py-2 font-semibold">
                            Grade / Competition
                          </th>
                          <th className="whitespace-nowrap px-3 py-2 font-semibold">
                            Venue
                          </th>
                          <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">
                            G
                          </th>
                          <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">
                            Best
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {filteredGames.length === 0 ? (
                          <tr>
                            <td
                              colSpan={7}
                              className="px-3 py-8 text-center text-sm text-slate-400"
                            >
                              No games match these filters.
                            </td>
                          </tr>
                        ) : null}
                        {filteredGames.map((g, i) => {
                          const gradeComp =
                            [g.grade, g.competition]
                              .filter(Boolean)
                              .join(" · ") || "—";
                          return (
                            <tr
                              key={`${g.gameId}-${i}`}
                              className="text-slate-200"
                            >
                              <td
                                className="whitespace-nowrap px-3 py-2"
                                title={g.matchName}
                              >
                                {g.matchName}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2">
                                {g.round ?? "—"}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2">
                                {dateLabel(g.date)}
                              </td>
                              <td
                                className="whitespace-nowrap px-3 py-2"
                                title={gradeComp}
                              >
                                {gradeComp}
                              </td>
                              <td
                                className="whitespace-nowrap px-3 py-2"
                                title={g.venue ?? undefined}
                              >
                                {g.venue ?? "—"}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">
                                {gameStat(g.stats, "GOAL_COUNT")}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">
                                {gameStat(g.stats, "BEST_PLAYER")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function PlayerProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center bg-[#0B1220] py-20 text-sm text-slate-400">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading…
        </div>
      }
    >
      <PlayerProfileInner />
    </Suspense>
  );
}
