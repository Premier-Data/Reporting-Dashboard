// Supabase-backed competition fixtures: sync from S3 once, then serve fast
// filtered reads to the /comp-fixtures page.
//
// WHY: the S3 comp JSONs (c_<uid>.json) can't be listed and carry their
// sport/season/fixtures INSIDE each file, so filtering by sport/year without a
// cache means downloading all ~440 files. This module mirrors the JSONs into
// Supabase (see migrations/create_comp_fixtures.sql) so:
//   - normal page loads are a single filtered SQL query (no S3),
//   - the expensive S3 sweep happens once (an admin action), and
//   - keeping current is cheap: an INCREMENTAL sync HEAD-checks known comps for
//     changes (via S3 Last-Modified) and probes for NEW comp ids past the
//     highest known one — no full re-download.

import { supabase } from "@/lib/supabase";
import { createKeyedCache } from "@/lib/api/cache";
import {
  compToFixtures,
  fetchCompetitionWithMeta,
  headCompetition,
  isExcludedCompetition,
  isAccuracyCompetition,
  normaliseKeyPart,
  COMP_ID_MIN,
  COMP_ID_MAX,
  type CompFixture,
} from "./comps";

// ---------------------------------------------------------------------------
// Row shapes (mirror the SQL columns).
// ---------------------------------------------------------------------------

export type CompFixtureRow = {
  id: string;
  competition_uid: number;
  competition: string;
  season: number | null;
  sport: string;
  round: string;
  fixture_date: string | null; // ISO date "yyyy-mm-dd"
  fixture_time: string;
  home_team: string;
  away_team: string;
  home_team_uid: number | null;
  away_team_uid: number | null;
  is_final: boolean;
  score: string;
  video_url: string;
  video_name: string;
  game_key: string;
};

export type CompSyncMeta = {
  last_full_sync: string | null;
  last_incremental: string | null;
  max_uid: number | null;
  comp_count: number;
  fixture_count: number;
};

export type CompFixtureFilters = {
  sport?: string; // exact sportName; omit/"all" for any
  season?: number | null; // exact season; omit for any
  competition?: string; // exact competition name; omit/"all" for any
  /** ISO dates (yyyy-mm-dd), inclusive. */
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Free-text across team/competition/round. */
  search?: string;
  /** Competition names to exclude. */
  excludeCompetitions?: string[];
  /**
   * How to treat "Accuracy" comps (e.g. "PD Soccer Accuracy Comp"), which hold
   * the analyst-coded games:
   *   - undefined/false (default): HIDE them — the normal fixture views (Comp
   *     Fixtures, Fixture Review, the master picker) never show accuracy comps.
   *   - true: return ONLY accuracy comps — used by the analyst picker on the
   *     Fixture Accuracy tool.
   */
  accuracyOnly?: boolean;
};

// Convert a CompFixture (from the JSON adapter) into a DB row. `fixture_date`
// is derived from the parsed dateMs so it lands as a real SQL date.
function toRow(f: CompFixture): CompFixtureRow {
  return {
    id: f.id,
    competition_uid: f.competitionUid,
    competition: f.competition,
    season: f.season,
    sport: f.sport,
    round: f.round,
    fixture_date:
      f.dateMs != null ? new Date(f.dateMs).toISOString().slice(0, 10) : null,
    fixture_time: f.time,
    home_team: f.home_team,
    away_team: f.away_team,
    home_team_uid: f.homeTeamUid,
    away_team_uid: f.awayTeamUid,
    is_final: f.isFinal,
    score: f.score,
    video_url: f.videoURL,
    video_name: f.videoName,
    game_key: f.game_key,
  };
}

// ---------------------------------------------------------------------------
// Reads (what the page uses on every load).
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

/**
 * Query fixtures from Supabase with server-side filtering. Only rows matching
 * the active filters come back — this is what makes normal loads fast (no S3).
 * Paginated internally so large result sets still return fully.
 */
