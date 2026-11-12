// Shared date-range labels for "Week N" dropdowns.
//
// Weeks are Wed->Tue blocks defined by the unified season rule (season.ts):
// a week's range is seasonWeekRange(season, week), not derived from row dates.
// Week numbers restart every season, so a range is only produced when the rows
// for that week belong to ONE season; otherwise the plain label is kept.
// A non-integer or < 1 week key falls back to the earliest-latest row date.
//
// All dates are handled as calendar-date strings (YYYY-MM-DD) and formatted
// from their parts, so there is no timezone / DST off-by-one.

import { seasonOfDate, seasonWeekRange } from "./season";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type WeekRange = { start: string; end: string };
export type WeekRow = { week?: unknown; date?: unknown; season?: unknown };

const DAY = 86400000;
const toIso = (d: Date) => d.toISOString().slice(0, 10);

function isoOf(v: unknown): string {
  const s = v == null ? "" : String(v).slice(0, 10);
  return ISO.test(s) ? s : "";
}

function part(iso: string) {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

/** "14 Oct – 20 Oct 2026"; the year is on both ends only when they differ. */
export function formatWeekRange(start: string, end: string): string {
  if (!ISO.test(start) || !ISO.test(end)) return "";
  const a = part(start);
  const b = part(end);
  const fa = `${a.d} ${MONTHS[a.m - 1]}`;
  const fb = `${b.d} ${MONTHS[b.m - 1]}`;
  if (a.y === b.y) return start === end ? `${fb} ${b.y}` : `${fa} – ${fb} ${b.y}`;
  return `${fa} ${a.y} – ${fb} ${b.y}`;
}

/** "Week 3 · 14 Oct – 20 Oct 2026"; falls back to `base` when there is no range. */
export function weekOptionLabel(base: string, range?: WeekRange | null): string {
  const r = range ? formatWeekRange(range.start, range.end) : "";
  return r ? `${base} · ${r}` : base;
}

/**
 * Date range per week key (String(week).trim()). Integer week >= 1 within a single
 * season uses that season's Wed→Tue definition; other keys use
 * the earliest/latest row date. Weeks spanning several seasons, or with no
 * usable dates, are omitted (caller falls back to the plain label).
 * A row's season is its own `season` if numeric, else derived from its date.
 */
export function buildWeekRanges(rows: Iterable<WeekRow>): Map<string, WeekRange> {
  const byWeek = new Map<string, { seasons: Set<number>; dates: string[] }>();
  for (const r of rows) {
    const key = String(r.week ?? "").trim();
    if (!key) continue;
    const iso = isoOf(r.date);
    let season = Number(r.season);
    if (r.season == null || r.season === "" || !Number.isFinite(season)) {
      season = iso ? seasonOfDate(new Date(`${iso}T00:00:00Z`)) : NaN;
    }
    const e = byWeek.get(key) ?? { seasons: new Set<number>(), dates: [] };
    if (Number.isFinite(season)) e.seasons.add(season);
    if (iso) e.dates.push(iso);
    byWeek.set(key, e);
  }

  const out = new Map<string, WeekRange>();
  for (const [key, e] of byWeek) {
    if (e.seasons.size > 1) continue;
    if (e.dates.length === 0) continue;
    const w = Number(key);
    if (Number.isInteger(w) && w >= 1) {
      const [season] = [...e.seasons];
      if (season === undefined) continue;
      const r = seasonWeekRange(season, w);
      out.set(key, { start: toIso(r.start), end: toIso(r.end) });
    } else {
      // Unexpected stored data (non-integer / < 1): earliest to latest row date.
      const sorted = [...e.dates].sort();
      out.set(key, { start: sorted[0], end: sorted[sorted.length - 1] });
    }
  }
  return out;
}
