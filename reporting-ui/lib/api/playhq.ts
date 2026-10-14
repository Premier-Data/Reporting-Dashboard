// PlayHQ live scores / fixtures — read through OUR Cloudflare Worker, never
// PlayHQ directly. The Worker holds the API key as a secret and adds an edge
// cache, so the browser only ever talks to our own domain.
//
// Set the Worker base URL via NEXT_PUBLIC_PLAYHQ_WORKER_URL (e.g.
// "https://scores.yourdomain.com.au" or the *.workers.dev URL). Falls back to
// the workers.dev default below so the feature works before a custom domain is
// wired up.

const WORKER_BASE =
  process.env.NEXT_PUBLIC_PLAYHQ_WORKER_URL?.replace(/\/$/, "") ||
  "https://playhq-scores.premier-data-enterprise.workers.dev";

// NTFL Premier grades — fixed per competition. Pass a grade id to
// getGradeGames(); the Worker handles any grade generically.
export const NTFL_PREMIER_MENS_GRADE = "be950883-7630-4df5-81e4-a5bba0f24cb6";
export const NTFL_PREMIER_WOMENS_GRADE = "61ca876d-f028-4f60-ad85-33e8fb2e5be7";

// The competitions shown on the Live Scores tab (label + grade id).
export const LIVE_SCORE_GRADES = [
  { key: "ntfl-mens", label: "NTFL Men's", gradeId: NTFL_PREMIER_MENS_GRADE },
  { key: "ntfl-womens", label: "NTFL Women's", gradeId: NTFL_PREMIER_WOMENS_GRADE },
  { key: "efnl", label: "EFNL Premier", gradeId: "6f964e7b-a56f-471e-9d9d-30e1f80da8d1" },
  { key: "gvl", label: "GVL Seniors", gradeId: "6c2c7212-d1b7-48bb-acee-0fd75ce1984f" },
  { key: "pfl", label: "PFL A-Grade", gradeId: "7540fef1-7fad-4375-8502-b95c09ae6105" },
] as const;

export type LiveScoreGradeKey = (typeof LIVE_SCORE_GRADES)[number]["key"];

// ── Types (mirrors the PlayHQ REST game shape the Worker passes through) ──────

export type GameStatus =
  | "UPCOMING"
  | "IN_PROGRESS"
  | "FINAL"
  | "ABANDONED"
  | "POSTPONED"
  | "CANCELLED"
  | string;

export type ScoreSubTotal = { type: string; value: number };

export type Competitor = {
  id: string;
  name: string;
  isHomeTeam: boolean;
  outcome: string | null; // WON / LOST / DRAW / null
  scoreTotal: number | null;
  scoreSubTotal: ScoreSubTotal[];
};

export type GameRound = {
  id: string;
  name: string; // "Round 1"
  abbreviatedName: string; // "R1"
  isFinalRound: boolean;
};

export type GameSchedule = {
  date: string; // "2026-10-02"
  time: string; // "20:00:00"
  timezone: string; // "Australia/Darwin"
};

export type GameVenue = {
  id: string;
  name: string;
  surfaceName?: string;
  address?: { suburb?: string; state?: string };
} | null;

export type PlayHqGame = {
  id: string;
  status: GameStatus;
  url: string;
  createdAt: string;
  updatedAt: string;
  round: GameRound;
  pool: unknown | null;
  schedule: GameSchedule;
  competitors: Competitor[];
  venue: GameVenue;
};

export type GradeGamesResponse = {
  gradeId: string;
  count: number;
  data: PlayHqGame[];
};

// ── Fetchers ──────────────────────────────────────────────────────────────────

