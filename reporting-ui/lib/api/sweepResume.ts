// Pure helpers deciding which grades of a season still need sweeping.
// No React / fetch imports so they are trivially unit-testable.

export type GradeRef = { id: string };

export type CompletionEntry = {
  seasonId: string;
  gradeId: string;
  completedAt?: string | null;
};

/**
 * Grade ids of `seasonId` that FINISHED (non-empty completedAt). A grade that
 * was only touched/partly processed has no completedAt and is not included.
 */
export function completedGradeIds(
  entries: readonly CompletionEntry[],
  seasonId: string
): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.seasonId === seasonId && e.completedAt) out.add(e.gradeId);
  }
  return out;
}

/** Indexes (original order) of grades not in `completed`. Extra ids ignored. */
export function remainingGradeIndexes(
  grades: readonly GradeRef[],
  completed: ReadonlySet<string>
): number[] {
  const out: number[] = [];
  grades.forEach((g, i) => {
    if (!completed.has(g.id)) out.push(i);
  });
  return out;
}

/** First remaining grade index >= fromIndex, or null when none is left. */
export function nextRemainingIndex(
  grades: readonly GradeRef[],
  completed: ReadonlySet<string>,
  fromIndex: number
): number | null {
  for (let i = Math.max(0, fromIndex); i < grades.length; i++) {
    if (!completed.has(grades[i].id)) return i;
  }
  return null;
}

/** e.g. "3 of 10 grades already swept - will continue with the remaining 7". */
export function summarizeResume(total: number, remaining: number): string {
  const swept = total - remaining;
  if (remaining === 0) {
    return `All ${total} grade${total === 1 ? "" : "s"} already swept.`;
  }
  return `${swept} of ${total} grade${total === 1 ? "" : "s"} already swept - will continue with the remaining ${remaining}`;
}
