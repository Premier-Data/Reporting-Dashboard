import { supabase } from "@/lib/supabase";

// Worker base URL — resolved the SAME way as lib/api/playhq.ts and
// lib/api/competitors.ts (each declares its own local constant). Points the
// live career proxy at our Cloudflare Worker; falls back to the workers.dev
// default so the feature works before a custom domain is wired up.
const WORKER_BASE =
  process.env.NEXT_PUBLIC_PLAYHQ_WORKER_URL?.replace(/\/$/, "") ||
  "https://playhq-scores.premier-data-enterprise.workers.dev";

// ======================================================================
// Player profiles: aggregate a single PlayHQ player's history from OUR
// Supabase tables (playhq_players + playhq_player_appearances), NOT a live
// PlayHQ call. Read client-side with the anon key (RLS: permissive anon
// policies). Used by the /player profile page, linked from team lists.
// ======================================================================

/** One game a player appeared in (snake_case DB row mapped to camelCase). */
export type AppearanceRow = {
  gameId: string;
  teamName: string | null;
  /**
   * Human match label "TeamA vs TeamB", derived from the two distinct
   * team_names recorded against this game_id in the appearances table (both
   * sides' players are ingested). Falls back to the player's own team, then
   * the game id, when the opponent can't be resolved.
   */
  matchName: string;
  number: string | null;
  position: string | null;
  goals: number;
  behinds: number;
  /** PlayHQ best-player rank (1 = best on ground); null when not awarded. */
  bestPlayer: number | null;
  createdAt: string | null;
};

/** A player's identity + aggregated stats across all stored appearances. */
export type PlayerProfile = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** Most recent team (from the identity row's last_team_name). */
  teamName: string | null;
  appearances: AppearanceRow[];
  totals: {
    games: number;
    goals: number;
    behinds: number;
    bestPlayerCount: number;
    /** Distinct non-null positions played, in first-seen order. */
    positions: string[];
  };
};

/**
 * Read a player's identity + appearance history and aggregate per-game totals.
 * Returns null when there is no playhq_players row for the id (e.g. a player
 * linked from a team list that hasn't been ingested yet). A player with an
 * identity row but no appearances returns a profile with empty appearances and
 * zeroed totals.
 */
export async function getPlayerProfile(
  playerId: string
): Promise<PlayerProfile | null> {
  if (!playerId) return null;

  // Identity row. maybeSingle() → null (not an error) when the row is absent.
  const { data: player, error: playerErr } = await supabase
    .from("playhq_players")
    .select("id, first_name, last_name, last_team_name")
    .eq("id", playerId)
    .maybeSingle();

  if (playerErr || !player) return null;

  // Appearances, most-recent first. A null/empty result = zero appearances.
  const { data: rows, error: appsErr } = await supabase
    .from("playhq_player_appearances")
    .select(
      "game_id, team_name, player_number, player_position, goals, behinds, best_player, created_at"
    )
    .eq("player_id", playerId)
    .order("created_at", { ascending: false });

  const rawRows = appsErr ? [] : rows ?? [];

  // Derive a "TeamA vs TeamB" label per game from the appearances table: both
  // sides' players are ingested, so the distinct team_names recorded against a
  // game_id are its two teams. One extra query over just this player's games.
  const gameIds = Array.from(new Set(rawRows.map((r) => String(r.game_id))));
  const teamsByGame = new Map<string, string[]>();
  if (gameIds.length > 0) {
    const { data: gameTeams } = await supabase
      .from("playhq_player_appearances")
      .select("game_id, team_name")
      .in("game_id", gameIds);
    for (const g of gameTeams ?? []) {
      const gid = String(g.game_id);
      const name = (g.team_name ?? "").trim();
      if (!name) continue;
      const list = teamsByGame.get(gid) ?? [];
      if (!list.includes(name)) list.push(name);
      teamsByGame.set(gid, list);
    }
  }
  const matchNameFor = (gameId: string, ownTeam: string | null): string => {
    const teams = teamsByGame.get(gameId) ?? [];
    if (teams.length >= 2) {
      // Put the player's own team first for readability when known.
      const ordered =
        ownTeam && teams.includes(ownTeam)
          ? [ownTeam, ...teams.filter((t) => t !== ownTeam)]
          : teams;
      return ordered.slice(0, 2).join(" vs ");
    }
    if (teams.length === 1) return teams[0];
    return ownTeam || gameId;
  };

  const appearances: AppearanceRow[] = rawRows.map((r) => {
    const gameId = String(r.game_id);
    const teamName = r.team_name ?? null;
    return {
      gameId,
      teamName,
      matchName: matchNameFor(gameId, teamName),
      number: r.player_number != null ? String(r.player_number) : null,
      position: r.player_position ?? null,
      goals: Number(r.goals) || 0,
      behinds: Number(r.behinds) || 0,
      bestPlayer: r.best_player == null ? null : Number(r.best_player),
      createdAt: r.created_at ?? null,
    };
  });

  // Distinct non-null positions, preserving first-seen order.
  const positions: string[] = [];
  for (const a of appearances) {
    if (a.position && !positions.includes(a.position)) positions.push(a.position);
  }

  return {
    id: String(player.id),
    firstName: player.first_name ?? null,
    lastName: player.last_name ?? null,
    teamName: player.last_team_name ?? null,
    appearances,
    totals: {
      games: appearances.length,
      goals: appearances.reduce((sum, a) => sum + a.goals, 0),
      behinds: appearances.reduce((sum, a) => sum + a.behinds, 0),
      bestPlayerCount: appearances.filter((a) => a.bestPlayer != null).length,
      positions,
    },
  };
}

