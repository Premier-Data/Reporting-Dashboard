// Admin-editable club configuration (Supabase `club_config`).
//
// Overrides/augments the hardcoded Live Scores defaults per club: PlayHQ club
// id, S3/JADE club uid, logo URL, and team colour. The Live Scores UI reads
// these (via the cached getters below) and falls back to the bundled defaults
// in clubLogos.ts when a club has no override. Edited on the Admin
// Configuration page.

import { supabase } from "@/lib/supabase";
import { normaliseClub } from "@/lib/api/clubLogos";

export type ClubConfig = {
  id: number;
  club_key: string;
  display_name: string;
  playhq_club_id: string | null;
  s3_club_uid: number | null;
  logo_url: string | null;
  team_color: string | null;
  competitions: string | null;
};

export type ClubConfigInput = {
  club_key: string;
  display_name?: string;
  playhq_club_id?: string | null;
  s3_club_uid?: number | null;
  logo_url?: string | null;
  team_color?: string | null;
  competitions?: string | null;
};

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listClubConfigs(): Promise<ClubConfig[]> {
  const { data, error } = await supabase
    .from("club_config")
    .select(
      "id, club_key, display_name, playhq_club_id, s3_club_uid, logo_url, team_color, competitions"
    )
    .order("display_name", { ascending: true });
  if (error) {
    console.error("Failed loading club_config:", error);
    throw new Error(error.message || "Failed loading club configuration");
  }
  return (data ?? []) as ClubConfig[];
}

// ── Writes ────────────────────────────────────────────────────────────────

export async function upsertClubConfig(input: ClubConfigInput): Promise<void> {
  const key = normaliseClub(input.club_key);
  if (!key) throw new Error("A club name/key is required.");
  const row = {
    club_key: key,
    display_name: input.display_name ?? "",
    playhq_club_id: input.playhq_club_id?.trim() || null,
    s3_club_uid:
      input.s3_club_uid == null || Number.isNaN(input.s3_club_uid)
        ? null
        : input.s3_club_uid,
    logo_url: input.logo_url?.trim() || null,
    team_color: input.team_color?.trim() || null,
    competitions: input.competitions?.trim() || null,
  };
  const { error } = await supabase
    .from("club_config")
    .upsert(row, { onConflict: "club_key" });
  if (error) {
    console.error("Failed saving club_config:", error);
    throw new Error(error.message || "Failed saving club configuration");
  }
  invalidateClubConfigCache();
}

export async function deleteClubConfig(id: number): Promise<void> {
  const { error } = await supabase.from("club_config").delete().eq("id", id);
  if (error) {
    console.error("Failed deleting club_config:", error);
    throw new Error(error.message || "Failed deleting club configuration");
  }
  invalidateClubConfigCache();
}

// ── Cached override lookup (used by the Live Scores UI) ─────────────────────
//
// The overrides are small and change rarely, so we fetch them once and cache
// by normalised key. The cache is a module-level promise so concurrent callers
// share one request; it's invalidated after any admin write.

let cache: Promise<Map<string, ClubConfig>> | null = null;

async function loadMap(): Promise<Map<string, ClubConfig>> {
  const rows = await listClubConfigs();
  const map = new Map<string, ClubConfig>();
  for (const r of rows) map.set(r.club_key, r);
  return map;
}

/** Prime (or reuse) the override cache. Safe to call repeatedly. */
export function ensureClubConfigCache(): Promise<Map<string, ClubConfig>> {
  if (!cache) {
    cache = loadMap().catch((e) => {
      // On failure, don't poison the cache — reset so a later call retries.
      cache = null;
      throw e;
    });
  }
  return cache;
}

export function invalidateClubConfigCache(): void {
  cache = null;
}

/** The override row for a club name, or null. Resolves the cache first. */
export async function clubConfigFor(
  name: string | null | undefined
): Promise<ClubConfig | null> {
  const key = normaliseClub(name);
  if (!key) return null;
  try {
    const map = await ensureClubConfigCache();
    return map.get(key) ?? null;
  } catch {
    return null; // overrides are best-effort; UI falls back to defaults
  }
}
