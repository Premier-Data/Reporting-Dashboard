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

/** A selectable date-range preset for the quick-pick dropdowns. */
export interface RangePreset {
  /** Stable value used as the <option> value and the dropdown's selected key. */
  value: string;
  /** Human label, e.g. "Wed 29 Oct – Tue 4 Nov 2026" or "November 2026". */
  label: string;
  from: string;
  to: string;
}

// Short month names for labels (locale-independent so tests are stable).
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Wed 29 Oct" style label for a Date. */
function shortDayLabel(d: Date): string {
  return `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

/**
 * The Wednesday-starting week containing `today`, plus the prior `count-1`
 * weeks, newest first. Each preset is a Wed→Tue range. value = the week's
 * `from` date (yyyy-mm-dd), so it's stable and easy to match against the
 * current range.
 */
export function recentWeekPresets(count = 26, today = new Date()): RangePreset[] {
  const { from } = currentWeekWedToTue(today);
  // Anchor on the current week's Wednesday (local midnight).
  const anchor = new Date(`${from}T00:00:00`);
  const out: RangePreset[] = [];
  for (let i = 0; i < count; i++) {
    const wFrom = new Date(anchor);
    wFrom.setDate(anchor.getDate() - i * 7);
    const wTo = new Date(wFrom);
    wTo.setDate(wFrom.getDate() + 6);
    const label =
      `${shortDayLabel(wFrom)} – ${shortDayLabel(wTo)} ${wTo.getFullYear()}`;
    out.push({
      value: toLocalISODate(wFrom),
      label,
      from: toLocalISODate(wFrom),
      to: toLocalISODate(wTo),
    });
  }
  return out;
}

/**
 * The calendar month containing `today`, plus the prior `count-1` months,
 * newest first. Each preset spans the 1st to the last day of the month.
 * value = "yyyy-mm".
 */
export function recentMonthPresets(count = 12, today = new Date()): RangePreset[] {
  const out: RangePreset[] = [];
  const y0 = today.getFullYear();
  const m0 = today.getMonth();
  for (let i = 0; i < count; i++) {
    const first = new Date(y0, m0 - i, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const y = first.getFullYear();
    const m = first.getMonth();
    out.push({
      value: `${y}-${String(m + 1).padStart(2, "0")}`,
      label: `${MONTHS[m]} ${y}`,
      from: toLocalISODate(first),
      to: toLocalISODate(last),
    });
  }
  return out;
}
