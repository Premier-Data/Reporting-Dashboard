// PlayHQ live-scores bridge — a Cloudflare Worker that proxies the PlayHQ
// spectator GraphQL endpoint behind your own domain, with validation, a short
// edge cache (so 3–4 fixtures polled every ~2 min never hammer PlayHQ), CORS
// for the dashboard, and sane error/back-off handling.
//
// Routes (GET):
//   /api/fixtures/:id/live-scores   full game payload (score, periods, clock)
//   /api/fixtures/:id/status        just { id, status, updatedAt }
//   /health                         liveness probe
//
// The upstream call is the same POST you ran with cURL, kept server-side so the
// query, headers and tenant live in one place and the browser never talks to
// PlayHQ directly.

export interface Env {
  // Comma-separated list of allowed browser origins for CORS, e.g.
  // "https://your-dashboard.example,https://www.yourdomain.com.au". Set in
  // wrangler.toml [vars] or as a secret. "*" allows any origin (fine for a
  // read-only public score, but prefer listing your real origins).
  ALLOWED_ORIGINS?: string;
  // PlayHQ tenant (default "afl"). Override per-deployment if you query other
  // sports/competitions.
  PHQ_TENANT?: string;
  // Seconds to cache the slow-moving data (fixtures list, game status) at the
  // edge. Default 90.
  CACHE_TTL_SECONDS?: string;
  // Seconds to cache the LIVE score endpoints (/live, /live-scores). Short by
  // design so in-play scores are near-real-time while still shielding PlayHQ
  // from bursts. Default 15.
  LIVE_TTL_SECONDS?: string;
  // PlayHQ REST API key (official API). A SECRET — set with
  // `wrangler secret put PHQ_API_KEY`, never committed. Required for the
  // /api/grades/:id/games endpoint.
  PHQ_API_KEY?: string;
  // Comma-separated grade ids whose fixtures the Worker knows about, so the
  // /live endpoint can attach team id+name to a game by looking it up in these
  // grades' REST feeds. Defaults to the NTFL Premier Men's + Women's grades.
  KNOWN_GRADE_IDS?: string;
}

// Default grades the /live endpoint searches to resolve a game's teams.
const DEFAULT_GRADE_IDS = [
  "be950883-7630-4df5-81e4-a5bba0f24cb6", // NTFL Premier Men's
  "61ca876d-f028-4f60-ad85-33e8fb2e5be7", // NTFL Premier Women's
  "6f964e7b-a56f-471e-9d9d-30e1f80da8d1", // EFNL Premier Men
  "6c2c7212-d1b7-48bb-acee-0fd75ce1984f", // GVL Seniors
  "7540fef1-7fad-4375-8502-b95c09ae6105", // PFL A-Grade Men
];

const PLAYHQ_URL = "https://spectator.playhq.com/graphql";
const PLAYHQ_REST = "https://api.playhq.com/v1";

// The GraphQL document (from the spectator cURL, whitespace trimmed). Includes
// per-player statistics under statistics.{home,away}.players[] so we can derive
// goal scorers (TOTAL_GOALS / TOTAL_BEHINDS per player).
const GAME_QUERY = `query game($id: ID!, $scope: PeriodScore) { game(id: $id) { id status updatedAt lastEventRecordedAt statistics { home { statisticsV2 { type { type value } count } players { name playerNumber statistics { type { value } count } } } away { statisticsV2 { type { type value } count } players { name playerNumber statistics { type { value } count } } } } result { home { statistics { type { value } count } periods(scope: $scope) { period { label shortName value } statistics { type { type value } count } type role closureStatus overtimeSequenceNo } } away { statistics { type { value } count } periods(scope: $scope) { period { label shortName value } statistics { type { type value } count } type role closureStatus overtimeSequenceNo } } currentPeriod { value primarySide } } clock { overtimeSequenceNo period periodValue status time lastUpdatedAt } } }`;

// A PlayHQ fixture/game id is a short alphanumeric token (e.g. "ab5ae0c9").
// Only accept that shape so the id can't be used to smuggle anything upstream.
const ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

