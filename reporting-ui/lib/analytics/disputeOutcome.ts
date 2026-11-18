// Shared dispute outcome classification, used by the per-check Excel export
// and the Disputes dashboard so both count "Analyst Correct" identically.
//
//   confirmed -> the supervisor upheld the analyst's dispute (Analyst Correct)
//   denied    -> the supervisor rejected it (Master Correct)
//   open      -> not resolved yet; excluded from every percentage denominator

export type OutcomeStatus = "open" | "confirmed" | "denied";

export interface OutcomeTally {
  total: number;
  resolved: number;
  open: number;
  analystCorrect: number;
  masterCorrect: number;
}

export function emptyTally(): OutcomeTally {
  return { total: 0, resolved: 0, open: 0, analystCorrect: 0, masterCorrect: 0 };
}

/** Add one dispute status to a tally (mutates and returns it). */
export function addToTally(t: OutcomeTally, status: OutcomeStatus): OutcomeTally {
  t.total += 1;
  if (status === "open") t.open += 1;
  else t.resolved += 1;
  if (status === "confirmed") t.analystCorrect += 1;
  else if (status === "denied") t.masterCorrect += 1;
  return t;
}

export function tallyStatuses(statuses: Iterable<OutcomeStatus>): OutcomeTally {
  const t = emptyTally();
  for (const s of statuses) addToTally(t, s);
  return t;
}

/** count / resolved as a 0..1 fraction, or null when nothing is resolved. */
export function resolvedFraction(count: number, resolved: number): number | null {
  return resolved > 0 ? count / resolved : null;
}

/** Whole-percent text ("23%") or "n/a" for a null fraction. */
export function percentText(fraction: number | null): string {
  return fraction == null ? "n/a" : `${Math.round(fraction * 100)}%`;
}
