// Pure formatting + derivation helpers for the Deputy API page.
//
// Kept free of React/Deno imports so they are unit-testable in isolation and
// reusable by the client page. These are intentionally separate from the loose
// `lib/format.ts` helpers (shared, `any`-typed, no null handling) so existing
// callers stay untouched while the Deputy page gets strict, null-safe money /
// hours formatting and the derived estimated-rate math out of JSX.

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/** Format a number as AUD currency; `"-"` for null/undefined/NaN. */
export function formatAud(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return AUD.format(value);
}

/** Format a number of hours to 2dp; `"-"` for null/undefined/NaN. */
export function formatHours2(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

/**
 * Derived estimated hourly rate = cost / totalTime (hours).
 * Returns null unless both are finite numbers and totalTime > 0, so callers
 * can render a dash for missing/zero hours rather than Infinity/NaN.
 */
export function estimatedHourlyRate(
  cost: number | null | undefined,
  totalTime: number | null | undefined
): number | null {
  if (cost == null || !Number.isFinite(cost)) return null;
  if (totalTime == null || !Number.isFinite(totalTime) || totalTime <= 0) {
    return null;
  }
  return cost / totalTime;
}

/** Convenience: estimated hourly rate formatted as AUD, `"-"` when not derivable. */
export function formatRate(
  cost: number | null | undefined,
  totalTime: number | null | undefined
): string {
  return formatAud(estimatedHourlyRate(cost, totalTime));
}
