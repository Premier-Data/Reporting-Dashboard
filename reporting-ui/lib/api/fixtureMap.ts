// PlayHQ fixture → JADE (S3) fixture uid mapping (Supabase `fixture_map`).
//
// The stats/team-list resolver (matchReport.resolveJadeUidForGame) consults
// this first: a stored row with a uid is used verbatim; a stored row with a
// NULL uid means "intentionally no report — don't auto-match" (an admin
// suppressed a bad match); no row at all means "fall back to the automatic
// name/round matcher". Edited on the Admin Configuration page.

import { supabase } from "@/lib/supabase";

export type FixtureMapRow = {
  id: number;
  playhq_game_id: string;
  jade_fixture_uid: number | null;
  grade_key: string | null;
  label: string | null;
  source: string; // 'auto' | 'manual'
};

export type FixtureMapInput = {
  playhq_game_id: string;
  jade_fixture_uid: number | null;
  grade_key?: string | null;
  label?: string | null;
  source?: "auto" | "manual";
};

// A stored mapping entry as the resolver sees it: whether a row exists, and the
// uid it carries (null = suppressed).
export type MappingEntry = { present: true; uid: number | null } | { present: false };

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listFixtureMap(): Promise<FixtureMapRow[]> {
  const { data, error } = await supabase
    .from("fixture_map")
    .select("id, playhq_game_id, jade_fixture_uid, grade_key, label, source");
  if (error) {
    console.error("Failed loading fixture_map:", error);
    throw new Error(error.message || "Failed loading fixture mapping");
  }
  return (data ?? []) as FixtureMapRow[];
}

// ── Writes ────────────────────────────────────────────────────────────────

export async function upsertFixtureMap(input: FixtureMapInput): Promise<void> {
  const id = input.playhq_game_id.trim();
  if (!id) throw new Error("A PlayHQ game id is required.");
  const row = {
    playhq_game_id: id,
    jade_fixture_uid:
      input.jade_fixture_uid == null || Number.isNaN(input.jade_fixture_uid)
        ? null
        : input.jade_fixture_uid,
    grade_key: input.grade_key?.trim() || null,
    label: input.label?.trim() || null,
    source: input.source ?? "manual",
  };
  const { error } = await supabase
    .from("fixture_map")
    .upsert(row, { onConflict: "playhq_game_id" });
  if (error) {
    console.error("Failed saving fixture_map:", error);
    throw new Error(error.message || "Failed saving fixture mapping");
  }
  invalidateFixtureMapCache();
}

export async function deleteFixtureMap(id: number): Promise<void> {
  const { error } = await supabase.from("fixture_map").delete().eq("id", id);
  if (error) {
    console.error("Failed deleting fixture_map:", error);
    throw new Error(error.message || "Failed deleting fixture mapping");
  }
  invalidateFixtureMapCache();
}

// ── Cached lookup (used by the resolver) ────────────────────────────────────

let cache: Promise<Map<string, number | null>> | null = null;

async function loadMap(): Promise<Map<string, number | null>> {
  const rows = await listFixtureMap();
  const map = new Map<string, number | null>();
  for (const r of rows) map.set(r.playhq_game_id, r.jade_fixture_uid);
  return map;
}

export function ensureFixtureMapCache(): Promise<Map<string, number | null>> {
  if (!cache) {
    cache = loadMap().catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}

export function invalidateFixtureMapCache(): void {
  cache = null;
}

/**
 * The stored mapping for a PlayHQ game id. `present:false` → no override, use
 * the automatic matcher. `present:true, uid` → use it (uid null = suppressed).
 * Best-effort: on any error returns `present:false` so the resolver falls back.
 */
export async function mappingFor(playhqGameId: string): Promise<MappingEntry> {
  try {
    const map = await ensureFixtureMapCache();
    if (map.has(playhqGameId)) {
      return { present: true, uid: map.get(playhqGameId) ?? null };
    }
    return { present: false };
  } catch {
    return { present: false };
  }
}

// ── Admin fixture-mapping listing ───────────────────────────────────────────

export type FixtureMapping = {
  playhqGameId: string;
  gradeKey: string;
  label: string; // "Round 2 — St Mary's vs Wanderers"
  isFinal: boolean;
  storedUid: number | null; // from fixture_map (null = suppressed OR not stored)
  hasStored: boolean; // whether a fixture_map row exists for this game
  autoUid: number | null; // what the automatic matcher resolves
};

/**
 * List a grade's PlayHQ fixtures with both the stored override and the
 * automatic resolution, for the Admin mapping table. Resolving the auto uid
 * for every game hits comp_fixtures per game, so this is intended for one grade
 * at a time (the admin picks a competition).
 */
export async function listFixturesForMapping(
  gradeKey: string
): Promise<FixtureMapping[]> {
  // Lazy imports to avoid pulling the heavy resolver into every caller.
  const { getGradeGames, sides, isLive, LIVE_SCORE_GRADES } = await import(
    "@/lib/api/playhq"
  );
  const { autoResolveJadeUidForGame } = await import("@/lib/api/matchReport");

  const grade = LIVE_SCORE_GRADES.find((g) => g.key === gradeKey);
  if (!grade) return [];

  const [games, stored] = await Promise.all([
    getGradeGames(grade.gradeId),
    listFixtureMap(),
  ]);
  const storedByGame = new Map(stored.map((r) => [r.playhq_game_id, r]));

  const out: FixtureMapping[] = [];
  for (const game of games) {
    const { home, away } = sides(game);
    const label = `${game.round?.name ?? ""} — ${home?.name ?? "?"} vs ${
      away?.name ?? "?"
    }`.trim();
    const row = storedByGame.get(game.id);
    // Only auto-resolve FINAL games (upcoming have no report yet) to keep this
    // bounded and meaningful.
    const autoUid = isLive(game.status)
      ? null
      : await autoResolveJadeUidForGame(game);
    out.push({
      playhqGameId: game.id,
      gradeKey,
      label,
      isFinal: String(game.status).toUpperCase() === "FINAL",
      storedUid: row?.jade_fixture_uid ?? null,
      hasStored: !!row,
      autoUid,
    });
  }
  // Order by round number then label.
  const roundNum = (s: string) => {
    const m = s.match(/(\d+)/);
    return m ? Number(m[1]) : 9999;
  };
  return out.sort(
    (a, b) => roundNum(a.label) - roundNum(b.label) || a.label.localeCompare(b.label)
  );
}