export async function queryCompFixtures(
  filters: CompFixtureFilters = {}
): Promise<CompFixtureRow[]> {
  const rows: CompFixtureRow[] = [];
  let from = 0;

  // Build the base query with the equality/range filters applied server-side.
  const build = () => {
    let q = supabase.from("comp_fixtures").select("*");
    if (filters.sport && filters.sport !== "all") {
      q = q.eq("sport", filters.sport);
    }
    if (filters.season != null) {
      q = q.eq("season", filters.season);
    }
    if (filters.competition && filters.competition !== "all") {
      q = q.eq("competition", filters.competition);
    }
    if (filters.dateFrom) q = q.gte("fixture_date", filters.dateFrom);
    if (filters.dateTo) q = q.lte("fixture_date", filters.dateTo);
    if (filters.search && filters.search.trim()) {
      const s = filters.search.trim().replace(/[%,]/g, " ");
      q = q.or(
        [
          `home_team.ilike.%${s}%`,
          `away_team.ilike.%${s}%`,
          `competition.ilike.%${s}%`,
          `round.ilike.%${s}%`,
        ].join(",")
      );
    }
    // fixture_date desc (nulls last), newest first.
    return q.order("fixture_date", { ascending: false, nullsFirst: false });
  };

  while (true) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("queryCompFixtures failed:", error);
      throw new Error(error.message || "Failed loading competition fixtures");
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as CompFixtureRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // Always drop truly-internal comps (practice/test), in case any were synced
  // before that source filter existed.
  let result = rows.filter((r) => !isExcludedCompetition(r.competition));

  // Accuracy comps hold the analyst-coded games: show ONLY them when the caller
  // asks (the analyst picker), and HIDE them from every normal view otherwise.
  result = filters.accuracyOnly
    ? result.filter((r) => isAccuracyCompetition(r.competition))
    : result.filter((r) => !isAccuracyCompetition(r.competition));

  // Client-side user exclusion (small list; keeps the query simple).
  const exclude = new Set(
    (filters.excludeCompetitions ?? []).map((c) => c.trim())
  );
  if (exclude.size > 0) {
    result = result.filter((r) => !exclude.has(r.competition.trim()));
  }
  return result;
}

/**
 * Distinct sports and seasons present in the table, for the filter dropdowns.
 * Supabase's JS client has no GROUP BY, so we page through the two small
 * columns and tally client-side (cheap — only sport + season are selected).
 */
export type CompFacets = {
  sports: { sport: string; count: number }[];
  years: { year: string; count: number }[];
};

// Internal fetcher: full-table facet scan. `key` is "accuracy" or "normal"
// (derived from accuracyOnly) so the two variants cache independently.
async function fetchCompFacets(key: string): Promise<CompFacets> {
  const accuracyOnly = key === "accuracy";
  const sportCounts = new Map<string, number>();
  const yearCounts = new Map<string, number>();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("comp_fixtures")
      .select("sport,season,competition")
      .range(from, from + PAGE_SIZE - 1);
    if (error) break;
    if (!data || data.length === 0) break;
    for (const r of data as {
      sport: string;
      season: number | null;
      competition: string;
    }[]) {
      // Skip truly-internal comps (practice/test) so they don't inflate counts.
      if (isExcludedCompetition(r.competition)) continue;
      // Accuracy comps: count ONLY them when asked, else EXCLUDE them (they
      // don't belong in the normal sport/year dropdowns).
      const isAccuracy = isAccuracyCompetition(r.competition);
      if (accuracyOnly ? !isAccuracy : isAccuracy) continue;
      const s = (r.sport ?? "").trim();
      if (s) sportCounts.set(s, (sportCounts.get(s) ?? 0) + 1);
      if (r.season != null) {
        const y = String(r.season);
        yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
      }
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return {
    sports: Array.from(sportCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([sport, count]) => ({ sport, count })),
    years: Array.from(yearCounts.entries())
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([year, count]) => ({ year, count })),
  };
}

// The facets are session-static: they only change when the comp_fixtures table
// is re-synced, and every such mutation calls compFacetsCached.invalidate().
// Keyed by "accuracy"/"normal" so the two variants don't clobber each other.
// Returned objects are shared READ-ONLY instances (see cache.ts) — the three
// caller pages only read / setState the sports/years arrays, never mutate them.
const compFacetsCached = createKeyedCache(fetchCompFacets, (k) => k);

/**
 * Distinct sports and seasons present in the table, for the filter dropdowns.
 * Supabase's JS client has no GROUP BY, so we page through the two small
 * columns and tally client-side (cheap — only sport + season are selected).
 *
 * Cached once per session per variant; invalidated on any comp-sync mutation.
 */
