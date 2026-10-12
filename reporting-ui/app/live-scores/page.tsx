"use client";

// Live Scores — lists all fixtures for the NTFL Premier Men's grade, pulled
// from the official PlayHQ REST API through our Cloudflare Worker (which holds
// the API key). Scores and statuses come straight from the grade games feed;
// while any match is in progress the list auto-refreshes every 2 minutes so
// live scores update without a reload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Radio,
  Loader2,
  AlertTriangle,
  RefreshCw,
  MapPin,
  ExternalLink,
  ChevronDown,
} from "lucide-react";

import {
  getGradeGames,
  getLiveScore,
  restStatusUnknown,
  sides,
  goalsBehinds,
  isLive,
  scheduleDate,
  scheduleLabel,
  LIVE_SCORE_GRADES,
  type PlayHqGame,
  type GameStatus,
  type NormalisedLive,
  type LiveScoreGradeKey,
  type Scorer,
  type PeriodScore,
} from "@/lib/api/playhq";
import {
  clubLogo,
  clubInitials,
  clubBadgeColor,
} from "@/lib/api/clubLogos";

// Poll interval while any game is live (ms). 2 minutes — modest load, and the
// Worker's edge cache means concurrent viewers share one upstream call.
const LIVE_POLL_MS = 120_000;

// "3rd Quarter" -> "Q3"; passes through anything else.
function shortPeriod(period: string | null): string {
  if (!period) return "";
  const m = period.match(/(\d)/);
  if (m && /quarter/i.test(period)) return `Q${m[1]}`;
  return period;
}

function statusBadge(status: GameStatus): { label: string; cls: string } {
  const s = String(status).toUpperCase();
  if (s === "IN_PROGRESS" || s === "LIVE")
    return { label: "LIVE", cls: "bg-red-100 text-red-700 ring-1 ring-red-300" };
  if (s === "FINAL")
    return { label: "Final", cls: "bg-slate-100 text-slate-600" };
  if (s === "UPCOMING" || s === "" || s === "NULL")
    return { label: "Upcoming", cls: "bg-blue-50 text-blue-700" };
  if (s === "ABANDONED" || s === "CANCELLED" || s === "POSTPONED")
    return { label: s.charAt(0) + s.slice(1).toLowerCase(), cls: "bg-amber-50 text-amber-700" };
  return { label: s.charAt(0) + s.slice(1).toLowerCase(), cls: "bg-slate-100 text-slate-600" };
}

// Winner side for emphasising the score of the team that won.
function wonSide(game: PlayHqGame): "home" | "away" | null {
  const { home, away } = sides(game);
  if (home?.outcome === "WON") return "home";
  if (away?.outcome === "WON") return "away";
  return null;
}

