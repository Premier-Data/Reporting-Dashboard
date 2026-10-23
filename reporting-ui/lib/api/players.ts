import { supabase } from "@/lib/supabase";

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

  const appearances: AppearanceRow[] = rawRows.map((r) => ({
    gameId: String(r.game_id),
    teamName: r.team_name ?? null,
    number: r.player_number != null ? String(r.player_number) : null,
    position: r.player_position ?? null,
    goals: Number(r.goals) || 0,
    behinds: Number(r.behinds) || 0,
    bestPlayer: r.best_player == null ? null : Number(r.best_player),
    createdAt: r.created_at ?? null,
  }));

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
