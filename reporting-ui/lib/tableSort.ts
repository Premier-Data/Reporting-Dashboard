import { useCallback, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
export type SortPrimitive = string | number | null | undefined;
/** An array is compared element by element (primary key first, then tiebreaks). */
export type SortValue = SortPrimitive | readonly SortPrimitive[];

export interface SortColumn<T> {
  value: (row: T) => SortValue;
  /** Direction used the first time the column is clicked. Default "asc" (text). */
  defaultDir?: SortDir;
  /** Compare strings as-is (e.g. ISO dates) instead of natural, case-insensitive. */
  raw?: boolean;
}

export function isBlank(v: SortPrimitive): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return Number.isNaN(v);
  const s = v.trim();
  return s === "" || s === "-" || s === "\u2014" || s === "\u2013";
}

const FINALS_ORDER = ["EF", "QF", "SF", "PF", "GF"];

/**
 * Round sort value: numeric rounds sort numerically; finals (EF, QF, SF, PF,
 * GF) sort after all numeric rounds in finals order; other text sorts after
 * that, naturally.
 */
export function roundSortValue(round: string | number | null | undefined): SortPrimitive {
  if (round === null || round === undefined) return null;
  if (typeof round === "number") return round;
  const s = round.trim();
  if (isBlank(s)) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const i = FINALS_ORDER.indexOf(s.toUpperCase());
  if (i >= 0) return 1_000_000 + i;
  return s;
}

/** Non-blank comparison: numbers numerically (before text); text naturally, case-insensitive. */
export function comparePrimitive(a: string | number, b: string | number, raw = false): number {
  const an = typeof a === "number";
  const bn = typeof b === "number";
  if (an && bn) return a - b;
  if (an) return -1;
  if (bn) return 1;
  if (raw) return a < b ? -1 : a > b ? 1 : 0;
  return (a as string).localeCompare(b as string, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Compare two sort values in the given direction. Blanks always sort last,
 * whatever the direction.
 */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir, raw = false): number {
  const as = Array.isArray(a) ? (a as readonly SortPrimitive[]) : [a as SortPrimitive];
  const bs = Array.isArray(b) ? (b as readonly SortPrimitive[]) : [b as SortPrimitive];
  const sign = dir === "asc" ? 1 : -1;
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    const xb = isBlank(x);
    const yb = isBlank(y);
    if (xb && yb) continue;
    if (xb) return 1;
    if (yb) return -1;
    const c = comparePrimitive(x as string | number, y as string | number, raw);
    if (c !== 0) return sign * c;
  }
  return 0;
}

export interface TableSort<K extends string> {
  key: K;
  dir: SortDir;
  toggle: (key: K) => void;
}

export interface UseTableSortOptions<T, K extends string> {
  columns: Record<K, SortColumn<T>>;
  initialKey: K;
  initialDir: SortDir;
  /** Final ascending tiebreak so order never jumps. Falls back to input order. */
  tiebreak?: (a: T, b: T) => number;
}

export function sortRows<T, K extends string>(
  rows: readonly T[],
  col: SortColumn<T>,
  dir: SortDir,
  tiebreak?: (a: T, b: T) => number
): T[] {
  return rows
    .map((row, index) => ({ row, index, v: col.value(row) }))
    .sort(
      (x, y) =>
        compareValues(x.v, y.v, dir, col.raw) ||
        (tiebreak ? tiebreak(x.row, y.row) : 0) ||
        x.index - y.index
    )
    .map((x) => x.row);
}

export function useTableSort<T, K extends string>(
  rows: readonly T[],
  { columns, initialKey, initialDir, tiebreak }: UseTableSortOptions<T, K>
): { rows: T[]; sort: TableSort<K> } {
  const [state, setState] = useState<{ key: K; dir: SortDir }>({
    key: initialKey,
    dir: initialDir,
  });

  const toggle = useCallback(
    (key: K) => {
      setState((s) =>
        s.key === key
          ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
          : { key, dir: columns[key].defaultDir ?? "asc" }
      );
    },
    [columns]
  );

  const sorted = useMemo(
    () => sortRows(rows, columns[state.key], state.dir, tiebreak),
    [rows, columns, state, tiebreak]
  );

  return { rows: sorted, sort: { key: state.key, dir: state.dir, toggle } };
}