/** All games (full season) for a grade, via the Worker. Throws on failure. */
export async function getGradeGames(
  gradeId: string = NTFL_PREMIER_MENS_GRADE,
  signal?: AbortSignal
): Promise<PlayHqGame[]> {
  const res = await fetch(`${WORKER_BASE}/api/grades/${gradeId}/games`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`Failed loading fixtures (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GradeGamesResponse;
  return Array.isArray(body.data) ? body.data : [];
}

// The live spectator payload is a loose shape; the list view only needs the
// status + score, which already come from the grade games. This is here for a
// future per-game live drill-down (clock, period) via the spectator proxy.
export type LiveScore = {
  id: string;
  status: GameStatus;
  updatedAt: string;
  [key: string]: unknown;
};

/** One fixture's live status (lightweight) via the Worker's spectator proxy. */
export async function getLiveStatus(
  gameId: string,
  signal?: AbortSignal
): Promise<LiveScore> {
  const res = await fetch(`${WORKER_BASE}/api/fixtures/${gameId}/status`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`Failed loading live status (HTTP ${res.status})`);
  return (await res.json()) as LiveScore;
}

// Compact normalised live score from the Worker's /live endpoint. Scores and
// clock come from the spectator feed (the REST grade feed is null in-play).
export type Scorer = {
  name: string;
  number: string | null;
  goals: number;
  behinds: number;
};

export type PeriodScore = {
  period: string; // "Q1"
  label: string; // "First Quarter"
  goals: number;
  behinds: number;
  total: number;
};

export type NormalisedLiveSide = {
  id: string | null;
  name: string | null;
  total: number | null;
  goals: number | null;
  behinds: number | null;
  scorers: Scorer[];
  periods: PeriodScore[];
};

export type NormalisedLive = {
  id: string;
  status: GameStatus | null;
  clock: { period: string | null; time: string | null; status: string | null };
  home: NormalisedLiveSide;
  away: NormalisedLiveSide;
};

/** One fixture's live score (normalised) via the Worker's spectator proxy. */
export async function getLiveScore(
  gameId: string,
  signal?: AbortSignal
): Promise<NormalisedLive> {
  const res = await fetch(`${WORKER_BASE}/api/fixtures/${gameId}/live`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`Failed loading live score (HTTP ${res.status})`);
  return (await res.json()) as NormalisedLive;
}

// PlayHQ team lists (named players + jumper numbers), via the Worker. Populated
// once a game is live/final; empty pre-game (PlayHQ has no pre-game lineup).
export type TeamListPlayer = { name: string; number: string | null };

export type TeamListSide = {
  id: string | null;
  name: string | null;
  players: TeamListPlayer[];
};

export type TeamLists = {
  id: string;
  status: GameStatus | null;
  home: TeamListSide;
  away: TeamListSide;
};

/** One fixture's team lists (home/away rosters) via the Worker. */
export async function getTeamLists(
  gameId: string,
  signal?: AbortSignal
): Promise<TeamLists> {
  const res = await fetch(`${WORKER_BASE}/api/fixtures/${gameId}/teamlists`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`Failed loading team lists (HTTP ${res.status})`);
  return (await res.json()) as TeamLists;
}

/**
 * COMPLETE goal kickers + quarter scores for a fixture, from the official REST
 * game summary (via the Worker). Unlike getLiveScore (spectator feed, which
 * only attributes some goals to named players), this matches the PlayHQ
 * game-centre. Shares the NormalisedLive shape so the UI renders it the same.
 */
export async function getScorers(
  gameId: string,
  signal?: AbortSignal
): Promise<NormalisedLive> {
  const res = await fetch(`${WORKER_BASE}/api/fixtures/${gameId}/scorers`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`Failed loading scorers (HTTP ${res.status})`);
  return (await res.json()) as NormalisedLive;
}

// A REST game is "not yet finalised" when its status is empty/null — in AFL
// that means it's either about to start or currently in play. The REST feed
// carries no live score for these, so they're the ones to enrich from the
// spectator feed.
export function restStatusUnknown(status: GameStatus | null | undefined): boolean {
  const s = String(status ?? "").trim().toUpperCase();
  return s === "" || s === "NULL";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Home / away competitor from a game (null-safe). */
export function sides(game: PlayHqGame): {
  home: Competitor | null;
  away: Competitor | null;
} {
  const comps = Array.isArray(game.competitors) ? game.competitors : [];
  const home = comps.find((c) => c.isHomeTeam) ?? null;
  const away = comps.find((c) => !c.isHomeTeam) ?? null;
  return { home, away };
}

/** AFL sub-score as "G.B" (goals.behinds), or "" if not available. */
export function goalsBehinds(c: Competitor | null): string {
  if (!c || !Array.isArray(c.scoreSubTotal)) return "";
  const g = c.scoreSubTotal.find((s) => s.type === "TOTAL_GOALS")?.value;
  const b = c.scoreSubTotal.find((s) => s.type === "TOTAL_BEHINDS")?.value;
  if (g == null && b == null) return "";
  return `${g ?? 0}.${b ?? 0}`;
}

/** A match is "live" (worth polling) when in progress. */
export function isLive(status: GameStatus): boolean {
  const s = String(status).toUpperCase();
  return s === "IN_PROGRESS" || s === "LIVE";
}

/** Combine schedule date + time + tz into a Date (best effort). */
export function scheduleDate(game: PlayHqGame): Date | null {
  const { date, time } = game.schedule ?? {};
  if (!date) return null;
  const d = new Date(`${date}T${time || "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Short, readable kickoff like "Fri 2 Oct, 8:00 PM". */
export function scheduleLabel(game: PlayHqGame): string {
  const d = scheduleDate(game);
  if (!d) return "TBC";
  return d.toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Just the date part, e.g. "Sat 10 Oct". */
export function scheduleDateLabel(game: PlayHqGame): string {
  const d = scheduleDate(game);
  if (!d) return "TBC";
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Just the time part, e.g. "8:00 PM" (empty when no time is set). */
export function scheduleTimeLabel(game: PlayHqGame): string {
  const { time } = game.schedule ?? {};
  const d = scheduleDate(game);
  if (!d || !time) return "";
  return d.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
  });
}
