"use client";

import { useMemo, useState } from "react";

import {
  buildCompetitionSummary,
  type CompetitionEntry,
  type SummaryRow,
} from "@/lib/analytics/competitionSummary";

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

function compare(a: CompetitionEntry, b: CompetitionEntry, key: SortKey): number {
  switch (key) {
    case "label":
      return a.label.localeCompare(b.label);
    case "seasons":
      return a.seasons.length - b.seasons.length;
    case "games":
      return a.games - b.games;
    case "teams":
      return a.teams - b.teams;
    case "firstDate":
      return (a.firstDate ?? "").localeCompare(b.firstDate ?? "");
    case "lastDate":
      return (a.lastDate ?? "").localeCompare(b.lastDate ?? "");
  }
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
  const [sortKey, setSortKey] = useState<SortKey>("games");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const summary = useMemo(
    () => buildCompetitionSummary(games, { onlyAllocated }),
    [games, onlyAllocated]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = summary.competitions.filter(
      (c) =>
        q === "" ||
        c.label.toLowerCase().includes(q) ||
        c.rawNames.some((n) => n.toLowerCase().includes(q))
    );
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort(
      (a, b) => dir * compare(a, b, sortKey) || a.label.localeCompare(b.label)
    );
  }, [summary, query, sortKey, sortDir]);

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

  function sortBy(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "label" ? "asc" : "desc");
    }
  }

  const th = (key: SortKey, text: string, right = false) => (
    <th
      scope="col"
      aria-sort={
        sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      className={`px-4 py-3 font-semibold ${right ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => sortBy(key)}
        className="uppercase tracking-wide hover:text-white focus:outline-none focus:ring-1 focus:ring-sky-400"
      >
        {text}
        {sortKey === key ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
      </button>
    </th>
  );

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
              <th scope="col" className="px-4 py-3 font-semibold">Season</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Competitions</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">New competitions</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Teams</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">New teams</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Games</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {summary.seasons.map((s) => (
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
            <thead className="sticky top-0 bg-slate-800 text-xs text-slate-400">
              <tr>
                {th("label", "Competition")}
                {th("seasons", "Seasons")}
                {th("games", "Games", true)}
                {th("teams", "Teams", true)}
                {th("firstDate", "First game")}
                {th("lastDate", "Last game")}
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
        Seasons run from the Wednesday on or before 1 October.
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
