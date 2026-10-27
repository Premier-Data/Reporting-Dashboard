"use client";

import { useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabase";
import { buildAnalystMetrics } from "@/lib/analytics/buildAnalystMetrics";
import { seasonsFromTT, dateInSeason } from "@/lib/analytics/season";
import { THEME } from "@/lib/theme";
import type { AnalystMetrics } from "@/types/analyst";
import type { DeputyShift } from "@/types/deputy";
import type { TTGame } from "@/types/ttgame";

import {
  getAnalystImage,
  getAnalystInitials,
} from "@/app/analyst-profile/analystImages";

const PAGE_SIZE = 1000;
const LEADERBOARD_SIZE = 20;

type Team = "AUS" | "PHL";

const TEAM_LABELS: Record<Team, string> = {
  AUS: "Australia",
  PHL: "Philippines",
};

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

export default function LeaderboardPage() {
  const [shiftRows, setShiftRows] = useState<DeputyShift[]>([]);
  const [gameRows, setGameRows] = useState<TTGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [team, setTeam] = useState<Team>("AUS");
  // Season filter: games by explicit season, shifts by Oct→Sep window.
  const [season, setSeason] = useState<string>("all");

  useEffect(() => {
    async function load() {
      setLoading(true);

      const [shifts, games] = await Promise.all([
        fetchAll<DeputyShift>("deputy_shifts"),
        fetchAll<TTGame>("TT_Games"),
      ]);

      setShiftRows(shifts);
      setGameRows(games);
      setLoading(false);
    }

    load();
  }, []);

  const seasonInfo = useMemo(() => seasonsFromTT(gameRows), [gameRows]);

  // Default to the latest season once data loads.
  useEffect(() => {
    if (season === "all" && seasonInfo.years.length > 0) {
      setSeason(String(seasonInfo.years[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonInfo.years.length]);

  // Analyst metrics rebuilt from season-scoped shifts + games.
  const analysts = useMemo(() => {
    let games = gameRows;
    let shifts = shiftRows;
    if (season !== "all") {
      if (season === "unknown") {
        games = gameRows.filter(
          (g) => g.season == null || !Number.isFinite(Number(g.season))
        );
        // Unknown-season has no reliable date window, so leave shifts unscoped.
      } else {
        const yr = Number(season);
        games = gameRows.filter((g) => Number(g.season) === yr);
        shifts = shiftRows.filter((r) => {
          const sd = (r as { shift_date?: string }).shift_date;
          if (!sd) return false;
          const d = new Date(sd);
          return !Number.isNaN(d.getTime()) && dateInSeason(d, yr);
        });
      }
    }
    return buildAnalystMetrics(shifts, games);
  }, [shiftRows, gameRows, season]);

  // Ranked within the selected team only, by overall score.
  const ranked = useMemo(() => {
    return analysts
      .filter((a) => a.team === team && a.totalGames > 0)
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
      .slice(0, LEADERBOARD_SIZE)
      .map((analyst, index) => ({
        ...analyst,
        leaderboardRank: index + 1,
      }));
  }, [analysts, team]);

  const podium = ranked.slice(0, 3);
  const rest = ranked.slice(3);

  if (loading) {
    return (
      <div
        className="min-h-screen p-10 text-slate-200"
        style={{ background: THEME.bg }}
      >
        Loading leaderboard...
      </div>
    );
  }

  return (
    <div
      className="min-h-screen p-6 text-slate-200"
      style={{ background: THEME.bg }}
    >
      <div className="mx-auto max-w-5xl">

        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">

          <div>
            <h1 className="mb-1 text-3xl font-bold text-white">
              Leaderboard
            </h1>

            <p className="text-sm text-slate-500">
              Top {LEADERBOARD_SIZE} {TEAM_LABELS[team]} analysts by overall rating
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {(seasonInfo.years.length > 0 || seasonInfo.hasUnknown) && (
              <SeasonToggle
                years={seasonInfo.years}
                hasUnknown={seasonInfo.hasUnknown}
                value={season}
                onChange={setSeason}
              />
            )}
            <TeamToggle
              value={team}
              onChange={setTeam}
            />
          </div>

        </div>

        {ranked.length === 0 ? (

          <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-10 text-center text-slate-500">
            No {TEAM_LABELS[team]} analysts have coded games yet.
          </div>

        ) : (

          <>
            {podium.length > 0 && <Podium analysts={podium} />}

            <LeaderboardList
              analysts={rest}
              startRank={4}
            />
          </>

        )}

      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TEAM TOGGLE                                                          */
/* ------------------------------------------------------------------ */

function TeamToggle({
  value,
  onChange,
}: {
  value: Team;
  onChange: (team: Team) => void;
}) {
  return (
    <div className="flex rounded-lg border border-slate-700 bg-[#0f1b2d] p-1">

      {(["AUS", "PHL"] as Team[]).map((option) => (

        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
            value === option
              ? "bg-sky-600 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          {TEAM_LABELS[option]}
        </button>

      ))}

    </div>
  );
}

// Season toggle — seasons newest-first, plus optional Unknown + All. Styled to
// match TeamToggle so they sit together cleanly.
function SeasonToggle({
  years,
  hasUnknown,
  value,
  onChange,
}: {
  years: number[];
  hasUnknown: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const options: { key: string; label: string }[] = [
    ...years.map((y) => ({ key: String(y), label: String(y) })),
    ...(hasUnknown ? [{ key: "unknown", label: "Unknown" }] : []),
    { key: "all", label: "All" },
  ];
  return (
    <div className="flex rounded-lg border border-slate-700 bg-[#0f1b2d] p-1">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-md px-4 py-2 text-sm font-semibold transition ${
            value === o.key
              ? "bg-sky-600 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PODIUM                                                              */
/* ------------------------------------------------------------------ */

function Podium({
  analysts,
}: {
  analysts: (AnalystMetrics & { leaderboardRank: number })[];
}) {
  const first = analysts.find((a) => a.leaderboardRank === 1);
  const second = analysts.find((a) => a.leaderboardRank === 2);
  const third = analysts.find((a) => a.leaderboardRank === 3);

  return (
    <div className="mb-10 flex items-end justify-center gap-4 sm:gap-8">

      <PodiumSlot analyst={second} place={2} />
      <PodiumSlot analyst={first} place={1} />
      <PodiumSlot analyst={third} place={3} />

    </div>
  );
}

const PLACE_STYLES: Record<
  number,
  {
    height: string;
    block: string;
    ring: string;
    avatarSize: string;
    crown: boolean;
  }
> = {
  1: {
    height: "h-28",
    block: "bg-sky-500",
    ring: "ring-sky-400",
    avatarSize: "h-16 w-16",
    crown: true,
  },
  2: {
    height: "h-20",
    block: "bg-slate-500",
    ring: "ring-slate-400",
    avatarSize: "h-14 w-14",
    crown: false,
  },
  3: {
    height: "h-14",
    block: "bg-amber-700",
    ring: "ring-amber-500",
    avatarSize: "h-14 w-14",
    crown: false,
  },
};

function PodiumSlot({
  analyst,
  place,
}: {
  analyst?: AnalystMetrics & { leaderboardRank: number };
  place: 1 | 2 | 3;
}) {
  const style = PLACE_STYLES[place];

  if (!analyst) {
    return <div className="w-24 sm:w-28" />;
  }

  const image = getAnalystImage(analyst.name);
  const initials = getAnalystInitials(analyst.name);

  return (
    <div className="flex w-24 flex-col items-center sm:w-28">

      {/* CROWN */}
      {style.crown && (
        <div className="mb-1 text-2xl" aria-hidden="true">
          👑
        </div>
      )}

      {/* AVATAR */}
      <div
        className={`relative mb-2 overflow-hidden rounded-full ring-4 ${style.avatarSize} ${style.ring}`}
      >
        <AvatarImage
          src={image}
          initials={initials}
        />
      </div>

      {/* NAME */}
      <div className="w-full truncate text-center text-sm font-semibold text-white">
        {analyst.name}
      </div>

      {/* STATS */}
      <div className="mt-1.5 flex flex-col items-center gap-1 text-[11px] text-slate-400">

        <div className="flex items-center gap-1">
          <span className="font-semibold text-slate-200">
            {analyst.totalGames.toFixed(1)}
          </span>
          games
        </div>

        <div className="flex items-center gap-1">
          <span className="font-semibold text-slate-200">
            {analyst.avgGamesPerWeek.toFixed(2)}
          </span>
          games / wk
        </div>

        <div className="flex items-center gap-1">
          <span className="font-semibold text-slate-200">
            {analyst.avgHoursPerGame.toFixed(2)}
          </span>
          hrs / game
        </div>

        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="font-semibold text-slate-200">
              {Object.keys(analyst.competitions ?? {}).length}
            </span>
            comps
          </span>

          <span className="flex items-center gap-1">
            <span className="font-semibold text-slate-200">
              {Object.keys(analyst.teams ?? {}).length}
            </span>
            clubs
          </span>
        </div>

        <div className="rounded-full bg-slate-800 px-3 py-1 text-xs font-bold text-sky-300">
          {analyst.ratings.overall} rating
        </div>

      </div>

      {/* BLOCK */}
      <div
        className={`mt-3 flex w-full items-end justify-center rounded-t-lg ${style.height} ${style.block}`}
      >
        <span className="mb-2 text-2xl font-black text-white/90">
          {place}
        </span>
      </div>

    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LEADERBOARD LIST                                                    */
/* ------------------------------------------------------------------ */

function LeaderboardList({
  analysts,
  startRank,
}: {
  analysts: (AnalystMetrics & { leaderboardRank: number })[];
  startRank: number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0f1b2d]">

      <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">

        <div className="text-sm font-semibold text-white">
          Full Leaderboard
        </div>

        <div className="text-xs uppercase tracking-wide text-slate-500">
          Rank {startRank}
          {"–"}
          {startRank + analysts.length - 1}
        </div>

      </div>

      <table className="w-full text-left">

        <thead>
          <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">

            <th className="w-14 px-5 py-3 font-semibold">
              Rank
            </th>

            <th className="px-3 py-3 font-semibold">
              Analyst
            </th>

            <th className="w-32 px-3 py-3 text-right font-semibold">
              Games Coded
            </th>

            <th className="w-32 px-3 py-3 text-right font-semibold">
              Ave Games / Wk
            </th>

            <th className="w-28 px-3 py-3 text-right font-semibold">
              Ave Time
            </th>

            <th className="w-24 px-3 py-3 text-right font-semibold">
              Comps
            </th>

            <th className="w-24 px-3 py-3 text-right font-semibold">
              Clubs
            </th>

            <th className="w-20 px-5 py-3 text-right font-semibold">
              Rating
            </th>

          </tr>
        </thead>

        <tbody className="divide-y divide-slate-800">

          {analysts.map((analyst) => (
            <LeaderboardRow
              key={analyst.key}
              analyst={analyst}
            />
          ))}

        </tbody>

      </table>

    </div>
  );
}

function LeaderboardRow({
  analyst,
}: {
  analyst: AnalystMetrics & { leaderboardRank: number };
}) {
  const image = getAnalystImage(analyst.name);
  const initials = getAnalystInitials(analyst.name);

  return (
    <tr className="transition hover:bg-slate-800/50">

      {/* RANK */}
      <td className="px-5 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-slate-300">
          {analyst.leaderboardRank}
        </div>
      </td>

      {/* ANALYST */}
      <td className="px-3 py-3">
        <div className="flex items-center gap-3">

          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full ring-2 ring-slate-700">
            <AvatarImage
              src={image}
              initials={initials}
            />
          </div>

          <div className="min-w-0 truncate text-sm font-semibold text-white">
            {analyst.name}
          </div>

        </div>
      </td>

      {/* GAMES CODED */}
      <td className="px-3 py-3 text-right text-sm font-semibold text-slate-200">
        {analyst.totalGames.toFixed(1)}
      </td>

      {/* AVE GAMES PER WEEK */}
      <td className="px-3 py-3 text-right text-sm font-semibold text-slate-200">
        {analyst.avgGamesPerWeek.toFixed(2)}
      </td>

      {/* AVE TIME */}
      <td className="px-3 py-3 text-right text-sm font-semibold text-slate-200">
        {analyst.avgHoursPerGame.toFixed(2)} hrs
      </td>

      {/* COMPETITIONS COVERED */}
      <td className="px-3 py-3 text-right text-sm font-semibold text-slate-200">
        {Object.keys(analyst.competitions ?? {}).length}
      </td>

      {/* CLUBS COVERED */}
      <td className="px-3 py-3 text-right text-sm font-semibold text-slate-200">
        {Object.keys(analyst.teams ?? {}).length}
      </td>

      {/* RATING */}
      <td className="px-5 py-3 text-right text-lg font-bold text-sky-400">
        {analyst.ratings.overall}
      </td>

    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* AVATAR (shared image-with-fallback behaviour)                       */
/* ------------------------------------------------------------------ */

function AvatarImage({
  src,
  initials,
}: {
  src: string;
  initials: string;
}) {
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [src]);

  if (errored) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-sm font-bold"
        style={{ background: THEME.panel, color: THEME.accent }}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className="h-full w-full object-cover"
      onError={() => setErrored(true)}
    />
  );
}
