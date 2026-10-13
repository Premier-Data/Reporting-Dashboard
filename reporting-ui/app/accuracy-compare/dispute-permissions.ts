import type { MatchStatus } from "@/lib/comparison/xml-compare";

// An empty-slot row has exactly one populated side: "missed" (master instance,
// empty analyst slot) or "extra" (analyst instance, empty master slot). The
// four fully-populated statuses (exact / wrong_stat / wrong_player /
// wrong_team) always have both sides populated.
export const isEmptySlotStatus = (status: MatchStatus): boolean =>
  status === "missed" || status === "extra";

// Who may FLAG (raise a dispute on) a given comparison row:
//   - the allocated analyst may flag ANY row (the existing gate), OR
//   - any logged-in user viewing a loaded check may flag an empty-slot
//     (missed/extra) row — the dispute attaches to the single populated side.
// Fully-populated rows stay allocated-analyst-only. Resolving disputes is a
// separate admin/super_admin gate and is not covered by this predicate.
export const canFlagRowPure = (
  status: MatchStatus,
  ctx: { isAllocated: boolean; isLoggedIn: boolean; hasCheck: boolean }
): boolean =>
  ctx.isAllocated ||
  (ctx.isLoggedIn && ctx.hasCheck && isEmptySlotStatus(status));