// ======================================================================
// Full PlayHQ player career: a player's COMPLETE career (career totals +
// every game ever played), sourced LIVE from PlayHQ's public Discovery
// GraphQL API and proxied through OUR Cloudflare Worker (never PlayHQ
// directly). The worker flattens the deep GraphQL payload into the
// CareerProfile shape below, so this is a thin typed fetch. Read client-side
// — no auth, no token. Used by the /player profile page.
// ======================================================================

/** One career total / per-game stat, e.g. { type: "GOAL_COUNT", value: 767 }. */
export type CareerStat = { type: string; value: number };

/** One game in a player's flattened career history (every field null-safe). */
export type CareerGame = {
  gameId: string;
  season: string | null;
  competition: string | null;
  organisation: string | null;
  club: string | null;
  team: string | null;
  grade: string | null;
  round: string | null;
  date: string | null;
  home: string | null;
  away: string | null;
  /** Human match label "Home vs Away" (never the id when both sides known). */
  matchName: string;
  venue: string | null;
  stats: CareerStat[];
};

/** A player's identity + flattened LIVE PlayHQ career (totals + every game). */
export type CareerProfile = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** Every career total type present (APPEARANCE, GOAL_COUNT, BEST_PLAYER, …). */
  totals: CareerStat[];
  /** Every game ever played, most-recent first. */
  games: CareerGame[];
};

/**
 * Read a PlayHQ player's COMPLETE public career via the Worker proxy. Returns
 * the flattened CareerProfile, or null on a not-found player. A PRIVATE profile
 * (no public career data) resolves to a profile with empty totals/games rather
 * than throwing, so the page can show a friendly empty state. Throws an Error
 * (carrying the worker's error message when present) on other failures.
 */
export async function getPlayerCareer(
  playerId: string,
  tenant = "afl"
): Promise<CareerProfile | null> {
  if (!playerId) return null;

  const res = await fetch(
    `${WORKER_BASE}/api/player/${playerId}/profile?tenant=${encodeURIComponent(tenant)}`,
    { cache: "no-store" }
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    let message = `Failed loading player career (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = `Failed loading player career (${body.error})`;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new Error(message);
  }

  const profile = (await res.json()) as CareerProfile;
  return {
    id: profile.id,
    firstName: profile.firstName ?? null,
    lastName: profile.lastName ?? null,
    totals: Array.isArray(profile.totals) ? profile.totals : [],
    games: Array.isArray(profile.games) ? profile.games : [],
  };
}
