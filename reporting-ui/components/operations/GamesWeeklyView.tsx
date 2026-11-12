"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { THEME } from "@/lib/theme";
import { fetchTTGamesForOps } from "@/lib/api/ttGames";
import { fetchSoccerGamesForOps } from "@/lib/api/soccerGames";
import {
  OPS_MIXED_KEY,
  WEEK_BANDS,
  bandForWeekValue,
  buildOpsGamesReport,
  latestSeason,
  seasonsFromGames,
  totalScale,
  type OpsGamesAnalystRow,
  type OpsGamesWeek,
  type TTGameRow,
  type WeekBand,
} from "@/lib/analytics/opsGames";
import {
  MIXED_KEY,
  buildSoccerOpsReport,
  soccerSeasons,
  type SoccerGameRow,
} from "@/lib/analytics/opsSoccer";

type SortKey = "name" | "total" | `w${number}`;
type Sport = "aussie" | "soccer";

type SummaryRow = {
  label: string;
  title?: string;
  vals: (w: number) => string;
  total: string;
};

/** Everything the grid needs, independent of sport. */
type GridModel = {
  season: number;
  weeks: OpsGamesWeek[];
  analysts: OpsGamesAnalystRow[];
  summary: SummaryRow[];
  excluded: { placeholderHalfGames: number; skippedRows: number };
};

const BAND_STYLE: Record<WeekBand, { bg: string; fg: string }> = {
  blue: { bg: "#1d4ed8", fg: "#ffffff" },
  green: { bg: "#15803d", fg: "#ffffff" },
  amber: { bg: "#b45309", fg: "#ffffff" },
  none: { bg: "transparent", fg: THEME.text },
};

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const pct = (v: number | null) => (v === null ? "\u2013" : `${Math.round(v * 100)}%`);

const NAME_W = 180;
const cellBase = {
  padding: "4px 8px",
  textAlign: "center" as const,
  whiteSpace: "nowrap" as const,
  borderBottom: `1px solid ${THEME.border}`,
};

const box = { padding: 24, color: THEME.text };

