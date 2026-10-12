// Admin-editable club configuration (Supabase `club_config`).
//
// Overrides/augments the hardcoded Live Scores defaults per club: PlayHQ club
// id, S3/JADE club uid, logo URL, and team colour. The Live Scores UI reads
// these (via the cached getters below) and falls back to the bundled defaults
// in clubLogos.ts when a club has no override. Edited on the Admin
// Configuration page.

import { supabase } from "@/lib/supabase";
import { normaliseClub } from "@/lib/api/clubLogos";
import {
  getGradeGames,
  sides,
  isLive,
  LIVE_SCORE_GRADES,
} from "@/lib/api/playhq";
import { resolveJadeUidForGame } from "@/lib/api/matchReport";
import { fetchFixtureReport } from "@/lib/api/fixtureReports";

export type ClubConfig = {
  id: number;
  club_key: string;
  display_name: string;
  playhq_club_id: string | null;
  s3_club_uid: number | null;
  logo_url: string | null;
  /** @deprecated kept for back-compat; use primary_color. */
  team_color: string | null;
  /** Number-square BACKGROUND on the Players stats tab. */
  primary_color: string | null;
  /** Number TEXT colour on the Players stats tab. */
  secondary_color: string | null;
  competitions: string | null;
};

export type ClubConfigInput = {
  club_key: string;
  display_name?: string;
  playhq_club_id?: string | null;
  s3_club_uid?: number | null;
  logo_url?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  competitions?: string | null;
};

