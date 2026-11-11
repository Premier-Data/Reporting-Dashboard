// Employee name aliases: Deputy API name -> the name used in TT_Games
// allocations / analysts (lowercase key, whitespace-collapsed).
//
// Why: the Excel shifts and TT_Games call this analyst "Jimmy New Dwyer", but
// Deputy has "Jimmy Dwyer". Without this entry his games would not link to his
// hours. EDIT OR REMOVE the entry if you prefer to rename the TT_Games
// allocation to "Jimmy Dwyer" instead.
export const EMPLOYEE_ALIASES: Record<string, string> = {
  "jimmy dwyer": "Jimmy New Dwyer",
};

/** Applies the alias map (case-insensitive) to an already-normalised name. */
export function applyEmployeeAlias(name: string): string {
  return EMPLOYEE_ALIASES[name.toLowerCase()] ?? name;
}