export default function GamesWeeklyView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sport: Sport = searchParams.get("sport") === "soccer" ? "soccer" : "aussie";

  const setSport = (s: Sport) =>
    router.replace(
      s === "soccer" ? `${pathname}?tab=games&sport=soccer` : `${pathname}?tab=games`,
      { scroll: false }
    );

  return (
    <div>
      {/* Sport sub-tabs, same style as Reporting > TT Games. */}
      <div style={{ padding: "16px 24px 0" }}>
        <div
          role="group"
          aria-label="Sport"
          className="inline-flex rounded-lg border border-slate-300 bg-white p-1"
        >
          {(["aussie", "soccer"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={sport === s}
              onClick={() => setSport(s)}
              className={`rounded-md px-4 py-1.5 text-sm font-semibold ${
                sport === s ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "aussie" ? "Aussie Rules" : "Soccer"}
            </button>
          ))}
        </div>
      </div>
      {sport === "aussie" ? <AussieGames /> : <SoccerOpsGames />}
    </div>
  );
}

/** Loads rows once (and again on retry). Soccer mounts lazily so it only fetches when opened. */
function useLoader<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loader()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load games");
      });
    return () => {
      cancelled = true;
    };
    // loader is a stable module-level function
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  const reload = useCallback(() => {
    setData(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  return { data, error, reload };
}

function aussieModel(rows: TTGameRow[], season: number): GridModel {
  const report = buildOpsGamesReport(rows, season);
  const summary: SummaryRow[] = [
    {
      label: "Total games",
      vals: (w) => fmt(report.totalsByWeek[w] ?? 0),
      total: fmt(report.totals.all),
    },
  ];
  const hasAus = report.totals.aus > 0;
  for (const l of report.locations)
    summary.push({
      label: l.key,
      title: l.key === OPS_MIXED_KEY ? "Games with a combined or unrecognised location (e.g. PHL/ AUS)" : undefined,
      vals: (w) => fmt(l.byWeek[w] ?? 0),
      total: fmt(l.total),
    });
  if (hasAus)
    summary.push({
      label: "% AUS",
      title: "AUS games as a share of all games that week (every TT game row counts as completed)",
      vals: (w) => pct(report.pctAusByWeek[w] ?? null),
      total: pct(report.totals.pctAus),
    });
  return { season, weeks: report.weeks, analysts: report.analysts, summary, excluded: report.excluded };
}

function soccerModel(rows: SoccerGameRow[], season: number): GridModel {
  const report = buildSoccerOpsReport(rows, season);
  const summary: SummaryRow[] = [
    {
      label: "Total games",
      vals: (w) => fmt(report.totalsByWeek[w] ?? 0),
      total: fmt(report.totals.all),
    },
    // No "% AUS" row for soccer (VN dominates, so it is not meaningful).
    ...report.locations.map((l) => ({
      label: l.key,
      title: l.key === MIXED_KEY ? "Games with a mixed or unrecognised location (e.g. AUS/ VN)" : undefined,
      vals: (w: number) => fmt(l.byWeek[w] ?? 0),
      total: fmt(l.total),
    })),
  ];
  return { season, weeks: report.weeks, analysts: report.analysts, summary, excluded: report.excluded };
}

function AussieGames() {
  const { data: rows, error, reload } = useLoader(fetchTTGamesForOps);
  const [season, setSeason] = useState<number | null>(null);
  useEffect(() => {
    if (rows) setSeason((s) => s ?? latestSeason(rows));
  }, [rows]);
  const seasons = useMemo(() => (rows ? seasonsFromGames(rows) : []), [rows]);
  const model = useMemo(
    () => (rows && season !== null ? aussieModel(rows, season) : null),
    [rows, season]
  );
  return (
    <GamesGrid
      loaded={!!rows}
      error={error}
      onRetry={reload}
      seasons={seasons}
      season={season}
      onSeason={setSeason}
      model={model}
      emptyLabel="games"
      footnote={
        <>
          Weeks run Wednesday to Tuesday and are derived from the game date (Week 1
          starts on the Wednesday on or before 1 October). Columns are labelled by their week-ending Saturday. A game is worth 0.5 per team side. Total Games = (Home + Away) / 2.
        </>
      }
    />
  );
}


function SoccerOpsGames() {
  const { data, error, reload } = useLoader(fetchSoccerGamesForOps);
  const [season, setSeason] = useState<number | null>(null);
  useEffect(() => {
    if (data) setSeason((s) => s ?? soccerSeasons(data)[0] ?? null);
  }, [data]);
  const seasons = useMemo(() => (data ? soccerSeasons(data) : []), [data]);
  const model = useMemo(
    () => (data && season !== null ? soccerModel(data, season) : null),
    [data, season]
  );
  return (
    <GamesGrid
      loaded={!!data}
      error={error}
      onRetry={reload}
      seasons={seasons}
      season={season}
      onSeason={setSeason}
      model={model}
      emptyLabel="soccer games"
      footnote={
        <>
          Weeks run Wednesday to Tuesday and are derived from the game date (Week 1 starts on the
          Wednesday on or before 1 October), so they match Deputy and the Reporting Soccer Games
          card. Columns are labelled by their week-ending Saturday. A game is worth 0.5 per team side.
          Total Games = (Home + Away) / 2. Location rows plus Mixed add up to Total games.
        </>
      }
    />
  );
}

function GamesGrid({
  loaded,
  error,
  onRetry,
  seasons,
  season,
  onSeason,
  model,
  emptyLabel,
  footnote,
}: {
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  seasons: number[];
  season: number | null;
  onSeason: (s: number) => void;
  model: GridModel | null;
  emptyLabel: string;
  footnote: React.ReactNode;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  const sorted = useMemo(() => {
    if (!model) return [];
    const list = [...model.analysts];
    const m = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "name") return sort.dir === "asc" ? list : list.reverse();
    const val = (a: (typeof list)[number]) =>
      sort.key === "total" ? a.total : a.weekly[Number(sort.key.slice(1))] ?? 0;
    return list.sort(
      (a, b) => m * (val(a) - val(b)) || a.name.localeCompare(b.name)
    );
  }, [model, sort]);

  const range = useMemo(() => {
    const t = sorted.map((a) => a.total);
    return { min: t.length ? Math.min(...t) : 0, max: t.length ? Math.max(...t) : 0 };
  }, [sorted]);

  const toggle = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" }
    );

  const ariaSort = (key: SortKey) =>
    sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none";

  if (error)
    return (
      <div role="alert" style={box}>
        <p style={{ color: THEME.bad }}>Could not load games: {error}</p>
        <button
          onClick={onRetry}
          style={{ marginTop: 8, padding: "4px 12px", border: `1px solid ${THEME.border}`, borderRadius: 4 }}
        >
          Retry
        </button>
      </div>
    );
  if (!loaded) return <div role="status" style={box}>Loading games...</div>;
  if (!model || model.weeks.length === 0)
    return (
      <div style={box}>
        <SeasonSelect seasons={seasons} season={season} onChange={onSeason} />
        <p style={{ marginTop: 12, color: THEME.muted }}>
          No {emptyLabel} for season {season ?? "\u2013"}.
        </p>
      </div>
    );

  const report = model;
  const summary = model.summary;

  const stickyHead = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    ...cellBase,
    position: "sticky",
    top: 0,
    background: THEME.panelSoft,
    color: THEME.muted,
    fontWeight: 600,
    zIndex: 2,
    ...extra,
  });
  const nameCell = (head = false): React.CSSProperties => ({
    ...cellBase,
    textAlign: "left",
    position: "sticky",
    left: 0,
    minWidth: NAME_W,
    background: head ? THEME.panelSoft : THEME.panel,
    zIndex: head ? 3 : 1,
  });

  return (
    <div style={{ padding: 24, color: THEME.text }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginBottom: 12 }}>
        <SeasonSelect seasons={seasons} season={season} onChange={onSeason} />
        <ul aria-label="Colour legend" style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, listStyle: "none", padding: 0, margin: 0 }}>
          {WEEK_BANDS.map((b) => (
            <li key={b.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span aria-hidden style={{ width: 12, height: 12, background: BAND_STYLE[b.key].bg, display: "inline-block", borderRadius: 2 }} />
              {b.key === "blue" ? "Blue" : b.key === "green" ? "Green" : "Amber"}: {b.label} games in a week
            </li>
          ))}
          <li style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span aria-hidden style={{ width: 40, height: 12, display: "inline-block", borderRadius: 2, background: "linear-gradient(to right, hsl(0,65%,35%), hsl(60,65%,35%), hsl(120,65%,30%))" }} />
            Total Games: low to high
          </li>
        </ul>
      </div>

      <div style={{ overflow: "auto", maxHeight: "70vh", border: `1px solid ${THEME.border}`, borderRadius: 6, background: THEME.panel }}>
        <table aria-label="Games completed per analyst per week" style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <caption className="sr-only">
            Games completed per analyst per week for season {report.season}. Each team side counts as half a game.
          </caption>
          <thead>
            <tr>
              <th scope="col" aria-sort={ariaSort("name")} style={{ ...stickyHead(), ...nameCell(true), top: 0 }}>
                <SortBtn k="name" sort={sort} onToggle={toggle}>Name</SortBtn>
              </th>
              <th scope="col" style={stickyHead()}>Home Teams</th>
              <th scope="col" style={stickyHead()}>Away Teams</th>
              <th scope="col" aria-sort={ariaSort("total")} style={stickyHead()}>
                <SortBtn k="total" sort={sort} onToggle={toggle}>Total Games</SortBtn>
              </th>
              {report.weeks.map((w) => {
                const k: SortKey = `w${w.week}`;
                return (
                  <th key={w.week} scope="col" aria-sort={ariaSort(k)} style={stickyHead()}>
                    <SortBtn k={k} sort={sort} onToggle={toggle}>
                      Week {w.week}
                      <br />
                      <span style={{ fontWeight: 400 }}>{w.label}</span>
                    </SortBtn>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.label} style={{ fontWeight: 600 }}>
                <th scope="row" title={s.title} style={nameCell()}>{s.label}</th>
                <td style={cellBase} />
                <td style={cellBase} />
                <td style={cellBase}>{s.total}</td>
                {report.weeks.map((w) => (
                  <td key={w.week} style={cellBase}>{s.vals(w.week)}</td>
                ))}
              </tr>
            ))}
            {sorted.map((a) => {
              const hue = totalScale(a.total, range.min, range.max) * 120;
              return (
                <tr key={a.name}>
                  <th scope="row" style={nameCell()}>{a.name}</th>
                  <td style={cellBase}>{a.home}</td>
                  <td style={cellBase}>{a.away}</td>
                  <td style={{ ...cellBase, background: `hsl(${hue}, 65%, 30%)`, color: "#fff", fontWeight: 600 }}>
                    {fmt(a.total)}
                  </td>
                  {report.weeks.map((w) => {
                    const v = a.weekly[w.week] ?? 0;
                    const band = bandForWeekValue(v);
                    const st = BAND_STYLE[band];
                    return (
                      <td
                        key={w.week}
                        title={band === "none" ? undefined : `${fmt(v)} games (${band})`}
                        style={{ ...cellBase, background: st.bg, color: v === 0 ? THEME.muted : st.fg }}
                      >
                        {v === 0 ? "\u00b7" : fmt(v)}
                        {v === 0 && <span className="sr-only">0</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: THEME.muted }}>
        <p>{footnote}</p>
        {report.excluded.placeholderHalfGames > 0 && (
          <p>
            {fmt(report.excluded.placeholderHalfGames)} game-equivalents allocated
            to ZZ are left out of the analyst rows but included in the summary rows.
          </p>
        )}
        {report.excluded.skippedRows > 0 && (
          <p>{report.excluded.skippedRows} rows without a valid date or week were skipped.</p>
        )}
      </div>
    </div>
  );
}

function SortBtn({
  k,
  sort,
  onToggle,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onToggle: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(k)}
      style={{ font: "inherit", color: "inherit", fontWeight: 600 }}
    >
      {children}
      {sort.key === k ? (sort.dir === "asc" ? " \u25b2" : " \u25bc") : ""}
    </button>
  );
}

function SeasonSelect({
  seasons,
  season,
  onChange,
}: {
  seasons: number[];
  season: number | null;
  onChange: (s: number) => void;
}) {
  return (
    <label style={{ fontSize: 13, color: THEME.muted }}>
      Season{" "}
      <select
        value={season ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ background: THEME.panelSoft, color: THEME.text, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px" }}
      >
        {seasons.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </label>
  );
}
