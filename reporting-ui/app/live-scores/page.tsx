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
  ChevronDown,
  BarChart3,
  Users,
} from "lucide-react";

import { useRouter } from "next/navigation";

import {
  getGradeGames,
  getLiveScore,
  restStatusUnknown,
  sides,
  goalsBehinds,
  isLive,
  scheduleDate,
  scheduleDateLabel,
  scheduleTimeLabel,
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
import {
  ensureClubConfigCache,
  clubLogoOverride,
} from "@/lib/api/clubConfig";


// Poll interval while any game is live (ms). 2 minutes — modest load, and the
// Worker's edge cache means concurrent viewers share one upstream call.
const LIVE_POLL_MS = 120_000;

// Seasons available in the picker. The grade ids wired up are the current
// season's grades, so this currently lists just that season; add past/future
// years here once their grade ids are mapped.
const SEASONS = ["2026"] as const;

// A short, app-style round label: "Round 2" -> "02", "Round 12" -> "12",
// finals keep a compact text label. The finals series runs AFTER the last
// home-and-away round as F1, F2, then Preliminary (PF) and Grand (GF) finals.
// PlayHQ names them "Finals Round 1/2…", "Preliminary Final", "Grand Final";
// comp feeds use "FW1/FW2", "PF", "GF". Falls back to the raw name.
function roundShort(name: string): string {
  const n = name.trim();
  if (/grand\s*final/i.test(n)) return "GF";
  if (/prelim/i.test(n)) return "PF";
  if (/semi/i.test(n)) return "SF";
  if (/qualif/i.test(n)) return "QF";
  if (/elim/i.test(n)) return "EF";
  // "Finals Round N" / "Finals Week N" / "FWn" / "Fn" -> "F<n>".
  const fin =
    n.match(/final(?:s)?\s*(?:round|week)?\s*(\d+)/i) ||
    n.match(/\bf(?:w)?\s*(\d+)\b/i);
  if (fin) return `F${fin[1]}`;
  const m = n.match(/(\d+)/);
  if (m && /round/i.test(n)) return m[1].padStart(2, "0");
  if (m) return m[1].padStart(2, "0");
  return n;
}

// A sortable ORDER key so the pills read 01, 02, … 18, F1, F2, PF, GF — the
// home-and-away rounds in numeric order, THEN the finals series. Numbered
// rounds keep their number (1–99); finals are pushed past them:
//   Finals Round/Week N, Fn, Elimination/Qualifying -> 1000 + n (default 1)
//   Semi Final -> 2000, Preliminary Final -> 3000, Grand Final -> 4000.
function roundOrder(name: string): number {
  const n = name.trim();
  if (/grand\s*final/i.test(n)) return 4000;
  if (/prelim/i.test(n)) return 3000;
  if (/semi/i.test(n)) return 2000;
  if (/qualif|elim/i.test(n)) {
    const q = n.match(/(\d+)/);
    return 1000 + (q ? Number(q[1]) : 1);
  }
  const fin =
    n.match(/final(?:s)?\s*(?:round|week)?\s*(\d+)/i) ||
    n.match(/\bf(?:w)?\s*(\d+)\b/i);
  if (fin) return 1000 + Number(fin[1]);
  if (/final/i.test(n)) return 1000;
  const m = n.match(/(\d+)/);
  if (m) return Number(m[1]);
  return 9999;
}

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
    return { label: "LIVE", cls: "bg-red-500/20 text-red-300 ring-1 ring-red-500/40" };
  if (s === "FINAL")
    return { label: "Final", cls: "bg-white/10 text-slate-300" };
  if (s === "UPCOMING" || s === "" || s === "NULL")
    return { label: "Upcoming", cls: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30" };
  if (s === "ABANDONED" || s === "CANCELLED" || s === "POSTPONED")
    return { label: s.charAt(0) + s.slice(1).toLowerCase(), cls: "bg-amber-500/15 text-amber-300" };
  return { label: s.charAt(0) + s.slice(1).toLowerCase(), cls: "bg-white/10 text-slate-300" };
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
    if (!p) return <span className="text-slate-500">—</span>;
    return (
      <span className="tabular-nums">
        <span className="text-slate-200">
          {p.goals}.{p.behinds}
        </span>{" "}
        <span className="text-[10px] text-slate-500">({p.total})</span>
      </span>
    );
  };
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-slate-500">
          <th className="pb-1 text-left font-medium"></th>
          {labels.map((q) => (
            <th key={q} className="pb-1 text-right font-semibold">
              {q}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="border-t border-white/10">
          <td className="truncate py-1 pr-2 text-slate-300">{homeName}</td>
          {labels.map((q) => (
            <td key={q} className="py-1 text-right">
              {cell(home, q)}
            </td>
          ))}
        </tr>
        <tr className="border-t border-white/10">
          <td className="truncate py-1 pr-2 text-slate-300">{awayName}</td>
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

// One team's goal scorers as a table with headers: # (when any player has a
// number), Name, and G.B (goals.behinds). Full width + larger font since only
// one team shows at a time via the Home/Away toggle.
function ScorerList({ scorers }: { scorers: Scorer[] }) {
  if (!scorers.length) {
    return <div className="py-1 text-sm text-slate-400">No scorers yet.</div>;
  }
  // Only show the # column if at least one scorer has a jersey number.
  const hasNumbers = scorers.some((s) => s.number != null && s.number !== "");
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-slate-400">
          {hasNumbers && <th className="w-8 pb-1 text-left font-semibold">#</th>}
          <th className="pb-1 text-left font-semibold">Name</th>
          <th className="w-14 pb-1 text-right font-semibold">G.B</th>
        </tr>
      </thead>
      <tbody>
        {scorers.map((s, i) => (
          <tr key={`${s.name}-${i}`} className="border-t border-white/10">
            {hasNumbers && (
              <td className="py-1.5 pr-2 tabular-nums text-slate-500">
                {s.number ?? ""}
              </td>
            )}
            <td className="truncate py-1.5 text-slate-200">{s.name}</td>
            <td className="py-1.5 text-right tabular-nums">
              <span className="font-bold text-white">{s.goals}</span>
              <span className="text-slate-400">.{s.behinds}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A club crest: the local logo when mapped, else an initials badge in a
// deterministic colour. Keeps every team visually anchored even without a logo.
// `size` controls the pixel dimensions (default matches the old inline badge).
function ClubCrest({
  name,
  size = 24,
}: {
  name: string | undefined;
  size?: number;
}) {
  // Admin-configured logo URL wins over the bundled public/clubs/*.png, so
  // clubs without a bundled file (e.g. PFL) still show their crest.
  const logo = clubLogoOverride(name) || clubLogo(name);
  // Lock the badge box on every axis so flex can neither grow nor shrink it,
  // and clip overflow so a logo can never bleed into the score/name beside it.
  const box = {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    maxWidth: size,
    maxHeight: size,
  };
  if (logo) {
    // Fixed-size circular badge. A subtle bg fill makes a letterboxed
    // (object-contain) non-square logo still read as a full-size badge
    // rather than a small floating image, while the logo itself is never
    // cropped.
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10"
        style={box}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt={`${name ?? ""} logo`}
          className="h-full w-full rounded-full object-contain"
        />
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{
        ...box,
        background: clubBadgeColor(name),
        fontSize: Math.round(size * 0.4),
      }}
      aria-hidden="true"
    >
      {clubInitials(name)}
    </span>
  );
}

function GameRow({
  game,
  gradeKey,
  live: liveData,
}: {
  game: PlayHqGame;
  /** The grade key the game belongs to — used to build the match-stats link. */
  gradeKey: string;
  live?: NormalisedLive;
}) {
  const router = useRouter();
  const [scoresOpen, setScoresOpen] = useState(false);
  const [scorersOpen, setScorersOpen] = useState(false);
  // Which team's goal kickers to show — home by default; toggled via the tabs.
  const [scorerTeam, setScorerTeam] = useState<"home" | "away">("home");
  const { home, away } = sides(game);

  // Navigate to a full-screen match page: the tabbed stats page, or the
  // standalone team-lists page.
  const openPage = (base: "match" | "teamlists") => {
    const q = new URLSearchParams({ grade: gradeKey, id: game.id });
    router.push(`/live-scores/${base}?${q.toString()}`);
  };

  // Effective status/score: the REST feed is null for in-play games, so when a
  // spectator live payload is present it takes precedence (status + score +
  // clock). Otherwise fall back to the REST final/upcoming values.
  const effectiveStatus: GameStatus = liveData?.status ?? game.status;
  const badge = statusBadge(effectiveStatus);
  const live = isLive(effectiveStatus);
  const won = wonSide(game); // outcome only exists once FINAL
  // Detailed reports exist only once a game is finalised AND coded.
  const isFinalGame = String(effectiveStatus).toUpperCase() === "FINAL";

  // Per-side score: the REST scoreTotal is authoritative for a finalised game,
  // so prefer it and only fall back to the live/overlay payload when REST has
  // no score (an in-play game the REST feed reports as null). The spectator
  // overlay can carry a null total for some fixtures, which must NOT blank a
  // known final score.
  const homeScore = home?.scoreTotal ?? liveData?.home.total ?? null;
  const awayScore = away?.scoreTotal ?? liveData?.away.total ?? null;
  const homeRestGB = goalsBehinds(home);
  const awayRestGB = goalsBehinds(away);
  const homeGB =
    homeRestGB ||
    (liveData ? `${liveData.home.goals ?? 0}.${liveData.home.behinds ?? 0}` : "");
  const awayGB =
    awayRestGB ||
    (liveData ? `${liveData.away.goals ?? 0}.${liveData.away.behinds ?? 0}` : "");

  const showScore =
    (homeScore != null || awayScore != null) &&
    String(effectiveStatus).toUpperCase() !== "UPCOMING";

  // Live clock label, e.g. "Q3 02:11".
  const clockLabel =
    live && liveData?.clock
      ? [shortPeriod(liveData.clock.period), liveData.clock.time]
          .filter(Boolean)
          .join(" ")
      : "";

  // One team block: crest + score + G.B grouped on a single aligned row, with
  // the club name on a fixed single line (truncated with "…") directly below.
  // Home and away are exact mirrors (`side`), so the two blocks always line up
  // regardless of name length — the name can only ever be one line, so no team
  // column grows taller than the other and knocks the alignment out.
  const teamBlock = (
    name: string | undefined,
    score: number | null,
    gb: string,
    side: "home" | "away"
  ) => {
    const isHome = side === "home";
    const crest = <ClubCrest name={name} size={56} />;
    const scoreBox = (
      <div
        className={`flex flex-col ${isHome ? "items-start" : "items-end"}`}
      >
        <span
          className={`text-3xl leading-none tabular-nums md:text-4xl ${
            won === side
              ? "font-extrabold text-white"
              : "font-bold text-slate-200"
          }`}
        >
          {showScore ? score ?? "-" : "–"}
        </span>
        {showScore && (
          <span className="mt-1 text-xs tabular-nums text-slate-400">{gb}</span>
        )}
      </div>
    );
    return (
      <div
        className={`flex min-w-0 flex-col gap-2 ${
          isHome ? "items-start" : "items-end"
        }`}
      >
        {/* crest + score on one row, pushed to the OUTER edge (home → left,
            away → right) so the scores sit against the card edge and never
            crowd the centre schedule column. */}
        <div
          className={`flex items-center gap-2 ${
            isHome ? "flex-row" : "flex-row-reverse"
          }`}
        >
          {crest}
          {scoreBox}
        </div>
        {/* name: single line, ellipsis when too long, aligned under the crest */}
        <span
          className={`block w-full truncate text-xs md:text-sm ${
            isHome ? "text-left" : "text-right"
          } ${won === side ? "font-bold text-white" : "font-medium text-slate-300"}`}
          title={name ?? "TBC"}
        >
          {name ?? "TBC"}
        </span>
      </div>
    );
  };

  const dateLabel = scheduleDateLabel(game);
  const timeLabel = scheduleTimeLabel(game);
  const venue = game.venue?.name ?? "Venue TBC";

  return (
    <div
      className={`overflow-hidden rounded-2xl border backdrop-blur transition ${
        live
          ? "border-red-500/40 bg-red-500/10 shadow-lg shadow-red-500/5"
          : "border-white/10 bg-white/[0.04] hover:bg-white/[0.06]"
      }`}
    >
      {/* Status strip (live clock / final / upcoming). */}
      <div className="flex items-center justify-center gap-1.5 border-b border-white/10 bg-white/[0.03] py-1.5">
        {live && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
        )}
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}
        >
          {live && clockLabel ? clockLabel : badge.label}
        </span>
      </div>

      {/* Scoreboard: [home block] | [centre schedule] | [away block].
          Each side block groups its own crest + score + name (mirrored), and
          the centre is a fixed-width schedule column that never shifts when a
          name is long (names truncate to one line). The outer tracks are equal
          1fr so the two blocks are symmetric. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 px-3 py-4 md:gap-3 md:px-4">
        {teamBlock(home?.name, homeScore, homeGB, "home")}

        {/* Centre schedule: a fixed-width column (clamped) so a long venue
            truncates instead of widening the track and shoving the scores
            into it. */}
        <div className="flex w-[108px] min-w-[108px] max-w-[108px] flex-col items-center px-1 text-center md:w-[128px] md:min-w-[128px] md:max-w-[128px]">
          {!showScore && (
            <span className="mb-1 text-lg font-bold text-slate-500">vs</span>
          )}
          <span className="text-xs font-semibold text-slate-200">
            {dateLabel}
          </span>
          {timeLabel && (
            <span className="text-xs text-slate-400">{timeLabel}</span>
          )}
          <span className="mt-0.5 flex w-full items-center justify-center gap-0.5 text-[11px] text-slate-500">
            <MapPin size={11} className="shrink-0" />
            <span className="min-w-0 truncate" title={venue}>
              {venue}
            </span>
          </span>
        </div>

        {teamBlock(away?.name, awayScore, awayGB, "away")}
      </div>

      <div className="px-3 pb-3 md:px-4">

      {/* Quarter-by-quarter scores — collapsed behind an "Extended Scores"
          toggle (same pattern as Goal kickers). */}
      {liveData && liveData.home.periods.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-2.5">
          <button
            type="button"
            onClick={() => setScoresOpen((o) => !o)}
            aria-expanded={scoresOpen}
            className="flex w-full items-center justify-between gap-2 text-xs font-medium text-slate-400 hover:text-slate-200"
          >
            <span>Extended Scores</span>
            <ChevronDown
              size={15}
              className={`transition-transform ${
                scoresOpen ? "rotate-180" : ""
              }`}
            />
          </button>
          {scoresOpen && (
            <div className="mt-2">
              <QuarterTable
                homeName={home?.name ?? "Home"}
                awayName={away?.name ?? "Away"}
                home={liveData.home.periods}
                away={liveData.away.periods}
              />
            </div>
          )}
        </div>
      )}

      {/* Goal kickers — still collapsed behind an expand toggle. One team at a
          time (home default) with a Home/Away switch. */}
      {liveData &&
        (liveData.home.scorers.length > 0 ||
          liveData.away.scorers.length > 0) && (
          <div className="mt-3 border-t border-white/10 pt-2.5">
            <button
              type="button"
              onClick={() => setScorersOpen((o) => !o)}
              aria-expanded={scorersOpen}
              className="flex w-full items-center justify-between gap-2 text-xs font-medium text-slate-400 hover:text-slate-200"
            >
              <span>Goal kickers</span>
              <ChevronDown
                size={15}
                className={`transition-transform ${
                  scorersOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {scorersOpen && (
              <div className="mt-2">
                <div className="mb-2 inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5">
                  <button
                    type="button"
                    onClick={() => setScorerTeam("home")}
                    className={`max-w-[45vw] truncate rounded-md px-3 py-1 text-xs font-semibold transition ${
                      scorerTeam === "home"
                        ? "bg-sky-500 text-white"
                        : "text-slate-300 hover:bg-white/10"
                    }`}
                  >
                    {home?.name ?? "Home"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setScorerTeam("away")}
                    className={`max-w-[45vw] truncate rounded-md px-3 py-1 text-xs font-semibold transition ${
                      scorerTeam === "away"
                        ? "bg-sky-500 text-white"
                        : "text-slate-300 hover:bg-white/10"
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

      {isFinalGame && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => openPage("match")}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/10 py-2 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20"
          >
            <BarChart3 size={13} /> Statistics
          </button>
          <button
            type="button"
            onClick={() => openPage("teamlists")}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:text-sky-300"
          >
            <Users size={13} /> Team Lists
          </button>
        </div>
      )}

      </div>
    </div>
  );
}

export default function LiveScoresPage() {
  // Which competition (grade) is shown.
  const [comp, setComp] = useState<LiveScoreGradeKey>("ntfl-mens");
  // Season picker. Only the current season's grades are wired up, so this is a
  // single option today; it drives the UI the same way the official app does.
  const [season, setSeason] = useState<string>(SEASONS[0]);

  // Prime the club_config override cache (logos + colours) once, then bump a
  // tick so the crests re-render with any admin-configured logos.
  const [, setClubCfgTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    ensureClubConfigCache()
      .then(() => {
        if (!cancelled) setClubCfgTick((t) => t + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
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

  // Rounds present, ordered home-and-away first (01, 02, …) then the finals
  // series (F1, F2, PF, GF) via roundOrder — not by the raw first number, which
  // previously interleaved "Finals Round 1" with "Round 1".
  const rounds = useMemo(() => {
    const names = Array.from(
      new Set(games.map((g) => g.round?.name).filter(Boolean))
    ) as string[];
    return names.sort((a, b) => roundOrder(a) - roundOrder(b));
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

    // Fetch with BOUNDED CONCURRENCY and update state as each result lands.
    // Firing one request per visible final at once would hammer the spectator
    // feed (and trip its rate limit), which previously left most games with no
    // scorers/periods. A small worker pool keeps load gentle and makes each
    // game's extended scores + goal kickers appear as soon as it resolves.
    const CONCURRENCY = 3;
    (async () => {
      let cursor = 0;
      const runOne = async () => {
        while (!cancelled && cursor < needed.length) {
          const g = needed[cursor++];
          try {
            // Goal kickers + quarter scores come from the PlayHQ spectator feed
            // (same source as the live score + totals), so the overlay also
            // carries the real score. The feed can be incomplete for some
            // fixtures, but it's the live, authoritative PlayHQ source.
            const data = await getLiveScore(g.id);
            if (cancelled) return;
            if (
              data.home.scorers.length > 0 ||
              data.away.scorers.length > 0 ||
              data.home.periods.length > 0
            ) {
              setScorersById((prev) => ({ ...prev, [g.id]: data }));
            }
          } catch {
            // Ignore a single game's failure; others still enrich. A later
            // round switch / refresh re-attempts the ones still missing.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, needed.length) }, runOne)
      );
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const selectClass =
    "w-full appearance-none rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 pr-10 text-sm font-medium text-slate-100 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 [&>option]:bg-slate-800 [&>option]:text-slate-100";

  return (
    <div className="min-h-full bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900 dark:from-[#0B1220] dark:via-[#0d1526] dark:to-[#0f172a] dark:text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-5 md:px-6 md:py-8">
      {/* Header: title + refresh */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-white md:text-2xl">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/30">
            <Radio size={18} />
          </span>
          Live Scores
        </h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="hidden text-xs text-slate-400 sm:inline">
              Updated {lastUpdated.toLocaleTimeString("en-AU")}
            </span>
          )}
          <button
            onClick={() => load(true)}
            disabled={refreshing || loading}
            aria-label="Refresh"
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Season + Competition dropdowns (match the official app layout). */}
      <div className="mb-4 grid grid-cols-[minmax(0,140px)_1fr] gap-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
            Season
          </span>
          <div className="relative">
            <select
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              className={selectClass}
            >
              {SEASONS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
            Competition
          </span>
          <div className="relative">
            <select
              value={comp}
              onChange={(e) => setComp(e.target.value as LiveScoreGradeKey)}
              className={selectClass}
            >
              {LIVE_SCORE_GRADES.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
          </div>
        </label>
      </div>

      {/* Rounds — horizontal scroll of round pills, like the app. */}
      {rounds.length > 0 && (
        <div className="-mx-4 mb-5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex items-center gap-2">
            {rounds.map((r) => {
              const active = roundFilter === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRoundFilter(r)}
                  title={r}
                  className={`min-w-[52px] shrink-0 rounded-xl px-4 py-2.5 text-center text-base font-bold tabular-nums transition ${
                    active
                      ? "bg-sky-500 text-white shadow-lg shadow-sky-500/25"
                      : "bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  {roundShort(r)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Loading fixtures…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertTriangle size={16} /> {error}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-white/5 py-16 text-center text-sm text-slate-400">
          No fixtures to show.
        </div>
      ) : (
        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-3">
          {visible.map((g) => (
            <GameRow
              key={g.id}
              game={g}
              gradeKey={comp}
              live={liveById[g.id] ?? scorersById[g.id]}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