export async function getCompFacets(
  options: { accuracyOnly?: boolean } = {}
): Promise<CompFacets> {
  return compFacetsCached.get(options.accuracyOnly ? "accuracy" : "normal");
}

/** Current sync state, for the "last synced" display + probe start point. */
export async function getCompSyncMeta(): Promise<CompSyncMeta | null> {
  const { data, error } = await supabase
    .from("comp_sync_meta")
    .select("*")
    .eq("id", true)
    .single();
  if (error) {
    console.error("getCompSyncMeta failed:", error);
    return null;
  }
  return data as CompSyncMeta;
}

/** Total fixtures currently stored — a cheap "is the table populated?" check. */
export async function getCompFixtureCount(): Promise<number> {
  const { count, error } = await supabase
    .from("comp_fixtures")
    .select("id", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Analyst allocations (comp_fixture_assignments).
// ---------------------------------------------------------------------------

// Which team an analyst is allocated to within a fixture. "home"/"away" are the
// two sides; null is a legacy allocation made before sides existed (still a
// valid allocation, just side-unspecified).
export type TeamSide = "home" | "away";

export type CompAssignment = {
  id: number;
  analystName: string;
  teamSide: TeamSide | null;
};

/**
 * Load allocations for a set of fixture ids, grouped by fixture id. Returns a
 * Map so the page can look up a fixture's analysts in O(1). Batches the ids
 * to keep the `in` clause a reasonable size.
 */
export async function getAssignmentsForFixtures(
  fixtureIds: string[]
): Promise<Map<string, CompAssignment[]>> {
  const byFixture = new Map<string, CompAssignment[]>();
  if (fixtureIds.length === 0) return byFixture;

  const CHUNK = 300;
  for (let i = 0; i < fixtureIds.length; i += CHUNK) {
    const slice = fixtureIds.slice(i, i + CHUNK);
    // Try to read team_side. If the column doesn't exist yet (migration not
    // applied), retry without it so the app keeps working — those rows come
    // back with teamSide = null.
    type AssignmentRow = {
      id: number;
      comp_fixture_id: string;
      analyst_name: string;
      team_side?: string | null;
    };
    let rows: AssignmentRow[] = [];

    const withSide = await supabase
      .from("comp_fixture_assignments")
      .select("id,comp_fixture_id,analyst_name,team_side")
      .in("comp_fixture_id", slice);

    if (withSide.error) {
      const legacy = await supabase
        .from("comp_fixture_assignments")
        .select("id,comp_fixture_id,analyst_name")
        .in("comp_fixture_id", slice);
      if (legacy.error) {
        console.error("getAssignmentsForFixtures failed:", legacy.error);
        continue;
      }
      rows = (legacy.data ?? []) as AssignmentRow[];
    } else {
      rows = (withSide.data ?? []) as AssignmentRow[];
    }

    for (const r of rows) {
      const side =
        r.team_side === "home" || r.team_side === "away" ? r.team_side : null;
      const list = byFixture.get(r.comp_fixture_id) ?? [];
      list.push({ id: r.id, analystName: r.analyst_name, teamSide: side });
      byFixture.set(r.comp_fixture_id, list);
    }
  }
  // Stable display order: alphabetical by name.
  for (const list of byFixture.values()) {
    list.sort((a, b) => a.analystName.localeCompare(b.analystName));
  }
  return byFixture;
}

/**
 * Allocate an analyst to a comp fixture. Idempotent: the unique index on
 * (comp_fixture_id, lower(analyst_name)) means re-assigning the same analyst is
 * a no-op rather than a duplicate.
 */
export async function assignCompFixture(
  compFixtureId: string,
  analystName: string,
  teamSide: TeamSide
): Promise<void> {
  const name = analystName.trim();
  if (!name) return;

  // Skip if this analyst is already allocated to this fixture ON THIS SIDE
  // (case-insensitive). The unique index is on
  // (comp_fixture_id, coalesce(team_side,''), lower(analyst_name)), which a
  // column-based upsert can't target, so we guard with an explicit check.
  const { data: existing } = await supabase
    .from("comp_fixture_assignments")
    .select("id")
    .eq("comp_fixture_id", compFixtureId)
    .eq("team_side", teamSide)
    .ilike("analyst_name", name)
    .limit(1);
  if (existing && existing.length > 0) return;

  const { error } = await supabase
    .from("comp_fixture_assignments")
    .insert({
      comp_fixture_id: compFixtureId,
      analyst_name: name,
      team_side: teamSide,
    });
  if (error) {
    console.error("assignCompFixture failed:", error);
    throw new Error(error.message || "Failed allocating analyst");
  }
}

// One comp-fixture allocation joined to its fixture, in a shape the analyst
// profile can merge with TT_Games. The allocated analyst's name is placed on
// home_allocated / away_allocated according to the side, so the profile's
// existing "on either side" logic picks it up unchanged.
export type CompAllocationGame = {
  game_key: string;
  Week: string;
  Date: string;
  Competition: string;
  Round: string;
  home_team: string;
  away_team: string;
  home_allocated: string | null;
  away_allocated: string | null;
  videoURL: string;
};

/**
 * Fetch every comp-fixture analyst allocation, joined to its fixture, as
 * profile-ready rows (one per allocation). Used to MERGE comp allocations into
 * the analyst profile so a fixture appears when the analyst is on either side.
 *
 * Legacy allocations (team_side null) default to the home side. Rows whose
 * fixture is missing from comp_fixtures are skipped. This reads the whole
 * allocation set (it's small relative to comp_fixtures) plus the referenced
 * fixtures; it does no S3 work.
 */
export async function getCompAllocationGames(): Promise<CompAllocationGame[]> {
  // 1) Load all allocations. Tolerate the team_side column being absent.
  type AllocRow = {
    comp_fixture_id: string;
    analyst_name: string;
    team_side?: string | null;
  };
  let allocs: AllocRow[] = [];
  const withSide = await supabase
    .from("comp_fixture_assignments")
    .select("comp_fixture_id,analyst_name,team_side");
  if (withSide.error) {
    const legacy = await supabase
      .from("comp_fixture_assignments")
      .select("comp_fixture_id,analyst_name");
    if (legacy.error) {
      console.error("getCompAllocationGames: allocations failed", legacy.error);
      return [];
    }
    allocs = (legacy.data ?? []) as AllocRow[];
  } else {
    allocs = (withSide.data ?? []) as AllocRow[];
  }
  if (allocs.length === 0) return [];

  // 2) Load the referenced fixtures (batched by id).
  const ids = Array.from(new Set(allocs.map((a) => a.comp_fixture_id)));
  const fixtureById = new Map<string, CompFixtureRow>();
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("comp_fixtures")
      .select("*")
      .in("id", slice);
    if (error) {
      console.error("getCompAllocationGames: fixtures failed", error);
      continue;
    }
    for (const r of (data ?? []) as CompFixtureRow[]) {
      fixtureById.set(r.id, r);
    }
  }

  // 3) Build one profile row per allocation, placing the analyst on the
  //    allocated side.
  const out: CompAllocationGame[] = [];
  for (const a of allocs) {
    const fx = fixtureById.get(a.comp_fixture_id);
    if (!fx) continue;
    const side = a.team_side === "away" ? "away" : "home"; // null → home
    out.push({
      game_key: fx.game_key,
      Week: "",
      Date: fx.fixture_date ?? "",
      Competition: fx.competition,
      Round: fx.round,
      home_team: fx.home_team,
      away_team: fx.away_team,
      home_allocated: side === "home" ? a.analyst_name : null,
      away_allocated: side === "away" ? a.analyst_name : null,
      videoURL: fx.video_url,
    });
  }
  return out;
}

/**
 * The set of match video URLs allocated to a given analyst (either side),
 * normalised lower-case for matching. Used by Fixture Review's "my allocated
 * fixtures" filter to show only games the logged-in analyst is on. Empty set
 * when the name is blank or has no allocations.
 */
export async function getAllocatedVideoUrlsForAnalyst(
  analystName: string
): Promise<Set<string>> {
  const name = analystName.trim().toLowerCase();
  const out = new Set<string>();
  if (!name) return out;

  const games = await getCompAllocationGames();
  for (const g of games) {
    const allocated =
      (g.home_allocated ?? "").trim().toLowerCase() === name ||
      (g.away_allocated ?? "").trim().toLowerCase() === name;
    if (allocated && g.videoURL) {
      out.add(g.videoURL.trim().toLowerCase());
    }
  }
  return out;
}

/** Remove one analyst allocation from a comp fixture (by allocation id). */
export async function unassignCompFixture(assignmentId: number): Promise<void> {
  const { error } = await supabase
    .from("comp_fixture_assignments")
    .delete()
    .eq("id", assignmentId);
  if (error) {
    console.error("unassignCompFixture failed:", error);
    throw new Error(error.message || "Failed removing allocation");
  }
}

// ---------------------------------------------------------------------------
// Writes / sync (admin actions; the expensive part happens here, not on load).
// ---------------------------------------------------------------------------

export type SyncProgress = {
  phase: "existing" | "probing" | "writing";
  done: number;
  total: number;
  found: number; // comps found/changed this run
  fixtures: number; // fixtures upserted this run
};

// Upsert one competition's fixtures, replacing any previous rows for it. We
// delete-then-insert per comp so removed fixtures don't linger (a comp's set
// can shrink if the source corrects a mistake).
async function upsertCompFixtures(
  competitionUid: number,
  fixtures: CompFixture[]
): Promise<number> {
  // Remove existing rows for this comp, then insert the fresh set.
  const { error: delErr } = await supabase
    .from("comp_fixtures")
    .delete()
    .eq("competition_uid", competitionUid);
  if (delErr) {
    console.error(`Failed clearing comp ${competitionUid}:`, delErr);
    throw new Error(delErr.message || "Failed clearing competition fixtures");
  }
  if (fixtures.length === 0) return 0;

  const rows = fixtures.map(toRow);
  // Insert in chunks to stay under payload limits.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: insErr } = await supabase
      .from("comp_fixtures")
      .insert(rows.slice(i, i + CHUNK));
    if (insErr) {
      console.error(`Failed inserting comp ${competitionUid}:`, insErr);
      throw new Error(insErr.message || "Failed inserting competition fixtures");
    }
  }
  return rows.length;
}

