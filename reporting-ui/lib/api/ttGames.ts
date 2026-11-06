import { supabase } from "@/lib/supabase";
import type { TTGameRow } from "@/lib/analytics/opsGames";

const PAGE_SIZE = 1000; // Supabase caps a response at 1000 rows

/** Reads every TT_Games row, paginated on a stable key. Throws on error. */
export async function fetchTTGamesForOps(): Promise<TTGameRow[]> {
  const all: TTGameRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("TT_Games")
      .select("game_key,Date,Week,season,home_allocated,away_allocated,Location")
      .order("game_key", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as TTGameRow[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}
