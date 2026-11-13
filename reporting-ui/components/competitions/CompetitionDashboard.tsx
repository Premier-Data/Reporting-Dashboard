"use client";

import { useMemo, useState } from "react";

import {
  buildCompetitionSummary,
  type CompetitionEntry,
  type SeasonSummary,
  type SummaryRow,
} from "@/lib/analytics/competitionSummary";
import SortableTh from "@/components/UI/SortableTh";
import { useTableSort, type SortColumn } from "@/lib/tableSort";

type SortKey = "label" | "seasons" | "games" | "teams" | "firstDate" | "lastDate";

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

const COMPETITION_COLUMNS: Record<SortKey, SortColumn<CompetitionEntry>> = {
  label: { value: (c) => c.label },
  seasons: { value: (c) => c.seasons.length, defaultDir: "desc" },
  games: { value: (c) => c.games, defaultDir: "desc" },
  teams: { value: (c) => c.teams, defaultDir: "desc" },
  firstDate: { value: (c) => c.firstDate, defaultDir: "desc", raw: true },
  lastDate: { value: (c) => c.lastDate, defaultDir: "desc", raw: true },
};

const compareLabel = (a: CompetitionEntry, b: CompetitionEntry) => a.label.localeCompare(b.label);

type SeasonKey = "season" | "competitions" | "newCompetitions" | "teams" | "newTeams" | "games";

const SEASON_COLUMNS: Record<SeasonKey, SortColumn<SeasonSummary>> = {
  season: { value: (s) => s.season, defaultDir: "desc" },
  competitions: { value: (s) => s.competitions, defaultDir: "desc" },
  newCompetitions: { value: (s) => s.newCompetitions, defaultDir: "desc" },
  teams: { value: (s) => s.teams, defaultDir: "desc" },
  newTeams: { value: (s) => s.newTeams, defaultDir: "desc" },
  games: { value: (s) => s.games, defaultDir: "desc" },
};
export default function CompetitionDashboard({
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
    return summary.competitions.filter(
      (c) =>
        q === "" ||
        c.label.toLowerCase().includes(q) ||
        c.rawNames.some((n) => n.toLowerCase().includes(q))
    );
  }, [summary, query]);

  const { rows, sort } = useTableSort<CompetitionEntry, SortKey>(filtered, {
    columns: COMPETITION_COLUMNS,
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
        Loading summary...
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
  if (summary.totalGames === 0) {
    return (
      <div className="space-y-4">
        <Toggle checked={onlyAllocated} onChange={setOnlyAllocated} />
        <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-10 text-center text-slate-500">
          No games found.
        </div>
      </div>
    );
  }

  const years = summary.seasons.map((s) => s.season);
  const range =
    years.length === 0
      ? "-"
      : years.length === 1
      ? String(years[0])
      : `${Math.min(...years)}-${Math.max(...years)}`;

  return (
    <div className="space-y-6">
      <Toggle checked={onlyAllocated} onChange={setOnlyAllocated} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Unique competitions (all years)" value={nf.format(summary.totalCompetitions)} />
        <StatCard label="Unique teams (all years)" value={nf.format(summary.totalTeams)} />
        <StatCard label="Games analysed" value={nf.format(summary.totalGames)} />
        <StatCard
          label="Seasons covered"
          value={range}
          sub={`${years.length} season${years.length === 1 ? "" : "s"}`}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0f1b2d]">
        <div className="border-b border-slate-700 px-5 py-4 text-sm font-semibold text-white">
          By season
        </div>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Unique competitions and teams per season</caption>
          <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <SortableTh sort={seasonSort} sortKey="season" className="px-4 py-3 font-semibold">Season</SortableTh>
              <SortableTh sort={seasonSort} sortKey="competitions" className="px-4 py-3 text-right font-semibold">Competitions</SortableTh>
              <SortableTh sort={seasonSort} sortKey="newCompetitions" className="px-4 py-3 text-right font-semibold">New competitions</SortableTh>
              <SortableTh sort={seasonSort} sortKey="teams" className="px-4 py-3 text-right font-semibold">Teams</SortableTh>
              <SortableTh sort={seasonSort} sortKey="newTeams" className="px-4 py-3 text-right font-semibold">New teams</SortableTh>
              <SortableTh sort={seasonSort} sortKey="games" className="px-4 py-3 text-right font-semibold">Games</SortableTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {seasonRows.map((s) => (
              <tr key={s.season} className="hover:bg-slate-800/50">
                <th scope="row" className="px-4 py-2.5 font-semibold text-sky-400">{s.season}</th>
                <td className="px-4 py-2.5 text-right text-slate-200">{nf.format(s.competitions)}</td>
                <td className="px-4 py-2.5 text-right text-emerald-400">{nf.format(s.newCompetitions)}</td>
                <td className="px-4 py-2.5 text-right text-slate-200">{nf.format(s.teams)}</td>
                <td className="px-4 py-2.5 text-right text-emerald-400">{nf.format(s.newTeams)}</td>
                <td className="px-4 py-2.5 text-right text-slate-200">{nf.format(s.games)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-[#0f1b2d]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 px-5 py-4">
          <div className="text-sm font-semibold text-white">
            Competitions{" "}
            <span className="ml-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-bold text-sky-300">
              {rows.length}
            </span>
          </div>
          <div>
            <label htmlFor="comp-search" className="sr-only">
              Search competitions
            </label>
            <input
              id="comp-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search competitions..."
              className="rounded-lg border border-slate-700 bg-[#0b1524] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Unique competitions across all years</caption>
            <thead className="sticky top-0 bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <SortableTh sort={sort} sortKey="label" className="px-4 py-3 font-semibold">Competition</SortableTh>
                <SortableTh sort={sort} sortKey="seasons" className="px-4 py-3 font-semibold">Seasons</SortableTh>
                <SortableTh sort={sort} sortKey="games" className="px-4 py-3 text-right font-semibold">Games</SortableTh>
                <SortableTh sort={sort} sortKey="teams" className="px-4 py-3 text-right font-semibold">Teams</SortableTh>
                <SortableTh sort={sort} sortKey="firstDate" className="px-4 py-3 font-semibold">First game</SortableTh>
                <SortableTh sort={sort} sortKey="lastDate" className="px-4 py-3 font-semibold">Last game</SortableTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    No competitions match your search.
                  </td>
                </tr>
              ) : (
                rows.map((c) => {
                  const merged = c.rawNames.filter((n) => n !== c.label);
                  return (
                    <tr key={c.key} className="hover:bg-slate-800/50">
                      <th
                        scope="row"
                        className="px-4 py-2.5 font-medium text-slate-200"
                        title={`Listed as: ${c.rawNames.join(", ")}`}
                      >
                        {c.label}
                        {merged.length > 0 && (
                          <div className="text-xs font-normal text-slate-500">
                            also listed as: {merged.join(", ")}
                          </div>
                        )}
                      </th>
                      <td className="px-4 py-2.5 text-slate-300">
                        {c.seasons.length > 0 ? c.seasons.join(", ") : "-"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-200">{nf.format(c.games)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-200">{nf.format(c.teams)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-400">{c.firstDate ?? "-"}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-400">{c.lastDate ?? "-"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Competition names are matched ignoring case, extra spaces and a year or season at the
        start or end of the name (for example PSA and PSA 2022, or 2026-27 TIO NTFL Men Premier
        League and TIO NTFL Men Premier League count as one). Numbers that are part of a name,
        such as Under 19s or Division 1, are kept. Teams are matched ignoring case and spacing.
        Seasons run from the Wednesday on or before 1 October. Competitions with
        &quot;Practice&quot; in the name are not counted.
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