// Quarter-by-quarter score table. Each cell shows the goals.behinds that team
// kicked IN that quarter (as PlayHQ reports it), with the quarter points below.
function QuarterTable({
  homeName,
  awayName,
  home,
  away,
}: {
  homeName: string;
  awayName: string;
  home: PeriodScore[];
  away: PeriodScore[];
}) {
  // Union of quarter labels present on either side, in order.
  const labels = (home.length >= away.length ? home : away).map(
    (p) => p.period
  );
  const cell = (list: PeriodScore[], q: string) => {
    const p = list.find((x) => x.period === q);
    if (!p) return <span className="text-slate-300">—</span>;
    return (
      <span className="tabular-nums">
        <span className="text-slate-700">
          {p.goals}.{p.behinds}
        </span>{" "}
        <span className="text-[10px] text-slate-400">({p.total})</span>
      </span>
    );
  };
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-slate-400">
          <th className="pb-1 text-left font-medium"></th>
          {labels.map((q) => (
            <th key={q} className="pb-1 text-right font-semibold">
              {q}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="border-t border-slate-100">
          <td className="truncate py-1 pr-2 text-slate-600">{homeName}</td>
          {labels.map((q) => (
            <td key={q} className="py-1 text-right">
              {cell(home, q)}
            </td>
          ))}
        </tr>
        <tr className="border-t border-slate-100">
          <td className="truncate py-1 pr-2 text-slate-600">{awayName}</td>
          {labels.map((q) => (
            <td key={q} className="py-1 text-right">
              {cell(away, q)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

// One team's goal scorers, full width. Name on the left, goals.behinds on the
// right (goals bold). Larger, easy-to-read font since only one team shows at a
// time via the Home/Away toggle.
function ScorerList({ scorers }: { scorers: Scorer[] }) {
  if (!scorers.length) {
    return <div className="py-1 text-sm text-slate-400">No scorers yet.</div>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {scorers.map((s, i) => (
        <li
          key={`${s.name}-${i}`}
          className="flex items-center justify-between gap-3 py-1.5"
        >
          <span className="truncate text-sm text-slate-700">{s.name}</span>
          <span className="shrink-0 tabular-nums text-sm">
            {s.goals > 0 && (
              <span className="font-bold text-slate-900">{s.goals}</span>
            )}
            {s.goals > 0 && s.behinds > 0 && (
              <span className="text-slate-400">.{s.behinds}</span>
            )}
            {s.goals === 0 && s.behinds > 0 && (
              <span className="text-slate-400">0.{s.behinds}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A club crest: the local logo when mapped, else an initials badge in a
// deterministic colour. Keeps every team visually anchored even without a logo.
function ClubCrest({ name }: { name: string | undefined }) {
  const logo = clubLogo(name);
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={logo}
        alt={`${name ?? ""} logo`}
        className="h-6 w-6 shrink-0 rounded-full object-contain"
      />
    );
  }
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ background: clubBadgeColor(name) }}
      aria-hidden="true"
    >
      {clubInitials(name)}
    </span>
  );
}

function GameRow({
  game,
  live: liveData,
}: {
  game: PlayHqGame;
  live?: NormalisedLive;
}) {
  const [scorersOpen, setScorersOpen] = useState(false);
  // Which team's goal kickers to show — home by default; toggled via the tabs.
  const [scorerTeam, setScorerTeam] = useState<"home" | "away">("home");
  const { home, away } = sides(game);

  // Effective status/score: the REST feed is null for in-play games, so when a
  // spectator live payload is present it takes precedence (status + score +
  // clock). Otherwise fall back to the REST final/upcoming values.
  const effectiveStatus: GameStatus = liveData?.status ?? game.status;
  const badge = statusBadge(effectiveStatus);
  const live = isLive(effectiveStatus);
  const won = wonSide(game); // outcome only exists once FINAL

  // Per-side score: live payload first, else the REST scoreTotal.
  const homeScore = liveData ? liveData.home.total : home?.scoreTotal ?? null;
  const awayScore = liveData ? liveData.away.total : away?.scoreTotal ?? null;
  const homeGB = liveData
    ? `${liveData.home.goals ?? 0}.${liveData.home.behinds ?? 0}`
    : goalsBehinds(home);
  const awayGB = liveData
    ? `${liveData.away.goals ?? 0}.${liveData.away.behinds ?? 0}`
    : goalsBehinds(away);

  const showScore =
    (homeScore != null || awayScore != null) &&
    String(effectiveStatus).toUpperCase() !== "UPCOMING";

  const row = (
    name: string | undefined,
    score: number | null,
    gb: string,
    side: "home" | "away"
  ) => (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2">
        <ClubCrest name={name} />
        <span
          className={`truncate text-sm ${
            won === side ? "font-bold text-slate-900" : "font-medium text-slate-700"
          }`}
        >
          {name ?? "TBC"}
        </span>
      </span>
      {showScore && (
        <span className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-xs text-slate-400">{gb}</span>
          <span
            className={`text-base ${
              won === side ? "font-bold text-slate-900" : "font-semibold text-slate-600"
            }`}
          >
            {score ?? "-"}
          </span>
        </span>
      )}
    </div>
  );

  // Live clock label, e.g. "Q3 02:11".
  const clockLabel =
    live && liveData?.clock
      ? [shortPeriod(liveData.clock.period), liveData.clock.time]
          .filter(Boolean)
          .join(" ")
      : "";

  return (
    <div
      className={`rounded-xl border p-3.5 ${
        live ? "border-red-300 bg-red-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">{scheduleLabel(game)}</span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${badge.cls}`}
        >
          {live && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" />
          )}
          {live && clockLabel ? clockLabel : badge.label}
        </span>
      </div>
      <div className="space-y-1.5">
        {row(home?.name, homeScore, homeGB, "home")}
        {row(away?.name, awayScore, awayGB, "away")}
      </div>

      {/* Expandable detail (live/final feed only): quarter-by-quarter scores
          and goal kickers. Collapsed by default behind the toggle. */}
      {liveData &&
        (liveData.home.periods.length > 0 ||
          liveData.home.scorers.length > 0 ||
          liveData.away.scorers.length > 0) && (
          <div className="mt-2.5 border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => setScorersOpen((o) => !o)}
              aria-expanded={scorersOpen}
              className="flex w-full items-center justify-between gap-2 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              <span>Quarter scores &amp; goal kickers</span>
              <ChevronDown
                size={15}
                className={`transition-transform ${
                  scorersOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {scorersOpen && (
              <div className="mt-2 space-y-3">
                {/* Quarter-by-quarter scores */}
                {liveData.home.periods.length > 0 && (
                  <QuarterTable
                    homeName={home?.name ?? "Home"}
                    awayName={away?.name ?? "Away"}
                    home={liveData.home.periods}
                    away={liveData.away.periods}
                  />
                )}
                {/* Goal kickers — one team at a time (home default) with a
                    Home/Away toggle, so each list gets the full width and a
                    larger, easier-to-read font. */}
                {(liveData.home.scorers.length > 0 ||
                  liveData.away.scorers.length > 0) && (
                  <div>
                    <div className="mb-2 inline-flex rounded-lg border border-slate-200 p-0.5">
                      <button
                        type="button"
                        onClick={() => setScorerTeam("home")}
                        className={`max-w-[45vw] truncate rounded-md px-3 py-1 text-xs font-semibold ${
                          scorerTeam === "home"
                            ? "bg-slate-800 text-white"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {home?.name ?? "Home"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setScorerTeam("away")}
                        className={`max-w-[45vw] truncate rounded-md px-3 py-1 text-xs font-semibold ${
                          scorerTeam === "away"
                            ? "bg-slate-800 text-white"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {away?.name ?? "Away"}
                      </button>
                    </div>
                    <ScorerList
                      scorers={
                        scorerTeam === "home"
                          ? liveData.home.scorers
                          : liveData.away.scorers
                      }
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs text-slate-400">
        <span className="flex min-w-0 items-center gap-1">
          <MapPin size={12} className="shrink-0" />
          <span className="truncate">{game.venue?.name ?? "Venue TBC"}</span>
        </span>
        <a
          href={game.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 text-slate-400 hover:text-slate-600"
        >
          Game centre <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}

export default function LiveScoresPage() {
  // Which competition (grade) is shown.
  const [comp, setComp] = useState<LiveScoreGradeKey>("ntfl-mens");
  const grade = useMemo(
    () => LIVE_SCORE_GRADES.find((g) => g.key === comp) ?? LIVE_SCORE_GRADES[0],
    [comp]
  );

  // Latches once the round picker has been auto-defaulted for the current data
  // load (reset when the competition changes).
  const didDefaultRound = useRef(false);

  const [games, setGames] = useState<PlayHqGame[]>([]);
  // Live score overlays keyed by game id (from the spectator feed), for games
  // the REST feed reports with no status/score while in play.
  const [liveById, setLiveById] = useState<Record<string, NormalisedLive>>({});
  // Goal-scorer data keyed by game id, for FINALISED games in the visible round
  // (the REST feed carries no scorers, so they're fetched from the spectator
  // feed on demand). Live games use liveById above; this fills in the rest.
  const [scorersById, setScorersById] = useState<Record<string, NormalisedLive>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [roundFilter, setRoundFilter] = useState<string>("all");

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const data = await getGradeGames(grade.gradeId);
      setGames(data);
      setError(null);
      setLastUpdated(new Date());

      // Enrich in-play games from the spectator feed. The REST grade feed gives
      // no live score (status is null until FINAL), so for games whose REST
      // status is unknown AND which should have started (scheduled within the
      // last ~4h, not far in the future) we ask the spectator proxy for the
      // live score. Keep overlays only for games the spectator says are LIVE.
      const now = Date.now();
      const WINDOW_BEFORE = 30 * 60 * 1000; // 30 min before kickoff
      const WINDOW_AFTER = 4 * 60 * 60 * 1000; // 4 h after kickoff
      const candidates = data.filter((g) => {
        if (!restStatusUnknown(g.status)) return false;
        const d = scheduleDate(g);
        if (!d) return false;
        const dt = d.getTime();
        return now >= dt - WINDOW_BEFORE && now <= dt + WINDOW_AFTER;
      });

      const results = await Promise.allSettled(
        candidates.map((g) => getLiveScore(g.id))
      );
      const overlays: Record<string, NormalisedLive> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && isLive(r.value.status ?? "")) {
          overlays[candidates[i].id] = r.value;
        }
      });
      setLiveById(overlays);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load fixtures."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [grade.gradeId]);

  // Load on mount and whenever the competition changes. Reset state so the
  // round picker re-defaults to the current round of the newly-selected comp.
  useEffect(() => {
    didDefaultRound.current = false;
    setLoading(true);
    setGames([]);
    setLiveById({});
    setScorersById({});
    setRoundFilter("all");
    load();
  }, [load]);

  const anyLive = useMemo(
    () => Object.keys(liveById).length > 0,
    [liveById]
  );

  // Auto-poll ONLY while a match is live. Interval is cleared when nothing is
  // live, so a finished round doesn't keep hitting the API.
  const liveRef = useRef(anyLive);
  liveRef.current = anyLive;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => {
      if (liveRef.current) load(true);
    }, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [anyLive, load]);

  // Rounds present, ordered by their numeric suffix (Round 1, 2, …), finals last.
  const rounds = useMemo(() => {
    const names = Array.from(new Set(games.map((g) => g.round?.name).filter(Boolean)));
    const num = (n: string) => {
      const m = n.match(/(\d+)/);
      return m ? Number(m[1]) : 9999;
    };
    return names.sort((a, b) => num(a) - num(b));
  }, [games]);

  // Default the round filter to the round being played today (then nearest
  // round to now). Runs once per data load (the latch resets on comp change).
  useEffect(() => {
    if (didDefaultRound.current || games.length === 0) return;
    // Prefer the round with a live game. If overlays haven't arrived yet,
    // fall back to the most recent round, but don't latch until we've either
    // found a live game or confirmed there are none (overlays resolved).
    const liveGame = games.find(
      (g) => isLive(g.status) || liveById[g.id] != null
    );
    if (liveGame) {
      didDefaultRound.current = true;
      setRoundFilter(liveGame.round.name);
      return;
    }
    didDefaultRound.current = true;

    const now = new Date();
    const todayKey = now.toLocaleDateString("en-CA"); // yyyy-mm-dd, local

    // 1) A round with a game scheduled TODAY wins (the round being played now).
    const todayGame = games.find((g) => {
      const d = scheduleDate(g);
      return d != null && d.toLocaleDateString("en-CA") === todayKey;
    });
    if (todayGame) {
      setRoundFilter(todayGame.round.name);
      return;
    }

    // 2) Otherwise the round CLOSEST to now (smallest gap from today to any of
    //    its games) — i.e. the current/next round mid-week, not a round months
    //    away. Ties break toward the round that's already started/just gone.
    const nowMs = now.getTime();
    let best: { round: string; gap: number } | null = null;
    for (const g of games) {
      const d = scheduleDate(g);
      if (!d) continue;
      const gap = Math.abs(d.getTime() - nowMs);
      if (!best || gap < best.gap) best = { round: g.round.name, gap };
    }
    if (best) setRoundFilter(best.round);
  }, [games, liveById]);

  const visible = useMemo(() => {
    const list =
      roundFilter === "all"
        ? games
        : games.filter((g) => g.round?.name === roundFilter);
    // Within a round, order by kickoff time.
    return [...list].sort((a, b) => {
      const da = scheduleDate(a)?.getTime() ?? 0;
      const db = scheduleDate(b)?.getTime() ?? 0;
      return da - db;
    });
  }, [games, roundFilter]);

  // Enrich the VISIBLE finalised games with goal scorers from the spectator
  // feed (the REST feed has none). Only the games on screen are fetched (not
  // the whole season), and each id is fetched once. Live games already carry
  // scorers via liveById, so they're skipped here. Re-runs when the visible
  // set changes (round switch / data load).
  useEffect(() => {
    const needed = visible.filter(
      (g) =>
        String(g.status).toUpperCase() === "FINAL" &&
        !scorersById[g.id] &&
        !liveById[g.id]
    );
    if (needed.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        needed.map((g) => getLiveScore(g.id))
      );
      if (cancelled) return;
      const add: Record<string, NormalisedLive> = {};
      results.forEach((r, i) => {
        if (
          r.status === "fulfilled" &&
          (r.value.home.scorers.length > 0 ||
            r.value.away.scorers.length > 0 ||
            r.value.home.periods.length > 0)
        ) {
          add[needed[i].id] = r.value;
        }
      });
      if (Object.keys(add).length > 0) {
        setScorersById((prev) => ({ ...prev, ...add }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const selectClass =
    "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500";

  return (
    <div className="mx-auto max-w-5xl px-4 py-5 md:px-6 md:py-8">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">
            <Radio size={24} /> Live Scores
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-600 md:mt-2">
            NTFL {grade.label} fixtures and scores, straight from PlayHQ.
            {anyLive
              ? " A match is live — scores refresh automatically every 2 minutes."
              : " Scores update when matches are in progress."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-slate-400">
              Updated {lastUpdated.toLocaleTimeString("en-AU")}
            </span>
          )}
          <button
            onClick={() => load(true)}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Competition toggle — horizontally scrollable so the full set of
          competitions never overflows on a narrow phone. */}
      <div className="-mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
          {LIVE_SCORE_GRADES.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setComp(g.key)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium md:px-4 ${
                comp === g.key
                  ? "bg-blue-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* Round filter */}
      {rounds.length > 0 && (
        <div className="mb-5 flex items-center gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Round
          </label>
          <select
            value={roundFilter}
            onChange={(e) => setRoundFilter(e.target.value)}
            className={selectClass}
          >
            <option value="all">All rounds</option>
            {rounds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="text-sm text-slate-400">
            {visible.length} {visible.length === 1 ? "game" : "games"}
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-slate-500">
          <Loader2 size={16} className="animate-spin" /> Loading fixtures…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={16} /> {error}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 py-16 text-center text-sm text-slate-500">
          No fixtures to show.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((g) => (
            <GameRow
              key={g.id}
              game={g}
              live={liveById[g.id] ?? scorersById[g.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
