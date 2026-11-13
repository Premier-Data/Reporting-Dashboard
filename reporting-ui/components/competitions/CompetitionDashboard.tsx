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

type SeasonKey =
  | "season"
  | "competitions"
  | "newCompetitions"
  | "returningCompetitions"
  | "droppedCompetitions"
  | "runningCompetitions"
  | "teams"
  | "newTeams"
  | "returningTeams"
  | "droppedTeams"
  | "runningTeams"
  | "games";

const seasonCol = (k: Exclude<SeasonKey, "season">): SortColumn<SeasonSummary> => ({
  value: (s) => s[k],
  defaultDir: "desc",
});

const SEASON_COLUMNS: Record<SeasonKey, SortColumn<SeasonSummary>> = {
  season: { value: (s) => s.season, defaultDir: "desc" },
  competitions: seasonCol("competitions"),
  newCompetitions: seasonCol("newCompetitions"),
  returningCompetitions: seasonCol("returningCompetitions"),
  droppedCompetitions: seasonCol("droppedCompetitions"),
  runningCompetitions: seasonCol("runningCompetitions"),
  teams: seasonCol("teams"),
  newTeams: seasonCol("newTeams"),
  returningTeams: seasonCol("returningTeams"),
  droppedTeams: seasonCol("droppedTeams"),
  runningTeams: seasonCol("runningTeams"),
  games: seasonCol("games"),
};

const HEAD = "px-3 py-2 text-right font-semibold";

function SeasonGroupHeads({
  sort,
  unit,
  keys,
}: {
  sort: ReturnType<typeof useTableSort<SeasonSummary, SeasonKey>>["sort"];
  unit: "competitions" | "teams";
  keys: [SeasonKey, SeasonKey, SeasonKey, SeasonKey, SeasonKey];
}) {
  return (
    <>
      <SortableTh sort={sort} sortKey={keys[0]} className={HEAD}>
        <span title={`Active: ${unit} with at least one game this season`}>Active</span>
      </SortableTh>
      <SortableTh sort={sort} sortKey={keys[1]} className={HEAD}>
        <span title={`New: ${unit} not seen in any earlier season`}>New</span>
      </SortableTh>
      <SortableTh sort={sort} sortKey={keys[2]} className={HEAD}>
        <span title={`Returning: active this season and seen in an earlier season (Active = New + Returning)`}>Returning</span>
      </SortableTh>
      <SortableTh sort={sort} sortKey={keys[3]} className={HEAD}>
        <span title={`Dropped: covered last season but not this season`}>Dropped</span>
      </SortableTh>
      <SortableTh sort={sort} sortKey={keys[4]} className={HEAD}>
        <span title={`Running total: distinct ${unit} seen in any season up to and including this one`}>Running total</span>
      </SortableTh>
    </>
  );
}

function SeasonGroupCells({
  active,
  fresh,
  returning,
  revived,
  dropped,
  running,
  first,
}: {
  active: number;
  fresh: number;
  returning: number;
  revived: number;
  dropped: number;
  running: number;
  first: boolean;
}) {
  return (
    <>
      <td className="border-l border-slate-700 px-3 py-2.5 text-right text-slate-200">{nf.format(active)}</td>
      <td className="px-3 py-2.5 text-right text-emerald-400" title="New">{nf.format(fresh)}</td>
      <td
        className="px-3 py-2.5 text-right text-slate-200"
        title={revived > 0 ? `incl. ${nf.format(revived)} back after a gap` : undefined}
      >
        {nf.format(returning)}
        {revived > 0 && <span aria-hidden="true" className="text-slate-500">*</span>}
        {revived > 0 && <span className="sr-only"> (incl. {nf.format(revived)} back after a gap)</span>}
      </td>
      <td
        className={`px-3 py-2.5 text-right ${first || dropped === 0 ? "text-slate-500" : "text-amber-400"}`}
        title={first ? "No earlier season" : undefined}
      >
        {first ? "\u2014" : dropped > 0 ? `\u2212${nf.format(dropped)}` : "0"}
      </td>
      <td className="px-3 py-2.5 text-right font-bold text-sky-300">{nf.format(running)}</td>
    </>
  );
}
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
  const firstSeason = years.length ? Math.min(...years) : null;
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
        <div className="overflow-x-auto">
        <table className="w-full min-w-max text-left text-sm">
          <caption className="sr-only">Unique competitions and teams per season</caption>
          <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <td />
              <th colSpan={5} scope="colgroup" className="border-l border-slate-700 px-3 py-1.5 text-center font-semibold text-slate-300">Competitions</th>
              <th colSpan={5} scope="colgroup" className="border-l border-slate-700 px-3 py-1.5 text-center font-semibold text-slate-300">Teams</th>
              <td />
            </tr>
            <tr>
              <SortableTh sort={seasonSort} sortKey="season" className="px-3 py-2 font-semibold">Season</SortableTh>
              <SeasonGroupHeads sort={seasonSort} unit="competitions" keys={["competitions", "newCompetitions", "returningCompetitions", "droppedCompetitions", "runningCompetitions"]} />
              <SeasonGroupHeads sort={seasonSort} unit="teams" keys={["teams", "newTeams", "returningTeams", "droppedTeams", "runningTeams"]} />
              <SortableTh sort={seasonSort} sortKey="games" className="px-3 py-2 text-right font-semibold">Games</SortableTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {seasonRows.map((s) => (
              <tr key={s.season} className="hover:bg-slate-800/50">
                <th scope="row" className="px-3 py-2.5 font-semibold text-sky-400">{s.season}</th>
                <SeasonGroupCells
                  active={s.competitions}
                  fresh={s.newCompetitions}
                  returning={s.returningCompetitions}
                  revived={s.revivedCompetitions}
                  dropped={s.droppedCompetitions}
                  running={s.runningCompetitions}
                  first={s.season === firstSeason}
                />
                <SeasonGroupCells
                  active={s.teams}
                  fresh={s.newTeams}
                  returning={s.returningTeams}
                  revived={s.revivedTeams}
                  dropped={s.droppedTeams}
                  running={s.runningTeams}
                  first={s.season === firstSeason}
                />
                <td className="border-l border-slate-700 px-3 py-2.5 text-right text-slate-200">{nf.format(s.games)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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
        &quot;Practice&quot; in the name are not counted. In the season table, Active = New +
        Returning (an asterisk marks returning counts that include some back after a gap), and
        Running total = previous running total + New.
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