// Record a comp file's source metadata (existence + Last-Modified) so the next
// incremental sync can skip unchanged comps and detect missing ones.
async function upsertSource(row: {
  competition_uid: number;
  status: "ok" | "missing" | "error";
  last_modified: string | null;
  sport: string | null;
  season: number | null;
  name: string | null;
  fixture_count: number;
  fetched: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("comp_sources").upsert(
    {
      competition_uid: row.competition_uid,
      status: row.status,
      last_modified: row.last_modified,
      sport: row.sport,
      season: row.season,
      name: row.name,
      fixture_count: row.fixture_count,
      checked_at: now,
      fetched_at: row.fetched ? now : undefined,
    },
    { onConflict: "competition_uid" }
  );
  if (error) console.error(`Failed upserting source ${row.competition_uid}:`, error);
}

// Fetch + store a single comp. Returns fixtures written (0 if missing).
async function syncOne(
  uid: number,
  signal?: AbortSignal
): Promise<{ status: "ok" | "missing" | "error"; fixtures: number }> {
  const res = await fetchCompetitionWithMeta(uid, signal);
  if (res.status !== "ok" || !res.competition) {
    await upsertSource({
      competition_uid: uid,
      status: res.status,
      last_modified: res.lastModified,
      sport: null,
      season: null,
      name: null,
      fixture_count: 0,
      fetched: false,
    });
    return { status: res.status, fixtures: 0 };
  }
  const comp = res.competition;
  const fixtures = compToFixtures(comp);
  const written = await upsertCompFixtures(uid, fixtures);
  await upsertSource({
    competition_uid: uid,
    status: "ok",
    last_modified: res.lastModified,
    sport: comp.sportName ?? null,
    season: typeof comp.season === "number" ? comp.season : null,
    name: comp.name ?? null,
    fixture_count: written,
    fetched: true,
  });
  return { status: "ok", fixtures: written };
}

// Run `worker` over `ids` with bounded concurrency.
async function runPool(
  ids: number[],
  concurrency: number,
  worker: (uid: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let cursor = 0;
  async function run() {
    while (cursor < ids.length) {
      if (signal?.aborted) return;
      const uid = ids[cursor++];
      await worker(uid);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, () => run())
  );
}

export type TeamLinkResult = {
  /** Distinct (uid, name) team pairs seen in comp_fixtures. */
  seen: number;
  /** Existing teams that had their team_uid filled in by a name match. */
  linked: number;
  /** New team rows created for comp teams with no name match. */
  created: number;
};

/**
 * Link competition teams to the `teams` table via the external UID.
 *
 * The comp JSONs give each team a stable external UID (home_team_uid /
 * away_team_uid) plus a name. This reconciles those into `teams`:
 *   1. If a team already carries that team_uid → nothing to do.
 *   2. Else if a team's NAME matches (normalised) → set its team_uid (links the
 *      UID onto the existing team, no duplicate).
 *   3. Else → create a new team row { team_name, team_uid }.
 *
 * After this, comp_fixtures.home_team_uid / away_team_uid join directly to
 * teams.team_uid. Reads the team pairs straight from comp_fixtures so it also
 * back-fills any rows synced before linking existed. Requires the team_uid
 * column (migrations/add_team_uid_to_teams.sql).
 */
export async function linkTeamUids(): Promise<TeamLinkResult> {
  // 1) Collect distinct (uid, name) pairs from comp_fixtures (home + away).
  //    First non-empty name seen for a uid wins (names are consistent per uid).
  const pairs = new Map<number, string>();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("comp_fixtures")
      .select("home_team,home_team_uid,away_team,away_team_uid")
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as {
      home_team: string;
      home_team_uid: number | null;
      away_team: string;
      away_team_uid: number | null;
    }[]) {
      if (r.home_team_uid != null && !pairs.has(r.home_team_uid)) {
        pairs.set(r.home_team_uid, (r.home_team ?? "").trim());
      }
      if (r.away_team_uid != null && !pairs.has(r.away_team_uid)) {
        pairs.set(r.away_team_uid, (r.away_team ?? "").trim());
      }
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (pairs.size === 0) return { seen: 0, linked: 0, created: 0 };

  // 2) Load existing teams: which UIDs are already set, and a name -> id map
  //    for name matching (normalised the same way as everywhere else).
  const existingUids = new Set<number>();
  const idByName = new Map<string, number>();
  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("teams")
      .select("id,team_name,team_uid")
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    for (const t of data as {
      id: number;
      team_name: string;
      team_uid: number | null;
    }[]) {
      if (t.team_uid != null) existingUids.add(t.team_uid);
      const key = normaliseKeyPart(t.team_name);
      if (key && !idByName.has(key)) idByName.set(key, t.id);
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  let linked = 0;
  let created = 0;
  const toInsert: { team_name: string; team_uid: number }[] = [];

  for (const [uid, name] of pairs) {
    if (existingUids.has(uid)) continue; // already linked
    const key = normaliseKeyPart(name);
    const matchId = key ? idByName.get(key) : undefined;
    if (matchId != null) {
      // Fill the UID onto the existing team (by name match).
      const { error } = await supabase
        .from("teams")
        .update({ team_uid: uid })
        .eq("id", matchId);
      if (!error) {
        linked += 1;
        existingUids.add(uid);
      }
    } else if (name) {
      // No name match — queue a new team row for this comp team.
      toInsert.push({ team_name: name, team_uid: uid });
    }
  }

  // 3) Create new teams for unmatched comp teams (batched). Upsert on team_name
  //    so a concurrent/duplicate name can't violate the unique constraint.
  if (toInsert.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const { error } = await supabase
        .from("teams")
        .upsert(toInsert.slice(i, i + CHUNK), { onConflict: "team_name" });
      if (!error) created += Math.min(CHUNK, toInsert.length - i);
    }
  }

  return { seen: pairs.size, linked, created };
}

/**
 * Remove any already-stored internal/non-real comps (practice/test/accuracy)
 * from the table. New syncs never insert them (compToFixtures skips them), but
 * this cleans up rows synced before that filter existed. Fetches the distinct
 * competition names, then deletes rows for the ones that match.
 */
export async function purgeExcludedCompetitions(): Promise<number> {
  const names = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("comp_fixtures")
      .select("competition")
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as { competition: string }[]) {
      if (isExcludedCompetition(r.competition)) names.add(r.competition);
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  let removed = 0;
  for (const name of names) {
    const { error, count } = await supabase
      .from("comp_fixtures")
      .delete({ count: "exact" })
      .eq("competition", name);
    if (!error) removed += count ?? 0;
  }
  // Deleted rows → cached facets may be stale.
  if (removed > 0) compFacetsCached.invalidate();
  return removed;
}

/**
 * FULL SYNC — sweep the whole known range (plus a probe tail past the last id),
 * fetching every comp and replacing its fixtures. This is the one-time
 * expensive operation; run it to first populate the table (or to rebuild).
 */
export async function fullSync(opts?: {
  onProgress?: (p: SyncProgress) => void;
  concurrency?: number;
  signal?: AbortSignal;
  min?: number;
  max?: number;
  /** Consecutive misses past `max` before the probe stops. */
  probeGap?: number;
}): Promise<{ comps: number; fixtures: number; maxUid: number }> {
  const min = opts?.min ?? COMP_ID_MIN;
  const max = opts?.max ?? COMP_ID_MAX;
  const concurrency = Math.max(1, opts?.concurrency ?? 8);

  const ids: number[] = [];
  for (let i = min; i <= max; i++) ids.push(i);

  const total = ids.length;
  let done = 0;
  let found = 0;
  let fixtures = 0;
  let maxUid = 0;

  await runPool(
    ids,
    concurrency,
    async (uid) => {
      const r = await syncOne(uid, opts?.signal);
      done += 1;
      if (r.status === "ok") {
        found += 1;
        fixtures += r.fixtures;
        if (uid > maxUid) maxUid = uid;
      }
      opts?.onProgress?.({ phase: "existing", done, total, found, fixtures });
    },
    opts?.signal
  );

  // Probe for NEW comps past the highest known id (ids look sequential; stop
  // after `probeGap` consecutive misses).
  const probeGap = opts?.probeGap ?? 15;
  let uid = Math.max(max, maxUid) + 1;
  let misses = 0;
  while (misses < probeGap) {
    if (opts?.signal?.aborted) break;
    const r = await syncOne(uid, opts?.signal);
    if (r.status === "ok") {
      found += 1;
      fixtures += r.fixtures;
      maxUid = uid;
      misses = 0;
      opts?.onProgress?.({
        phase: "probing",
        done: done + 1,
        total: total + 1,
        found,
        fixtures,
      });
    } else if (r.status === "missing") {
      misses += 1;
    } else {
      // transient error — count as a miss but don't hammer.
      misses += 1;
    }
    uid += 1;
  }

  // Clean up any previously-synced internal comps (defensive; new inserts
  // already skip them).
  await purgeExcludedCompetitions();
  // Link competition teams to the `teams` table via their external UID.
  await linkTeamUids();
  await writeMeta({ full: true, maxUid, compCount: found, fixtureCount: fixtures });
  // Table contents changed → drop the cached facets so the next read re-tallies.
  compFacetsCached.invalidate();
  return { comps: found, fixtures, maxUid };
}

/**
 * INCREMENTAL SYNC — cheap "keep current" pass:
 *   1. HEAD every known comp; refetch only those whose Last-Modified changed.
 *   2. Probe for NEW comp ids past the highest known one.
 * This is what a scheduled/regular job (or an on-load-if-stale trigger) runs.
 */
/**
 * Force a re-fetch + re-store of specific competition uids, ignoring the
 * HEAD/last-modified short-circuit that incrementalSync uses. Needed when the
 * PARSING rules change (not the source file) — e.g. accuracy comps that were
 * previously dropped by compToFixtures and so never written, even though their
 * S3 file is unchanged. Returns per-uid fixture counts.
 */
export async function resyncCompetitions(
  uids: number[],
  signal?: AbortSignal
): Promise<{ uid: number; status: string; fixtures: number }[]> {
  const out: { uid: number; status: string; fixtures: number }[] = [];
  for (const uid of uids) {
    if (signal?.aborted) break;
    const r = await syncOne(uid, signal);
    out.push({ uid, status: r.status, fixtures: r.fixtures });
  }
  // Re-stored one or more comps → cached facets may be stale.
  compFacetsCached.invalidate();
  return out;
}

export async function incrementalSync(opts?: {
  onProgress?: (p: SyncProgress) => void;
  concurrency?: number;
  signal?: AbortSignal;
  probeGap?: number;
}): Promise<{ changed: number; added: number; fixtures: number; maxUid: number }> {
  const concurrency = Math.max(1, opts?.concurrency ?? 8);

  // Load known sources (uid + last_modified) to diff against.
  const known = new Map<number, string | null>();
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("comp_sources")
        .select("competition_uid,last_modified,status")
        .range(from, from + PAGE_SIZE - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data as {
        competition_uid: number;
        last_modified: string | null;
        status: string;
      }[]) {
        if (r.status === "ok") known.set(r.competition_uid, r.last_modified);
      }
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  const knownIds = Array.from(known.keys()).sort((a, b) => a - b);
  const total = knownIds.length;
  let done = 0;
  let changed = 0;
  let fixtures = 0;

  // 1) HEAD-check known comps; refetch changed ones.
  await runPool(
    knownIds,
    concurrency,
    async (uid) => {
      const head = await headCompetition(uid, opts?.signal);
      done += 1;
      // Decide whether to refetch this comp:
      //  - HEAD ok + Last-Modified changed  → definitely changed, refetch.
      //  - HEAD ok but no Last-Modified     → can't compare, refetch to be safe.
      //  - HEAD "error" (e.g. CORS blocks HEAD on the S3 object in the browser,
      //    or a transient failure) → can't tell, refetch rather than silently
      //    skip. A GET works even when HEAD doesn't, so this self-heals the
      //    case where an edited comp was being missed.
      // Only a definitive "missing" (403/404 → the file doesn't exist) is
      // skipped, since there's nothing to fetch.
      const refetch =
        (head.status === "ok" &&
          (head.lastModified == null ||
            head.lastModified !== known.get(uid))) ||
        head.status === "error";
      if (refetch) {
        const r = await syncOne(uid, opts?.signal);
        if (r.status === "ok") {
          changed += 1;
          fixtures += r.fixtures;
        }
      }
      opts?.onProgress?.({
        phase: "existing",
        done,
        total,
        found: changed,
        fixtures,
      });
    },
    opts?.signal
  );

  // 2) Probe for NEW comps past the current max.
  const meta = await getCompSyncMeta();
  const startFrom =
    (meta?.max_uid ?? (knownIds.length ? knownIds[knownIds.length - 1] : COMP_ID_MAX)) +
    1;
  const probeGap = opts?.probeGap ?? 15;
  let uid = startFrom;
  let misses = 0;
  let added = 0;
  let maxUid = meta?.max_uid ?? COMP_ID_MAX;
  while (misses < probeGap) {
    if (opts?.signal?.aborted) break;
    const r = await syncOne(uid, opts?.signal);
    if (r.status === "ok") {
      added += 1;
      fixtures += r.fixtures;
      maxUid = uid;
      misses = 0;
      opts?.onProgress?.({
        phase: "probing",
        done,
        total,
        found: changed + added,
        fixtures,
      });
    } else {
      misses += 1;
    }
    uid += 1;
  }

  await purgeExcludedCompetitions();
  await linkTeamUids();
  await writeMeta({
    full: false,
    maxUid,
    // comp_count/fixture_count reflect the whole table, recomputed below.
  });
  // Table contents may have changed (refetched/added comps) → drop the cache.
  compFacetsCached.invalidate();
  return { changed, added, fixtures, maxUid };
}

// Update the singleton meta row. On a full sync we set the totals directly; on
// incremental we recompute the table totals so the display stays accurate.
async function writeMeta(args: {
  full: boolean;
  maxUid: number;
  compCount?: number;
  fixtureCount?: number;
}): Promise<void> {
  const now = new Date().toISOString();

  let compCount = args.compCount;
  let fixtureCount = args.fixtureCount;
  if (compCount == null || fixtureCount == null) {
    fixtureCount = await getCompFixtureCount();
    const { count } = await supabase
      .from("comp_sources")
      .select("competition_uid", { count: "exact", head: true })
      .eq("status", "ok");
    compCount = count ?? 0;
  }

  const patch: Record<string, unknown> = {
    id: true,
    max_uid: args.maxUid,
    comp_count: compCount,
    fixture_count: fixtureCount,
  };
  if (args.full) patch.last_full_sync = now;
  else patch.last_incremental = now;

  const { error } = await supabase
    .from("comp_sync_meta")
    .upsert(patch, { onConflict: "id" });
  if (error) console.error("writeMeta failed:", error);
}
