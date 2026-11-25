"use client";
// Per-fixture list for the Operations > Games > Soccer view: the added date
// (SoccerData column A) next to the completed date (SoccerData last column). Collapsed by default so the weekly grid stays the focus and
// the rows only render when opened.
import { useMemo, useState } from "react";
import { THEME } from "@/lib/theme";
import SortableTh from "@/components/UI/SortableTh";
import { useTableSort, type SortColumn } from "@/lib/tableSort";
import type { SoccerGameRow } from "@/lib/analytics/opsSoccer";
import { soccerSeasonFor, soccerWeekFor } from "@/lib/analytics/soccerWeeks";
import { seasonWeekRangeIso, weekOptionLabel } from "@/lib/analytics/weekLabels";
import { completedSeasonWeek, isoToDmy } from "@/lib/analytics/soccerCompleted";

type Fixture = {
  key: string;
  putIn: string | null;
  putInWeek: number | null;
  completed: string | null;
  /** Completed week, only when it falls in the selected season. */
  completedWeek: number | null;
  competition: string;
  home: string;
  away: string;
};

type Key = "putIn" | "completed" | "competition" | "home" | "away";
type Status = "all" | "completed" | "not";
type WeekBasis = "putIn" | "completed";

const COLUMNS: Record<Key, SortColumn<Fixture>> = {
  putIn: { value: (f) => f.putIn, raw: true, defaultDir: "desc" },
  completed: { value: (f) => f.completed, raw: true, defaultDir: "desc" },
  competition: { value: (f) => f.competition },
  home: { value: (f) => f.home },
  away: { value: (f) => f.away },
};
const tiebreak = (a: Fixture, b: Fixture) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const cell = { padding: "4px 8px", borderBottom: `1px solid ${THEME.border}`, whiteSpace: "nowrap" as const };
const thCls = "px-2 py-1 text-left text-xs font-semibold";
const selectStyle = {
  background: THEME.panelSoft,
  color: THEME.text,
  border: `1px solid ${THEME.border}`,
  borderRadius: 4,
  padding: "2px 6px",
};

export default function SoccerFixturesTable({
  rows,
  season,
}: {
  rows: SoccerGameRow[];
  season: number;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("all");
  const [week, setWeek] = useState<string>("all");
  const [basis, setBasis] = useState<WeekBasis>("putIn");

  // A fixture belongs here when it was added OR completed in this season.
  const fixtures = useMemo(() => {
    const out: Fixture[] = [];
    for (const r of rows) {
      const done = completedSeasonWeek(r);
      const inSeason = soccerSeasonFor(r) === season;
      const doneInSeason = done?.season === season;
      if (!inSeason && !doneInSeason) continue;
      out.push({
        key: r.game_key,
        putIn: r.Date?.slice(0, 10) ?? null,
        putInWeek: inSeason ? soccerWeekFor(r) : null,
        completed: r.completed_date?.slice(0, 10) || null,
        completedWeek: doneInSeason ? done!.week : null,
        competition: r.Competition?.trim() ?? "",
        home: r.home_team?.trim() ?? "",
        away: r.away_team?.trim() ?? "",
      });
    }
    return out;
  }, [rows, season]);

  const weeks = useMemo(() => {
    const set = new Set<number>();
    for (const f of fixtures) {
      const w = basis === "putIn" ? f.putInWeek : f.completedWeek;
      if (w !== null) set.add(w);
    }
    return [...set].sort((a, b) => a - b);
  }, [fixtures, basis]);

  const filtered = useMemo(
    () =>
      fixtures.filter((f) => {
        if (status === "completed" && !f.completed) return false;
        if (status === "not" && f.completed) return false;
        if (week !== "all") {
          const w = basis === "putIn" ? f.putInWeek : f.completedWeek;
          if (w !== Number(week)) return false;
        }
        return true;
      }),
    [fixtures, status, week, basis]
  );

  const { rows: sorted, sort } = useTableSort<Fixture, Key>(filtered, {
    columns: COLUMNS,
    initialKey: "putIn",
    initialDir: "desc",
    tiebreak,
  });

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{ marginTop: 16 }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Fixtures: added and completed dates ({fixtures.length})
      </summary>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 13, color: THEME.muted, marginBottom: 8 }}>
            <label>
              Status{" "}
              <select value={status} onChange={(e) => setStatus(e.target.value as Status)} style={selectStyle}>
                <option value="all">All</option>
                <option value="completed">Completed</option>
                <option value="not">Not completed</option>
              </select>
            </label>
            <label>
              Week{" "}
              <select value={week} onChange={(e) => setWeek(e.target.value)} style={selectStyle}>
                <option value="all">All weeks</option>
                {weeks.map((w) => (
                  <option key={w} value={w}>
                    {weekOptionLabel(`Week ${w}`, seasonWeekRangeIso(season, w))}
                  </option>
                ))}
              </select>
            </label>
            <label title="Which date the Week filter uses">
              Week by{" "}
              <select value={basis} onChange={(e) => {
                  setBasis(e.target.value as WeekBasis);
                  setWeek("all");
                }} style={selectStyle}>
                <option value="putIn">Added date</option>
                <option value="completed">Completed date</option>
              </select>
            </label>
            <span aria-live="polite">{sorted.length} fixtures</span>
          </div>
          <div style={{ overflow: "auto", maxHeight: "50vh", border: `1px solid ${THEME.border}`, borderRadius: 6, background: THEME.panel }}>
            <table aria-label="Soccer fixtures with added and completed dates" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead style={{ position: "sticky", top: 0, background: THEME.panelSoft, color: THEME.muted }}>
                <tr>
                  <SortableTh sort={sort} sortKey="putIn" className={thCls}>
                    <span title="Date the fixture was added (SoccerData column A)">Added</span>
                  </SortableTh>
                  <SortableTh sort={sort} sortKey="completed" className={thCls}>
                    <span title="Completion date from the last column of the SoccerData sheet (older fixtures: Completion Times sheet). A dash means not completed.">
                      Completed
                    </span>
                  </SortableTh>
                  <SortableTh sort={sort} sortKey="competition" className={thCls}>Competition</SortableTh>
                  <SortableTh sort={sort} sortKey="home" className={thCls}>Home</SortableTh>
                  <SortableTh sort={sort} sortKey="away" className={thCls}>Away</SortableTh>
                </tr>
              </thead>
              <tbody>
                {sorted.map((f) => (
                  <tr key={f.key}>
                    <td style={cell}>{isoToDmy(f.putIn)}</td>
                    <td style={{ ...cell, color: f.completed ? THEME.text : THEME.muted }}>{isoToDmy(f.completed)}</td>
                    <td style={cell}>{f.competition || "\u2013"}</td>
                    <td style={cell}>{f.home || "\u2013"}</td>
                    <td style={cell}>{f.away || "\u2013"}</td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ ...cell, textAlign: "center", color: THEME.muted }}>
                      No fixtures match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </details>
  );
}
