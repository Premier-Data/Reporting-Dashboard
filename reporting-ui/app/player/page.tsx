"use client";

// Player profile page, opened by clicking a player in the Live Scores team
// lists. Reads the player id from the URL (?id=<playerId>) and shows that
// player's aggregated stats from OUR Supabase tables (playhq_players +
// playhq_player_appearances) — NOT a live PlayHQ call. Static-export friendly:
// one HTML file that reads the id client-side (same pattern as teamlists), so
// the useSearchParams consumer MUST sit inside a <Suspense> boundary.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  Loader2,
  AlertTriangle,
  Trophy,
  Target,
  Shield,
  Award,
  MapPin,
} from "lucide-react";

import { getPlayerProfile, type PlayerProfile } from "@/lib/api/players";

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

function PlayerProfileInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") ?? "";

  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        const data = await getPlayerProfile(id);
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

  // Display name: full name → "#<number>" from the most recent appearance →
  // "Unknown player".
  const displayName = useMemo(() => {
    if (!profile) return "";
    const full = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim();
    if (full) return full;
    const num = profile.appearances.find((a) => a.number)?.number;
    return num ? `#${num}` : "Unknown player";
  }, [profile]);

  const positionsLabel =
    profile && profile.totals.positions.length > 0
      ? profile.totals.positions.join(", ")
      : "—";

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

      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin" /> Loading player…
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
              <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-400">
                <MapPin size={14} className="shrink-0" />
                {profile.teamName ?? "No team on record"}
              </p>
            </div>

            {/* Summary stat cards */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard
                icon={<Shield size={14} />}
                label="Games"
                value={profile.totals.games}
              />
              <StatCard
                icon={<Trophy size={14} />}
                label="Goals"
                value={profile.totals.goals}
              />
              <StatCard
                icon={<Target size={14} />}
                label="Behinds"
                value={profile.totals.behinds}
              />
              <StatCard
                icon={<Award size={14} />}
                label="Best on Ground"
                value={profile.totals.bestPlayerCount}
              />
              <div className="col-span-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 sm:col-span-1">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <MapPin size={14} />
                  <span>Positions</span>
                </div>
                <div className="mt-1 truncate text-sm font-medium text-slate-100">
                  {positionsLabel}
                </div>
              </div>
            </div>

            {/* Per-game appearance history */}
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Appearance history
            </div>
            {profile.appearances.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-slate-400">
                No appearances yet.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-400">
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Game</th>
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Team</th>
                      <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">No.</th>
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Position</th>
                      <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">G</th>
                      <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">B</th>
                      <th className="whitespace-nowrap px-3 py-2 text-center font-semibold">Best</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {profile.appearances.map((a, i) => (
                      <tr key={`${a.gameId}-${i}`} className="text-slate-200">
                        <td
                          className="max-w-[22rem] truncate px-3 py-2"
                          title={a.matchName}
                        >
                          {a.matchName}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2" title={a.teamName ?? undefined}>
                          {a.teamName ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">
                          {a.number ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {a.position ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">
                          {a.goals}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">
                          {a.behinds}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">
                          {a.bestPlayer != null ? a.bestPlayer : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