/** The effective primary colour (new column, falling back to legacy team_color). */
export function primaryColorOf(cfg: ClubConfig | null | undefined): string | null {
  return cfg?.primary_color ?? cfg?.team_color ?? null;
}
export function secondaryColorOf(cfg: ClubConfig | null | undefined): string | null {
  return cfg?.secondary_color ?? null;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listClubConfigs(): Promise<ClubConfig[]> {
  const withColors =
    "id, club_key, display_name, playhq_club_id, s3_club_uid, logo_url, team_color, primary_color, secondary_color, competitions";
  const legacy =
    "id, club_key, display_name, playhq_club_id, s3_club_uid, logo_url, team_color, competitions";

  const first = await supabase
    .from("club_config")
    .select(withColors)
    .order("display_name", { ascending: true });

  let data: unknown = first.data;
  let error = first.error;

  // If the colour columns haven't been migrated yet, fall back to the legacy
  // select so the page still works (primary falls back to team_color).
  if (error && /primary_color|secondary_color/.test(error.message || "")) {
    const retry = await supabase
      .from("club_config")
      .select(legacy)
      .order("display_name", { ascending: true });
    data = retry.data;
    error = retry.error;
  }
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
  const primary = input.primary_color?.trim() || null;
  const row = {
    club_key: key,
    display_name: input.display_name ?? "",
    playhq_club_id: input.playhq_club_id?.trim() || null,
    s3_club_uid:
      input.s3_club_uid == null || Number.isNaN(input.s3_club_uid)
        ? null
        : input.s3_club_uid,
    logo_url: input.logo_url?.trim() || null,
    primary_color: primary,
    secondary_color: input.secondary_color?.trim() || null,
    // Keep the legacy column in sync with the primary so older readers still work.
    team_color: primary,
    competitions: input.competitions?.trim() || null,
  };
  let { error } = await supabase
    .from("club_config")
    .upsert(row, { onConflict: "club_key" });

  // If the colour columns aren't migrated yet, retry without them (primary
  // still lands in the legacy team_color so the Players tab background works).
  if (error && /primary_color|secondary_color/.test(error.message || "")) {
    const { primary_color, secondary_color, ...legacyRow } = row;
    void primary_color;
    void secondary_color;
    ({ error } = await supabase
      .from("club_config")
      .upsert(legacyRow, { onConflict: "club_key" }));
  }
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

// ── Auto-populate from the live feeds ───────────────────────────────────────
//
// Everything the admin would otherwise type is already in the feeds:
//   - PlayHQ club id  → the team id on the PlayHQ game (per grade/competitor)
//   - S3 / JADE uid   → homeClubUid / awayClubUid on the fixture report
//   - logo URL        → myHomeTeamImage / myAwayTeamImage .imageFilename
// This walks every configured grade's finalised games, resolves each to its
// S3 report, and harvests those three fields per club (keyed by normalised
// name). It fills ONLY blank fields on existing rows (never clobbers an admin
// edit) and creates rows for new clubs. Returns a per-club summary.

export type DiscoveredClub = {
  club_key: string;
  display_name: string;
  playhq_club_id: string | null;
  s3_club_uid: number | null;
  logo_url: string | null;
  /** Competition labels this club was seen in (e.g. "NTFL Men's, NTFL Women's"). */
  competitions: string | null;
};

/**
 * Harvest club ids + logos from the PlayHQ grades and their S3 reports. Does no
 * writes — returns what it found so the caller can preview / merge. `onProgress`
 * reports coarse progress (0..1) for a UI spinner.
 */
export async function discoverClubsFromFeeds(
  onProgress?: (done: number, total: number) => void
): Promise<DiscoveredClub[]> {
  const byKey = new Map<string, DiscoveredClub>();
  // Competition labels seen per club (dedup set), joined into `competitions`.
  const comps = new Map<string, Set<string>>();

  const ensure = (name: string, compLabel?: string): DiscoveredClub => {
    const key = normaliseClub(name);
    let d = byKey.get(key);
    if (!d) {
      d = {
        club_key: key,
        display_name: name.trim(),
        playhq_club_id: null,
        s3_club_uid: null,
        logo_url: null,
        competitions: null,
      };
      byKey.set(key, d);
    }
    if (compLabel) {
      const set = comps.get(key) ?? new Set<string>();
      set.add(compLabel);
      comps.set(key, set);
      d.competitions = Array.from(set).join(", ");
    }
    return d;
  };

  // 1) Gather all games across grades, recording PlayHQ team ids per club.
  const allGames: { game: Awaited<ReturnType<typeof getGradeGames>>[number] }[] =
    [];
  for (const grade of LIVE_SCORE_GRADES) {
    let games: Awaited<ReturnType<typeof getGradeGames>> = [];
    try {
      games = await getGradeGames(grade.gradeId);
    } catch {
      continue; // skip a grade that fails to load
    }
    for (const game of games) {
      const { home, away } = sides(game);
      if (home?.name && home.id) {
        const d = ensure(home.name, grade.label);
        if (!d.playhq_club_id) d.playhq_club_id = home.id;
      }
      if (away?.name && away.id) {
        const d = ensure(away.name, grade.label);
        if (!d.playhq_club_id) d.playhq_club_id = away.id;
      }
      allGames.push({ game });
    }
  }

  // 2) For finalised games, resolve the S3 report and harvest club uid + logo.
  //    We only need ONE report per club, so stop touching a game once both of
  //    its clubs have a uid+logo.
  const finals = allGames
    .map((x) => x.game)
    .filter((g) => !isLive(g.status));
  const total = finals.length;
  let done = 0;

  for (const game of finals) {
    const { home, away } = sides(game);
    const hKey = home?.name ? normaliseClub(home.name) : null;
    const aKey = away?.name ? normaliseClub(away.name) : null;
    const needs = (key: string | null) => {
      if (!key) return false;
      const d = byKey.get(key);
      return !d || d.s3_club_uid == null || !d.logo_url;
    };
    if (needs(hKey) || needs(aKey)) {
      try {
        const uid = await resolveJadeUidForGame(game);
        if (uid != null) {
          const report = (await fetchFixtureReport(uid, {
            cache: "force-cache",
          })) as Record<string, unknown>;
          const homeName = String(report.homeTeamName ?? home?.name ?? "");
          const awayName = String(report.awayTeamName ?? away?.name ?? "");
          const homeImg = (report.myHomeTeamImage as { imageFilename?: string } | undefined)
            ?.imageFilename;
          const awayImg = (report.myAwayTeamImage as { imageFilename?: string } | undefined)
            ?.imageFilename;
          if (homeName) {
            const d = ensure(homeName);
            if (d.s3_club_uid == null && report.homeClubUid != null)
              d.s3_club_uid = Number(report.homeClubUid) || null;
            if (!d.logo_url && homeImg) d.logo_url = homeImg;
          }
          if (awayName) {
            const d = ensure(awayName);
            if (d.s3_club_uid == null && report.awayClubUid != null)
              d.s3_club_uid = Number(report.awayClubUid) || null;
            if (!d.logo_url && awayImg) d.logo_url = awayImg;
          }
        }
      } catch {
        // skip games whose report can't be resolved/fetched
      }
    }
    done += 1;
    onProgress?.(done, total);
  }

  return Array.from(byKey.values()).sort((a, b) =>
    a.display_name.localeCompare(b.display_name)
  );
}
