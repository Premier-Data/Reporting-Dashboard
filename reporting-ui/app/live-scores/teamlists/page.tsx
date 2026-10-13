"use client";

// Full-screen Team Lists page (mobile-first), opened from a Live Scores card's
// "Team Lists" button. Shows ONLY the two teams' player lists (jersey-number
// order) with a home/away switch — no stats tabs. Reads the game by grade + id
// from the URL (?grade=<key>&id=<gameId>), the same way the match stats page
// does. A back arrow returns to the Live Scores list.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Loader2, AlertTriangle } from "lucide-react";

import {
  clubLogo,
  clubInitials,
  clubBadgeColor,
  safeImageUrl,
} from "@/lib/api/clubLogos";
import {
  clubConfigFor,
  primaryColorOf,
  secondaryColorOf,
} from "@/lib/api/clubConfig";
import {
  getGradeGames,
  getTeamLists,
  sides,
  goalsBehinds,
  LIVE_SCORE_GRADES,
  type PlayHqGame,
  type TeamListSide,
} from "@/lib/api/playhq";

function Crest({
  name,
  size = 44,
  logoUrl,
}: {
  name: string | undefined;
  size?: number;
  /** Admin-configured logo URL override; falls back to the bundled logo. */
  logoUrl?: string | null;
}) {
  const logo = safeImageUrl(logoUrl) || clubLogo(name);
  const dim = { width: size, height: size };
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img src={logo} alt="" style={dim} className="shrink-0 rounded-full object-contain" />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ ...dim, background: clubBadgeColor(name), fontSize: Math.round(size * 0.38) }}
    >
      {clubInitials(name)}
    </span>
  );
}

// The team-list roster for one side, in jersey-number order.
function TeamRoster({
  team,
  badge,
}: {
  team: TeamListSide;
  // The player-number badge colours: square background + number text.
  badge: { bg: string; fg: string };
}) {
  // The worker already returns players in jumper-number order; keep as-is but
  // be defensive in case of ties.
  const roster = useMemo(
    () =>
      [...team.players].sort((a, b) => {
        const na = Number(a.number) || Number.POSITIVE_INFINITY;
        const nb = Number(b.number) || Number.POSITIVE_INFINITY;
        if (na !== nb) return na - nb;
        return a.name.localeCompare(b.name);
      }),
    [team]
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">
        <span>Player</span>
        <span>{roster.length} players</span>
      </div>
      <ul className="divide-y divide-white/5">
        {roster.map((p, i) => (
          <li key={`${p.name}-${i}`} className="flex items-center gap-3 py-2.5">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold"
              style={{ backgroundColor: badge.bg, color: badge.fg }}
            >
              {p.number || "-"}
            </span>
            <span className="truncate text-sm font-medium text-slate-100">
              {p.name}
            </span>
          </li>
        ))}
        {roster.length === 0 && (
          <li className="py-8 text-center text-sm text-slate-400">
            No team list available yet. Lists appear once a match is live or
            final.
          </li>
        )}
      </ul>
    </div>
  );
}

