// Competitor Intelligence data layer (Supabase).
//
// - competitors:        the register of market competitors.
// - competitor_sources: per-competitor links (website / youtube / socials).
// - competitor_posts:   items auto-collected by the worker from rss/youtube.
//
// Social platforms (x/instagram/facebook/linkedin/tiktok) have no free,
// compliant way to auto-detect new posts, so they're stored as `manual`
// sources — the UI shows a one-click "open profile" link + last_reviewed.
// Only rss/youtube sources are polled into competitor_posts.

import { supabase } from "@/lib/supabase";

export type CompetitorCategory =
  | "direct"
  | "adjacent"
  | "emerging"
  | "technology"
  | "partner";

export type CollectionMethod = "rss" | "youtube" | "manual";

export type SourcePlatform =
  | "website"
  | "blog"
  | "youtube"
  | "x"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "tiktok";

export type Competitor = {
  id: number;
  created_at: string;
  updated_at: string;
  name: string;
  website: string | null;
  sport: string | null;
  category: CompetitorCategory;
  priority: "high" | "medium" | "low";
  country: string | null;
  description: string | null;
  notes: string | null;
  status: "active" | "archived";
};

export type CompetitorSource = {
  id: number;
  competitor_id: number;
  platform: SourcePlatform;
  profile_url: string;
  feed_url: string | null;
  collection_method: CollectionMethod;
  last_checked_at: string | null;
  last_status: string | null;
  last_reviewed_at: string | null;
};

export type CompetitorPost = {
  id: number;
  created_at: string;
  competitor_id: number;
  source_id: number | null;
  platform: string | null;
  external_id: string;
  title: string | null;
  url: string;
  summary: string | null;
  published_at: string | null;
};

export type CompetitorInput = Omit<
  Competitor,
  "id" | "created_at" | "updated_at"
>;
export type CompetitorSourceInput = Omit<CompetitorSource, "id">;

// ── Competitors CRUD ─────────────────────────────────────────────────────────

export async function listCompetitors(
  includeArchived = false
): Promise<Competitor[]> {
  let q = supabase.from("competitors").select("*").order("name");
  if (!includeArchived) q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) throw new Error(error.message || "Failed loading competitors");
  return (data ?? []) as Competitor[];
}

export async function createCompetitor(
  input: Partial<CompetitorInput> & { name: string }
): Promise<Competitor> {
  const { data, error } = await supabase
    .from("competitors")
    .insert(input)
    .select()
    .single();
  if (error) throw new Error(error.message || "Failed creating competitor");
  return data as Competitor;
}

export async function updateCompetitor(
  id: number,
  patch: Partial<CompetitorInput>
): Promise<void> {
  const { error } = await supabase
    .from("competitors")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(error.message || "Failed updating competitor");
}

export async function deleteCompetitor(id: number): Promise<void> {
  const { error } = await supabase.from("competitors").delete().eq("id", id);
  if (error) throw new Error(error.message || "Failed deleting competitor");
}

// ── Sources CRUD ─────────────────────────────────────────────────────────────

export async function listSources(
  competitorId: number
): Promise<CompetitorSource[]> {
  const { data, error } = await supabase
    .from("competitor_sources")
    .select("*")
    .eq("competitor_id", competitorId)
    .order("platform");
  if (error) throw new Error(error.message || "Failed loading sources");
  return (data ?? []) as CompetitorSource[];
}

export async function addSource(
  input: Partial<CompetitorSourceInput> & {
    competitor_id: number;
    platform: SourcePlatform;
    profile_url: string;
  }
): Promise<CompetitorSource> {
  const { data, error } = await supabase
    .from("competitor_sources")
    .insert(input)
    .select()
    .single();
  if (error) throw new Error(error.message || "Failed adding source");
  return data as CompetitorSource;
}

export async function updateSource(
  id: number,
  patch: Partial<CompetitorSourceInput>
): Promise<void> {
  const { error } = await supabase
    .from("competitor_sources")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(error.message || "Failed updating source");
}

