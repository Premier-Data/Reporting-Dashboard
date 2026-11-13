import { seasonWeekOfIso } from "@/lib/analytics/season";
import {
  canonicalCompetition,
  canonicalTeam,
  collapseSpaces,
  stripCompetitionYear,
} from "@/lib/analytics/competitionNames";

export type SummaryRow = {
  Date?: string | null;
  season?: number | string | null;
  Competition?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  home_allocated?: string | null;
  away_allocated?: string | null;
};

export type SeasonSummary = {
  season: number;
  competitions: number;
  newCompetitions: number;
  teams: number;
  newTeams: number;
  games: number;
};

export type CompetitionEntry = {
  key: string;
  label: string;
  rawNames: string[];
  seasons: number[];
  firstDate: string | null;
  lastDate: string | null;
  games: number;
  teams: number;
};

export type CompetitionSummary = {
  totalCompetitions: number;
  totalTeams: number;
  totalGames: number;
  seasons: SeasonSummary[]; // latest season first
  competitions: CompetitionEntry[]; // label A-Z
};

export type SummaryOptions = { onlyAllocated?: boolean };

const hasText = (v: unknown) => String(v ?? "").trim() !== "";

function seasonOfRow(r: SummaryRow): number | null {
  const sw = seasonWeekOfIso(r.Date);
  if (sw) return sw.season;
  if (r.season == null || r.season === "") return null;
  const n = Number(r.season);
  return Number.isFinite(n) ? n : null;
}

function dateOf(r: SummaryRow): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(r.Date ?? ""));
  return m ? m[1] : null;
}

type Acc = {
  labels: Map<string, number>;
  raws: Set<string>;
  seasons: Set<number>;
  first: string | null;
  last: string | null;
  games: number;
  teams: Set<string>;
};

export function buildCompetitionSummary(
  rows: readonly SummaryRow[],
  opts: SummaryOptions = {}
): CompetitionSummary {
  const onlyAllocated = opts.onlyAllocated ?? false;
  const allTeams = new Set<string>();
  const comps = new Map<string, Acc>();
  const perSeason = new Map<
    number,
    { comps: Set<string>; teams: Set<string>; games: number }
  >();
  let totalGames = 0;

  for (const r of rows) {
    if (onlyAllocated && !hasText(r.home_allocated) && !hasText(r.away_allocated)) {
      continue;
    }
    totalGames++;
    const season = seasonOfRow(r);
    const key = canonicalCompetition(r.Competition);
    const teamKeys = [canonicalTeam(r.home_team), canonicalTeam(r.away_team)].filter(
      (t) => t !== ""
    );
    teamKeys.forEach((t) => allTeams.add(t));

    let ps: { comps: Set<string>; teams: Set<string>; games: number } | undefined;
    if (season != null) {
      ps = perSeason.get(season);
      if (!ps) perSeason.set(season, (ps = { comps: new Set<string>(), teams: new Set<string>(), games: 0 }));
      ps.games++;
      teamKeys.forEach((t) => ps!.teams.add(t));
    }
    if (key === "") continue;

    let c = comps.get(key);
    if (!c) {
      comps.set(
        key,
        (c = {
          labels: new Map(),
          raws: new Set(),
          seasons: new Set(),
          first: null,
          last: null,
          games: 0,
          teams: new Set(),
        })
      );
    }
    const label = stripCompetitionYear(r.Competition);
    c.labels.set(label, (c.labels.get(label) ?? 0) + 1);
    c.raws.add(collapseSpaces(r.Competition));
    c.games++;
    teamKeys.forEach((t) => c!.teams.add(t));
    if (season != null) {
      c.seasons.add(season);
      ps!.comps.add(key);
    }
    const d = dateOf(r);
    if (d) {
      if (c.first == null || d < c.first) c.first = d;
      if (c.last == null || d > c.last) c.last = d;
    }
  }

  const asc = [...perSeason.keys()].sort((a, b) => a - b);
  const seenC = new Set<string>();
  const seenT = new Set<string>();
  const seasons: SeasonSummary[] = asc.map((s) => {
    const p = perSeason.get(s)!;
    let nc = 0;
    let nt = 0;
    p.comps.forEach((k) => {
      if (!seenC.has(k)) nc++;
    });
    p.teams.forEach((k) => {
      if (!seenT.has(k)) nt++;
    });
    p.comps.forEach((k) => seenC.add(k));
    p.teams.forEach((k) => seenT.add(k));
    return {
      season: s,
      competitions: p.comps.size,
      newCompetitions: nc,
      teams: p.teams.size,
      newTeams: nt,
      games: p.games,
    };
  });

  const competitions: CompetitionEntry[] = [...comps.entries()]
    .map(([key, c]) => {
      const label = [...c.labels.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0][0];
      return {
        key,
        label,
        rawNames: [...c.raws].sort((a, b) => a.localeCompare(b)),
        seasons: [...c.seasons].sort((a, b) => a - b),
        firstDate: c.first,
        lastDate: c.last,
        games: c.games,
        teams: c.teams.size,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    totalCompetitions: comps.size,
    totalTeams: allTeams.size,
    totalGames,
    seasons: seasons.reverse(),
    competitions,
  };
}
