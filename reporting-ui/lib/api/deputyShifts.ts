// Shared data layer for ALL Deputy shift data in the app.
//
// Everything here comes from the live Deputy API (the private `deputy` schema):
//   * Aggregate path (no names): the owner-rights view public.weekly_report_shifts
//     (migration 007), used by the Weekly Report.
//   * Employee-level path (names + cost): the deputy-read edge function via
//     lib/api/deputy.ts, shaped here into the legacy shift row shape.
//   * Rosters: deputy-read?dataset=rosters with a derived week + season.
// No function falls back to any other source. Failures throw DeputyShiftsError;
// an empty array always means "no data", never "failed".
import { supabase } from "@/lib/supabase";
import {
  getDeputyRosters,
  getDeputyTimesheets,
  type DeputyTimesheetRow,
} from "@/lib/api/deputy";
import { mapApiRosters, sydneyTimeOfDay } from "@/lib/data/deputyApiRoster";
import type { DeputyRoster } from "@/types/deputyRoster";
import {
  DEPUTY_REPORT_START_DATE,
  deputySeasonOf,
  deputySeasonWindows,
  deputyWeekOf,
  toAreaName,
} from "@/lib/deputy/reportWeeks";
import { applyEmployeeAlias } from "@/lib/deputy/employeeAliases";

const VIEW = "weekly_report_shifts";
const AREA_MAP_TABLE = "deputy_area_map";
const PAGE = 1000;
/** deputy-read stops at this many rows; reaching it means the result may be cut off. */
const DEPUTY_READ_CEILING = 20000;
const CACHE_MS = 60_000;
const SYNC_TIMEOUT_MS = 20_000;
export const UNKNOWN_EMPLOYEE = "Unknown";

export type DeputyShiftsErrorCode =
  | "http"
  | "network"
  | "truncated"
  | "stale_view"
  | "area_map"
  | "bad_data";

export class DeputyShiftsError extends Error {
  code: DeputyShiftsErrorCode;
  constructor(code: DeputyShiftsErrorCode, message: string) {
    super(message);
    this.name = "DeputyShiftsError";
    this.code = code;
  }
}

/** Legacy shift row shape, API-sourced (employee-level). */
export interface DeputyShiftRow {
  shift_key: string; // "api_<deputy_id>"
  employee_name: string; // "Unknown" when unresolved
  shift_date: string; // yyyy-mm-dd
  start_time: string | null; // Sydney HH:mm:ss
  end_time: string | null;
  meal_break: number | null; // mealbreak_minutes
  total_hours: number;
  total_cost: number; // Deputy `cost` (not on_cost)
  hourly_rate: number | null; // derived: cost / hours
  area_name: string;
  day_name: string;
  month_name: string;
  week: number;
  season: number;
  // Not available from the Deputy API; kept null so the row shape is stable.
  level: null;
  employee_comment: null;
  comment: null;
  source: "deputy-api";
}

/** Name-free row from the weekly_report_shifts view. */
export interface DeputyShiftAggregateRow {
  shift_key: string;
  shift_date: string;
  area_name: string;
  total_hours: number;
  total_cost: number;
  week: number;
  season: number;
  source: "deputy-api";
}

export type DeputyRosterWithSeason = DeputyRoster & { season: number };

// ── helpers ───────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Sydney calendar date (yyyy-mm-dd) of `now`. */
export function sydneyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Employee name rule: trim and collapse whitespace; empty or all-digit values
 * (deputy-read falls back to the raw Deputy id) are unresolved => "Unknown".
 * Known Deputy->TT_Games spelling differences are mapped in employeeAliases.ts.
 */
export function normaliseEmployeeName(raw: unknown): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s || /^\d+$/.test(s)) return UNKNOWN_EMPLOYEE;
  return applyEmployeeAlias(s);
}

/** Rows for analyst-level views: drops unresolved employees. Returns a new array. */
export function analystShifts<T extends { employee_name: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.employee_name !== UNKNOWN_EMPLOYEE);
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toDeputyShiftsError(e: unknown): DeputyShiftsError {
  if (e instanceof DeputyShiftsError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("no rows array")) return new DeputyShiftsError("bad_data", message);
  if (/ failed: \d+/.test(message)) return new DeputyShiftsError("http", message);
  return new DeputyShiftsError("network", message);
}

