// Club logo resolution for the Live Scores cards.
//
// PlayHQ's APIs don't expose club crests in any reachable, supported call (the
// logos load via an internal GraphQL op on playhq.com), so we host them
// ourselves under public/clubs/ and map by a normalised team name. A club with
// no mapped file falls back to an initials badge, so the UI always looks right
// and new clubs can be added incrementally by dropping a file in and adding a
// line to CLUB_LOGO_FILES.
//
// To add a club:
//   1. Save its logo to reporting-ui/public/clubs/<file>.png
//   2. Add an entry below keyed by the normalised club name (see normaliseClub).

// Normalise a team name to a stable key: lowercase, strip the grade suffix
// ("Men Premier", "Women Premier", "Seniors", etc.), collapse whitespace, drop
// punctuation. So "St Mary's Men Premier" and "St Marys Seniors" → "st marys".
export function normaliseClub(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\u2019/g, "'") // curly → straight apostrophe
    .replace(/\b(men|women|mens|womens)\b/g, "")
    .replace(/\b(premier|premier league|seniors|senior|reserves|reserve|a[-\s]?grade|division \d+|div \d+)\b/g, "")
    .replace(/[^a-z0-9 ]/g, "") // drop punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// Normalised club key → logo file under public/clubs/. Seeded with the two
// clubs confirmed from PlayHQ; extend as you add more logos.
const CLUB_LOGO_FILES: Record<string, string> = {
  "palmerston magpies": "palmerston-magpies.png",
  waratah: "waratah.png",
  // Add more, e.g.:
  // "nightcliff tigers": "nightcliff-tigers.png",
  // "st marys": "st-marys.png",
};

/** Local logo path for a team name, or null when the club isn't mapped yet. */
export function clubLogo(name: string | null | undefined): string | null {
  const key = normaliseClub(name);
  const file = CLUB_LOGO_FILES[key];
  return file ? `/clubs/${file}` : null;
}

/** Up to two initials from a club name, for the fallback badge. */
export function clubInitials(name: string | null | undefined): string {
  const clean = normaliseClub(name);
  if (!clean) return "?";
  const words = clean.split(" ").filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// A deterministic background colour for the initials badge, derived from the
// club name so each club gets a consistent colour.
const BADGE_COLORS = [
  "#0ea5e9", "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e",
  "#f97316", "#eab308", "#22c55e", "#14b8a6", "#64748b",
];
export function clubBadgeColor(name: string | null | undefined): string {
  const key = normaliseClub(name) || "?";
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return BADGE_COLORS[h % BADGE_COLORS.length];
}
