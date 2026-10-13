import type { Instance, MatchStatus } from "@/lib/comparison/xml-compare";
import type { DisputeSide } from "@/lib/api/disputes";

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

// For a missed/extra row the empty cell cannot carry a dispute itself (the
// data model anchors every dispute to an existing instance/side), so its
// flag must attach to the OPPOSING populated instance:
//   - "missed": analyst slot is empty -> anchor to the master instance ("master")
//   - "extra":  master slot is empty  -> anchor to the analyst instance ("analyst")
// Returns null for fully-populated statuses and, defensively, when the
// expected populated side is absent (so the empty cell is never made
// flaggable with a null anchor — honours the "never flag when both sides
// null" guard).
export const emptyCellAnchor = (
  status: MatchStatus,
  sides: { master: Instance | null; analyst: Instance | null }
): { instance: Instance; side: DisputeSide } | null => {
  if (!isEmptySlotStatus(status)) return null;
  if (status === "missed") {
    return sides.master ? { instance: sides.master, side: "master" } : null;
  }
  // status === "extra"
  return sides.analyst ? { instance: sides.analyst, side: "analyst" } : null;
};