/** Logs once at the layer boundary (never row data or names) and returns the error. */
function fail(e: unknown): DeputyShiftsError {
  const err = toDeputyShiftsError(e);
  console.error("deputyShifts:", err.code, err.message);
  return err;
}

/** Maps one approved timesheet to the legacy shift row; null when it has no valid date. */
export function mapTimesheetToShift(
  t: DeputyTimesheetRow,
  areaMap: Map<string, string>
): DeputyShiftRow | null {
  const date = t.timesheet_date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hours = num(t.total_time);
  const cost = num(t.cost);
  const dt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return {
    shift_key: `api_${t.deputy_id}`,
    employee_name: normaliseEmployeeName(t.employee_name),
    shift_date: date,
    start_time: sydneyTimeOfDay(t.start_at),
    end_time: sydneyTimeOfDay(t.end_at),
    meal_break: t.mealbreak_minutes == null ? null : num(t.mealbreak_minutes),
    total_hours: hours,
    total_cost: cost,
    hourly_rate: hours > 0 ? cost / hours : null,
    area_name: toAreaName(t.operational_unit_name, areaMap),
    day_name: DAY_NAMES[dt.getUTCDay()],
    month_name: MONTH_NAMES[dt.getUTCMonth()],
    week: deputyWeekOf(date),
    season: deputySeasonOf(date),
    level: null,
    employee_comment: null,
    comment: null,
    source: "deputy-api",
  };
}

// ── cache: 60 s memo, in-flight sharing, failures never cached ───────────────

interface Cached<T> {
  get(force?: boolean): Promise<T[]>;
  clear(): void;
}

