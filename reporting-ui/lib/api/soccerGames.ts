import { supabase } from "@/lib/supabase";
import type { SoccerGameRow } from "@/lib/analytics/opsSoccer";

const PAGE_SIZE = 1000; // Supabase caps a response at 1000 rows

let cache: Promise<SoccerGameRow[]> | null = null;

async function load(): Promise<SoccerGameRow[]> {
  const all: SoccerGameRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("soccer_games")
      .select("game_key,Date,season,week,home_allocated,away_allocated,Location")
      .order("game_key", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as SoccerGameRow[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
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
