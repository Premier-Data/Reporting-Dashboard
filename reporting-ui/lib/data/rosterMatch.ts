/*
 * ROSTER MATCH KEYS (pure)
 *
 * Roster rows from the Deputy API carry the employee's legal name but NO email
 * (deputy.employees.email is empty), while the AutoDownload analysts carry an
 * email and a display name that can differ slightly from the legal name. So a
 * roster row is indexed by its email when it has one (legacy rows), otherwise by
 * its normalised name, and an analyst is looked up by each of its candidate
 * keys: email, name, then a small alias of the name.
 */

/** Known nickname -> legal-name differences (both sides normalised). */
export const ROSTER_NAME_ALIASES: Record<string, string> = {
  "tom winneke": "thomas winneke",
};

/**
 * Trim, lowercase, drop parenthetical suffixes such as "(NEW)" and collapse
 * whitespace.
 */
export function normaliseIdentifier(
  value: string | null | undefined
): string {
  return String(value ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Key a roster row is indexed under: normalised email, else normalised name. */
export function rosterIndexKey(
  email: string | null | undefined,
  name: string | null | undefined
): string {
  return normaliseIdentifier(email) || normaliseIdentifier(name);
}

/**
 * Ordered, de-duplicated candidate keys for an analyst:
 * [email, name, alias(name)] with empties removed.
 */
export function analystRosterKeys(
  email: string | null | undefined,
  name: string | null | undefined
): string[] {
  const emailKey = normaliseIdentifier(email);
  const nameKey = normaliseIdentifier(name);
  const alias = nameKey ? ROSTER_NAME_ALIASES[nameKey] : undefined;
  const keys: string[] = [];
  for (const k of [emailKey, nameKey, alias ?? ""]) {
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * Shifts for an analyst on a day from a map keyed `${rosterIndexKey}|${date}`,
 * merging every candidate key.
 */
export function shiftsForAnalystDay<T>(
  map: Map<string, T[]>,
  email: string | null | undefined,
  name: string | null | undefined,
  dayKey: string
): T[] {
  const out: T[] = [];
  for (const k of analystRosterKeys(email, name)) {
    const found = map.get(`${k}|${dayKey}`);
    if (found) out.push(...found);
  }
  return out;
}
