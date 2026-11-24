import { fetchAllPaged } from "@/lib/supabase/fetchAllPaged";
import type { SoccerGameRow } from "@/lib/analytics/opsSoccer";

let cache: Promise<SoccerGameRow[]> | null = null;

function load(): Promise<SoccerGameRow[]> {
  return fetchAllPaged<SoccerGameRow>("soccer_games", {
    select:
      "game_key,Date,season,week,Competition,home_team,away_team,home_allocated,away_allocated,Location,completed_date,completed_season,completed_week",
    unique: "game_key",
  });
}

/** Reads every soccer_games row (paginated). Cached for the session; a failure is not cached. */
export function fetchSoccerGamesForOps(): Promise<SoccerGameRow[]> {
  if (!cache) {
    cache = load().catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}