function makeCache<T>(load: () => Promise<T[]>): Cached<T> {
  let value: T[] | null = null;
  let at = 0;
  let inflight: Promise<T[]> | null = null;
  return {
    async get(force = false) {
      if (!force && value && Date.now() - at < CACHE_MS) return value.slice();
      if (!inflight) {
        inflight = load()
          .then((rows) => {
            value = rows;
            at = Date.now();
            return rows;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return (await inflight).slice();
    },
    clear() {
      value = null;
      at = 0;
      inflight = null;
    },
  };
}

// ── best-effort sync (once per page load) ────────────────────────────────────

let syncPromise: Promise<void> | null = null;

/**
 * Asks deputy-read to pull the latest timesheets from Deputy (throttled
 * server-side). Best effort: never rejects, runs once per page load.
 */
export function ensureDeputySynced(): Promise<void> {
  if (!syncPromise) {
    const today = sydneyToday();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = getDeputyTimesheets({ sync: true, from: today, to: today })
      .then(() => undefined)
      .catch((e) => {
        console.warn("deputyShifts: sync skipped", toDeputyShiftsError(e).code);
      });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn("deputyShifts: sync skipped", "timeout");
        resolve();
      }, SYNC_TIMEOUT_MS);
    });
    syncPromise = Promise.race([sync, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
  return syncPromise;
}

// ── area map ──────────────────────────────────────────────────────────────────

async function loadAreaMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(AREA_MAP_TABLE)
      .select("unit_name, area_name")
      .order("unit_name", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new DeputyShiftsError("area_map", error.message || "area map read failed");
    const page = (data ?? []) as Array<{ unit_name: string; area_name: string }>;
    for (const r of page) map.set(String(r.unit_name).trim(), String(r.area_name));
    if (page.length < PAGE) return map;
  }
}

// ── employee-level shifts (D) ─────────────────────────────────────────────────

async function loadShifts(): Promise<DeputyShiftRow[]> {
  try {
    await ensureDeputySynced();
    const windows = deputySeasonWindows(sydneyToday());
    const [areaMap, ...perWindow] = await Promise.all([
      loadAreaMap(),
      ...windows.map((w) => getDeputyTimesheets({ from: w.from, to: w.to, strict: true })),
    ]);
    const out: DeputyShiftRow[] = [];
    for (const rows of perWindow) {
      if (rows.length >= DEPUTY_READ_CEILING) {
        throw new DeputyShiftsError(
          "truncated",
          `deputy-read returned ${rows.length} timesheets for one season window (ceiling ${DEPUTY_READ_CEILING})`
        );
      }
      for (const t of rows) {
        if (!t.timesheet_date || t.timesheet_date < DEPUTY_REPORT_START_DATE) continue;
        const mapped = mapTimesheetToShift(t, areaMap);
        if (mapped) out.push(mapped);
      }
    }
    return out.sort(
      (a, b) => a.shift_date.localeCompare(b.shift_date) || a.shift_key.localeCompare(b.shift_key)
    );
  } catch (e) {
    throw fail(e);
  }
}

const shiftsCache = makeCache<DeputyShiftRow>(loadShifts);

/** All approved Deputy API shifts since 2026-01-01 with names, in the legacy row shape. */
export function getDeputyShifts(opts?: { force?: boolean }): Promise<DeputyShiftRow[]> {
  return shiftsCache.get(opts?.force);
}

// ── aggregates (V) ────────────────────────────────────────────────────────────

async function loadAggregates(): Promise<DeputyShiftAggregateRow[]> {
  try {
    await ensureDeputySynced();
    const out: DeputyShiftAggregateRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(VIEW)
        .select("shift_key, shift_date, area_name, total_hours, total_cost, week, season, source")
        .order("shift_date", { ascending: true })
        .order("shift_key", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new DeputyShiftsError("http", error.message || "weekly_report_shifts read failed");
      if (!Array.isArray(data)) throw new DeputyShiftsError("bad_data", "weekly_report_shifts page is not an array");
      for (const r of data as Array<Record<string, unknown>>) {
        if (r.source !== "deputy-api") {
          throw new DeputyShiftsError(
            "stale_view",
            "weekly_report_shifts is not API-only yet: run migration 007_deputy_api_shifts_all_seasons.sql"
          );
        }
        out.push({
          shift_key: String(r.shift_key),
          shift_date: String(r.shift_date),
          area_name: String(r.area_name),
          total_hours: num(r.total_hours),
          total_cost: num(r.total_cost),
          week: num(r.week),
          season: num(r.season),
          source: "deputy-api",
        });
      }
      if (data.length < PAGE) return out;
    }
  } catch (e) {
    throw fail(e);
  }
}

const aggregatesCache = makeCache<DeputyShiftAggregateRow>(loadAggregates);

/** Name-free API shift rows (from the view) for the Weekly Report. */
export function getDeputyShiftAggregates(opts?: { force?: boolean }): Promise<DeputyShiftAggregateRow[]> {
  return aggregatesCache.get(opts?.force);
}

// ── rosters (R) ───────────────────────────────────────────────────────────────

async function loadRosters(): Promise<DeputyRosterWithSeason[]> {
  try {
    const rows = await getDeputyRosters({ from: DEPUTY_REPORT_START_DATE, strict: true });
    if (rows.length >= DEPUTY_READ_CEILING) {
      throw new DeputyShiftsError("truncated", `deputy-read returned ${rows.length} rosters (ceiling ${DEPUTY_READ_CEILING})`);
    }
    const out: DeputyRosterWithSeason[] = [];
    for (const r of mapApiRosters(rows, { startDate: DEPUTY_REPORT_START_DATE })) {
      const name = normaliseEmployeeName(r.employee_name);
      if (name === UNKNOWN_EMPLOYEE) continue;
      out.push({
        ...r,
        employee_name: name,
        week: deputyWeekOf(r.shift_date),
        season: deputySeasonOf(r.shift_date),
      });
    }
    return out;
  } catch (e) {
    throw fail(e);
  }
}

const rostersCache = makeCache<DeputyRosterWithSeason>(loadRosters);

/**
 * Published Deputy API rosters since 2026-01-01 with week + season derived from
 * the date. area_name is deliberately the raw Deputy unit name (not mapped via
 * deputy_area_map): Recommendations does not read it.
 */
export function getDeputyRostersWithWeek(opts?: { force?: boolean }): Promise<DeputyRosterWithSeason[]> {
  return rostersCache.get(opts?.force);
}

// ── names (N) ─────────────────────────────────────────────────────────────────

/** Distinct, sorted analyst names seen in approved Deputy timesheets (excludes "Unknown"). */
export async function getDeputyShiftEmployeeNames(): Promise<string[]> {
  const rows = await getDeputyShifts();
  const set = new Set<string>();
  for (const r of analystShifts(rows)) set.add(r.employee_name);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Test helper: resets every cache and the once-per-page sync. */
export function clearDeputyShiftsCache(): void {
  shiftsCache.clear();
  aggregatesCache.clear();
  rostersCache.clear();
  syncPromise = null;
}