export async function deleteSource(id: number): Promise<void> {
  const { error } = await supabase
    .from("competitor_sources")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message || "Failed deleting source");
}

/** Mark a manual source as reviewed now (sets last_reviewed_at). */
export async function markSourceReviewed(id: number): Promise<void> {
  const { error } = await supabase
    .from("competitor_sources")
    .update({ last_reviewed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message || "Failed marking reviewed");
}

// ── Posts (auto-collected feed) ──────────────────────────────────────────────

export async function listRecentPosts(limit = 100): Promise<CompetitorPost[]> {
  const { data, error } = await supabase
    .from("competitor_posts")
    .select("*")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message || "Failed loading posts");
  return (data ?? []) as CompetitorPost[];
}

// The Cloudflare Worker base (same one the Live Scores feature uses) — it hosts
// the competitor feed collector. Falls back to the workers.dev default.
const WORKER_BASE =
  process.env.NEXT_PUBLIC_PLAYHQ_WORKER_URL?.replace(/\/$/, "") ||
  "https://playhq-scores.premier-data-enterprise.workers.dev";

/**
 * Manually run the feed collector NOW (the same job the worker cron runs every
 * ~30 min): polls every rss/youtube source and upserts new posts into
 * competitor_posts. Returns how many sources were polled and items upserted.
 */
