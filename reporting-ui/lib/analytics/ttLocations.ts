// Pure, data-driven location aggregation for the Reporting > TT Games card
// (Aussie Rules). Every distinct Location value in the rows becomes its own
// category, so locations such as IND are no longer dropped.

export const TT_MIXED_LABEL = "Mixed";
export const TT_UNKNOWN_LABEL = "Unknown";

/**
 * Category for a raw Location value: trimmed, whitespace collapsed, upper-cased.
 * Blank -> "Unknown". Any value naming both AUS and PHL -> "Mixed" (as before).
 */
export function ttLocationLabel(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!s) return TT_UNKNOWN_LABEL;
  if (s.includes("AUS") && s.includes("PHL")) return TT_MIXED_LABEL;
  return s;
}

export type TTLocationInput = { week: string; location: string | null | undefined };

export type TTLocationWeek = {
  week: string;
  counts: Record<string, number>;
  games: number;
};

export type TTLocationReport = {
  /** AUS first, then the rest by total games desc (ties alphabetical). */
  locations: string[];
  weeks: TTLocationWeek[];
  totals: Record<string, number>;
  games: number;
};

/** One count per row, grouped by week and location. Weeks sorted numerically. */
export function aggregateTTLocations(rows: TTLocationInput[]): TTLocationReport {
  const byWeek = new Map<string, TTLocationWeek>();
  const totals: Record<string, number> = {};
  let games = 0;
  for (const r of rows) {
    const weekKey = r.week || "Unknown";
    const loc = ttLocationLabel(r.location);
    let w = byWeek.get(weekKey);
    if (!w) byWeek.set(weekKey, (w = { week: weekKey, counts: {}, games: 0 }));
    w.counts[loc] = (w.counts[loc] ?? 0) + 1;
    w.games += 1;
    totals[loc] = (totals[loc] ?? 0) + 1;
    games += 1;
  }
  const locations = Object.keys(totals).sort((a, b) => {
    if (a === "AUS") return -1;
    if (b === "AUS") return 1;
    return totals[b] - totals[a] || a.localeCompare(b);
  });
  const weeks = [...byWeek.values()].sort((a, b) => Number(a.week) - Number(b.week));
  return { locations, weeks, totals, games };
}

// [top, bottom] gradient colours. AUS / PHL / Mixed keep their original look.
const FIXED_COLOURS: Record<string, [string, string]> = {
  AUS: ["#4ade80", "#16a34a"],
  PHL: ["#fbbf24", "#d97706"],
  [TT_MIXED_LABEL]: ["#a78bfa", "#38bdf8"],
  [TT_UNKNOWN_LABEL]: ["#94a3b8", "#475569"],
};
const PALETTE: [string, string][] = [
  ["#f472b6", "#be185d"],
  ["#60a5fa", "#1d4ed8"],
  ["#2dd4bf", "#0f766e"],
  ["#fb923c", "#c2410c"],
  ["#f87171", "#b91c1c"],
  ["#c084fc", "#7e22ce"],
  ["#a3e635", "#4d7c0f"],
  ["#22d3ee", "#0e7490"],
];

/** Stable [top, bottom] colour pair for a location label (same label, same colour). */
export function ttLocationColours(label: string): [string, string] {
  const fixed = FIXED_COLOURS[label];
  if (fixed) return fixed;
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
