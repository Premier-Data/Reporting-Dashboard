"use client";

import { useMemo, useState } from "react";

import {
  buildCompetitionSummary,
  type SeasonSummary,
  type SummaryRow,
  type TeamEntry,
} from "@/lib/analytics/competitionSummary";
import SortableTh from "@/components/UI/SortableTh";
import { useTableSort, type SortColumn } from "@/lib/tableSort";

type TeamKey =
  | "label"
  | "seasons"
  | "games"
  | "homeGames"
  | "awayGames"
  | "competitions"
  | "firstDate"
  | "lastDate";

type SeasonKey = "season" | "teams" | "newTeams" | "returningTeams" | "droppedTeams" | "runningTeams";

const nf = new Intl.NumberFormat("en-AU");

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-[#0f1b2d] p-5">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-bold text-white">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const TEAM_COLUMNS: Record<TeamKey, SortColumn<TeamEntry>> = {
  label: { value: (t) => t.label },
  seasons: { value: (t) => t.seasons.length, defaultDir: "desc" },
  games: { value: (t) => t.games, defaultDir: "desc" },
  homeGames: { value: (t) => t.homeGames, defaultDir: "desc" },
  awayGames: { value: (t) => t.awayGames, defaultDir: "desc" },
  competitions: { value: (t) => t.competitions, defaultDir: "desc" },
  firstDate: { value: (t) => t.firstDate, defaultDir: "desc", raw: true },
  lastDate: { value: (t) => t.lastDate, defaultDir: "desc", raw: true },
};

const SEASON_COLUMNS: Record<SeasonKey, SortColumn<SeasonSummary>> = {
  season: { value: (s) => s.season, defaultDir: "desc" },
  teams: { value: (s) => s.teams, defaultDir: "desc" },
  newTeams: { value: (s) => s.newTeams, defaultDir: "desc" },
  returningTeams: { value: (s) => s.returningTeams, defaultDir: "desc" },
  droppedTeams: { value: (s) => s.droppedTeams, defaultDir: "desc" },
  runningTeams: { value: (s) => s.runningTeams, defaultDir: "desc" },
};

const compareLabel = (a: TeamEntry, b: TeamEntry) => a.label.localeCompare(b.label);
const HEAD = "px-3 py-2 text-right font-semibold";

