"use client";

// Full match-report drill-in for a Live Scores game, modelled on the official
// app: a header scoreboard, then General / Efficiencies / Players tabs. Data is
// the aggregated S3 fixture report (see lib/api/matchReport). Opens over the
// Live Scores list and closes back to it.

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, AlertTriangle, Settings, Target, User } from "lucide-react";

import {
  getMatchReportForGame,
  playerDePercent,
  type MatchReport,
  type TeamStatRow,
} from "@/lib/api/matchReport";
import type { PlayerStatLine } from "@/types/fixtureReport";
import { clubLogo, clubInitials, clubBadgeColor } from "@/lib/api/clubLogos";
import { sides, goalsBehinds, type PlayHqGame } from "@/lib/api/playhq";

type TabKey = "general" | "efficiencies" | "players";

// Small crest (shared look with the list page).
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

// A single comparison bar: red (home) vs green (away), widths proportional to
// each team's share. Ties render a yellow bar (matches the app).
function CompareBar({ row }: { row: TeamStatRow }) {
  const total = row.home + row.away;
  const homePct = total > 0 ? (row.home / total) * 100 : 50;
  const awayPct = total > 0 ? (row.away / total) * 100 : 50;
  const tie = row.home === row.away;
  const fmt = (n: number) => (row.percent ? `${n}%` : `${n}`);

  return (
    <div className="mb-4">
      <div className="mb-1.5 text-center text-sm font-bold text-slate-100">
        {row.label}
      </div>
      <div className="flex h-8 overflow-hidden rounded-full">
        <div
          className={`flex items-center justify-start pl-3 text-sm font-bold text-white transition-all ${
            tie ? "bg-amber-400" : "bg-red-500"
          }`}
          style={{ width: `${Math.max(homePct, 12)}%` }}
        >
          {fmt(row.home)}
        </div>
        <div
          className={`flex items-center justify-end pr-3 text-sm font-bold text-white transition-all ${
            tie ? "bg-amber-400" : "bg-emerald-500"
          }`}
          style={{ width: `${Math.max(awayPct, 12)}%` }}
        >
          {fmt(row.away)}
        </div>
      </div>
    </div>
  );
}

// Section heading (SCORING / POSSESSIONS style).
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-5 border-b border-white/10 pb-1 text-sm font-bold uppercase tracking-wide text-sky-300 first:mt-0">
      {children}
    </h3>
  );
}

// The Players table (All / per-team filter), sortable-looking header, RP first.
const PLAYER_COLS: { key: string; label: string }[] = [
  { key: "rp", label: "RP" },
  { key: "g", label: "G" },
  { key: "d", label: "D" },
  { key: "k", label: "K" },
  { key: "hb", label: "H" },
  { key: "m", label: "M" },
  { key: "t", label: "T" },
];

function PlayersTable({ report }: { report: MatchReport }) {
  const [team, setTeam] = useState<"all" | "home" | "away">("all");

  const rows = useMemo(() => {
    const list =
      team === "home"
        ? report.home.players
        : team === "away"
          ? report.away.players
          : [...report.home.players, ...report.away.players];
    return [...list].sort(
      (a, b) => (b.columns.rp?.[5] ?? 0) - (a.columns.rp?.[5] ?? 0)
    );
  }, [team, report]);

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

  return (
    <div>
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {chip("all", "All")}
        {chip("home", report.home.name)}
        {chip("away", report.away.name)}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs font-semibold uppercase text-slate-400">
              <th className="py-2 pr-2 text-left">Player</th>
              {PLAYER_COLS.map((c) => (
                <th key={c.key} className="px-1.5 py-2 text-right tabular-nums">
                  {c.label}
                </th>
              ))}
              <th className="px-1.5 py-2 text-right">DE%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={p.playerUid}
                className="border-b border-white/5 hover:bg-white/[0.03]"
              >
                <td className="py-2 pr-2">
                  <span className="flex items-center gap-2">
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
                    className="px-1.5 py-2 text-right tabular-nums text-slate-200"
                  >
                    {p.columns[c.key]?.[5] ?? 0}
                  </td>
                ))}
                <td className="px-1.5 py-2 text-right tabular-nums text-slate-200">
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

export default function MatchReportModal({
  game,
  onClose,
}: {
  game: PlayHqGame;
  onClose: () => void;
}) {
  const [report, setReport] = useState<MatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("general");

  const { home, away } = sides(game);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMatchReportForGame(game)
      .then((r) => {
        if (cancelled) return;
        if (!r) {
          setError(
            "No detailed report is available for this match yet. Reports appear once a game has been coded."
          );
        } else {
          setReport(r);
        }
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load report.");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [game]);

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
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-0 backdrop-blur-sm sm:p-4"
      onClick={onClose}
    >
      <div
        className="relative flex min-h-full w-full max-w-2xl flex-col bg-[#0d1526] text-slate-100 shadow-2xl sm:min-h-0 sm:rounded-2xl sm:border sm:border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          <X size={20} />
        </button>

        {/* Scoreboard header */}
        <div className="border-b border-white/10 px-4 pb-4 pt-5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <div className="flex flex-col items-center gap-1.5 text-center">
              <Crest name={home?.name} />
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
              <Crest name={away?.name} />
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

        {/* Tabs */}
        <div className="flex border-b border-white/10 bg-white/[0.02]">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 py-3 text-sm font-semibold transition ${
                  active
                    ? "border-b-2 border-sky-500 text-sky-300"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Icon size={16} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 px-4 py-5">
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
                    .filter((r) =>
                      ["rp", "g", "rb", "b"].includes(r.key)
                    )
                    .map((r) => (
                      <CompareBar key={r.key} row={r} />
                    ))}
                  <SectionTitle>Possessions</SectionTitle>
                  {report.general
                    .filter((r) =>
                      ["d", "k", "hb", "m", "cp"].includes(r.key)
                    )
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

              {/* Team-colour legend */}
              {tab !== "players" && (
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