export async function syncCompetitorFeeds(): Promise<{
  sources: number;
  inserted: number;
}> {
  const res = await fetch(`${WORKER_BASE}/api/collect-competitors`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Sync failed (HTTP ${res.status})`);
  return (await res.json()) as { sources: number; inserted: number };
}

// ── Ready reckoner (capability matrix) ───────────────────────────────────────
//
// The capability ROWS are defined here so they're versioned + consistent. Each
// has a Premier Data baseline (what PD does), rendered as the fixed first
// column. Competitor cells are stored per (competitor, capability) and default
// to "unknown" until someone fills them in from research.
//
// The list is grounded in Premier Data's actual service (grassroots match
// stats + video analysis delivered by remote analysts, plus the platform
// features in this dashboard): analyst-led coding, accuracy QA, live scores,
// multi-sport, reporting, etc. Edit CAPABILITIES to add/adjust rows.

export type CapabilityRating = "yes" | "partial" | "no" | "unknown";

export type CapabilityDef = {
  key: string;
  label: string;
  group: string;
  /** What Premier Data does for this capability (the baseline column). */
  pd: CapabilityRating;
  /** Short description shown on hover / under the row label. */
  detail?: string;
};

export const CAPABILITIES: CapabilityDef[] = [
  // Core service
  { key: "remote_analysts", label: "Remote analyst service", group: "Core service", pd: "yes", detail: "Trained analysts code matches remotely as a managed service." },
  { key: "match_stats", label: "Match statistics", group: "Core service", pd: "yes", detail: "Per-player and team stats coded from footage." },
  { key: "video_analysis", label: "Video analysis", group: "Core service", pd: "yes", detail: "Clip review, tagging and match vision." },
  { key: "team_lists", label: "Team lists / line-ups", group: "Core service", pd: "yes" },
  { key: "grassroots_focus", label: "Grassroots / community focus", group: "Core service", pd: "yes", detail: "Elite-level analysis for community clubs." },

  // Accuracy / quality
  { key: "accuracy_qa", label: "Accuracy QA & grading", group: "Accuracy & quality", pd: "yes", detail: "Master-vs-analyst accuracy checks and grading." },
  { key: "dispute_review", label: "Dispute / correction workflow", group: "Accuracy & quality", pd: "yes" },
  { key: "analyst_benchmarking", label: "Analyst benchmarking", group: "Accuracy & quality", pd: "yes", detail: "Compare analysts, leaderboards, profiles." },

  // Live / coverage
  { key: "live_scores", label: "Live scores", group: "Live & coverage", pd: "yes", detail: "Live score + goal-kicker feeds (PlayHQ-sourced)." },
  { key: "live_push", label: "Live data push / integrations", group: "Live & coverage", pd: "yes", detail: "Pushes scores to external platforms (e.g. JADE)." },
  { key: "multi_sport", label: "Multi-sport", group: "Live & coverage", pd: "yes", detail: "Aussie Rules + soccer, expanding." },

  // Platform / reporting
  { key: "reporting", label: "Reporting & dashboards", group: "Platform & reporting", pd: "yes" },
  { key: "board_reports", label: "Board / exec reporting", group: "Platform & reporting", pd: "yes" },
  { key: "ai_recommendations", label: "AI recommendations / insights", group: "Platform & reporting", pd: "yes" },
  { key: "fixture_management", label: "Fixture management", group: "Platform & reporting", pd: "yes" },
  { key: "messaging", label: "In-platform messaging", group: "Platform & reporting", pd: "yes" },

  // Model / delivery
  { key: "managed_service", label: "Fully managed (not self-serve)", group: "Model & delivery", pd: "yes", detail: "PD codes for the club vs. club self-captures." },
  { key: "self_capture_app", label: "Self-capture app for clubs", group: "Model & delivery", pd: "partial", detail: "PD is analyst-led; some capture tooling exists." },
];

export type CapabilityCell = {
  id: number;
  competitor_id: number;
  capability_key: string;
  rating: CapabilityRating;
  note: string | null;
};

/** All stored capability cells (across every competitor). */
export async function listCapabilityCells(): Promise<CapabilityCell[]> {
  const { data, error } = await supabase
    .from("competitor_capabilities")
    .select("*");
  if (error) throw new Error(error.message || "Failed loading capabilities");
  return (data ?? []) as CapabilityCell[];
}

// Researched FIRST-PASS capability ratings for the well-documented
// competitors, keyed by competitor name. Based on their public sites (verified
// Oct 2026). Every cell carries a "needs confirming" posture — treat as a
// starting point, not gospel. Only capabilities that differ from "unknown" are
// listed; anything omitted stays "unknown" for manual research.
//
// Models in brief (from research):
//  - iSportsAnalysis: online video-analysis + tagging + stats software; self-
//    serve (coaches/clubs tag themselves), multi-sport, shareable. NOT a
//    managed remote-analyst service; no live scores.
//  - GamePulse: self-capture live scoring/stats app for coaches/clubs; multi-
//    sport (AFL now, others coming). Not analyst-led, not video analysis.
//  - PlayHQ: competition management + registration + live scoring/stats; not
//    video analysis, not a managed analyst service.
//  - Dartfish: video tagging/analysis software; self-serve, multi-sport. No
//    managed service, no live scores, not grassroots-specific.
const RESEARCHED_RATINGS: Record<
  string,
  Partial<Record<string, CapabilityRating>>
> = {
  iSportsAnalysis: {
    remote_analysts: "no",
    match_stats: "yes",
    video_analysis: "yes",
    team_lists: "unknown",
    grassroots_focus: "partial",
    accuracy_qa: "no",
    dispute_review: "no",
    analyst_benchmarking: "no",
    live_scores: "no",
    live_push: "no",
    multi_sport: "yes",
    reporting: "yes",
    managed_service: "no",
    self_capture_app: "yes",
  },
  GamePulse: {
    remote_analysts: "no",
    match_stats: "yes",
    video_analysis: "no",
    grassroots_focus: "yes",
    accuracy_qa: "no",
    live_scores: "yes",
    multi_sport: "partial",
    reporting: "partial",
    managed_service: "no",
    self_capture_app: "yes",
  },
  PlayHQ: {
    remote_analysts: "no",
    match_stats: "partial",
    video_analysis: "no",
    team_lists: "yes",
    grassroots_focus: "yes",
    live_scores: "yes",
    multi_sport: "yes",
    fixture_management: "yes",
    reporting: "partial",
    managed_service: "no",
    self_capture_app: "yes",
  },
  Dartfish: {
    remote_analysts: "no",
    match_stats: "yes",
    video_analysis: "yes",
    grassroots_focus: "no",
    accuracy_qa: "no",
    live_scores: "no",
    multi_sport: "yes",
    reporting: "partial",
    managed_service: "no",
    self_capture_app: "yes",
  },
};

/**
 * Seed the researched first-pass capability ratings for the well-documented
 * competitors. Only writes cells that are still "unknown" (never overwrites a
 * rating someone has already set by hand). Returns how many cells were set.
 */
export async function seedResearchedCapabilities(): Promise<{ set: number }> {
  const comps = await listCompetitors(true);
  const existing = await listCapabilityCells();
  const existingKeys = new Set(
    existing.map((c) => `${c.competitor_id}|${c.capability_key}`)
  );
  let set = 0;
  for (const comp of comps) {
    const ratings = RESEARCHED_RATINGS[comp.name];
    if (!ratings) continue;
    for (const [key, rating] of Object.entries(ratings)) {
      if (!rating || rating === "unknown") continue;
      if (existingKeys.has(`${comp.id}|${key}`)) continue; // don't clobber manual edits
      await setCapabilityCell(comp.id, key, rating, "First-pass from research — confirm");
      set += 1;
    }
  }
  return { set };
}

/** Upsert one competitor×capability cell (rating + note). */
export async function setCapabilityCell(
  competitorId: number,
  capabilityKey: string,
  rating: CapabilityRating,
  note: string | null
): Promise<void> {
  const { error } = await supabase
    .from("competitor_capabilities")
    .upsert(
      {
        competitor_id: competitorId,
        capability_key: capabilityKey,
        rating,
        note,
      },
      { onConflict: "competitor_id,capability_key" }
    );
  if (error) throw new Error(error.message || "Failed saving capability");
}

// ── Seed ─────────────────────────────────────────────────────────────────────
//
// The initial competitor register. URLs verified via web search where noted;
// a few carry an unverified flag in the description so they can be checked.
// Sources are seeded as `manual` (profile links) — the worker/UI can add
// rss/youtube feed URLs later once channel ids / blog feeds are confirmed.

type SeedCompetitor = {
  name: string;
  website: string | null;
  sport: string;
  category: CompetitorCategory;
  priority: "high" | "medium" | "low";
  description: string;
  sources: {
    platform: SourcePlatform;
    profile_url: string;
    feed_url?: string;
    collection_method?: CollectionMethod;
  }[];
};

const SEED: SeedCompetitor[] = [
  {
    name: "iSportsAnalysis",
    website: "https://www.isportsanalysis.com/",
    sport: "Multi-sport",
    category: "direct",
    priority: "high",
    description:
      "Video analysis, statistics and team-management tools for coaches, teams and players (verified).",
    sources: [
      { platform: "website", profile_url: "https://www.isportsanalysis.com/" },
    ],
  },
  {
    name: "iSports (Rotations)",
    website: "https://isports.net.au/",
    sport: "Aussie Rules",
    category: "direct",
    priority: "high",
    description:
      "AFL rotations management, video analysis and team tools; used by AFL-level teams (verified; distinct from iSportsAnalysis).",
    sources: [{ platform: "website", profile_url: "https://isports.net.au/" }],
  },
  {
    name: "GamePulse",
    website: "https://gamepulse.com.au/",
    sport: "Multi-sport",
    category: "direct",
    priority: "high",
    description:
      "Grassroots analytics, live scoring and performance insights. AFL now; NRL, cricket, basketball, soccer, touch, netball on the way (verified).",
    sources: [
      { platform: "website", profile_url: "https://gamepulse.com.au/" },
    ],
  },
  {
    name: "PowerCoach AI",
    website: "https://powercoach.ai/",
    sport: "Aussie Rules",
    category: "emerging",
    priority: "high",
    description:
      "AI-powered AFL coaching analytics for grassroots clubs — live stats, win probability, tactical recommendations (verified).",
    sources: [{ platform: "website", profile_url: "https://powercoach.ai/" }],
  },
  {
    name: "Loggers Nation",
    website: "https://loggersnation.com/",
    sport: "Multi-sport",
    category: "direct",
    priority: "high",
    description:
      "Outsourced analyst recruitment/training/management and video analysis, stats and data annotation — closest to Premier Data's analyst-led model (verified, found in research).",
    sources: [{ platform: "website", profile_url: "https://loggersnation.com/" }],
  },
  {
    name: "MatchAssist",
    website: "https://matchassist.com.au/",
    sport: "Multi-sport",
    category: "adjacent",
    priority: "medium",
    description:
      "Club-run live scoring, player stats, rotations and season tracking across AFL, soccer and community sports (URL unverified — confirm).",
    sources: [
      { platform: "website", profile_url: "https://matchassist.com.au/" },
    ],
  },
  {
    name: "KickChasers",
    website: "https://kickchasers.com/",
    sport: "Aussie Rules",
    category: "adjacent",
    priority: "medium",
    description:
      "Player/team tracking, field mapping, performance cards, leaderboards and community features (URL unverified — confirm).",
    sources: [{ platform: "website", profile_url: "https://kickchasers.com/" }],
  },
  {
    name: "Legend Sports",
    website: "https://legendsports.com.au/",
    sport: "Multi-sport",
    category: "emerging",
    priority: "high",
    description:
      "Automated broadcasts, computer-vision stats, match narratives and AI commentary — watch as a cost-of-footage/stats disruptor (URL unverified — confirm).",
    sources: [
      { platform: "website", profile_url: "https://legendsports.com.au/" },
    ],
  },
  {
    name: "Dartfish",
    website: "https://www.dartfish.com/",
    sport: "Multi-sport",
    category: "technology",
    priority: "low",
    description:
      "Video tagging, review, KPI reporting and performance-analysis software — a tooling alternative, not an outsourced analyst service (verified vendor).",
    sources: [{ platform: "website", profile_url: "https://www.dartfish.com/" }],
  },
  {
    name: "PlayHQ",
    website: "https://www.playhq.com/",
    sport: "Multi-sport",
    category: "adjacent",
    priority: "medium",
    description:
      "Competition-management platform in the grassroots ecosystem; its data/integrations shape the market Premier Data operates in (verified).",
    sources: [{ platform: "website", profile_url: "https://www.playhq.com/" }],
  },
];

/**
 * Seed the register with the initial competitor list. Idempotent by NAME:
 * a competitor whose name already exists is skipped (not duplicated), so this
 * is safe to run once from the UI. Returns how many were added.
 */
export async function seedCompetitors(): Promise<{
  added: number;
  skipped: number;
}> {
  const existing = await listCompetitors(true);
  const existingNames = new Set(existing.map((c) => c.name.toLowerCase()));
  let added = 0;
  let skipped = 0;

  for (const s of SEED) {
    if (existingNames.has(s.name.toLowerCase())) {
      skipped += 1;
      continue;
    }
    const competitor = await createCompetitor({
      name: s.name,
      website: s.website,
      sport: s.sport,
      category: s.category,
      priority: s.priority,
      country: "Australia",
      description: s.description,
      notes: null,
      status: "active",
    });
    for (const src of s.sources) {
      await addSource({
        competitor_id: competitor.id,
        platform: src.platform,
        profile_url: src.profile_url,
        feed_url: src.feed_url ?? null,
        collection_method: src.collection_method ?? "manual",
        last_checked_at: null,
        last_status: null,
        last_reviewed_at: null,
      });
    }
    added += 1;
  }
  return { added, skipped };
}
