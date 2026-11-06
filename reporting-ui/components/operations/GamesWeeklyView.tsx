"use client";
import { useEffect, useMemo, useState } from "react";
import { THEME } from "@/lib/theme";
import { fetchTTGamesForOps } from "@/lib/api/ttGames";
import {
  WEEK_BANDS,
  bandForWeekValue,
  buildOpsGamesReport,
  latestSeason,
  seasonsFromGames,
  totalScale,
  type TTGameRow,
  type WeekBand,
} from "@/lib/analytics/opsGames";

type SortKey = "name" | "total" | `w${number}`;

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

export default function GamesWeeklyView() {
  const [rows, setRows] = useState<TTGameRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTTGamesForOps()
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setSeason((s) => s ?? latestSeason(r));
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load games");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const load = () => {
    setRows(null);
    setError(null);
    setAttempt((n) => n + 1);
  };
  const seasons = useMemo(() => (rows ? seasonsFromGames(rows) : []), [rows]);
  const report = useMemo(
    () => (rows && season !== null ? buildOpsGamesReport(rows, season) : null),
    [rows, season]
  );

  const sorted = useMemo(() => {
    if (!report) return [];
    const list = [...report.analysts];
    const m = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "name") return sort.dir === "asc" ? list : list.reverse();
    const val = (a: (typeof list)[number]) =>
      sort.key === "total" ? a.total : a.weekly[Number(sort.key.slice(1))] ?? 0;
    return list.sort(
      (a, b) => m * (val(a) - val(b)) || a.name.localeCompare(b.name)
    );
  }, [report, sort]);

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

  const box = { padding: 24, color: THEME.text };

  if (error)
    return (
      <div role="alert" style={box}>
        <p style={{ color: THEME.bad }}>Could not load games: {error}</p>
        <button
          onClick={load}
          style={{ marginTop: 8, padding: "4px 12px", border: `1px solid ${THEME.border}`, borderRadius: 4 }}
        >
          Retry
        </button>
      </div>
    );
  if (!rows) return <div role="status" style={box}>Loading games...</div>;
  if (!report || report.weeks.length === 0)
    return (
      <div style={box}>
        <SeasonSelect seasons={seasons} season={season} onChange={setSeason} />
        <p style={{ marginTop: 12, color: THEME.muted }}>
          No games for season {season ?? "\u2013"}.
        </p>
      </div>
    );

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

  const summary: { label: string; title?: string; vals: (w: number) => string; total: string }[] = [
    {
      label: "Total games",
      vals: (w) => fmt(report.totalsByWeek[w] ?? 0),
      total: fmt(report.totals.all),
    },
  ];
  const hasAus = report.totals.aus > 0;
  const hasPhl = report.totals.phl > 0;
  if (hasAus)
    summary.push({ label: "AUS", vals: (w) => fmt(report.ausByWeek[w] ?? 0), total: fmt(report.totals.aus) });
  if (hasPhl)
    summary.push({ label: "PHL", vals: (w) => fmt(report.phlByWeek[w] ?? 0), total: fmt(report.totals.phl) });
  if (hasAus)
    summary.push({
      label: "% AUS",
      title: "AUS games as a share of all games that week (every TT game row counts as completed)",
      vals: (w) => pct(report.pctAusByWeek[w] ?? null),
      total: pct(report.totals.pctAus),
    });

  return (
    <div style={{ padding: 24, color: THEME.text }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginBottom: 12 }}>
        <SeasonSelect seasons={seasons} season={season} onChange={setSeason} />
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
        <p>
          Weeks follow the sheet&apos;s Week column and are labelled by their
          week-ending Saturday. A game is worth 0.5 per team side. Total Games = (Home + Away) / 2.
        </p>
        {report.excluded.placeholderHalfGames > 0 && (
          <p>
            {fmt(report.excluded.placeholderHalfGames)} game-equivalents allocated
            to placeholders (Premier Data, ZZ) are left out of the analyst rows
            but included in the summary rows.
          </p>
        )}
        {report.totals.mixedOrOther > 0 && (
          <p>
            {report.totals.mixedOrOther} games with a mixed or unknown location
            count only in Total games.
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


