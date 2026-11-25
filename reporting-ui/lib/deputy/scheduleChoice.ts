// Which Deputy the Schedule page shows. Premier Data is the default. GameFace
// is chosen with ?deputy=gameface and only for users who may open the
// GameFace Deputy page (admin / super_admin).
export type ScheduleDeputy = "premier" | "gameface";

export const GAMEFACE_PAGE_KEY = "gameface-deputy";

export function resolveScheduleDeputy(
  param: string | null | undefined,
  canSeeGameface: boolean
): ScheduleDeputy {
  return param === "gameface" && canSeeGameface ? "gameface" : "premier";
}
