"use client";

// Full-screen match stats page (mobile-first), opened from a Live Scores card's
// Statistics / Team Lists buttons. It re-fetches the game by grade + id from
// the URL (?grade=<key>&id=<gameId>&tab=<general|teamlists|…>), shows the
// fixture scoreboard at the top, then the General / Efficiencies / Players /
// Team Lists tabs — like the official app's match screen. A back arrow returns
// to the Live Scores list.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  Loader2,
  AlertTriangle,
  Settings,
  Target,
  User,
  Users,
} from "lucide-react";

import {
  getMatchReportForGame,
  playerDePercent,
  type MatchReport,
  type MatchReportTeam,
  type TeamStatRow,
} from "@/lib/api/matchReport";
import type { PlayerStatLine } from "@/types/fixtureReport";
import { clubLogo, clubInitials, clubBadgeColor } from "@/lib/api/clubLogos";
import {
  getGradeGames,
  sides,
  goalsBehinds,
  LIVE_SCORE_GRADES,
  type PlayHqGame,
} from "@/lib/api/playhq";

type TabKey = "general" | "efficiencies" | "players" | "teamlists";

// ── Shared bits (crest, bars, tables) ───────────────────────────────────────

function Crest({ name, size = 44 }: { name: string | undefined; size?: number }) {
  const logo = clubLogo(name);
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

// A head-to-head bar that grows OUTWARD from the centre: home extends left,
// away extends right. The BETTER team's bar fills its whole half; the other's
// length is the ratio of the two values (so a close contest shows two near-full
// bars, a blowout shows one tiny). "Better" is the higher value, except for
// `lowerIsBetter` stats (Frees Against, turnovers) where it's the lower value.
function CompareBar({ row }: { row: TeamStatRow }) {
  const { home, away } = row;
  const tie = home === away;
  const fmt = (n: number) => (row.percent ? `${n}%` : `${n}`);

  // Which side is better, and each side's fill as a fraction (0–1) of its half.
  let homeFrac = 1;
  let awayFrac = 1;
  let homeBetter = false;
  let awayBetter = false;

  if (!tie) {
    if (row.lowerIsBetter) {
      // Lower value wins and fills fully; the higher (worse) side shrinks.
      if (home < away) {
        homeBetter = true;
        awayFrac = away > 0 ? home / away : 0;
      } else {
        awayBetter = true;
        homeFrac = home > 0 ? away / home : 0;
      }
    } else {
      // Higher value wins and fills fully; the lower side shrinks.
      if (home > away) {
        homeBetter = true;
        awayFrac = home > 0 ? away / home : 0;
      } else {
        awayBetter = true;
        homeFrac = away > 0 ? home / away : 0;
      }
    }
  }

  // Winner green, loser red, tie amber. A small floor keeps the number legible.
  const homeColor = tie ? "bg-amber-400" : homeBetter ? "bg-emerald-500" : "bg-red-500";
  const awayColor = tie ? "bg-amber-400" : awayBetter ? "bg-emerald-500" : "bg-red-500";
  const homeW = Math.max(homeFrac * 100, 14);
  const awayW = Math.max(awayFrac * 100, 14);

  return (
    <div className="mb-4">
      <div className="mb-1.5 text-center text-sm font-bold text-slate-100">
        {row.label}
      </div>
      {/* Two halves meeting at the centre; each bar is anchored to the centre
          and grows toward its outer edge. */}
      <div className="flex h-8 items-stretch">
        {/* Home half — bar hugs the centre line (right edge of this half). */}
        <div className="flex w-1/2 justify-end">
          <div
            className={`flex h-full items-center justify-start rounded-l-full pl-3 text-sm font-bold text-white transition-all ${homeColor}`}
            style={{ width: `${homeW}%` }}
          >
            {fmt(home)}
          </div>
        </div>
        {/* Away half — bar hugs the centre line (left edge of this half). */}
        <div className="flex w-1/2 justify-start">
          <div
            className={`flex h-full items-center justify-end rounded-r-full pr-3 text-sm font-bold text-white transition-all ${awayColor}`}
            style={{ width: `${awayW}%` }}
          >
            {fmt(away)}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-5 border-b border-white/10 pb-1 text-sm font-bold uppercase tracking-wide text-sky-300 first:mt-0">
      {children}
    </h3>
  );
}

const PLAYER_COLS: { key: string; label: string }[] = [
  { key: "rp", label: "RP" },
  { key: "g", label: "G" },
  { key: "d", label: "D" },
  { key: "k", label: "K" },
  { key: "hb", label: "H" },
  { key: "m", label: "M" },
  { key: "t", label: "T" },
];

// Sortable keys: the "name" column, each stat column, and "de" (DE%).
type SortKey = "name" | "de" | string;
type SortDir = "asc" | "desc";

// The numeric value for a player in a given sort column.
function sortValue(p: PlayerStatLine, key: SortKey): number {
  if (key === "de") return playerDePercent(p);
  return p.columns[key]?.[5] ?? 0;
}

function PlayersTable({ report }: { report: MatchReport }) {
  const [team, setTeam] = useState<"all" | "home" | "away">("all");
  // Default sort: Ranking Points, highest first (matches the app).
  const [sortKey, setSortKey] = useState<SortKey>("rp");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Click a header: a new column starts descending for stats / ascending for
  // the name column; clicking the active column flips the direction.
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const list =
      team === "home"
        ? report.home.players
        : team === "away"
          ? report.away.players
          : [...report.home.players, ...report.away.players];

    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      let cmp: number;
      if (sortKey === "name") {
        cmp = a.playerName.localeCompare(b.playerName);
      } else {
        cmp = sortValue(a, sortKey) - sortValue(b, sortKey);
        // Stable, readable tie-break: by name ascending.
        if (cmp === 0) return a.playerName.localeCompare(b.playerName);
      }
      return cmp * dir;
    });
  }, [team, report, sortKey, sortDir]);

  const chip = (val: typeof team, label: string) => (
    <button
      type="button"
      onClick={() => setTeam(val)}
      className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
        team === val
          ? "border-sky-500 bg-sky-500 text-white"
          : "border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
      }`}
    >
      {label}
    </button>
  );

  const teamColor = (p: PlayerStatLine) =>
    p.teamUid === report.home.uid ? "bg-red-500" : "bg-emerald-500";

  // The active-column sort arrow.
  const arrow = (key: SortKey) => {
    if (key !== sortKey) return null;
    return sortDir === "asc" ? (
      <ChevronUp size={12} className="shrink-0" />
    ) : (
      <ChevronDown size={12} className="shrink-0" />
    );
  };

  // Shared classes for a sortable header cell. `active` tints it sky.
  // Horizontal padding is set per-cell by the caller so stat columns stay tight.
  const thCls = (active: boolean, align: "left" | "right") =>
    `cursor-pointer select-none py-2 font-semibold transition hover:text-slate-100 ${
      align === "left" ? "text-left" : "text-right"
    } ${active ? "text-sky-300" : "text-slate-400"}`;

  return (
    <div>
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {chip("all", "All")}
        {chip("home", report.home.name)}
        {chip("away", report.away.name)}
      </div>

      {/* table-fixed so every stat column fits the screen (no horizontal
          scroll); the Player column takes the remaining space and truncates
          long names. */}
      <div>
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            {[...PLAYER_COLS, { key: "de" }].map((c) => (
              <col key={c.key} className="w-[9%]" />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase">
              <th
                scope="col"
                aria-sort={
                  sortKey === "name"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                onClick={() => toggleSort("name")}
                className={`${thCls(sortKey === "name", "left")} pr-1`}
              >
                <span className="flex items-center gap-1">
                  Player {arrow("name")}
                </span>
              </th>
              {[...PLAYER_COLS, { key: "de", label: "DE%" }].map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    sortKey === c.key
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  onClick={() => toggleSort(c.key)}
                  className={`${thCls(sortKey === c.key, "right")} px-0.5 tabular-nums`}
                >
                  <span className="flex items-center justify-end gap-0.5">
                    {c.label} {arrow(c.key)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={p.playerUid}
                className="border-b border-white/5 hover:bg-white/[0.03]"
              >
                <td className="py-2 pr-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white ${teamColor(
                        p
                      )}`}
                    >
                      {p.playerNumber || "-"}
                    </span>
                    <span className="truncate font-medium text-slate-100">
                      {p.playerName}
                    </span>
                  </span>
                </td>
                {PLAYER_COLS.map((c) => (
                  <td
                    key={c.key}
                    className={`px-0.5 py-2 text-right tabular-nums ${
                      sortKey === c.key ? "font-semibold text-white" : "text-slate-200"
                    }`}
                  >
                    {p.columns[c.key]?.[5] ?? 0}
                  </td>
                ))}
                <td
                  className={`px-0.5 py-2 text-right tabular-nums ${
                    sortKey === "de" ? "font-semibold text-white" : "text-slate-200"
                  }`}
                >
                  {playerDePercent(p)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={PLAYER_COLS.length + 2} className="py-8 text-center text-slate-400">
                  No player stats available.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamLists({ report }: { report: MatchReport }) {
  const [side, setSide] = useState<"home" | "away">("home");
  const team: MatchReportTeam = side === "home" ? report.home : report.away;

  const roster = useMemo(() => {
    return [...team.players].sort((a, b) => {
      const na = a.playerNumber || Number.POSITIVE_INFINITY;
      const nb = b.playerNumber || Number.POSITIVE_INFINITY;
      if (na !== nb) return na - nb;
      return a.playerName.localeCompare(b.playerName);
    });
  }, [team]);

  const dotColor = side === "home" ? "bg-red-500" : "bg-emerald-500";

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

  return (
    <div>
      <div className="mb-4 flex gap-2">
        {tab("home", report.home.name)}
        {tab("away", report.away.name)}
      </div>

      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">
        <span>Player</span>
        <span>{roster.length} players</span>
      </div>

      <ul className="divide-y divide-white/5">
        {roster.map((p) => (
          <li key={p.playerUid} className="flex items-center gap-3 py-2.5">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white ${dotColor}`}
            >
              {p.playerNumber || "-"}
            </span>
            <span className="truncate text-sm font-medium text-slate-100">
              {p.playerName}
            </span>
          </li>
        ))}
        {roster.length === 0 && (
          <li className="py-8 text-center text-sm text-slate-400">
            No team list available.
          </li>
        )}
      </ul>
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

function MatchStatsInner() {
  const router = useRouter();
  const params = useSearchParams();

  const gradeKey = params.get("grade") ?? "";
  const gameId = params.get("id") ?? "";
  const initialTab = (params.get("tab") as TabKey) ?? "general";

  const [game, setGame] = useState<PlayHqGame | null>(null);
  const [report, setReport] = useState<MatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>(initialTab);

  const back = () => router.push("/live-scores");

  // Load the game (from its grade) then its report.
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
        const games = await getGradeGames(grade.gradeId);
        const g = games.find((x) => x.id === gameId) ?? null;
        if (cancelled) return;
        if (!g) {
          setError("Match not found.");
          setLoading(false);
          return;
        }
        setGame(g);
        const r = await getMatchReportForGame(g);
        if (cancelled) return;
        if (!r) {
          setError(
            "No detailed report is available for this match yet. Reports appear once a game has been coded."
          );
        } else {
          setReport(r);
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load report.");
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
  const margin =
    homeScore != null && awayScore != null
      ? Math.abs(homeScore - awayScore)
      : null;
  const winner =
    homeScore != null && awayScore != null && homeScore !== awayScore
      ? homeScore > awayScore
        ? home?.name
        : away?.name
      : null;

  const tabs: { key: TabKey; label: string; icon: typeof Settings }[] = [
    { key: "general", label: "General", icon: Settings },
    { key: "efficiencies", label: "Efficiencies", icon: Target },
    { key: "players", label: "Players", icon: User },
    { key: "teamlists", label: "Team Lists", icon: Users },
  ];

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
        <span className="text-sm font-semibold">Match Stats</span>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1">
        {/* Scoreboard header — always visible */}
        {game && (
          <div className="border-b border-white/10 px-4 pb-4 pt-4">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <Crest name={home?.name} size={52} />
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
                <Crest name={away?.name} size={52} />
                <span className="text-xs font-medium leading-tight text-slate-300">
                  {away?.name ?? "Away"}
                </span>
              </div>
            </div>
            {winner && margin != null && (
              <p className="mt-3 text-center text-sm font-semibold text-sky-300">
                {winner} won by {margin} point{margin === 1 ? "" : "s"}
              </p>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="sticky top-[52px] z-10 flex border-b border-white/10 bg-[#0d1526]/95 backdrop-blur">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-xs font-semibold transition sm:flex-row sm:gap-1.5 sm:text-sm ${
                  active
                    ? "border-b-2 border-sky-500 text-sky-300"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Icon size={16} />{" "}
                <span className="whitespace-nowrap">{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="px-4 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
              <Loader2 size={18} className="animate-spin" /> Loading report…
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
            </div>
          ) : report ? (
            <>
              {tab === "general" && (
                <div>
                  <SectionTitle>Scoring</SectionTitle>
                  {report.general
                    .filter((r) => ["rp", "g", "rb", "b"].includes(r.key))
                    .map((r) => (
                      <CompareBar key={r.key} row={r} />
                    ))}
                  <SectionTitle>Possessions</SectionTitle>
                  {report.general
                    .filter((r) => ["d", "k", "hb", "m", "cp"].includes(r.key))
                    .map((r) => (
                      <CompareBar key={r.key} row={r} />
                    ))}
                  <SectionTitle>Contest &amp; Pressure</SectionTitle>
                  {report.general
                    .filter((r) =>
                      ["t", "ci", "i50", "ho", "ff", "fa"].includes(r.key)
                    )
                    .map((r) => (
                      <CompareBar key={r.key} row={r} />
                    ))}
                </div>
              )}
              {tab === "efficiencies" && (
                <div>
                  <SectionTitle>Efficiencies</SectionTitle>
                  {report.efficiencies.map((r) => (
                    <CompareBar key={r.key} row={r} />
                  ))}
                </div>
              )}
              {tab === "players" && <PlayersTable report={report} />}
              {tab === "teamlists" && <TeamLists report={report} />}

              {tab !== "players" && tab !== "teamlists" && (
                <div className="mt-6 flex items-center justify-center gap-5 text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    {report.home.name}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    {report.away.name}
                  </span>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function MatchStatsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center bg-[#0B1220] py-20 text-sm text-slate-400">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading…
        </div>
      }
    >
      <MatchStatsInner />
    </Suspense>
  );
}
