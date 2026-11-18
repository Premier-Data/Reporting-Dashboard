// "Check type" filter for the Disputes page (Specific stats / Full game /
// Golden / Other). Reuses the Dashboard's category -> group mapping so the two
// never drift. Not to be confused with the dispute FLAG category filter.

import { CHECK_GROUP_LABELS, groupOfCategory, type CheckGroup } from "@/lib/analytics/disputeDashboard";

export type CheckTypeFilter = CheckGroup;

/** Dropdown order. "other" = null/unknown category. */
export const CHECK_TYPE_ORDER: readonly CheckTypeFilter[] = ["specific", "full", "golden", "other"];

export function checkTypeLabel(g: CheckTypeFilter): string {
  return g === "other" ? "Uncategorised" : CHECK_GROUP_LABELS[g];
}

/** True when a check with this category passes the filter. */
export function matchesCheckType(
  category: string | null | undefined,
  filter: CheckTypeFilter
): boolean {
  return filter === "all" || groupOfCategory(category) === filter;
}

/** Counts per group of the given items (category looked up per item). */
export function countByCheckType<T>(
  items: readonly T[],
  categoryOf: (item: T) => string | null | undefined
): Record<CheckTypeFilter, number> {
  const out: Record<CheckTypeFilter, number> = { all: 0, specific: 0, full: 0, golden: 0, other: 0 };
  for (const it of items) {
    out.all += 1;
    out[groupOfCategory(categoryOf(it))] += 1;
  }
  return out;
}