function corsHeaders(env: Env, requestOrigin: string | null): HeadersInit {
  const allowed = (env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAny = allowed.includes("*");
  const origin =
    allowAny || !requestOrigin
      ? allowAny
        ? "*"
        : (allowed[0] ?? "*")
      : allowed.includes(requestOrigin)
        ? requestOrigin
        : allowed[0] ?? "null";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(
  body: unknown,
  status: number,
  extra: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// A compact, normalised live-score shape derived from the spectator payload,
// so the dashboard doesn't have to parse the deep GraphQL structure. Scores
// come from result.{home,away}.statistics (TOTAL_SCORE/GOALS/BEHINDS) and the
// clock from clock.{period,time,status}.
type NormalisedLive = {
  id: string;
  status: string | null;
  clock: { period: string | null; time: string | null; status: string | null };
  home: {
    id: string | null;
    name: string | null;
    total: number | null;
    goals: number | null;
    behinds: number | null;
    scorers: Scorer[];
    periods: PeriodScore[];
  };
  away: {
    id: string | null;
    name: string | null;
    total: number | null;
    goals: number | null;
    behinds: number | null;
    scorers: Scorer[];
    periods: PeriodScore[];
  };
};

// A player who has scored, with their goal/behind tally this game.
type Scorer = {
  name: string;
  number: string | null;
  goals: number;
  behinds: number;
};

// One quarter's score for a side (the score kicked IN that period, as PlayHQ
// reports it — not cumulative).
type PeriodScore = {
  period: string; // "Q1"
  label: string; // "First Quarter"
  goals: number;
  behinds: number;
  total: number;
};

// Extract a side's quarter-by-quarter scores from result.{home,away}.periods[].
function periodsFrom(
  result: Record<string, unknown>,
  side: "home" | "away"
): PeriodScore[] {
  const sideObj = (result[side] ?? {}) as Record<string, unknown>;
  const periods = Array.isArray(sideObj.periods)
    ? (sideObj.periods as Array<Record<string, unknown>>)
    : [];
  const out: PeriodScore[] = [];
  for (const p of periods) {
    const period = (p.period ?? {}) as Record<string, unknown>;
    const stats = Array.isArray(p.statistics)
      ? (p.statistics as Array<{ type?: { value?: string }; count?: number }>)
      : [];
    out.push({
      period: (period.shortName as string) ?? "",
      label: (period.label as string) ?? "",
      goals: statVal(stats, "TOTAL_GOALS") ?? 0,
      behinds: statVal(stats, "TOTAL_BEHINDS") ?? 0,
      total: statVal(stats, "TOTAL_SCORE") ?? 0,
    });
  }
  return out;
}

// Team identity (id + name) for a game's two sides, resolved from the REST
// grade feeds. Keyed by side.
type GameTeams = { home: FixtureTeam; away: FixtureTeam } | null;

// Resolve a game's home/away team id+name by finding it in the known grades'
// REST feeds. The spectator game id is the short leading segment of the REST
// UUID (e.g. "7faaae3d" ⊂ "7faaae3d-bd91-..."), so match on that. Uses the
// edge cache for each grade's games to avoid re-hitting PlayHQ.
async function resolveGameTeams(
  gameId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<GameTeams> {
  const match = await resolveFullGame(gameId, env);
  if (!match) return null;
  const lite = toFixtureLite(match);
  void ctx; // reserved; no async write needed here
  return { home: lite.home, away: lite.away };
}

// Find a game's FULL raw record (and thus its full UUID id) from the known
// grades' REST feeds, given either the full UUID or the short leading segment
// (the spectator id). Uses the per-grade edge cache. Returns null if unknown.
async function resolveFullGame(
  gameId: string,
  env: Env
): Promise<Record<string, unknown> | null> {
  if (!env.PHQ_API_KEY) return null;
  const gradeIds = (env.KNOWN_GRADE_IDS ?? DEFAULT_GRADE_IDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cache = caches.default;

  for (const gradeId of gradeIds) {
    if (!UUID_RE.test(gradeId)) continue;
    let games: Array<Record<string, unknown>> | null = null;
    const key = new Request(`https://playhq-cache/grade-games/${gradeId}`);
    const hit = await cache.match(key);
    if (hit) {
      try {
        const body = (await hit.json()) as { data?: Array<Record<string, unknown>> };
        games = Array.isArray(body.data) ? body.data : null;
      } catch {
        games = null;
      }
    }
    if (!games) {
      try {
        games = (await fetchGradeGames(gradeId, env)) as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
    }
    const match = games.find((g) => {
      const full = String(g.id ?? "");
      return full === gameId || full.split("-")[0] === gameId;
    });
    if (match) return match;
  }
  return null;
}

// Pull a stat value out of a spectator statistics[] array by its type value.
function statVal(
  stats: Array<{ type?: { value?: string }; count?: number }> | undefined,
  typeValue: string
): number | null {
  if (!Array.isArray(stats)) return null;
  const hit = stats.find((s) => s?.type?.value === typeValue);
  return typeof hit?.count === "number" ? hit.count : null;
}

// One player on a team list (name + jumper number).
type TeamListPlayer = { name: string; number: string | null };

// Extract one side's full team list from the game's player statistics
// (statistics.{home,away}.players[]). PlayHQ populates this with every named
// player (not just scorers) once a game has data (live/final); it's empty
// pre-game. Sorted by jumper number ascending (unnumbered last, by name).
function teamListFrom(
  game: Record<string, unknown>,
  side: "home" | "away"
): TeamListPlayer[] {
  const stats = (game.statistics ?? {}) as Record<string, unknown>;
  const sideObj = (stats[side] ?? {}) as Record<string, unknown>;
  const players = Array.isArray(sideObj.players)
    ? (sideObj.players as Array<Record<string, unknown>>)
    : [];
  const out: TeamListPlayer[] = players.map((p) => ({
    name: (p.name as string) ?? "",
    number: (p.playerNumber as string) ?? null,
  }));
  const num = (n: string | null) => {
    const v = Number(n);
    return Number.isFinite(v) && n != null && n !== "" ? v : Number.POSITIVE_INFINITY;
  };
  out.sort((a, b) => num(a.number) - num(b.number) || a.name.localeCompare(b.name));
  return out;
}

// Extract the goal scorers for one side from the game's player statistics
// (statistics.{home,away}.players[]). Returns players with at least one goal or
// behind, sorted by goals desc then behinds desc.
function scorersFrom(
  game: Record<string, unknown>,
  side: "home" | "away"
): Scorer[] {
  const stats = (game.statistics ?? {}) as Record<string, unknown>;
  const sideObj = (stats[side] ?? {}) as Record<string, unknown>;
  const players = Array.isArray(sideObj.players)
    ? (sideObj.players as Array<Record<string, unknown>>)
    : [];
  const out: Scorer[] = [];
  for (const p of players) {
    const ps = Array.isArray(p.statistics)
      ? (p.statistics as Array<{ type?: { value?: string }; count?: number }>)
      : [];
    const goals = statVal(ps, "TOTAL_GOALS") ?? 0;
    const behinds = statVal(ps, "TOTAL_BEHINDS") ?? 0;
    if (goals > 0 || behinds > 0) {
      out.push({
        name: (p.name as string) ?? "",
        number: (p.playerNumber as string) ?? null,
        goals,
        behinds,
      });
    }
  }
  out.sort((a, b) => b.goals - a.goals || b.behinds - a.behinds);
  return out;
}

function normaliseLive(
  id: string,
  game: Record<string, unknown>,
  teams: GameTeams
): NormalisedLive {
  const result = (game.result ?? {}) as Record<string, unknown>;
  const clock = (game.clock ?? {}) as Record<string, unknown>;
  const sideStats = (side: string) =>
    (((result[side] ?? {}) as Record<string, unknown>).statistics ?? []) as Array<{
      type?: { value?: string };
      count?: number;
    }>;
  const home = sideStats("home");
  const away = sideStats("away");
  return {
    id,
    status: (game.status as string) ?? null,
    clock: {
      period: (clock.period as string) ?? null,
      time: (clock.time as string) ?? null,
      status: (clock.status as string) ?? null,
    },
    home: {
      id: teams?.home.id ?? null,
      name: teams?.home.name ?? null,
      total: statVal(home, "TOTAL_SCORE"),
      goals: statVal(home, "TOTAL_GOALS"),
      behinds: statVal(home, "TOTAL_BEHINDS"),
      scorers: scorersFrom(game, "home"),
      periods: periodsFrom(result, "home"),
    },
    away: {
      id: teams?.away.id ?? null,
      name: teams?.away.name ?? null,
      total: statVal(away, "TOTAL_SCORE"),
      goals: statVal(away, "TOTAL_GOALS"),
      behinds: statVal(away, "TOTAL_BEHINDS"),
      scorers: scorersFrom(game, "away"),
      periods: periodsFrom(result, "away"),
    },
  };
}

// Fetch one game from PlayHQ. Returns the `game` object, or throws a tagged
// error the handler maps to an HTTP status.
async function fetchGame(id: string, env: Env): Promise<unknown> {
  const upstream = await fetch(PLAYHQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.playhq.com",
      Accept: "*/*",
      "x-phq-tenant": env.PHQ_TENANT ?? "afl",
    },
    body: JSON.stringify({
      operationName: "game",
      variables: { id, scope: "BY_PERIOD" },
      query: GAME_QUERY,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  // Surface rate-limit / forbidden explicitly so the caller can back off.
  if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
  if (upstream.status === 403) throw new UpstreamError("forbidden", 403);
  if (!upstream.ok) throw new UpstreamError("upstream_error", 502);

  const data = (await upstream.json()) as {
    data?: { game?: unknown };
    errors?: unknown[];
  };
  if (data.errors?.length) throw new UpstreamError("graphql_errors", 502);
  if (!data.data?.game) throw new UpstreamError("not_found", 404);
  return data.data.game;
}

class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

// A grade id is a UUID (e.g. "be950883-7630-4df5-81e4-a5bba0f24cb6").
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fetch ALL games for a grade from the official PlayHQ REST API, following the
// cursor pagination (metadata.hasMore / metadata.nextCursor) so a full season
// comes back in one response. Requires the secret API key.
async function fetchGradeGames(gradeId: string, env: Env): Promise<unknown[]> {
  if (!env.PHQ_API_KEY) throw new UpstreamError("api_key_not_configured", 500);

  const all: unknown[] = [];
  let cursor: string | null = null;
  // Safety cap on pages so a pagination bug can't loop forever.
  for (let page = 0; page < 50; page++) {
    const u = new URL(`${PLAYHQ_REST}/grades/${gradeId}/games`);
    if (cursor) u.searchParams.set("cursor", cursor);

    const upstream = await fetch(u.toString(), {
      method: "GET",
      headers: {
        "x-api-key": env.PHQ_API_KEY,
        "x-phq-tenant": env.PHQ_TENANT ?? "afl",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
    if (upstream.status === 401 || upstream.status === 403)
      throw new UpstreamError("forbidden", upstream.status);
    if (upstream.status === 404) throw new UpstreamError("not_found", 404);
    if (!upstream.ok) throw new UpstreamError("upstream_error", 502);

    const body = (await upstream.json()) as {
      data?: unknown[];
      metadata?: { hasMore?: boolean; nextCursor?: string | null };
    };
    if (Array.isArray(body.data)) all.push(...body.data);
    if (!body.metadata?.hasMore || !body.metadata.nextCursor) break;
    cursor = body.metadata.nextCursor;
  }
  return all;
}

// Fetch a game's SUMMARY from the official REST API. This carries per-player
// `appearances[]` (complete goal kickers) and per-quarter `periods[]`, unlike
// the spectator feed which only attributes some goals. Requires the API key.
async function fetchGameSummary(
  fullGameId: string,
  env: Env
): Promise<Record<string, unknown>> {
  if (!env.PHQ_API_KEY) throw new UpstreamError("api_key_not_configured", 500);
  const u = `${PLAYHQ_REST}/games/${fullGameId}/summary`;
  const upstream = await fetch(u, {
    method: "GET",
    headers: {
      "x-api-key": env.PHQ_API_KEY,
      "x-phq-tenant": env.PHQ_TENANT ?? "afl",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
  if (upstream.status === 401 || upstream.status === 403)
    throw new UpstreamError("forbidden", upstream.status);
  if (upstream.status === 404) throw new UpstreamError("not_found", 404);
  if (!upstream.ok) throw new UpstreamError("upstream_error", 502);
  const body = (await upstream.json()) as { data?: Record<string, unknown> };
  if (!body.data) throw new UpstreamError("not_found", 404);
  return body.data;
}

// Build a normalised scorers + periods payload (home/away) from a REST game
// summary. Goal kickers come from appearances[].scoreSubTotal (6_POINT_SCORE =
// goals*6, 1_POINT_SCORE = behinds); quarter scores from periods[]. Team sides
// are keyed by the summary's competitors[].isHomeTeam.
function summaryToScorersPeriods(
  id: string,
  summary: Record<string, unknown>
): NormalisedLive {
  const comps = Array.isArray(summary.competitors)
    ? (summary.competitors as Array<Record<string, unknown>>)
    : [];
  const homeComp = comps.find((c) => c.isHomeTeam === true);
  const awayComp = comps.find((c) => c.isHomeTeam === false);
  const homeId = homeComp ? String(homeComp.id) : null;
  const awayId = awayComp ? String(awayComp.id) : null;

  const subVal = (
    sub: Array<{ type?: string; value?: number }> | undefined,
    type: string
  ): number => {
    if (!Array.isArray(sub)) return 0;
    const hit = sub.find((s) => s?.type === type);
    return typeof hit?.value === "number" ? hit.value : 0;
  };

  // Per-side goal kickers from appearances.
  const appearances = Array.isArray(summary.appearances)
    ? (summary.appearances as Array<Record<string, unknown>>)
    : [];
  const scorersFor = (teamId: string | null): Scorer[] => {
    if (!teamId) return [];
    const out: Scorer[] = [];
    for (const a of appearances) {
      if (String(a.teamID) !== teamId) continue;
      const sub = a.scoreSubTotal as Array<{ type?: string; value?: number }>;
      const goals = Math.floor(subVal(sub, "6_POINT_SCORE") / 6);
      const behinds = subVal(sub, "1_POINT_SCORE");
      if (goals > 0 || behinds > 0) {
        const name = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
        out.push({
          name,
          number: a.playerNumber != null ? String(a.playerNumber) : null,
          goals,
          behinds,
        });
      }
    }
    out.sort((x, y) => y.goals - x.goals || y.behinds - x.behinds);
    return out;
  };

  // Per-side quarter scores from periods[].
  const periods = Array.isArray(summary.periods)
    ? (summary.periods as Array<Record<string, unknown>>)
    : [];
  const PERIOD_LABEL: Record<string, { period: string; label: string }> = {
    FIRST_QTR: { period: "Q1", label: "First Quarter" },
    SECOND_QTR: { period: "Q2", label: "Second Quarter" },
    THIRD_QTR: { period: "Q3", label: "Third Quarter" },
    FOURTH_QTR: { period: "Q4", label: "Fourth Quarter" },
  };
  const periodsFor = (teamId: string | null): PeriodScore[] => {
    if (!teamId) return [];
    const out: PeriodScore[] = [];
    for (const p of periods) {
      const label = PERIOD_LABEL[String(p.name)] ?? { period: String(p.name), label: String(p.name) };
      const pc = Array.isArray(p.competitors)
        ? (p.competitors as Array<Record<string, unknown>>)
        : [];
      const mine = pc.find((c) => String(c.id) === teamId);
      if (!mine) continue;
      const sub = mine.scoreSubtotals as Array<{ type?: string; value?: number }>;
      const goals = subVal(sub, "6_POINT_SCORE");
      const behinds = subVal(sub, "1_POINT_SCORE");
      out.push({
        period: label.period,
        label: label.label,
        goals,
        behinds,
        total: typeof mine.scoreTotals === "number" ? mine.scoreTotals : goals * 6 + behinds,
      });
    }
    return out;
  };

  const sideTotals = (comp: Record<string, unknown> | undefined) => {
    const sub = comp?.scoreSubTotal as Array<{ type?: string; value?: number }>;
    return {
      total: typeof comp?.scoreTotal === "number" ? comp.scoreTotal : null,
      goals: subVal(sub, "TOTAL_GOALS"),
      behinds: subVal(sub, "TOTAL_BEHINDS"),
    };
  };
  const h = sideTotals(homeComp);
  const a = sideTotals(awayComp);

  return {
    id,
    status: (summary.status as string) ?? null,
    clock: { period: null, time: null, status: null },
    home: {
      id: homeId,
      name: (homeComp?.name as string) ?? null,
      total: h.total,
      goals: h.goals,
      behinds: h.behinds,
      scorers: scorersFor(homeId),
      periods: periodsFor(homeId),
    },
    away: {
      id: awayId,
      name: (awayComp?.name as string) ?? null,
      total: a.total,
      goals: a.goals,
      behinds: a.behinds,
      scorers: scorersFor(awayId),
      periods: periodsFor(awayId),
    },
  };
}

// Build complete home/away team lists from a REST game summary. Every
// `appearances[]` entry is a SELECTED player (not just scorers), so this is the
// authoritative, complete roster — unlike the spectator feed's players[], which
// PlayHQ only populates partially. Sides are keyed by competitors[].isHomeTeam;
// each player is grouped by appearance.teamID. Returns null when the summary
// carries no appearances (e.g. pre-match), so the caller can fall back.
type TeamListsPayload = {
  id: string;
  status: string | null;
  home: { id: string | null; name: string | null; players: TeamListPlayer[] };
  away: { id: string | null; name: string | null; players: TeamListPlayer[] };
};

function summaryToTeamLists(
  id: string,
  summary: Record<string, unknown>
): TeamListsPayload | null {
  const appearances = Array.isArray(summary.appearances)
    ? (summary.appearances as Array<Record<string, unknown>>)
    : [];
  if (appearances.length === 0) return null;

  const comps = Array.isArray(summary.competitors)
    ? (summary.competitors as Array<Record<string, unknown>>)
    : [];
  const homeComp = comps.find((c) => c.isHomeTeam === true);
  const awayComp = comps.find((c) => c.isHomeTeam === false);
  const homeId = homeComp ? String(homeComp.id) : null;
  const awayId = awayComp ? String(awayComp.id) : null;

  const num = (n: string | null) => {
    const v = Number(n);
    return Number.isFinite(v) && n != null && n !== "" ? v : Number.POSITIVE_INFINITY;
  };

  const rosterFor = (teamId: string | null): TeamListPlayer[] => {
    if (!teamId) return [];
    const out: TeamListPlayer[] = [];
    for (const a of appearances) {
      if (String(a.teamID) !== teamId) continue;
      const name = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
      if (!name) continue;
      out.push({
        name,
        number: a.playerNumber != null ? String(a.playerNumber) : null,
      });
    }
    out.sort((x, y) => num(x.number) - num(y.number) || x.name.localeCompare(y.name));
    return out;
  };

  return {
    id,
    status: (summary.status as string) ?? null,
    home: { id: homeId, name: (homeComp?.name as string) ?? null, players: rosterFor(homeId) },
    away: { id: awayId, name: (awayComp?.name as string) ?? null, players: rosterFor(awayId) },
  };
}

// One side of a fixture — the PlayHQ competitor (team) id plus its name.
type FixtureTeam = { id: string | null; name: string | null };

// A lean fixture record for the discovery endpoint: just what a consuming app
// needs to identify a fixture and then poll its score by `id`. Strips the
// heavy venue/address/sub-score detail from the full game object. Each side
// carries the team id AND name so a consumer can map on either.
type FixtureLite = {
  id: string; // the PlayHQ fixture/game id — poll /api/fixtures/:id/live with it
  status: string | null;
  round: string | null;
  date: string | null; // yyyy-mm-dd
  time: string | null; // HH:mm:ss
  timezone: string | null;
  venue: string | null;
  home: FixtureTeam;
  away: FixtureTeam;
  url: string | null;
};

function teamOf(c: Record<string, unknown> | undefined): FixtureTeam {
  return {
    id: c ? (c.id as string) ?? null : null,
    name: c ? (c.name as string) ?? null : null,
  };
}

function toFixtureLite(game: Record<string, unknown>): FixtureLite {
  const round = (game.round ?? {}) as Record<string, unknown>;
  const schedule = (game.schedule ?? {}) as Record<string, unknown>;
  const venue = (game.venue ?? null) as Record<string, unknown> | null;
  const comps = Array.isArray(game.competitors)
    ? (game.competitors as Array<Record<string, unknown>>)
    : [];
  const home = comps.find((c) => c.isHomeTeam === true);
  const away = comps.find((c) => c.isHomeTeam === false);
  return {
    id: String(game.id ?? ""),
    status: (game.status as string) ?? null,
    round: (round.name as string) ?? null,
    date: (schedule.date as string) ?? null,
    time: (schedule.time as string) ?? null,
    timezone: (schedule.timezone as string) ?? null,
    venue: (venue?.name as string) ?? null,
    home: teamOf(home),
    away: teamOf(away),
    url: (game.url as string) ?? null,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }

    if (url.pathname === "/health") {
      return json({ ok: true }, 200, cors);
    }

    const ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ?? "90") || 90);
    const cache = caches.default;

    // /api/grades/:id/fixtures — LEAN fixture index for a grade. Returns just
    // the fixture id + identifying detail (teams, round, date, status) so a
    // consuming application can discover the PlayHQ fixture id and then poll
    // its score via /api/fixtures/:id/live. This is the discovery endpoint for
    // external software.
    const fixturesMatch = url.pathname.match(
      /^\/api\/grades\/([^/]+)\/fixtures$/
    );
    if (fixturesMatch) {
      const gradeId = decodeURIComponent(fixturesMatch[1]);
      if (!UUID_RE.test(gradeId)) {
        return json({ error: "invalid_grade_id" }, 400, cors);
      }
      const key = new Request(`https://playhq-cache/grade-fixtures/${gradeId}`);
      const hit = await cache.match(key);
      if (hit) {
        return new Response(await hit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      try {
        const games = await fetchGradeGames(gradeId, env);
        const fixtures = (games as Array<Record<string, unknown>>).map(
          toFixtureLite
        );
        const bodyText = JSON.stringify({
          gradeId,
          count: fixtures.length,
          fixtures,
        });
        const listTtl = Math.min(ttl, 60) || 60;
        ctx.waitUntil(
          cache.put(
            key,
            new Response(bodyText, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${listTtl}`,
              },
            })
          )
        );
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${listTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_fixtures" }, 502, cors);
      }
    }

    // /api/grades/:id/games — the full fixture list for a grade (official REST
    // API). Cached at the edge like the live scores so repeated dashboard opens
    // don't re-hit PlayHQ. The fixture list changes slowly, so give it a longer
    // TTL than live scores.
    const gradeMatch = url.pathname.match(/^\/api\/grades\/([^/]+)\/games$/);
    if (gradeMatch) {
      const gradeId = decodeURIComponent(gradeMatch[1]);
      if (!UUID_RE.test(gradeId)) {
        return json({ error: "invalid_grade_id" }, 400, cors);
      }
      const gradeKey = new Request(`https://playhq-cache/grade-games/${gradeId}`);
      const gradeCached = await cache.match(gradeKey);
      if (gradeCached) {
        return new Response(await gradeCached.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      try {
        const games = await fetchGradeGames(gradeId, env);
        const bodyText = JSON.stringify({ gradeId, count: games.length, data: games });
        // Fixture list is slow-moving — cache a bit longer (but still short so
        // in-progress scores on the list refresh). 60s.
        const listTtl = Math.min(ttl, 60) || 60;
        const toCache = new Response(bodyText, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${listTtl}`,
          },
        });
        ctx.waitUntil(cache.put(gradeKey, toCache));
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${listTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_games" }, 502, cors);
      }
    }

    // /api/fixtures/:id/live-scores  (raw spectator payload)
    // /api/fixtures/:id/live         (compact normalised live score)
    // /api/fixtures/:id/status       (just id/status/updatedAt)
    // /api/fixtures/:id/scorers — COMPLETE goal kickers + quarter scores from
    // the official REST game summary (appearances + periods). Unlike /live
    // (spectator feed, often partial), this matches the PlayHQ game-centre.
    const scorersMatch = url.pathname.match(/^\/api\/fixtures\/([^/]+)\/scorers$/);
    if (scorersMatch) {
      const sid = decodeURIComponent(scorersMatch[1]);
      if (!ID_RE.test(sid)) return json({ error: "invalid_fixture_id" }, 400, cors);
      const scorersCacheKey = new Request(`https://playhq-cache/scorers/${sid}`);
      const scorersHit = await cache.match(scorersCacheKey);
      if (scorersHit) {
        return new Response(await scorersHit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      try {
        const full = await resolveFullGame(sid, env);
        if (!full) return json({ error: "not_found" }, 404, cors);
        const summary = await fetchGameSummary(String(full.id), env);
        const payload = summaryToScorersPeriods(sid, summary);
        const bodyText = JSON.stringify(payload);
        const sTtl = Math.max(0, Number(env.LIVE_TTL_SECONDS ?? "15") || 15);
        if (sTtl > 0) {
          ctx.waitUntil(
            cache.put(
              scorersCacheKey,
              new Response(bodyText, {
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": `public, max-age=${sTtl}`,
                },
              })
            )
          );
        }
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${sTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_scorers" }, 502, cors);
      }
    }

    // /api/fixtures/:id/teamlists — COMPLETE home/away rosters from the official
    // REST game summary (appearances[] = the full selected squad). This matches
    // the PlayHQ game-centre, unlike the spectator feed (players[]) which is
    // often partial. If the summary has no appearances yet (e.g. the lineup
    // isn't published), fall through to the spectator feed below.
    const teamlistsMatch = url.pathname.match(
      /^\/api\/fixtures\/([^/]+)\/teamlists$/
    );
    if (teamlistsMatch) {
      const tid = decodeURIComponent(teamlistsMatch[1]);
      if (!ID_RE.test(tid)) return json({ error: "invalid_fixture_id" }, 400, cors);
      const tlCacheKey = new Request(`https://playhq-cache/teamlists/${tid}`);
      const tlHit = await cache.match(tlCacheKey);
      if (tlHit) {
        return new Response(await tlHit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      // Try the authoritative REST summary first.
      let payload: TeamListsPayload | null = null;
      try {
        const full = await resolveFullGame(tid, env);
        if (full) {
          const summary = await fetchGameSummary(String(full.id), env);
          payload = summaryToTeamLists(tid, summary);
        }
      } catch {
        // Summary unavailable (e.g. 404 pre-match, API hiccup) — fall back to
        // the spectator feed below rather than failing the request.
        payload = null;
      }
      // Fall back to the spectator feed when the summary carried no roster
      // (pre-match / not yet published) so behaviour never regresses.
      if (!payload) {
        try {
          const game = (await fetchGame(tid, env)) as Record<string, unknown>;
          const teams = await resolveGameTeams(tid, env, ctx);
          payload = {
            id: tid,
            status: (game.status as string) ?? null,
            home: {
              id: teams?.home.id ?? null,
              name: teams?.home.name ?? null,
              players: teamListFrom(game, "home"),
            },
            away: {
              id: teams?.away.id ?? null,
              name: teams?.away.name ?? null,
              players: teamListFrom(game, "away"),
            },
          };
        } catch (err) {
          if (err instanceof UpstreamError) {
            const extra: HeadersInit =
              err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
            return json({ error: err.message }, err.status, extra);
          }
          return json({ error: "unable_to_retrieve_team_lists" }, 502, cors);
        }
      }
      const bodyText = JSON.stringify(payload);
      const tlTtl = Math.max(0, Number(env.LIVE_TTL_SECONDS ?? "15") || 15);
      if (tlTtl > 0) {
        ctx.waitUntil(
          cache.put(
            tlCacheKey,
            new Response(bodyText, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${tlTtl}`,
              },
            })
          )
        );
      }
      return new Response(bodyText, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "MISS",
          "Cache-Control": `public, max-age=${tlTtl}`,
          ...cors,
        },
      });
    }

    const m = url.pathname.match(
      /^\/api\/fixtures\/([^/]+)\/(live-scores|live|status)$/
    );
    if (!m) return json({ error: "not_found" }, 404, cors);

    const id = decodeURIComponent(m[1]);
    const kind = m[2];
    if (!ID_RE.test(id)) {
      return json({ error: "invalid_fixture_id" }, 400, cors);
    }

    // Edge cache keyed by the normalised request (one entry per fixture+kind).
    // Many dashboard tabs polling the same fixture within the TTL collapse to a
    // single upstream call.
    const cacheKey = new Request(
      `https://playhq-cache/${kind}/${id}`,
      { method: "GET" }
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "HIT",
          ...cors,
        },
      });
    }

    try {
      const game = (await fetchGame(id, env)) as Record<string, unknown>;
      // For the normalised /live payload, attach team id+name resolved from the
      // known grades' REST feeds (the spectator feed carries no team identity).
      const teams = kind === "live" ? await resolveGameTeams(id, env, ctx) : null;
      const payload =
        kind === "status"
          ? {
              id: game.id,
              status: game.status,
              updatedAt: game.updatedAt,
            }
          : kind === "live"
            ? normaliseLive(id, game, teams)
            : game;

      const bodyText = JSON.stringify(payload);

      // Live score endpoints get a SHORT TTL so in-play scores are near-live;
      // status (slow-moving) uses the longer TTL.
      const kindTtl =
        kind === "status"
          ? ttl
          : Math.max(0, Number(env.LIVE_TTL_SECONDS ?? "15") || 15);

      // Store in the edge cache with the kind's TTL (only when TTL > 0).
      if (kindTtl > 0) {
        const toCache = new Response(bodyText, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${kindTtl}`,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }

      return new Response(bodyText, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "MISS",
          // Tell the browser not to cache a live score beyond the edge TTL.
          "Cache-Control": `public, max-age=${kindTtl}`,
          ...cors,
        },
      });
    } catch (err) {
      if (err instanceof UpstreamError) {
        // Pass rate-limit / forbidden through so the poller can back off, and
        // hint a Retry-After on 429.
        const extra: HeadersInit =
          err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
        return json({ error: err.message }, err.status, extra);
      }
      // Timeouts / network faults.
      return json({ error: "unable_to_retrieve_scores" }, 502, cors);
    }
  },
};