export default function TeamsDashboard({
  games,
  loading,
  error,
}: {
  games: readonly SummaryRow[];
  loading: boolean;
  error: string | null;
}) {
  const [onlyAllocated, setOnlyAllocated] = useState(false);
  const [query, setQuery] = useState("");

  const summary = useMemo(
    () => buildCompetitionSummary(games, { onlyAllocated }),
    [games, onlyAllocated]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return summary.teams;
    return summary.teams.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        t.rawNames.some((n) => n.toLowerCase().includes(q)) ||
        t.competitionLabels.some((n) => n.toLowerCase().includes(q))
    );
  }, [summary, query]);

  const { rows, sort } = useTableSort<TeamEntry, TeamKey>(filtered, {
    columns: TEAM_COLUMNS,
    initialKey: "games",
    initialDir: "desc",
    tiebreak: compareLabel,
  });

  const { rows: seasonRows, sort: seasonSort } = useTableSort<SeasonSummary, SeasonKey>(
    summary.seasons,
    { columns: SEASON_COLUMNS, initialKey: "season", initialDir: "desc" }
  );

  if (loading) {
    return (
      <div role="status" className="p-6 text-slate-400">
        Loading teams...
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-900 bg-[#0f1b2d] p-6 text-red-300">
        Could not load games: {error}
      </div>
    );
  }
  if (summary.teams.length === 0) {
    return (
      <div className="space-y-4">
        <Toggle checked={onlyAllocated} onChange={setOnlyAllocated} />
        <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-10 text-center text-slate-500">
          No teams found.
        </div>
      </div>
    );
  }

  const latest = summary.seasons[0];
  const avgGames = summary.teams.reduce((n, t) => n + t.games, 0) / summary.teams.length;
  const firstSeason = summary.seasons.length
    ? Math.min(...summary.seasons.map((s) => s.season))
    : null;

  return (
    <div className="space-y-6">
      <Toggle checked={onlyAllocated} onChange={setOnlyAllocated} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Unique teams (all years)" value={nf.format(summary.totalTeams)} />
        <StatCard
          label="Teams active this season"
          value={latest ? nf.format(latest.teams) : "-"}
          sub={latest ? `${latest.season} season` : undefined}
        />
        <StatCard
          label="New teams this season"
          value={latest ? nf.format(latest.newTeams) : "-"}
          sub={latest ? `${latest.season} season` : undefined}
        />
        <StatCard
          label="Average games per team"
          value={nf.format(Math.round(avgGames * 10) / 10)}
          sub="All years"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0f1b2d]">
        <div className="border-b border-slate-700 px-5 py-4 text-sm font-semibold text-white">
          Teams by season
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left text-sm">
            <caption className="sr-only">Unique teams per season</caption>
            <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <SortableTh sort={seasonSort} sortKey="season" className="px-3 py-2 font-semibold">Season</SortableTh>
                <SortableTh sort={seasonSort} sortKey="teams" className={HEAD}>
                  <span title="Active: teams with at least one game this season">Active</span>
                </SortableTh>
                <SortableTh sort={seasonSort} sortKey="newTeams" className={HEAD}>
                  <span title="New: teams not seen in any earlier season">New</span>
                </SortableTh>
                <SortableTh sort={seasonSort} sortKey="returningTeams" className={HEAD}>
                  <span title="Returning: active this season and seen in an earlier season">Returning</span>
                </SortableTh>
                <SortableTh sort={seasonSort} sortKey="droppedTeams" className={HEAD}>
                  <span title="Dropped: active last season but not this season">Dropped</span>
                </SortableTh>
                <SortableTh sort={seasonSort} sortKey="runningTeams" className={HEAD}>
                  <span title="Running total: distinct teams seen up to and including this season">Running total</span>
                </SortableTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {seasonRows.map((s) => {
                const first = s.season === firstSeason;
                return (
                  <tr key={s.season} className="hover:bg-slate-800/50">
                    <th scope="row" className="px-3 py-2.5 font-semibold text-sky-400">{s.season}</th>
                    <td className="px-3 py-2.5 text-right text-slate-200">{nf.format(s.teams)}</td>
                    <td className="px-3 py-2.5 text-right text-emerald-400">{nf.format(s.newTeams)}</td>
                    <td className="px-3 py-2.5 text-right text-slate-200">{nf.format(s.returningTeams)}</td>
                    <td className={`px-3 py-2.5 text-right ${first || s.droppedTeams === 0 ? "text-slate-500" : "text-amber-400"}`}>
                      {first ? "\u2014" : s.droppedTeams > 0 ? `\u2212${nf.format(s.droppedTeams)}` : "0"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-sky-300">{nf.format(s.runningTeams)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0f1b2d]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 px-5 py-4">
          <div className="text-sm font-semibold text-white">
            Teams{" "}
            <span className="ml-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-bold text-sky-300">
              {rows.length}
            </span>
          </div>
          <div>
            <label htmlFor="team-search" className="sr-only">
              Search teams
            </label>
            <input
              id="team-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teams or competitions..."
              className="rounded-lg border border-slate-700 bg-[#0b1524] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Unique teams across all years</caption>
            <thead className="sticky top-0 bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <SortableTh sort={sort} sortKey="label" className="px-4 py-3 font-semibold">Team</SortableTh>
                <SortableTh sort={sort} sortKey="seasons" className="px-4 py-3 font-semibold">Seasons</SortableTh>
                <SortableTh sort={sort} sortKey="games" className="px-4 py-3 text-right font-semibold">Games</SortableTh>
                <SortableTh sort={sort} sortKey="homeGames" className="px-4 py-3 text-right font-semibold">Home</SortableTh>
                <SortableTh sort={sort} sortKey="awayGames" className="px-4 py-3 text-right font-semibold">Away</SortableTh>
                <SortableTh sort={sort} sortKey="competitions" className="px-4 py-3 text-right font-semibold">Competitions</SortableTh>
                <SortableTh sort={sort} sortKey="firstDate" className="px-4 py-3 font-semibold">First game</SortableTh>
                <SortableTh sort={sort} sortKey="lastDate" className="px-4 py-3 font-semibold">Last game</SortableTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    No teams match your search.
                  </td>
                </tr>
              ) : (
                rows.map((t) => {
                  const merged = t.rawNames.filter((n) => n !== t.label);
                  return (
                    <tr key={t.key} className="hover:bg-slate-800/50">
                      <th
                        scope="row"
                        className="px-4 py-2.5 font-medium text-slate-200"
                        title={`Listed as: ${t.rawNames.join(", ")}`}
                      >
                        {t.label}
                        {merged.length > 0 && (
                          <div className="text-xs font-normal text-slate-500">
                            also listed as: {merged.join(", ")}
                          </div>
                        )}
                      </th>
                      <td className="px-4 py-2.5 text-slate-300">
                        {t.seasons.length > 0 ? t.seasons.join(", ") : "-"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-200">{nf.format(t.games)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-300">{nf.format(t.homeGames)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-300">{nf.format(t.awayGames)}</td>
                      <td
                        className="px-4 py-2.5 text-right text-slate-200"
                        title={t.competitionLabels.length > 0 ? t.competitionLabels.join(", ") : undefined}
                      >
                        {nf.format(t.competitions)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-400">{t.firstDate ?? "-"}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-400">{t.lastDate ?? "-"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Teams are matched ignoring case, extra spaces and a year at the end of the name (for
        example Doncaster and Doncaster 2022 count as one team). A game counts once for a team,
        whether it played home or away. Competitions with &quot;Practice&quot; in the name are
        not counted. Competitions per team merge names that differ only by case, spacing or a
        season in the name; hover the Competitions number to see them. In the season table,
        Active = New + Returning, and Running total = previous running total + New.
      </p>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-sky-500"
      />
      Only games with an allocated analyst
    </label>
  );
}