function TeamListsInner() {
  const router = useRouter();
  const params = useSearchParams();

  const gradeKey = params.get("grade") ?? "";
  const gameId = params.get("id") ?? "";

  const [game, setGame] = useState<PlayHqGame | null>(null);
  const [lists, setLists] = useState<{
    home: TeamListSide;
    away: TeamListSide;
  } | null>(null);
  // Admin-configured number-badge colours per side (primary bg, secondary text).
  const [colors, setColors] = useState<{
    home: { bg: string; fg: string };
    away: { bg: string; fg: string };
  }>({
    home: { bg: "#ef4444", fg: "#ffffff" },
    away: { bg: "#10b981", fg: "#ffffff" },
  });
  // Admin-configured logo overrides per side (for clubs with no bundled png).
  const [logos, setLogos] = useState<{
    home: string | null;
    away: string | null;
  }>({ home: null, away: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<"home" | "away">("home");

  const back = () => router.push("/live-scores");

  useEffect(() => {
    let cancelled = false;
    const grade = LIVE_SCORE_GRADES.find((g) => g.key === gradeKey);
    if (!grade || !gameId) {
      setError("This match link is missing or invalid.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Game (for the scoreboard header) + the PlayHQ team lists, in parallel.
        const [games, tl] = await Promise.all([
          getGradeGames(grade.gradeId),
          getTeamLists(gameId),
        ]);
        const g = games.find((x) => x.id === gameId) ?? null;
        if (cancelled) return;
        if (!g) {
          setError("Match not found.");
          setLoading(false);
          return;
        }
        setGame(g);
        setLists({ home: tl.home, away: tl.away });

        // Resolve configured club colours for each side (best-effort).
        const [hc, ac] = await Promise.all([
          clubConfigFor(tl.home.name ?? sides(g).home?.name),
          clubConfigFor(tl.away.name ?? sides(g).away?.name),
        ]);
        if (!cancelled) {
          setColors({
            home: {
              bg: primaryColorOf(hc) ?? "#ef4444",
              fg: secondaryColorOf(hc) ?? "#ffffff",
            },
            away: {
              bg: primaryColorOf(ac) ?? "#10b981",
              fg: secondaryColorOf(ac) ?? "#ffffff",
            },
          });
          setLogos({
            home: hc?.logo_url ?? null,
            away: ac?.logo_url ?? null,
          });
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load team list.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gradeKey, gameId]);

  const { home, away } = game ? sides(game) : { home: null, away: null };
  const homeScore = home?.scoreTotal ?? null;
  const awayScore = away?.scoreTotal ?? null;
  const homeName = lists?.home.name ?? home?.name ?? "Home";
  const awayName = lists?.away.name ?? away?.name ?? "Away";

  const tab = (val: "home" | "away", name: string) => (
    <button
      type="button"
      onClick={() => setSide(val)}
      className={`flex-1 truncate rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
        side === val
          ? "border-sky-500 bg-sky-500 text-white"
          : "border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
      }`}
    >
      {name}
    </button>
  );

  const activeTeam = lists ? (side === "home" ? lists.home : lists.away) : null;

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      {/* Top bar with back arrow */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-[#0B1220]/90 px-3 py-3 backdrop-blur">
        <button
          type="button"
          onClick={back}
          aria-label="Back to Live Scores"
          className="rounded-lg p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft size={22} />
        </button>
        <span className="text-sm font-semibold">Team Lists</span>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1">
        {/* Scoreboard header */}
        {game && (
          <div className="border-b border-white/10 px-4 pb-4 pt-4">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <Crest name={home?.name} size={52} logoUrl={logos.home} />
                <span className="text-xs font-medium leading-tight text-slate-300">
                  {home?.name ?? "Home"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-center">
                  <span className="text-3xl font-extrabold tabular-nums">
                    {homeScore ?? "-"}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {goalsBehinds(home)}
                  </span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="rounded-full bg-sky-600 px-3 py-0.5 text-xs font-bold">
                    FT
                  </span>
                  <span className="mt-1 text-[11px] text-slate-400">
                    {game.venue?.name ?? ""}
                  </span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="text-3xl font-extrabold tabular-nums">
                    {awayScore ?? "-"}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {goalsBehinds(away)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-center gap-1.5 text-center">
                <Crest name={away?.name} size={52} logoUrl={logos.away} />
                <span className="text-xs font-medium leading-tight text-slate-300">
                  {away?.name ?? "Away"}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="px-4 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
              <Loader2 size={18} className="animate-spin" /> Loading team list…
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
            </div>
          ) : lists && activeTeam ? (
            <>
              <div className="mb-4 flex gap-2">
                {tab("home", homeName)}
                {tab("away", awayName)}
              </div>
              <TeamRoster
                team={activeTeam}
                badge={side === "home" ? colors.home : colors.away}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function TeamListsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center bg-[#0B1220] py-20 text-sm text-slate-400">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading…
        </div>
      }
    >
      <TeamListsInner />
    </Suspense>
  );
}
