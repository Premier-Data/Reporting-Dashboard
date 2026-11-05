// Pure date helpers shared by the Deputy pages (API + Insights).
//
// Kept free of React/Deno imports so they are unit-testable in isolation and
// reusable across pages. The "current week Wed→Tue" default is defined once
// here so both Deputy pages stay in lockstep.

/**
 * Local "yyyy-mm-dd" for a Date (not toISOString, which is UTC and can shift
 * the day across the AU timezone boundary).
 */
export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The current week, running Wednesday -> Tuesday, as { from, to } local ISO
 * dates. "Today" is included: if today is Wednesday the week starts today; if
 * today is Tuesday the week started the previous Wednesday.
 */
export function currentWeekWedToTue(today = new Date()): {
  from: string;
  to: string;
} {
  // JS getDay(): Sun=0 .. Sat=6; Wednesday=3. Days since the most recent Wed.
  const since = (today.getDay() - 3 + 7) % 7;
  const from = new Date(today);
  from.setDate(today.getDate() - since);
  const to = new Date(from);
  to.setDate(from.getDate() + 6);
  return { from: toLocalISODate(from), to: toLocalISODate(to) };
}
