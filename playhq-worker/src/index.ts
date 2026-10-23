// PlayHQ live-scores bridge — a Cloudflare Worker that proxies the PlayHQ
// spectator GraphQL endpoint behind your own domain, with validation, a short
// edge cache (so 3–4 fixtures polled every ~2 min never hammer PlayHQ), CORS
// for the dashboard, and sane error/back-off handling.
//
// Routes (GET):
//   /api/fixtures/:id/live-scores   full game payload (score, periods, clock)
//   /api/fixtures/:id/status        just { id, status, updatedAt }
//   /health                         liveness probe
//
// The upstream call is the same POST you ran with cURL, kept server-side so the
// query, headers and tenant live in one place and the browser never talks to
// PlayHQ directly.

export interface Env {
  // Comma-separated list of allowed browser origins for CORS, e.g.
  // "https://your-dashboard.example,https://www.yourdomain.com.au". Set in
  // wrangler.toml [vars] or as a secret. "*" allows any origin (fine for a
  // read-only public score, but prefer listing your real origins).
  ALLOWED_ORIGINS?: string;
  // PlayHQ tenant (default "afl"). Override per-deployment if you query other
  // sports/competitions.
  PHQ_TENANT?: string;
  // Seconds to cache the slow-moving data (fixtures list, game status) at the
  // edge. Default 90.
  CACHE_TTL_SECONDS?: string;
  // Seconds to cache the LIVE score endpoints (/live, /live-scores). Short by
  // design so in-play scores are near-real-time while still shielding PlayHQ
  // from bursts. Default 15.
  LIVE_TTL_SECONDS?: string;
  // PlayHQ REST API key (official API). A SECRET — set with
  // `wrangler secret put PHQ_API_KEY`, never committed. Required for the
  // /api/grades/:id/games endpoint.
  PHQ_API_KEY?: string;
  // Comma-separated grade ids whose fixtures the Worker knows about, so the
  // /live endpoint can attach team id+name to a game by looking it up in these
  // grades' REST feeds. Defaults to the NTFL Premier Men's + Women's grades.
  KNOWN_GRADE_IDS?: string;
  // Base URL of the TT REST system that live scores + team lists are pushed to
  // (the scheduled job and the /api/push/:id endpoint). Defaults to the AHP
  // production host. No auth is required on its write endpoints.
  TT_BASE_URL?: string;
  // KV namespace holding the most recent TT pushes, so the production dashboard
  // can render a live push-activity feed (via /api/push-log) from any device.
  PUSH_LOG?: KVNamespace;
  // Supabase (competitor-intelligence collector): read competitor_sources,
  // write competitor_posts.
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  // Poll cadence (minutes) for competitor RSS/YouTube feeds.
  COMPETITOR_POLL_MINUTES?: string;
  // Secret bearer token gating the admin player-backfill endpoint
  // (POST/GET /api/admin/backfill-players). A SECRET — set with
  // `wrangler secret put BACKFILL_TOKEN`, never committed. When unset the
  // endpoint always returns 401.
  BACKFILL_TOKEN?: string;
}

// Default grades the /live endpoint searches to resolve a game's teams.
const DEFAULT_GRADE_IDS = [
  "be950883-7630-4df5-81e4-a5bba0f24cb6", // NTFL Premier Men's
  "61ca876d-f028-4f60-ad85-33e8fb2e5be7", // NTFL Premier Women's
  "6f964e7b-a56f-471e-9d9d-30e1f80da8d1", // EFNL Premier Men
  "6c2c7212-d1b7-48bb-acee-0fd75ce1984f", // GVL Seniors
  "7540fef1-7fad-4375-8502-b95c09ae6105", // PFL A-Grade Men
];

const PLAYHQ_URL = "https://spectator.playhq.com/graphql";
const PLAYHQ_REST = "https://api.playhq.com/v1";

// Pretty competition labels keyed by the grade SLUG in a game's PlayHQ url
// (the path segment before "/game-centre/"). Any comp not listed here still
// shows a readable prettified slug, so this scales to 20+ comps without edits —
// add an entry only when you want a nicer name than the auto-prettified slug.
const COMPETITION_LABELS: Record<string, string> = {
  "2026-27-tio-ntfl-men-premier-league": "NTFL Men's Premier",
  "2026-27-tio-ntfl-women-premier-league": "NTFL Women's Premier",
  "premier-eastland-senior-men": "EFNL Premier Men",
};

// Prettify a grade slug: "2026-27-tio-ntfl-men-premier-league" -> a title-cased
// label. Strips a leading season token like "2026-27" / "2026".
function prettifySlug(slug: string): string {
  const cleaned = slug.replace(/^\d{4}(-\d{2,4})?-/, "").replace(/-/g, " ");
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Resolve a human competition label from a game's PlayHQ url. Returns the
// mapped label when known, else a prettified slug, else "".
function competitionLabel(url: string | null | undefined): string {
  if (!url) return "";
  const m = String(url).match(/\/org\/[^/]+\/[^/]+\/([^/]+)\/game-centre\//);
  const slug = m?.[1];
  if (!slug) return "";
  return COMPETITION_LABELS[slug] ?? prettifySlug(slug);
}

// Confirmed PlayHQ fixture UUID -> TT (JADE) fixtureUid map. Built by matching
// the live grade feed against TT's fixtures list (date + teams). TT resolves
// the mapping internally when we push by PlayHQ id; this table is for DISPLAY
// in the push log so the confirmed PlayHQ<->TT pairing is visible. Fixtures not
// listed here still push fine (TT does its own lookup) — they just show "—"
// for the TT id in the log. Extend as later rounds / Women's ids are confirmed.
// NTFL Men's + Women's, rounds 1-12 (built from TT's fixtures lists). Extend
// as later rounds are confirmed.
const PLAYHQ_TO_TT_FIXTURE: Record<string, number> = {
  "a4c47814-bd91-45d5-93e8-227f9c0d72ba": 32656,
  "07dce55b-e777-42c4-baa6-532e0b50d0da": 32657,
  "27cb3ff2-0efd-4ba6-85e2-4446298c7030": 32659,
  "493a5808-d166-4b3b-9966-0339700e0245": 32658,
  "6209d317-5984-4ac6-b68d-c093b8dc4b29": 32660,
  "ab5ae0c9-b938-438c-bbf3-bffe351bebfd": 32661,
  "a8fbb269-be06-4232-9abd-14329d0eb09d": 32662,
  "7faaae3d-5c9d-42ce-95b0-20836b41e051": 32663,
  "78454e3d-a8d9-42a5-b409-edcebd8bc904": 32664,
  "239b2098-a7bd-4793-b181-0c82d189dff9": 32665,
  "22c22bb1-471b-4ae3-8295-15568b69a829": 32666,
  "53f60f45-fd31-42cf-b3ed-ef0c491f45ce": 32669,
  "cbb849cc-9e1a-46a7-97d4-28362acde06e": 32667,
  "ee614e56-807d-444d-8118-b7a5e0f6ad9a": 32668,
  "d07ce3d6-2db5-4a6c-9df3-446ecf9b05a9": 32670,
  "366346b7-d08a-4a2c-9dd9-f5eb9d3a6b2c": 32671,
  "14bd3c37-9459-41a5-a6dc-96f7325623dc": 32673,
  "92270e92-5f51-4c1e-939c-c65085ff2ae1": 32675,
  "e605c9ce-4d52-44bc-acab-17b7ba6ead5b": 32672,
  "b6a7d925-7ca5-4a41-bad2-1c8f275e4b80": 32674,
  "93234344-8527-41c0-a029-f43ac8e39690": 32676,
  "e257a74f-9817-4468-9d21-7cb4680c1244": 32678,
  "cf1156e1-0e7d-4814-afaa-1bfade911c07": 32680,
  "47783dbf-d991-4e52-be6b-10fb7b989fce": 32679,
  "aef9effb-26d8-4778-b9bf-7894f0bd24a2": 32677,
  "d6717daa-e722-4ecd-b111-930fcf3d78d4": 32681,
  "64bb34cc-b20d-45ff-8447-fc855e90babe": 32683,
  "2a435325-c314-47f9-a121-83dfc5793c85": 32684,
  "6ad08186-cab8-4d76-a571-ef4d59df4885": 32682,
  "6bb9632b-7f85-4926-8ffa-e15841190963": 32685,
  "45c5d3a1-8e1c-4ecf-9b67-dcf7179c51a7": 32686,
  "94693745-5e2a-42a0-abdd-fd0f33a8d242": 32689,
  "8626bce0-5442-4340-9271-a5962ae505dd": 32688,
  "97f2d0dd-97d5-4100-a3b9-ec07bd5c89bc": 32687,
  "b53552ae-64df-49ce-bb9f-93805f3c8a0c": 32690,
  "16e8d23a-63e3-453d-997c-3c369d27f53d": 32692,
  "fb0bbe6d-008b-4f3f-afe4-f609380d0555": 32694,
  "b1e50e2d-b99a-4f05-b999-0954df76fe71": 32693,
  "dba32bf9-b03f-4641-9af4-254dc9306815": 32691,
  "1a3f3363-3f0d-4c8b-ba4c-9483a7c9c759": 32695,
  "f2235241-84cc-4ebc-a802-068f356f2a15": 32697,
  "e366da62-c283-4ac0-b0bd-ac3a79c157a6": 32699,
  "1edc9210-c65f-41d2-b678-a33e7318289b": 32696,
  "0cd90950-08e3-46d8-b482-75b2fa7eda96": 32698,
  "3ea35b17-b8e7-47cc-9078-5550ae414cbc": 32700,
  "34337738-8f29-488b-92f1-4b95d9711e18": 32701,
  "dd049415-d0bf-4579-b103-3bb633ef54a9": 32702,
  "7c2dffca-1321-4a83-af4b-b3c7b5b3c4ec": 32704,
  "32375746-c4a9-460b-97c1-1b94550198a6": 32705,
  "97fbcaad-a4f6-4f0d-a28b-507bd28fb788": 32703,
  "83edaec6-2418-45cc-b765-f6ce9d1df1f9": 32706,
  "3cd9c733-da16-406d-9f99-60e42bd4f910": 32708,
  "3f8b3a62-bb29-407a-af88-2edbb936788a": 32710,
  "a07677f8-a650-4d4a-95aa-dcbf5f3039cb": 32709,
  "7d0974d7-92c9-488a-a451-14cac53462a6": 32707,
  "b1eb7a29-7459-4abe-8f2f-30d3b151b1dd": 36243,
  "b3c306cc-08a3-49ee-8712-4bb379fa0868": 36374,
  "5570e5d8-7616-4add-a285-afec5f1835ae": 36376,
  "7784bdea-4366-4a73-a94f-a9c8fd54f94a": 36375,
  "90c02c2b-17eb-4078-8cd1-ef327e18631c": 36377,
  "3548b364-9ab1-438e-b348-04ee8826de07": 36378,
  "a8b5b644-e1f8-4232-a803-69f71f5a7616": 36379,
  "5c34b1a9-213d-46ef-b83c-86770fbc7a0b": 36380,
  "d581e9e4-7f16-4a0d-88fc-4db9b40de9aa": 36357,
  "4f6ce181-e78f-4b6b-8c0b-1b2a08a196d5": 36358,
  "a828dac4-be51-46b0-be46-a4474d2f5954": 36389,
  "6f844430-5333-42a9-9799-4a05ec4b92bc": 36390,
  "4bfef6a1-bd68-4715-8a16-673000d38f31": 36359,
  "53be4587-c597-4998-a8c2-401d72567e48": 36388,
  "dc547783-af0b-4da2-9efd-3114abcd32c0": 36391,
  "20ff0cc7-258f-4658-a8b8-51ab56b64f2d": 36360,
  "4129153e-7edd-402d-8933-b766429ffc2e": 36361,
  "5103aedb-52fa-4a5d-ad15-1b1075bed032": 36393,
  "566bb471-55ce-4474-bf05-9f6ba1ceaeca": 36394,
  "c6a0e517-2597-4f53-9b47-d609dc07e21d": 36392,
  "b82a82e9-80f9-4b87-a2bf-84a4ab174a7e": 36397,
  "27d2a7eb-2708-4f41-8be4-96dae874f0f0": 36395,
  "9f3856e6-1671-4c5d-a366-5dd3b2d89db4": 36362,
  "e447a72d-c13b-4d8b-a274-d7d8d0cb2dbd": 36396,
  "1b850f52-3df4-4ae8-a514-f876695c24c7": 36363,
  "3108f889-d9cf-4306-96ec-0a86ee769ea8": 36398,
  "e5e72fc2-e1af-4c11-9ebe-4b543edba27e": 36401,
  "dc897d7a-23bc-49b5-9060-6ae2a7b27d1c": 36399,
  "0c14422e-b841-4cbf-8336-fec598b6cfc0": 36364,
  "70044912-8d3f-4f0e-8e0f-5645cc0eb843": 36365,
  "a2e812ce-47aa-4847-9f18-5862f6e58967": 36402,
  "106749dd-e392-4117-99d7-2e0682cc4e33": 36403,
  "56496f9e-8417-4c30-a48e-b1b066bc3727": 36366,
  "14645c16-e863-453f-bd94-f9806e1eca2a": 36404,
  "363f81d5-c0a9-4678-82e3-2fe993b07072": 36406,
  "20731574-8333-44b3-8b8f-fcf2e59d3d42": 36407,
  "9ee0ccf0-a94b-4e14-b8f1-142525664102": 36367,
  "c9585229-dd7e-45b3-88c0-1ec29c736f3f": 36405,
  "cd173477-52db-4e2c-9daf-457ecd23cdd3": 36408,
  "906b402a-51fc-4108-b9bf-712caf928244": 36368,
  "19c4a9f5-e711-42b4-9855-278e6414ab8d": 36409,
  "2432220e-afb3-489d-b81c-53fa45913a66": 36369,
  "66bfc7ab-4e73-45f9-ad09-b3c67ebcd648": 36410,
  "2475da0f-701c-46a1-a696-0360c58740b9": 36411,
  "2e01da44-bed3-4972-adbf-8495144e3546": 36414,
  "124a4515-6c04-4bd4-b935-2d1db1788b2c": 36370,
  "d67f26b8-f02b-4a22-acb3-691277a1b53c": 36371,
  "cae58a00-b3d3-443a-964b-814f1f00c820": 36413,
  "b50e1da6-19da-4e5e-b851-2725260cbaa1": 36412,
  "71960de3-8e54-4def-9b35-4ce0a6b18079": 36416,
  "093bd9d2-9fdb-4bf2-b23b-995ceb01d8d3": 36415,
  "8536ce13-96c3-49b4-9d25-4ff443948f05": 36418,
  "25965f6d-035f-42f2-941b-781149f95722": 36372,
  "fd313a6b-0f7c-468b-a9e6-d5f072ce0931": 36417,
};

/** TT fixtureUid for a full PlayHQ fixture UUID, or null if not in the table. */
function ttFixtureUidFor(fullId: string): number | null {
  return PLAYHQ_TO_TT_FIXTURE[fullId] ?? null;
}

// The GraphQL document (from the spectator cURL, whitespace trimmed). Includes
// per-player statistics under statistics.{home,away}.players[] so we can derive
// goal scorers (TOTAL_GOALS / TOTAL_BEHINDS per player).
const GAME_QUERY = `query game($id: ID!, $scope: PeriodScore) { game(id: $id) { id status updatedAt lastEventRecordedAt statistics { home { statisticsV2 { type { type value } count } players { name playerNumber statistics { type { value } count } } } away { statisticsV2 { type { type value } count } players { name playerNumber statistics { type { value } count } } } } result { home { statistics { type { value } count } periods(scope: $scope) { period { label shortName value } statistics { type { type value } count } type role closureStatus overtimeSequenceNo } } away { statistics { type { value } count } periods(scope: $scope) { period { label shortName value } statistics { type { type value } count } type role closureStatus overtimeSequenceNo } } currentPeriod { value primarySide } } clock { overtimeSequenceNo period periodValue status time lastUpdatedAt } } }`;

// A PlayHQ fixture/game id is a short alphanumeric token (e.g. "ab5ae0c9").
// Only accept that shape so the id can't be used to smuggle anything upstream.
const ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

// ── Public player career (Discovery GraphQL) ────────────────────────────────
// PlayHQ's public player-statistics lives on the Discovery GraphQL endpoint
// (api.playhq.com/graphql), NOT the spectator one. It serves a player's COMPLETE
// career (career totals + every game ever played) with NO auth, provided the
// request looks like a browser AND carries the `tenant` header (lowercase,
// value "afl"). Confirmed empirically against Sam Dunstan
// (803aa666-2648-4ec9-b348-dbae149e0baf): HTTP 200 with APPEARANCE=321,
// GOAL_COUNT=767, BEST_PLAYER=132. A naive fetch without a Chrome User-Agent is
// the 403 risk; without the `tenant` header the statistics resolver returns the
// GraphQL error "tenant header is missing".
const PLAYHQ_GRAPH = "https://api.playhq.com/graphql";

// A realistic Chrome UA — required so PlayHQ doesn't 403 the proxy as a bot.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// The career GraphQL document. Operation `publicProfileStatistics`, variable
// `$profileID: ID!` (capital-ID spelling). Each statistic entry is
// `{ count, details { value }, gameFormat }` where `details` is a SINGLE object
// (NOT an array) and `details.value` is the stat-type string (APPEARANCE,
// GOAL_COUNT, BEST_PLAYER, …); `count` is the numeric value. Verified live.
const CAREER_QUERY = `query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    careerStatistics {
      totalStatistics { count details { value } gameFormat }
      clubStatistics { id club { id name } statistics { count details { value } gameFormat } }
    }
    seasonStatistics {
      name
      statistics {
        season { id name competition { id name organisation { id name } } }
        role
        club { id name }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            gameStatistics {
              game {
                id
                round { name }
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
                date
                allocation { court { abbreviatedName venue { name } } }
              }
              statistics { count details { value } gameFormat }
            }
          }
        }
      }
    }
  }
  publicProfile(profileID: $profileID) { id firstName lastName }
}`;

// One career total / per-game stat, flattened to a readable { type, value }.
type CareerStat = { type: string; value: number };

// One game in a player's flattened career history.
type CareerGame = {
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
  matchName: string;
  venue: string | null;
  stats: CareerStat[];
};

// A player's identity + flattened career (totals + every game), as the worker
// returns it to the dashboard. This is the single, chosen place to flatten.
type CareerProfile = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  totals: CareerStat[];
  games: CareerGame[];
};

// Map a raw PlayHQ statistics[] array to flattened { type, value } entries.
// Reads `count` for the value and `details.value` for the type (details is a
// single object, verified live — NOT an array). Skips entries missing a type.
function flattenStats(raw: unknown): CareerStat[] {
  if (!Array.isArray(raw)) return [];
  const out: CareerStat[] = [];
  for (const s of raw as Array<Record<string, unknown>>) {
    const details = (s?.details ?? null) as { value?: unknown } | null;
    const type = details?.value;
    if (typeof type !== "string" || !type) continue;
    const count = typeof s?.count === "number" ? s.count : 0;
    out.push({ type, value: count });
  }
  return out;
}

// Read a named string field off a nullable object (null-safe).
function strOf(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

// Flatten the raw Discovery `data` (from fetchPlayerCareer) into a CareerProfile.
// Defensive against every array/object being absent or null — a PRIVATE profile
// returns `publicProfileStatistics: null`, in which case identity still comes
// from `publicProfile` and totals/games are empty (never throws).
function flattenCareer(data: Record<string, unknown>): CareerProfile {
  const profile = (data.publicProfile ?? {}) as Record<string, unknown>;
  const stats = (data.publicProfileStatistics ?? null) as Record<
    string,
    unknown
  > | null;

  const id = strOf(profile, "id") ?? "";
  const firstName = strOf(profile, "firstName");
  const lastName = strOf(profile, "lastName");

  if (!stats) {
    return { id, firstName, lastName, totals: [], games: [] };
  }

  const career = (stats.careerStatistics ?? {}) as Record<string, unknown>;
  const totals = flattenStats(career.totalStatistics);

  const games: CareerGame[] = [];
  const seasons = Array.isArray(stats.seasonStatistics)
    ? (stats.seasonStatistics as Array<Record<string, unknown>>)
    : [];
  for (const s of seasons) {
    const outerSeasonName = strOf(s, "name");
    const statsList = Array.isArray(s.statistics)
      ? (s.statistics as Array<Record<string, unknown>>)
      : [];
    for (const st of statsList) {
      const seasonObj = (st.season ?? {}) as Record<string, unknown>;
      const seasonName = strOf(seasonObj, "name") ?? outerSeasonName;
      const competitionObj = (seasonObj.competition ?? {}) as Record<
        string,
        unknown
      >;
      const competition = strOf(competitionObj, "name");
      const organisation = strOf(
        (competitionObj.organisation ?? {}) as Record<string, unknown>,
        "name"
      );
      const club = strOf((st.club ?? {}) as Record<string, unknown>, "name");

      const teamStats = Array.isArray(st.teamStatistics)
        ? (st.teamStatistics as Array<Record<string, unknown>>)
        : [];
      for (const ts of teamStats) {
        const team = strOf((ts.team ?? {}) as Record<string, unknown>, "name");
        const gradeStats = Array.isArray(ts.gradeStatistics)
          ? (ts.gradeStatistics as Array<Record<string, unknown>>)
          : [];
        for (const gs of gradeStats) {
          const grade = strOf(
            (gs.grade ?? {}) as Record<string, unknown>,
            "name"
          );
          const gameStats = Array.isArray(gs.gameStatistics)
            ? (gs.gameStatistics as Array<Record<string, unknown>>)
            : [];
          for (const g of gameStats) {
            const game = (g.game ?? {}) as Record<string, unknown>;
            const home = strOf(
              (game.home ?? {}) as Record<string, unknown>,
              "name"
            );
            const away = strOf(
              (game.away ?? {}) as Record<string, unknown>,
              "name"
            );
            const court = (((game.allocation ?? {}) as Record<string, unknown>)
              .court ?? {}) as Record<string, unknown>;
            const venue = strOf(
              (court.venue ?? {}) as Record<string, unknown>,
              "name"
            );
            const matchName =
              home && away
                ? `${home} vs ${away}`
                : team || strOf(game, "id") || "Unknown match";
            games.push({
              gameId: strOf(game, "id") ?? "",
              season: seasonName,
              competition,
              organisation,
              club,
              team,
              grade,
              round: strOf((game.round ?? {}) as Record<string, unknown>, "name"),
              date: strOf(game, "date"),
              home,
              away,
              matchName,
              venue,
              stats: flattenStats(g.statistics),
            });
          }
        }
      }
    }
  }

  // Most-recent first by ISO date; undated games sort last (stable).
  games.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : NaN;
    const db = b.date ? Date.parse(b.date) : NaN;
    const va = Number.isNaN(da) ? -Infinity : da;
    const vb = Number.isNaN(db) ? -Infinity : db;
    return vb - va;
  });

  return { id, firstName, lastName, totals, games };
}

function corsHeaders(env: Env, requestOrigin: string | null): HeadersInit {
  const allowed = (env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAny = allowed.includes("*");
  const origin =
    allowAny || !requestOrigin
      ? allowAny
        ? "*"
        : (allowed[0] ?? "*")
      : allowed.includes(requestOrigin)
        ? requestOrigin
        : allowed[0] ?? "null";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(
  body: unknown,
  status: number,
  extra: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// A compact, normalised live-score shape derived from the spectator payload,
// so the dashboard doesn't have to parse the deep GraphQL structure. Scores
// come from result.{home,away}.statistics (TOTAL_SCORE/GOALS/BEHINDS) and the
// clock from clock.{period,time,status}.
type NormalisedLive = {
  id: string;
  status: string | null;
  clock: { period: string | null; time: string | null; status: string | null };
  home: {
    id: string | null;
    name: string | null;
    total: number | null;
    goals: number | null;
    behinds: number | null;
    scorers: Scorer[];
    periods: PeriodScore[];
  };
  away: {
    id: string | null;
    name: string | null;
    total: number | null;
    goals: number | null;
    behinds: number | null;
    scorers: Scorer[];
    periods: PeriodScore[];
  };
};

// A player who has scored, with their goal/behind tally this game.
type Scorer = {
  name: string;
  number: string | null;
  goals: number;
  behinds: number;
};

// One quarter's score for a side (the score kicked IN that period, as PlayHQ
// reports it — not cumulative).
type PeriodScore = {
  period: string; // "Q1"
  label: string; // "First Quarter"
  goals: number;
  behinds: number;
  total: number;
};

// Extract a side's quarter-by-quarter scores from result.{home,away}.periods[].
function periodsFrom(
  result: Record<string, unknown>,
  side: "home" | "away"
): PeriodScore[] {
  const sideObj = (result[side] ?? {}) as Record<string, unknown>;
  const periods = Array.isArray(sideObj.periods)
    ? (sideObj.periods as Array<Record<string, unknown>>)
    : [];
  const out: PeriodScore[] = [];
  for (const p of periods) {
    const period = (p.period ?? {}) as Record<string, unknown>;
    const stats = Array.isArray(p.statistics)
      ? (p.statistics as Array<{ type?: { value?: string }; count?: number }>)
      : [];
    out.push({
      period: (period.shortName as string) ?? "",
      label: (period.label as string) ?? "",
      goals: statVal(stats, "TOTAL_GOALS") ?? 0,
      behinds: statVal(stats, "TOTAL_BEHINDS") ?? 0,
      total: statVal(stats, "TOTAL_SCORE") ?? 0,
    });
  }
  return out;
}

// Team identity (id + name) for a game's two sides, resolved from the REST
// grade feeds. Keyed by side.
type GameTeams = { home: FixtureTeam; away: FixtureTeam } | null;

// Resolve a game's home/away team id+name by finding it in the known grades'
// REST feeds. The spectator game id is the short leading segment of the REST
// UUID (e.g. "7faaae3d" ⊂ "7faaae3d-bd91-..."), so match on that. Uses the
// edge cache for each grade's games to avoid re-hitting PlayHQ.
async function resolveGameTeams(
  gameId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<GameTeams> {
  const match = await resolveFullGame(gameId, env);
  if (!match) return null;
  const lite = toFixtureLite(match);
  void ctx; // reserved; no async write needed here
  return { home: lite.home, away: lite.away };
}

// Find a game's FULL raw record (and thus its full UUID id) from the known
// grades' REST feeds, given either the full UUID or the short leading segment
// (the spectator id). Uses the per-grade edge cache. Returns null if unknown.
async function resolveFullGame(
  gameId: string,
  env: Env
): Promise<Record<string, unknown> | null> {
  if (!env.PHQ_API_KEY) return null;
  const gradeIds = (env.KNOWN_GRADE_IDS ?? DEFAULT_GRADE_IDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cache = caches.default;

  for (const gradeId of gradeIds) {
    if (!UUID_RE.test(gradeId)) continue;
    let games: Array<Record<string, unknown>> | null = null;
    const key = new Request(`https://playhq-cache/grade-games/${gradeId}`);
    const hit = await cache.match(key);
    if (hit) {
      try {
        const body = (await hit.json()) as { data?: Array<Record<string, unknown>> };
        games = Array.isArray(body.data) ? body.data : null;
      } catch {
        games = null;
      }
    }
    if (!games) {
      try {
        games = (await fetchGradeGames(gradeId, env)) as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
    }
    const match = games.find((g) => {
      const full = String(g.id ?? "");
      return full === gameId || full.split("-")[0] === gameId;
    });
    if (match) return match;
  }
  return null;
}

// Pull a stat value out of a spectator statistics[] array by its type value.
function statVal(
  stats: Array<{ type?: { value?: string }; count?: number }> | undefined,
  typeValue: string
): number | null {
  if (!Array.isArray(stats)) return null;
  const hit = stats.find((s) => s?.type?.value === typeValue);
  return typeof hit?.count === "number" ? hit.count : null;
}

// One player on a team list (PlayHQ player id + name + jumper number + position).
type TeamListPlayer = {
  id: string | null;
  name: string;
  number: string | null;
  position: string | null;
};

// Extract one side's full team list from the game's player statistics
// (statistics.{home,away}.players[]). PlayHQ populates this with every named
// player (not just scorers) once a game has data (live/final); it's empty
// pre-game. Sorted by jumper number ascending (unnumbered last, by name).
function teamListFrom(
  game: Record<string, unknown>,
  side: "home" | "away"
): TeamListPlayer[] {
  const stats = (game.statistics ?? {}) as Record<string, unknown>;
  const sideObj = (stats[side] ?? {}) as Record<string, unknown>;
  const players = Array.isArray(sideObj.players)
    ? (sideObj.players as Array<Record<string, unknown>>)
    : [];
  const out: TeamListPlayer[] = players.map((p) => ({
    // The spectator-stats feed carries no per-player PlayHQ id/position.
    id: null,
    name: (p.name as string) ?? "",
    number: (p.playerNumber as string) ?? null,
    position: null,
  }));
  const num = (n: string | null) => {
    const v = Number(n);
    return Number.isFinite(v) && n != null && n !== "" ? v : Number.POSITIVE_INFINITY;
  };
  out.sort((a, b) => num(a.number) - num(b.number) || a.name.localeCompare(b.name));
  return out;
}

// Extract the goal scorers for one side from the game's player statistics
// (statistics.{home,away}.players[]). Returns players with at least one goal or
// behind, sorted by goals desc then behinds desc.
function scorersFrom(
  game: Record<string, unknown>,
  side: "home" | "away"
): Scorer[] {
  const stats = (game.statistics ?? {}) as Record<string, unknown>;
  const sideObj = (stats[side] ?? {}) as Record<string, unknown>;
  const players = Array.isArray(sideObj.players)
    ? (sideObj.players as Array<Record<string, unknown>>)
    : [];
  const out: Scorer[] = [];
  for (const p of players) {
    const ps = Array.isArray(p.statistics)
      ? (p.statistics as Array<{ type?: { value?: string }; count?: number }>)
      : [];
    const goals = statVal(ps, "TOTAL_GOALS") ?? 0;
    const behinds = statVal(ps, "TOTAL_BEHINDS") ?? 0;
    if (goals > 0 || behinds > 0) {
      out.push({
        name: (p.name as string) ?? "",
        number: (p.playerNumber as string) ?? null,
        goals,
        behinds,
      });
    }
  }
  out.sort((a, b) => b.goals - a.goals || b.behinds - a.behinds);
  return out;
}

function normaliseLive(
  id: string,
  game: Record<string, unknown>,
  teams: GameTeams
): NormalisedLive {
  const result = (game.result ?? {}) as Record<string, unknown>;
  const clock = (game.clock ?? {}) as Record<string, unknown>;
  const sideStats = (side: string) =>
    (((result[side] ?? {}) as Record<string, unknown>).statistics ?? []) as Array<{
      type?: { value?: string };
      count?: number;
    }>;
  const home = sideStats("home");
  const away = sideStats("away");
  return {
    id,
    status: (game.status as string) ?? null,
    clock: {
      period: (clock.period as string) ?? null,
      time: (clock.time as string) ?? null,
      status: (clock.status as string) ?? null,
    },
    home: {
      id: teams?.home.id ?? null,
      name: teams?.home.name ?? null,
      total: statVal(home, "TOTAL_SCORE"),
      goals: statVal(home, "TOTAL_GOALS"),
      behinds: statVal(home, "TOTAL_BEHINDS"),
      scorers: scorersFrom(game, "home"),
      periods: periodsFrom(result, "home"),
    },
    away: {
      id: teams?.away.id ?? null,
      name: teams?.away.name ?? null,
      total: statVal(away, "TOTAL_SCORE"),
      goals: statVal(away, "TOTAL_GOALS"),
      behinds: statVal(away, "TOTAL_BEHINDS"),
      scorers: scorersFrom(game, "away"),
      periods: periodsFrom(result, "away"),
    },
  };
}

// Fetch one game from PlayHQ. Returns the `game` object, or throws a tagged
// error the handler maps to an HTTP status.
async function fetchGame(id: string, env: Env): Promise<unknown> {
  const upstream = await fetch(PLAYHQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.playhq.com",
      Accept: "*/*",
      "x-phq-tenant": env.PHQ_TENANT ?? "afl",
    },
    body: JSON.stringify({
      operationName: "game",
      variables: { id, scope: "BY_PERIOD" },
      query: GAME_QUERY,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  // Surface rate-limit / forbidden explicitly so the caller can back off.
  if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
  if (upstream.status === 403) throw new UpstreamError("forbidden", 403);
  if (!upstream.ok) throw new UpstreamError("upstream_error", 502);

  const data = (await upstream.json()) as {
    data?: { game?: unknown };
    errors?: unknown[];
  };
  if (data.errors?.length) throw new UpstreamError("graphql_errors", 502);
  if (!data.data?.game) throw new UpstreamError("not_found", 404);
  return data.data.game;
}

// Fetch a player's COMPLETE career from the Discovery GraphQL endpoint and
// return the raw `data` (publicProfile + publicProfileStatistics). Sends
// browser-like headers + the lowercase `tenant` header so PlayHQ doesn't 403
// the proxy as a bot and the statistics resolver doesn't reject a missing
// tenant. Throws a tagged UpstreamError the route maps to an HTTP status.
async function fetchPlayerCareer(
  id: string,
  tenant: string,
  env: Env
): Promise<Record<string, unknown>> {
  const upstream = await fetch(PLAYHQ_GRAPH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": BROWSER_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.playhq.com",
      Referer: "https://www.playhq.com/",
      tenant: tenant || env.PHQ_TENANT || "afl",
    },
    body: JSON.stringify({
      operationName: "publicProfileStatistics",
      variables: { profileID: id },
      query: CAREER_QUERY,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
  if (upstream.status === 403) throw new UpstreamError("forbidden", 403);
  if (upstream.status === 404) throw new UpstreamError("not_found", 404);
  if (!upstream.ok) throw new UpstreamError("upstream_error", 502);

  const data = (await upstream.json()) as {
    data?: Record<string, unknown>;
    errors?: unknown[];
  };
  if (data.errors?.length) throw new UpstreamError("graphql_errors", 502);
  if (!data.data) throw new UpstreamError("not_found", 404);
  return data.data;
}

class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

// A grade id is a UUID (e.g. "be950883-7630-4df5-81e4-a5bba0f24cb6").
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fetch ALL games for a grade from the official PlayHQ REST API, following the
// cursor pagination (metadata.hasMore / metadata.nextCursor) so a full season
// comes back in one response. Requires the secret API key.
async function fetchGradeGames(gradeId: string, env: Env): Promise<unknown[]> {
  if (!env.PHQ_API_KEY) throw new UpstreamError("api_key_not_configured", 500);

  const all: unknown[] = [];
  let cursor: string | null = null;
  // Safety cap on pages so a pagination bug can't loop forever.
  for (let page = 0; page < 50; page++) {
    const u = new URL(`${PLAYHQ_REST}/grades/${gradeId}/games`);
    if (cursor) u.searchParams.set("cursor", cursor);

    const upstream = await fetch(u.toString(), {
      method: "GET",
      headers: {
        "x-api-key": env.PHQ_API_KEY,
        "x-phq-tenant": env.PHQ_TENANT ?? "afl",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
    if (upstream.status === 401 || upstream.status === 403)
      throw new UpstreamError("forbidden", upstream.status);
    if (upstream.status === 404) throw new UpstreamError("not_found", 404);
    if (!upstream.ok) throw new UpstreamError("upstream_error", 502);

    const body = (await upstream.json()) as {
      data?: unknown[];
      metadata?: { hasMore?: boolean; nextCursor?: string | null };
    };
    if (Array.isArray(body.data)) all.push(...body.data);
    if (!body.metadata?.hasMore || !body.metadata.nextCursor) break;
    cursor = body.metadata.nextCursor;
  }
  return all;
}

// Fetch a game's SUMMARY from the official REST API. This carries per-player
// `appearances[]` (complete goal kickers) and per-quarter `periods[]`, unlike
// the spectator feed which only attributes some goals. Requires the API key.
async function fetchGameSummary(
  fullGameId: string,
  env: Env
): Promise<Record<string, unknown>> {
  if (!env.PHQ_API_KEY) throw new UpstreamError("api_key_not_configured", 500);
  const u = `${PLAYHQ_REST}/games/${fullGameId}/summary`;
  const upstream = await fetch(u, {
    method: "GET",
    headers: {
      "x-api-key": env.PHQ_API_KEY,
      "x-phq-tenant": env.PHQ_TENANT ?? "afl",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (upstream.status === 429) throw new UpstreamError("rate_limited", 429);
  if (upstream.status === 401 || upstream.status === 403)
    throw new UpstreamError("forbidden", upstream.status);
  if (upstream.status === 404) throw new UpstreamError("not_found", 404);
  if (!upstream.ok) throw new UpstreamError("upstream_error", 502);
  const body = (await upstream.json()) as { data?: Record<string, unknown> };
  if (!body.data) throw new UpstreamError("not_found", 404);
  return body.data;
}

// Build a normalised scorers + periods payload (home/away) from a REST game
// summary. Goal kickers come from appearances[].scoreSubTotal (6_POINT_SCORE =
// goals*6, 1_POINT_SCORE = behinds); quarter scores from periods[]. Team sides
// are keyed by the summary's competitors[].isHomeTeam.
function summaryToScorersPeriods(
  id: string,
  summary: Record<string, unknown>
): NormalisedLive {
  const comps = Array.isArray(summary.competitors)
    ? (summary.competitors as Array<Record<string, unknown>>)
    : [];
  const homeComp = comps.find((c) => c.isHomeTeam === true);
  const awayComp = comps.find((c) => c.isHomeTeam === false);
  const homeId = homeComp ? String(homeComp.id) : null;
  const awayId = awayComp ? String(awayComp.id) : null;

  const subVal = (
    sub: Array<{ type?: string; value?: number }> | undefined,
    type: string
  ): number => {
    if (!Array.isArray(sub)) return 0;
    const hit = sub.find((s) => s?.type === type);
    return typeof hit?.value === "number" ? hit.value : 0;
  };

  // Per-side goal kickers from appearances.
  const appearances = Array.isArray(summary.appearances)
    ? (summary.appearances as Array<Record<string, unknown>>)
    : [];
  const scorersFor = (teamId: string | null): Scorer[] => {
    if (!teamId) return [];
    const out: Scorer[] = [];
    for (const a of appearances) {
      if (String(a.teamID) !== teamId) continue;
      const sub = a.scoreSubTotal as Array<{ type?: string; value?: number }>;
      const goals = Math.floor(subVal(sub, "6_POINT_SCORE") / 6);
      const behinds = subVal(sub, "1_POINT_SCORE");
      if (goals > 0 || behinds > 0) {
        const name = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
        out.push({
          name,
          number: a.playerNumber != null ? String(a.playerNumber) : null,
          goals,
          behinds,
        });
      }
    }
    out.sort((x, y) => y.goals - x.goals || y.behinds - x.behinds);
    return out;
  };

  // Per-side quarter scores from periods[].
  const periods = Array.isArray(summary.periods)
    ? (summary.periods as Array<Record<string, unknown>>)
    : [];
  const PERIOD_LABEL: Record<string, { period: string; label: string }> = {
    FIRST_QTR: { period: "Q1", label: "First Quarter" },
    SECOND_QTR: { period: "Q2", label: "Second Quarter" },
    THIRD_QTR: { period: "Q3", label: "Third Quarter" },
    FOURTH_QTR: { period: "Q4", label: "Fourth Quarter" },
  };
  const periodsFor = (teamId: string | null): PeriodScore[] => {
    if (!teamId) return [];
    const out: PeriodScore[] = [];
    for (const p of periods) {
      const label = PERIOD_LABEL[String(p.name)] ?? { period: String(p.name), label: String(p.name) };
      const pc = Array.isArray(p.competitors)
        ? (p.competitors as Array<Record<string, unknown>>)
        : [];
      const mine = pc.find((c) => String(c.id) === teamId);
      if (!mine) continue;
      const sub = mine.scoreSubtotals as Array<{ type?: string; value?: number }>;
      const goals = subVal(sub, "6_POINT_SCORE");
      const behinds = subVal(sub, "1_POINT_SCORE");
      out.push({
        period: label.period,
        label: label.label,
        goals,
        behinds,
        total: typeof mine.scoreTotals === "number" ? mine.scoreTotals : goals * 6 + behinds,
      });
    }
    return out;
  };

  const sideTotals = (comp: Record<string, unknown> | undefined) => {
    const sub = comp?.scoreSubTotal as Array<{ type?: string; value?: number }>;
    return {
      total: typeof comp?.scoreTotal === "number" ? comp.scoreTotal : null,
      goals: subVal(sub, "TOTAL_GOALS"),
      behinds: subVal(sub, "TOTAL_BEHINDS"),
    };
  };
  const h = sideTotals(homeComp);
  const a = sideTotals(awayComp);

  return {
    id,
    status: (summary.status as string) ?? null,
    clock: { period: null, time: null, status: null },
    home: {
      id: homeId,
      name: (homeComp?.name as string) ?? null,
      total: h.total,
      goals: h.goals,
      behinds: h.behinds,
      scorers: scorersFor(homeId),
      periods: periodsFor(homeId),
    },
    away: {
      id: awayId,
      name: (awayComp?.name as string) ?? null,
      total: a.total,
      goals: a.goals,
      behinds: a.behinds,
      scorers: scorersFor(awayId),
      periods: periodsFor(awayId),
    },
  };
}

// Build complete home/away team lists from a REST game summary. Every
// `appearances[]` entry is a SELECTED player (not just scorers), so this is the
// authoritative, complete roster — unlike the spectator feed's players[], which
// PlayHQ only populates partially. Sides are keyed by competitors[].isHomeTeam;
// each player is grouped by appearance.teamID. Returns null when the summary
// carries no appearances (e.g. pre-match), so the caller can fall back.
type TeamListsPayload = {
  id: string;
  status: string | null;
  home: { id: string | null; name: string | null; players: TeamListPlayer[] };
  away: { id: string | null; name: string | null; players: TeamListPlayer[] };
};

function summaryToTeamLists(
  id: string,
  summary: Record<string, unknown>
): TeamListsPayload | null {
  const appearances = Array.isArray(summary.appearances)
    ? (summary.appearances as Array<Record<string, unknown>>)
    : [];
  if (appearances.length === 0) return null;

  const comps = Array.isArray(summary.competitors)
    ? (summary.competitors as Array<Record<string, unknown>>)
    : [];
  const homeComp = comps.find((c) => c.isHomeTeam === true);
  const awayComp = comps.find((c) => c.isHomeTeam === false);
  const homeId = homeComp ? String(homeComp.id) : null;
  const awayId = awayComp ? String(awayComp.id) : null;

  const num = (n: string | null) => {
    const v = Number(n);
    return Number.isFinite(v) && n != null && n !== "" ? v : Number.POSITIVE_INFINITY;
  };

  const rosterFor = (teamId: string | null): TeamListPlayer[] => {
    if (!teamId) return [];
    const out: TeamListPlayer[] = [];
    for (const a of appearances) {
      if (String(a.teamID) !== teamId) continue;
      const name = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
      if (!name) continue;
      out.push({
        id: a.id != null ? String(a.id) : null,
        name,
        number: a.playerNumber != null ? String(a.playerNumber) : null,
        position: (a.playerPosition as string) ?? null,
      });
    }
    out.sort((x, y) => num(x.number) - num(y.number) || x.name.localeCompare(y.name));
    return out;
  };

  return {
    id,
    status: (summary.status as string) ?? null,
    home: { id: homeId, name: (homeComp?.name as string) ?? null, players: rosterFor(homeId) },
    away: { id: awayId, name: (awayComp?.name as string) ?? null, players: rosterFor(awayId) },
  };
}

// ── TT REST push (advancedhp) ───────────────────────────────────────────────
// Forward live scores + team lists INTO the TT system. TT keys fixtures by the
// FULL PlayHQ game UUID (verified: a short id returns "n/a", the full UUID
// returns "ok"). No auth is required on these write endpoints. The score push
// takes current totals + per-player goals/behinds; the team push takes full
// home/away rosters. Both are idempotent — safe to resend every cycle.

// Default TT base; override with the TT_BASE_URL var in wrangler.toml.
const TT_BASE_DEFAULT = "https://pdrest.advancedhp.com.au";

// Build the /PlayHQScoreUpdate body from a REST summary payload. Sends the
// current full totals for both sides. `requestor`/`sourceApp` identify the
// caller to TT (0 / "reporting-dashboard" accepted in testing).
function ttScoreBody(fullId: string, live: NormalisedLive) {
  return {
    fixturePlayHQId: fullId,
    homeTeamId: live.home.id ?? "",
    awayTeamId: live.away.id ?? "",
    homeG: live.home.goals ?? 0,
    homeB: live.home.behinds ?? 0,
    awayG: live.away.goals ?? 0,
    awayB: live.away.behinds ?? 0,
    requestType: "SCORE",
    sourceApp: "reporting-dashboard",
    requestor: 0,
  };
}

// Build the /PlayHQTeamUpdate body from a REST team-lists payload. Each side's
// players carry name + number; TT matches players by name/number on its side.
function ttTeamBody(fullId: string, lists: TeamListsPayload) {
  const toTeam = (side: { id: string | null; name: string | null; players: TeamListPlayer[] }) => ({
    playhqId: side.id ?? "",
    teamName: side.name ?? "",
    allPlayers: side.players.map((p) => {
      const parts = p.name.trim().split(/\s+/);
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");
      const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
      const num = Number(p.number);
      return {
        firstName,
        lastName,
        playerId: "",
        playerNumber: Number.isFinite(num) ? num : 0,
        position: "",
        teamId: side.id ?? "",
      };
    }),
  });
  return {
    fixtureId: fullId,
    myHomeTeam: toTeam(lists.home),
    myAwayTeam: toTeam(lists.away),
    sourceApp: "reporting-dashboard",
    requestor: 0,
  };
}

// POST a JSON body to a TT endpoint. Returns { status, body } (TT replies with
// a short string like "ok" / "n/a"). Never throws — a push failure for one
// fixture must not abort the others.
async function ttPost(
  env: Env,
  path: string,
  body: unknown
): Promise<{ status: number; body: string }> {
  const base = (env.TT_BASE_URL ?? TT_BASE_DEFAULT).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 200) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : "error" };
  }
}

// Resolve, fetch the summary for, and push ONE fixture's score + team list to
// TT. `shortId` is the PlayHQ spectator id (short or full). Returns a small
// result record for logging / the manual-trigger response.
// A single push-log entry, as stored in KV and returned by /api/push-log.
type PushLogEntry = {
  ts: string; // ISO timestamp
  id: string; // short PlayHQ fixture id
  playhqId: string; // full PlayHQ fixture UUID (what we push to TT)
  ttId: number | null; // confirmed TT (JADE) fixtureUid, or null if not mapped
  competition: string; // "NTFL Men's Premier" etc.
  round: string; // "Round 2" etc.
  match: string; // "Home vs Away" (grade suffix stripped)
  score: string; // "G.B (T) - G.B (T)"
  endpoint: string; // the TT base URL pushed to
  scoreReply: string; // TT's reply to /PlayHQScoreUpdate (e.g. "ok")
  teamReply: string; // TT's reply to /PlayHQTeamUpdate
  ok: boolean; // true when the score push was accepted ("ok")
};

const PUSH_LOG_KEY = "recent";
const PUSH_LOG_MAX = 100;

// Append push results to the KV ring buffer (newest first, capped). Best
// effort — a KV failure must never break the push itself.
async function recordPushLog(
  env: Env,
  base: string,
  results: Array<Record<string, unknown>>
): Promise<void> {
  if (!env.PUSH_LOG) return;
  try {
    const prevRaw = await env.PUSH_LOG.get(PUSH_LOG_KEY);
    const prev: PushLogEntry[] = prevRaw ? JSON.parse(prevRaw) : [];
    const now = new Date().toISOString();
    const entries: PushLogEntry[] = results.map((r) => {
      const score = r.scorePush as { body?: string } | undefined;
      const team = r.teamPush as { body?: string } | undefined;
      const scoreReply = (score?.body ?? r.error ?? "no reply") as string;
      return {
        ts: now,
        id: String(r.id ?? ""),
        playhqId: String(r.fullId ?? ""),
        ttId: (r.ttId as number | null) ?? null,
        competition: String(r.competition ?? ""),
        round: String(r.round ?? ""),
        match: String(r.match ?? ""),
        score: String(r.score ?? ""),
        endpoint: base,
        scoreReply,
        teamReply: (team?.body ?? "-") as string,
        ok: /ok/i.test(scoreReply),
      };
    });
    const merged = [...entries, ...prev].slice(0, PUSH_LOG_MAX);
    await env.PUSH_LOG.put(PUSH_LOG_KEY, JSON.stringify(merged));
  } catch (e) {
    console.log("push-log write failed:", e instanceof Error ? e.message : "error");
  }
}

// Print one readable line (or two) per fixture push, so `wrangler tail` reads
// like a live activity console. Shows the match, score sent, and TT's reply for
// each endpoint, with a ✓ / ✗ based on whether TT answered "ok".
function logPushResult(r: Record<string, unknown>, base: string): void {
  const ts = new Date().toISOString();
  if (r.error) {
    console.log(`[${ts}] ✗ ${r.id} — ${String(r.error)}`);
    return;
  }
  const score = r.scorePush as { status: number; body: string } | undefined;
  const team = r.teamPush as { status: number; body: string } | undefined;
  const okScore = /ok/i.test(score?.body ?? "");
  const okTeam = /ok/i.test(team?.body ?? "");
  const ttId = r.ttId != null ? String(r.ttId) : "—";
  console.log(
    `[${ts}] ${okScore ? "✓" : "✗"} SCORE ${r.match} | ${r.score} ` +
      `| PlayHQ ${r.fullId} -> TT ${ttId} ` +
      `-> POST ${base}/PlayHQScoreUpdate => ${score?.body ?? "no reply"}`
  );
  console.log(
    `[${ts}] ${okTeam ? "✓" : "·"} TEAM  ${r.match} ` +
      `-> POST ${base}/PlayHQTeamUpdate => ${team?.body ?? "no reply"}`
  );
}

// --- Live-during-play detection helpers (mirror the Next.js UI's spectator
// feed detection in reporting-ui/app/live-scores/page.tsx + lib/api/playhq.ts).
// The NTFL PlayHQ REST feed never reports IN_PROGRESS — a game stays UPCOMING
// then flips straight to FINAL — so the cheap REST status check alone finds
// nothing while a game is being played. To detect in-play games we build a
// bounded CANDIDATE set (status unknown/UPCOMING, scheduled within a kickoff
// window) and probe each one's spectator feed, which DOES report IN_PROGRESS.

// Kickoff window, matching the UI exactly: 30 min before, 4 h after kickoff.
const WINDOW_BEFORE_MS = 30 * 60 * 1000;
const WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;

// Venue offset for computing a fixture's kickoff epoch. The UI's scheduleDate
// parses "yyyy-mm-ddThh:mm:ss" with NO offset, so a browser reads it in the
// viewer's local zone (for the intended user = the venue zone, Darwin). A
// Cloudflare Worker runs in UTC, so the same string would be ~9.5 h wrong.
// NTFL = Australia/Darwin = UTC+09:30, no DST, so we apply that offset
// explicitly. If a future grade sits in a DST-observing zone, replace this with
// a per-fixture schedule.timezone -> offset lookup inside scheduledKickoffMs.
const NTFL_UTC_OFFSET = "+09:30";

// Kickoff epoch (ms) for a grade-feed schedule `{ date, time }` (venue-local),
// or null when the date is missing / unparseable. Mirrors the UI's
// scheduleDate but reads the fixed Darwin offset instead of the viewer zone.
export function scheduledKickoffMs(
  schedule: { date?: string | null; time?: string | null } | null | undefined
): number | null {
  const date = schedule?.date;
  if (!date) return null;
  const time = schedule.time || "00:00:00";
  const ms = Date.parse(`${date}T${time}${NTFL_UTC_OFFSET}`);
  return Number.isNaN(ms) ? null : ms;
}

// REST status the grade feed doesn't fill in — "" or "NULL" (copied verbatim
// from the UI's restStatusUnknown semantics).
export function restStatusUnknown(status: unknown): boolean {
  const s = String(status ?? "").trim().toUpperCase();
  return s === "" || s === "NULL";
}

// A game the spectator feed reports as being played (mirrors the UI's isLive).
export function isSpectatorLive(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "IN_PROGRESS" || s === "LIVE";
}

// Worth probing the spectator feed? True when the REST status is one the feed
// never resolves while in play — unknown ("" / "NULL") OR "UPCOMING" (the NTFL
// feed uses UPCOMING, not empty) — AND kickoff falls inside the window. FINAL /
// IN_PROGRESS / LIVE are excluded here (FINAL needs no probe; IN_PROGRESS/LIVE
// are already caught by the cheap REST first pass).
export function isLiveCandidate(
  status: unknown,
  scheduledMs: number | null,
  nowMs: number
): boolean {
  const s = String(status ?? "").trim().toUpperCase();
  const statusProbe = restStatusUnknown(status) || s === "UPCOMING";
  if (!statusProbe) return false;
  if (scheduledMs == null) return false;
  return (
    nowMs >= scheduledMs - WINDOW_BEFORE_MS &&
    nowMs <= scheduledMs + WINDOW_AFTER_MS
  );
}

// Run `fn` over `items` with at most `limit` in flight at once, settling every
// result (never rejecting), so one failing probe can't abort the batch. A tiny
// local worker pool — no dependency, mirrors the UI's Promise.allSettled but
// bounded so a 2-min tick never fires dozens of probes at once.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(pool);
  return results;
}

// ── Round-summary pure helpers (inline copies) ───────────────────────────────
// Behaviourally IDENTICAL to reporting-ui/lib/round-summary/roundSummary.ts (the
// TESTED reference). The task forbids adding a test runner to the Worker, so the
// frontend suite pins the behaviour and these copies are reviewed against it.
// Keep the two in sync. All pure — no I/O, no env, no caches. See design §1.7-1.9.

// Minimal structural shape the round helpers read — satisfied by the Worker's
// cast Array<Record<string, unknown>> games (and by the frontend's PlayHqGame).
type RoundInputGame = {
  round?: { name?: string | null } | null;
  schedule?: { date?: string | null; time?: string | null } | null;
};

// Lookahead for the "imminent" tier — one match-day slot (design §1.7).
const ROUND_LOOKAHEAD_MS = 6 * 60 * 60 * 1000;

// First integer in a round name, or null ("Grand Final"). NOT a 9999 sentinel.
function roundNumOf(name: string | null | undefined): number | null {
  const m = String(name ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Short round label. Branch order matches app/push-log/page.tsx EXACTLY
// (prelim/semi/qualif/elim before any generic "final").
function shortRound(round: string | undefined): string {
  const n = (round ?? "").trim();
  if (!n) return "";
  const m = n.match(/round\s*(\d+)/i);
  if (m) return `R${m[1]}`;
  if (/grand\s*final/i.test(n)) return "GF";
  if (/prelim/i.test(n)) return "PF";
  if (/semi/i.test(n)) return "SF";
  if (/qualif/i.test(n)) return "QF";
  if (/elim/i.test(n)) return "EF";
  return n;
}

// Normalise a REST status for display: "" / "NULL" → "UPCOMING", else upper.
function displayStatus(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (s === "" || s.toUpperCase() === "NULL") return "UPCOMING";
  return s.toUpperCase();
}

// Strip the grade suffix from a team name — same regex the push pipeline uses,
// with the same (n ?? "?") fallback.
function stripGradeName(name: string | null | undefined): string {
  return (name ?? "?").replace(/\s+(men|women)\s+premier.*$/i, "").trim();
}

type RoundKey = { roundName: string; roundNum: number | null };

// Ordering of rounds (design §1.7 step 3): numbered before unnumbered; two
// numbered by number; two unnumbered by name. Never compares null as a number.
function compareRounds(a: RoundKey, b: RoundKey): number {
  const aHas = a.roundNum !== null;
  const bHas = b.roundNum !== null;
  if (aHas && bHas) return (a.roundNum as number) - (b.roundNum as number);
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  return a.roundName.localeCompare(b.roundName);
}

type RoundAgg = {
  roundName: string;
  roundNum: number | null;
  hasNum: boolean;
  earliestKickoff: number | null;
};

function aggregateRounds(games: RoundInputGame[]): RoundAgg[] {
  const byName = new Map<string, RoundAgg>();
  for (const game of games) {
    const roundName = game.round?.name ?? "";
    let agg = byName.get(roundName);
    if (!agg) {
      const rn = roundNumOf(roundName);
      agg = { roundName, roundNum: rn, hasNum: rn !== null, earliestKickoff: null };
      byName.set(roundName, agg);
    }
    const ms = scheduledKickoffMs(game.schedule);
    if (ms !== null && (agg.earliestKickoff === null || ms < agg.earliestKickoff)) {
      agg.earliestKickoff = ms;
    }
  }
  return Array.from(byName.values());
}

function highestRound(rounds: RoundAgg[]): RoundAgg | null {
  let best: RoundAgg | null = null;
  for (const r of rounds) if (best === null || compareRounds(r, best) > 0) best = r;
  return best;
}

function smallestRound(rounds: RoundAgg[]): RoundAgg | null {
  let best: RoundAgg | null = null;
  for (const r of rounds) if (best === null || compareRounds(r, best) < 0) best = r;
  return best;
}

// THE latest-round rule (design §1.7): started → imminent → first-upcoming,
// then an undated fallback. Returns the chosen round, or null for no games.
function selectLatestRound(games: RoundInputGame[], nowMs: number): RoundKey | null {
  const rounds = aggregateRounds(games);
  if (rounds.length === 0) return null;
  const dated = rounds.filter((r) => r.earliestKickoff !== null);

  const started = dated.filter((r) => (r.earliestKickoff as number) <= nowMs);
  const tierA = highestRound(started);
  if (tierA) return { roundName: tierA.roundName, roundNum: tierA.roundNum };

  const imminent = dated.filter(
    (r) => (r.earliestKickoff as number) <= nowMs + ROUND_LOOKAHEAD_MS
  );
  const tierB = highestRound(imminent);
  if (tierB) return { roundName: tierB.roundName, roundNum: tierB.roundNum };

  const tierC = smallestRound(dated);
  if (tierC) return { roundName: tierC.roundName, roundNum: tierC.roundNum };

  const fallback = highestRound(rounds);
  return fallback ? { roundName: fallback.roundName, roundNum: fallback.roundNum } : null;
}

// Latest-push-per-fixture index (design §1.8): key by full-UUID playhqId (empty
// skipped), keep max numeric ts; ties keep first seen.
function indexLatestPushes(entries: PushLogEntry[]): Map<string, PushLogEntry> {
  const index = new Map<string, PushLogEntry>();
  for (const entry of entries) {
    const id = String(entry?.playhqId ?? "");
    if (!id) continue;
    const prev = index.get(id);
    if (!prev) {
      index.set(id, entry);
      continue;
    }
    const tsNew = Date.parse(entry.ts);
    const tsPrev = Date.parse(prev.ts);
    const nNew = Number.isNaN(tsNew) ? -Infinity : tsNew;
    const nPrev = Number.isNaN(tsPrev) ? -Infinity : tsPrev;
    if (nNew > nPrev) index.set(id, entry);
  }
  return index;
}

// Does a NormalisedLive carry a usable in-play score signal? The spectator
// normaliser (`normaliseLive`) leaves total/goals/behinds as `null` on each
// side when the feed has no data (pre-game, or a failed/empty fetch); once a
// game is live it fills them with numbers (including a genuine 0). So "usable"
// means at least one of total/goals/behinds on either side is a real number.
function liveHasScore(live: NormalisedLive): boolean {
  const num = (v: number | null): boolean => typeof v === "number";
  return (
    num(live.home.total) ||
    num(live.home.goals) ||
    num(live.home.behinds) ||
    num(live.away.total) ||
    num(live.away.goals) ||
    num(live.away.behinds)
  );
}

// Decide which NormalisedLive to push: prefer the SPECTATOR-derived score while
// a game is live (it carries the real in-play totals the UI shows); otherwise
// fall back to the SUMMARY-derived score. The summary is correct once a game is
// FINAL (and the spectator feed may be empty post-game), and the fallback also
// covers a failed/empty spectator fetch (passed as null) so the push is never
// skipped. Pure — no I/O, no throwing.
function chooseLive(
  spectatorLive: NormalisedLive | null,
  summaryLive: NormalisedLive
): NormalisedLive {
  if (spectatorLive && liveHasScore(spectatorLive)) return spectatorLive;
  return summaryLive;
}

async function pushFixtureToTT(
  shortId: string,
  env: Env
): Promise<Record<string, unknown>> {
  const full = await resolveFullGame(shortId, env);
  if (!full) return { id: shortId, resolved: false, error: "fixture_not_found" };
  const fullId = String(full.id);

  let summary: Record<string, unknown> | null = null;
  try {
    summary = await fetchGameSummary(fullId, env);
  } catch (e) {
    return { id: shortId, fullId, error: e instanceof Error ? e.message : "summary_failed" };
  }

  // Passive, best-effort player ingestion from the summary we already have (no
  // extra PlayHQ call). Double-guarded so it can never affect the push.
  try {
    await ingestPlayers(summary, env);
  } catch {
    /* ingestion is best-effort; never affect the push */
  }

  // Team lists stay sourced from the REST summary (the authoritative full
  // roster), as does the summary-derived score used as a FINAL/pre-game and
  // failure fallback below.
  const summaryLive = summaryToScorersPeriods(shortId, summary);
  const lists = summaryToTeamLists(shortId, summary);

  // SCORE: source the in-play totals from the SPECTATOR feed the same way
  // /api/fixtures/:id/live does. For NTFL the REST summary stays PENDING with
  // zero totals until FINAL, so live pushes must read the spectator feed. We
  // reuse the already-resolved `full` record (via toFixtureLite) for team
  // identity — the same grade-feed team UUIDs resolveGameTeams would return —
  // so no ExecutionContext or extra fetch is needed. A spectator-fetch failure
  // leaves spectatorLive null so chooseLive falls back to the summary score;
  // the push is never skipped and never throws here.
  let spectatorLive: NormalisedLive | null = null;
  try {
    const lite = toFixtureLite(full);
    const game = (await fetchGame(shortId, env)) as Record<string, unknown>;
    spectatorLive = normaliseLive(shortId, game, { home: lite.home, away: lite.away });
  } catch {
    spectatorLive = null;
  }
  const live = chooseLive(spectatorLive, summaryLive);

  const score = await ttPost(env, "/PlayHQScoreUpdate", ttScoreBody(fullId, live));
  const team = lists
    ? await ttPost(env, "/PlayHQTeamUpdate", ttTeamBody(fullId, lists))
    : { status: 0, body: "no_appearances" };

  // Competition name from the game's PlayHQ url (scales to any comp); round
  // from the grade feed record; match with the grade suffix stripped.
  const competition = competitionLabel(full.url as string | undefined);
  const roundObj = (full.round ?? {}) as Record<string, unknown>;
  const round = (roundObj.name as string) ?? "";
  const stripGrade = (n: string | null) =>
    (n ?? "?").replace(/\s+(men|women)\s+premier.*$/i, "").trim();

  return {
    id: shortId,
    fullId,
    ttId: ttFixtureUidFor(fullId),
    status: summary.status ?? null,
    competition, // "NTFL Men's Premier" etc.
    round, // "Round 2" etc.
    // Human-readable match (grade suffix stripped from each team name).
    match: `${stripGrade(live.home.name)} vs ${stripGrade(live.away.name)}`,
    score: `${live.home.goals ?? 0}.${live.home.behinds ?? 0} (${live.home.total ?? 0}) - ${live.away.goals ?? 0}.${live.away.behinds ?? 0} (${live.away.total ?? 0})`,
    scorePush: score,
    teamPush: team,
  };
}

// Find all fixtures across the known grades that are being played right now, so
// the scheduled push knows which to forward. Returns their FULL ids (the grade
// feed's UUID — pushFixtureToTT -> resolveFullGame accepts a full UUID).
//
// Two passes, UNIONed:
//  (a) cheap REST first pass — any fixture the grade feed already reports as
//      IN_PROGRESS/LIVE (kept unchanged so nothing regresses); and
//  (b) spectator probe — for NTFL the REST feed stays UPCOMING right up until
//      FINAL, so we probe the spectator feed of each in-window UPCOMING/unknown
//      candidate and include the ones the feed reports as live. Bounded by a
//      kickoff window + a small concurrency pool; a probe failure for one
//      candidate is swallowed so it can never abort the scheduled loop.
async function liveFixtureIds(env: Env): Promise<string[]> {
  const gradeIds = (env.KNOWN_GRADE_IDS ?? DEFAULT_GRADE_IDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = new Set<string>();
  // Candidates to probe via the spectator feed, collected across all grades.
  const candidates: Array<{ fullId: string; shortId: string }> = [];
  const now = Date.now();
  for (const gradeId of gradeIds) {
    if (!UUID_RE.test(gradeId)) continue;
    let games: Array<Record<string, unknown>> = [];
    try {
      games = (await fetchGradeGames(gradeId, env)) as Array<Record<string, unknown>>;
    } catch {
      continue;
    }
    for (const g of games) {
      const fullId = String(g.id ?? "");
      if (!fullId) continue;
      // (a) Cheap first pass: REST already says it's live.
      if (isSpectatorLive(g.status)) {
        ids.add(fullId);
        continue;
      }
      // (b) Otherwise queue it as a spectator probe candidate if it's within
      //     the kickoff window and its REST status is unknown/UPCOMING.
      const schedule = (g.schedule ?? {}) as { date?: string | null; time?: string | null };
      if (isLiveCandidate(g.status, scheduledKickoffMs(schedule), now)) {
        candidates.push({ fullId, shortId: fullId.split("-")[0] });
      }
    }
  }

  // Probe candidates' spectator feeds with bounded concurrency. The spectator
  // `game` op (fetchGame) takes the SHORT id, same as /api/fixtures/:id/live.
  // A rejected probe is ignored — never rethrown — so one bad candidate can't
  // abort the push.
  const probes = await mapPool(candidates, 4, async (c) => {
    const game = (await fetchGame(c.shortId, env)) as Record<string, unknown>;
    return { fullId: c.fullId, status: String(game?.status ?? "") };
  });
  for (const p of probes) {
    if (p.status === "fulfilled" && isSpectatorLive(p.value.status)) {
      ids.add(p.value.fullId);
    }
  }

  return [...ids];
}

// One side of a fixture — the PlayHQ competitor (team) id plus its name.
type FixtureTeam = { id: string | null; name: string | null };

// A lean fixture record for the discovery endpoint: just what a consuming app
// needs to identify a fixture and then poll its score by `id`. Strips the
// heavy venue/address/sub-score detail from the full game object. Each side
// carries the team id AND name so a consumer can map on either.
type FixtureLite = {
  id: string; // the PlayHQ fixture/game id — poll /api/fixtures/:id/live with it
  status: string | null;
  round: string | null;
  date: string | null; // yyyy-mm-dd
  time: string | null; // HH:mm:ss
  timezone: string | null;
  venue: string | null;
  home: FixtureTeam;
  away: FixtureTeam;
  url: string | null;
};

function teamOf(c: Record<string, unknown> | undefined): FixtureTeam {
  return {
    id: c ? (c.id as string) ?? null : null,
    name: c ? (c.name as string) ?? null : null,
  };
}

function toFixtureLite(game: Record<string, unknown>): FixtureLite {
  const round = (game.round ?? {}) as Record<string, unknown>;
  const schedule = (game.schedule ?? {}) as Record<string, unknown>;
  const venue = (game.venue ?? null) as Record<string, unknown> | null;
  const comps = Array.isArray(game.competitors)
    ? (game.competitors as Array<Record<string, unknown>>)
    : [];
  const home = comps.find((c) => c.isHomeTeam === true);
  const away = comps.find((c) => c.isHomeTeam === false);
  return {
    id: String(game.id ?? ""),
    status: (game.status as string) ?? null,
    round: (round.name as string) ?? null,
    date: (schedule.date as string) ?? null,
    time: (schedule.time as string) ?? null,
    timezone: (schedule.timezone as string) ?? null,
    venue: (venue?.name as string) ?? null,
    home: teamOf(home),
    away: teamOf(away),
    url: (game.url as string) ?? null,
  };
}

// ── Competitor-intelligence collector ────────────────────────────────────────
// Polls each competitor_source whose collection_method is rss/youtube, parses
// new items, and inserts them into competitor_posts (deduped). Runs on the cron
// every COMPETITOR_POLL_MINUTES. Social platforms (manual) are never polled.

type CompetitorSourceRow = {
  id: number;
  competitor_id: number;
  platform: string;
  profile_url: string;
  feed_url: string | null;
  collection_method: string;
};

type FeedItem = {
  externalId: string;
  title: string;
  url: string;
  publishedAt: string | null;
};

// Minimal Supabase REST helpers (no SDK in the worker). RLS is disabled on
// these tables, so the anon key suffices for read + insert.
async function sbGet(
  env: Env,
  pathAndQuery: string
): Promise<unknown[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return [];
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`supabase get ${res.status}`);
  return (await res.json()) as unknown[];
}

async function sbInsert(
  env: Env,
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || rows.length === 0) return;
  // Prefer resolution=ignore-duplicates so the unique (competitor_id,
  // external_id) index drops repeats instead of erroring the whole batch.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`supabase insert ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
}

// Supabase UPSERT (merge-duplicates): like sbInsert but updates rows on
// conflict rather than ignoring them, so we keep the LATEST values. `table`
// includes the on_conflict query (e.g. "playhq_players?on_conflict=id").
// Env-guarded and 409-tolerant, mirroring sbInsert; never used by the existing
// competitor_posts path (which must stay ignore-duplicates).
async function sbUpsert(
  env: Env,
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || rows.length === 0) return;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`supabase upsert ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
}

// Sum the `value` of the scoreSubTotal entry whose `type` matches, else 0.
function subValFor(
  sub: Array<{ type?: string; value?: number }> | undefined,
  type: string
): number {
  if (!Array.isArray(sub)) return 0;
  const hit = sub.find((s) => s?.type === type);
  return typeof hit?.value === "number" ? hit.value : 0;
}

// Pure extractor: turn a REST game summary into `playhq_players` +
// `playhq_player_appearances` rows. Coaches (and any non-'Player' roleType) and
// entries without an id are skipped at source. No I/O, no throwing.
function playersFromSummary(summary: Record<string, unknown>): {
  players: Record<string, unknown>[];
  appearances: Record<string, unknown>[];
} {
  const gameId = String(summary?.id ?? "");
  const rawAppearances = Array.isArray(summary?.appearances)
    ? (summary.appearances as Array<Record<string, unknown>>)
    : null;
  if (!gameId || !rawAppearances) return { players: [], appearances: [] };

  // teamId -> team name, from competitors[].
  const comps = Array.isArray(summary.competitors)
    ? (summary.competitors as Array<Record<string, unknown>>)
    : [];
  const teamName = new Map<string, string>();
  for (const c of comps) {
    const id = c?.id != null ? String(c.id) : null;
    if (id && typeof c.name === "string") teamName.set(id, c.name);
  }

  const players: Record<string, unknown>[] = [];
  const appearances: Record<string, unknown>[] = [];
  const seenPlayers = new Set<string>();

  for (const a of rawAppearances) {
    if (a?.roleType !== "Player") continue; // skip Coach / other roles
    const playerId = a?.id != null ? String(a.id) : "";
    if (!playerId) continue; // skip missing id

    const teamId = a.teamID != null ? String(a.teamID) : null;
    const name = teamId ? teamName.get(teamId) ?? null : null;

    if (!seenPlayers.has(playerId)) {
      seenPlayers.add(playerId);
      players.push({
        id: playerId,
        first_name: a.firstName ?? null,
        last_name: a.lastName ?? null,
        last_team_id: teamId,
        last_team_name: name,
      });
    }

    const sub = a.scoreSubTotal as Array<{ type?: string; value?: number }> | undefined;
    const scoreTotal = +(a.scoreTotal as number);
    appearances.push({
      player_id: playerId,
      game_id: gameId,
      team_id: teamId,
      team_name: name,
      player_number: a.playerNumber ?? null, // keep as string
      player_position: a.playerPosition ?? null,
      captain_role: a.captainRole ?? null,
      is_fill_in: !!a.isFillIn,
      is_emergency: !!a.isEmergency,
      score_total: Number.isFinite(scoreTotal) ? scoreTotal : null,
      goals: Math.floor(subValFor(sub, "6_POINT_SCORE") / 6),
      behinds: subValFor(sub, "1_POINT_SCORE"),
      best_player: a.bestPlayer == null ? null : +(a.bestPlayer as number),
      raw: a,
    });
  }

  return { players, appearances };
}

// Best-effort passive ingest of players + appearances from a game summary.
// Env-guarded and fully swallowed: never throws into the caller, never changes
// any response. Players UPSERT with merge-duplicates (keep latest name/team/
// last_seen); appearances UPSERT on (player_id,game_id) so a re-fetch after
// more scoring updates the row.
async function ingestPlayers(
  summary: Record<string, unknown>,
  env: Env
): Promise<void> {
  try {
    const { players, appearances } = playersFromSummary(summary);
    if (players.length === 0 && appearances.length === 0) return;
    const now = new Date().toISOString();
    const playerRows = players.map((p) => ({ ...p, last_seen_at: now }));
    await sbUpsert(env, "playhq_players?on_conflict=id", playerRows);
    await sbUpsert(
      env,
      "playhq_player_appearances?on_conflict=player_id,game_id",
      appearances
    );
  } catch (e) {
    console.warn("ingestPlayers failed:", e instanceof Error ? e.message : e);
  }
}

// Result of one backfill batch — a resumable cursor the caller loops on.
type BackfillBatchResult = {
  grade: string;
  totalGames: number;
  offset: number;
  limit: number;
  processed: number;
  skipped: number;
  nextOffset: number | null;
  done: boolean;
};

// Process a SMALL, resumable slice of a grade's games for player backfill. The
// Cloudflare free plan caps ~50 subrequests per invocation; fetchGradeGames
// spends several paginating, and each game costs 1 summary fetch + 2 Supabase
// upserts. So we only touch `limit` games (hard-capped) per call and hand back
// a cursor (`nextOffset`/`done`) for the caller to loop. Games are processed
// SEQUENTIALLY with a small inter-game delay to bound subrequest bursts and be
// gentle on PlayHQ; each game is wrapped in try/catch so a single failed
// summary (404/forbidden/etc.) is counted as `skipped` and never aborts the
// batch. Reuses fetchGradeGames/fetchGameSummary/ingestPlayers unchanged;
// re-running overlapping offsets is safe because ingestPlayers upserts.
async function runBackfillBatch(
  grade: string,
  offset: number,
  limit: number,
  env: Env
): Promise<BackfillBatchResult> {
  const games = (await fetchGradeGames(grade, env)) as Array<Record<string, unknown>>;
  const totalGames = games.length;
  const slice = games.slice(offset, offset + limit);

  let processed = 0;
  let skipped = 0;
  for (let i = 0; i < slice.length; i++) {
    const g = slice[i];
    const fullId = String(g.id ?? "");
    if (!fullId) {
      skipped++;
      continue;
    }
    try {
      const summary = await fetchGameSummary(fullId, env);
      await ingestPlayers(summary, env);
      processed++;
    } catch {
      // Per-game failure (404/forbidden/rate-limit/etc.) — count and continue,
      // never abort the batch.
      skipped++;
    }
    // Gentle pacing between games (skip after the last one).
    if (i < slice.length - 1) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const reachedEnd = offset + limit >= totalGames;
  return {
    grade,
    totalGames,
    offset,
    limit,
    processed,
    skipped,
    nextOffset: reachedEnd ? null : offset + limit,
    done: reachedEnd,
  };
}

// Pull the text content of the FIRST matching tag inside a block.
function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return null;
  return decodeXmlEntities(stripCdata(m[1]).trim());
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Parse a feed body into items. Handles YouTube/Atom (<entry>) and RSS
// (<item>). Returns newest-first order as the feed provides.
function parseFeed(body: string): FeedItem[] {
  const items: FeedItem[] = [];

  // Atom (YouTube channel feeds are Atom): <entry>…</entry>.
  const entryBlocks = body.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of entryBlocks) {
    // YouTube: <yt:videoId>, link href, <published>, <title>.
    const videoId = tagText(block, "yt:videoId");
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
    const url = linkMatch?.[1] ?? "";
    const title = tagText(block, "title") ?? "";
    const published = tagText(block, "published") ?? tagText(block, "updated");
    const id = videoId || tagText(block, "id") || url;
    if (id && url) {
      items.push({ externalId: id, title, url, publishedAt: published });
    }
  }
  if (items.length > 0) return items;

  // RSS: <item>…</item>.
  const itemBlocks = body.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const url = tagText(block, "link") ?? "";
    const title = tagText(block, "title") ?? "";
    const guid = tagText(block, "guid") || url;
    const pub = tagText(block, "pubDate") || tagText(block, "dc:date");
    let iso: string | null = null;
    if (pub) {
      const d = new Date(pub);
      iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (guid && url) {
      items.push({ externalId: guid, title, url, publishedAt: iso });
    }
  }
  return items;
}

// Poll all rss/youtube sources and insert new posts. Returns a summary. Never
// throws — a single bad feed is logged and skipped so others still collect.
async function collectCompetitorPosts(env: Env): Promise<{
  sources: number;
  inserted: number;
}> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.log("competitor collector: Supabase not configured");
    return { sources: 0, inserted: 0 };
  }
  let sources: CompetitorSourceRow[] = [];
  try {
    sources = (await sbGet(
      env,
      "competitor_sources?select=id,competitor_id,platform,profile_url,feed_url,collection_method&collection_method=in.(rss,youtube)"
    )) as CompetitorSourceRow[];
  } catch (e) {
    console.log("competitor collector: load sources failed:", e instanceof Error ? e.message : "err");
    return { sources: 0, inserted: 0 };
  }

  let inserted = 0;
  for (const src of sources) {
    const feedUrl = src.feed_url || src.profile_url;
    if (!feedUrl) continue;
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "premier-data-competitor-collector/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        await markSourceChecked(env, src.id, `http_${res.status}`);
        continue;
      }
      const body = await res.text();
      const items = parseFeed(body).slice(0, 15); // cap per poll
      if (items.length === 0) {
        await markSourceChecked(env, src.id, "no_items");
        continue;
      }
      const rows = items.map((it) => ({
        competitor_id: src.competitor_id,
        source_id: src.id,
        platform: src.platform,
        external_id: it.externalId,
        title: it.title || null,
        url: it.url,
        published_at: it.publishedAt,
      }));
      await sbInsert(env, "competitor_posts", rows);
      inserted += rows.length;
      await markSourceChecked(env, src.id, "ok");
    } catch (e) {
      await markSourceChecked(env, src.id, e instanceof Error ? e.message.slice(0, 40) : "error");
    }
  }
  console.log(`competitor collector: polled ${sources.length} source(s), upserted up to ${inserted} item(s)`);
  return { sources: sources.length, inserted };
}

// Stamp a source's last_checked_at + last_status (best effort).
async function markSourceChecked(env: Env, id: number, status: string): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/competitor_sources?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ last_checked_at: new Date().toISOString(), last_status: status }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // non-fatal
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST/GET /api/admin/backfill-players — token-gated, BATCHED + resumable
    // player backfill for a grade. The free plan caps ~50 subrequests per
    // invocation, so a single call only processes a SMALL slice of games
    // (`limit`, hard-capped at 12) and returns a cursor (`nextOffset`/`done`)
    // for the caller to loop. Accepts GET (easy curl) or POST — both require
    // the token. Declared BEFORE the GET-only guard so POST reaches it.
    if (url.pathname === "/api/admin/backfill-players") {
      // Auth (token-gated): accept the token from an Authorization: Bearer
      // header, the x-backfill-token header, or a ?token= query param. Any
      // mismatch — or an unset BACKFILL_TOKEN — is a 401.
      const bearer = (request.headers.get("Authorization") ?? "").replace(
        /^Bearer\s+/i,
        ""
      );
      const provided =
        bearer ||
        request.headers.get("x-backfill-token") ||
        url.searchParams.get("token") ||
        "";
      if (!env.BACKFILL_TOKEN || provided !== env.BACKFILL_TOKEN) {
        return json({ error: "unauthorized" }, 401, cors);
      }

      // Validate the grade UUID.
      const grade = url.searchParams.get("grade") ?? "";
      if (!UUID_RE.test(grade)) {
        return json({ error: "invalid_grade_id" }, 400, cors);
      }

      // offset (default 0) and limit (default 10, hard-capped at 12) keep
      // subrequests well under the free-plan ceiling (limit*3 + pagination).
      const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
      const offset =
        Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
      const limitRaw = Number(url.searchParams.get("limit") ?? "10");
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(12, Math.floor(limitRaw))
          : 10;

      try {
        const result = await runBackfillBatch(grade, offset, limit, env);
        return json(result, 200, cors);
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "backfill_failed" }, 502, cors);
      }
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }

    if (url.pathname === "/health") {
      return json({ ok: true }, 200, cors);
    }

    const ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ?? "90") || 90);
    const cache = caches.default;

    // /api/grades/:id/fixtures — LEAN fixture index for a grade. Returns just
    // the fixture id + identifying detail (teams, round, date, status) so a
    // consuming application can discover the PlayHQ fixture id and then poll
    // its score via /api/fixtures/:id/live. This is the discovery endpoint for
    // external software.
    const fixturesMatch = url.pathname.match(
      /^\/api\/grades\/([^/]+)\/fixtures$/
    );
    if (fixturesMatch) {
      const gradeId = decodeURIComponent(fixturesMatch[1]);
      if (!UUID_RE.test(gradeId)) {
        return json({ error: "invalid_grade_id" }, 400, cors);
      }
      const key = new Request(`https://playhq-cache/grade-fixtures/${gradeId}`);
      const hit = await cache.match(key);
      if (hit) {
        return new Response(await hit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      try {
        const games = await fetchGradeGames(gradeId, env);
        const fixtures = (games as Array<Record<string, unknown>>).map(
          toFixtureLite
        );
        const bodyText = JSON.stringify({
          gradeId,
          count: fixtures.length,
          fixtures,
        });
        const listTtl = Math.min(ttl, 60) || 60;
        ctx.waitUntil(
          cache.put(
            key,
            new Response(bodyText, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${listTtl}`,
              },
            })
          )
        );
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${listTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_fixtures" }, 502, cors);
      }
    }

    // /api/grades/:id/games — the full fixture list for a grade (official REST
    // API). Cached at the edge like the live scores so repeated dashboard opens
    // don't re-hit PlayHQ. The fixture list changes slowly, so give it a longer
    // TTL than live scores.
    const gradeMatch = url.pathname.match(/^\/api\/grades\/([^/]+)\/games$/);
    if (gradeMatch) {
      const gradeId = decodeURIComponent(gradeMatch[1]);
      if (!UUID_RE.test(gradeId)) {
        return json({ error: "invalid_grade_id" }, 400, cors);
      }
      const gradeKey = new Request(`https://playhq-cache/grade-games/${gradeId}`);
      const gradeCached = await cache.match(gradeKey);
      if (gradeCached) {
        return new Response(await gradeCached.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      try {
        const games = await fetchGradeGames(gradeId, env);
        const bodyText = JSON.stringify({ gradeId, count: games.length, data: games });
        // Fixture list is slow-moving — cache a bit longer (but still short so
        // in-progress scores on the list refresh). 60s.
        const listTtl = Math.min(ttl, 60) || 60;
        const toCache = new Response(bodyText, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${listTtl}`,
          },
        });
        ctx.waitUntil(cache.put(gradeKey, toCache));
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${listTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_games" }, 502, cors);
      }
    }

    // /api/player/:id/profile — a PlayHQ player's COMPLETE public career
    // (career totals + every game ever played), flattened IN THE WORKER into
    // the CareerProfile shape the dashboard renders directly. Read-only, public
    // (no token). Proxies the Discovery GraphQL endpoint with browser-like
    // headers + the `tenant` header so PlayHQ returns 200, not 403. Short edge
    // cache so repeated profile opens don't re-hit PlayHQ.
    const careerMatch = url.pathname.match(/^\/api\/player\/([^/]+)\/profile$/);
    if (careerMatch) {
      const pid = decodeURIComponent(careerMatch[1]);
      if (!UUID_RE.test(pid)) {
        return json({ error: "invalid_player_id" }, 400, cors);
      }
      const tenant = url.searchParams.get("tenant") || env.PHQ_TENANT || "afl";
      const careerKey = new Request(
        `https://playhq-cache/player-career/${pid}/${tenant}`
      );
      const careerHit = await cache.match(careerKey);
      if (careerHit) {
        return new Response(await careerHit.text(), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "HIT",
            ...cors,
          },
        });
      }
      try {
        const data = await fetchPlayerCareer(pid, tenant, env);
        const profile = flattenCareer(data);
        const bodyText = JSON.stringify(profile);
        const careerTtl = 300;
        ctx.waitUntil(
          cache.put(
            careerKey,
            new Response(bodyText, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${careerTtl}`,
              },
            })
          )
        );
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${careerTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_career" }, 502, cors);
      }
    }

    // /api/fixtures/:id/live-scores  (raw spectator payload)
    // /api/fixtures/:id/live         (compact normalised live score)
    // /api/fixtures/:id/status       (just id/status/updatedAt)
    // /api/fixtures/:id/scorers — COMPLETE goal kickers + quarter scores from
    // the official REST game summary (appearances + periods). Unlike /live
    // (spectator feed, often partial), this matches the PlayHQ game-centre.
    const scorersMatch = url.pathname.match(/^\/api\/fixtures\/([^/]+)\/scorers$/);
    if (scorersMatch) {
      const sid = decodeURIComponent(scorersMatch[1]);
      if (!ID_RE.test(sid)) return json({ error: "invalid_fixture_id" }, 400, cors);
      const scorersCacheKey = new Request(`https://playhq-cache/scorers/${sid}`);
      const scorersHit = await cache.match(scorersCacheKey);
      if (scorersHit) {
        return new Response(await scorersHit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      try {
        const full = await resolveFullGame(sid, env);
        if (!full) return json({ error: "not_found" }, 404, cors);
        const summary = await fetchGameSummary(String(full.id), env);
        // Passive, best-effort ingest — no added latency (runs after response).
        ctx.waitUntil(ingestPlayers(summary, env));
        const payload = summaryToScorersPeriods(sid, summary);
        const bodyText = JSON.stringify(payload);
        const sTtl = Math.max(0, Number(env.LIVE_TTL_SECONDS ?? "15") || 15);
        if (sTtl > 0) {
          ctx.waitUntil(
            cache.put(
              scorersCacheKey,
              new Response(bodyText, {
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": `public, max-age=${sTtl}`,
                },
              })
            )
          );
        }
        return new Response(bodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": `public, max-age=${sTtl}`,
            ...cors,
          },
        });
      } catch (err) {
        if (err instanceof UpstreamError) {
          const extra: HeadersInit =
            err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
          return json({ error: err.message }, err.status, extra);
        }
        return json({ error: "unable_to_retrieve_scorers" }, 502, cors);
      }
    }

    // /api/fixtures/:id/teamlists — COMPLETE home/away rosters from the official
    // REST game summary (appearances[] = the full selected squad). This matches
    // the PlayHQ game-centre, unlike the spectator feed (players[]) which is
    // often partial. If the summary has no appearances yet (e.g. the lineup
    // isn't published), fall through to the spectator feed below.
    const teamlistsMatch = url.pathname.match(
      /^\/api\/fixtures\/([^/]+)\/teamlists$/
    );
    if (teamlistsMatch) {
      const tid = decodeURIComponent(teamlistsMatch[1]);
      if (!ID_RE.test(tid)) return json({ error: "invalid_fixture_id" }, 400, cors);
      const tlCacheKey = new Request(`https://playhq-cache/teamlists/${tid}`);
      const tlHit = await cache.match(tlCacheKey);
      if (tlHit) {
        return new Response(await tlHit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
      // Try the authoritative REST summary first.
      let payload: TeamListsPayload | null = null;
      try {
        const full = await resolveFullGame(tid, env);
        if (full) {
          const summary = await fetchGameSummary(String(full.id), env);
          // Passive, best-effort ingest — no added latency (runs after response).
          ctx.waitUntil(ingestPlayers(summary, env));
          payload = summaryToTeamLists(tid, summary);
        }
      } catch {
        // Summary unavailable (e.g. 404 pre-match, API hiccup) — fall back to
        // the spectator feed below rather than failing the request.
        payload = null;
      }
      // Fall back to the spectator feed when the summary carried no roster
      // (pre-match / not yet published) so behaviour never regresses.
      if (!payload) {
        try {
          const game = (await fetchGame(tid, env)) as Record<string, unknown>;
          const teams = await resolveGameTeams(tid, env, ctx);
          payload = {
            id: tid,
            status: (game.status as string) ?? null,
            home: {
              id: teams?.home.id ?? null,
              name: teams?.home.name ?? null,
              players: teamListFrom(game, "home"),
            },
            away: {
              id: teams?.away.id ?? null,
              name: teams?.away.name ?? null,
              players: teamListFrom(game, "away"),
            },
          };
        } catch (err) {
          if (err instanceof UpstreamError) {
            const extra: HeadersInit =
              err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
            return json({ error: err.message }, err.status, extra);
          }
          return json({ error: "unable_to_retrieve_team_lists" }, 502, cors);
        }
      }
      const bodyText = JSON.stringify(payload);
      const tlTtl = Math.max(0, Number(env.LIVE_TTL_SECONDS ?? "15") || 15);
      if (tlTtl > 0) {
        ctx.waitUntil(
          cache.put(
            tlCacheKey,
            new Response(bodyText, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${tlTtl}`,
              },
            })
          )
        );
      }
      return new Response(bodyText, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "MISS",
          "Cache-Control": `public, max-age=${tlTtl}`,
          ...cors,
        },
      });
    }

    // /api/push/:id — manually push ONE fixture's score + team list to TT (the
    // same work the scheduled job does per live fixture). Lets you verify the
    // TT integration on demand without waiting for a game to be live. Returns
    // TT's reply for each push so you can see "ok" / "n/a".
    const pushMatch = url.pathname.match(/^\/api\/push\/([^/]+)$/);
    if (pushMatch) {
      const pid = decodeURIComponent(pushMatch[1]);
      if (!ID_RE.test(pid)) return json({ error: "invalid_fixture_id" }, 400, cors);
      const result = await pushFixtureToTT(pid, env);
      const pushBase = (env.TT_BASE_URL ?? TT_BASE_DEFAULT).replace(/\/$/, "");
      await recordPushLog(env, pushBase, [result]);
      return json(result, 200, cors);
    }

    // /api/push — push ALL currently-live fixtures to TT on demand (same set
    // the cron would push). Useful to trigger a sweep manually. Also records to
    // the push log so the manual sweep shows up in the dashboard feed.
    if (url.pathname === "/api/push") {
      const pushBase = (env.TT_BASE_URL ?? TT_BASE_DEFAULT).replace(/\/$/, "");
      const ids = await liveFixtureIds(env);
      const results = [];
      for (const id of ids) results.push(await pushFixtureToTT(id, env));
      await recordPushLog(env, pushBase, results);
      return json({ count: results.length, results }, 200, cors);
    }

    // /api/collect-competitors — manually run the competitor feed collector
    // (same work the cron does). Returns how many sources were polled and
    // items upserted. Lets you populate the activity feed on demand.
    if (url.pathname === "/api/collect-competitors") {
      const result = await collectCompetitorPosts(env);
      return json(result, 200, cors);
    }

    // /api/push-log — the most recent TT pushes (newest first), so the
    // production dashboard can render a live push-activity feed from any
    // device. Read-only; no cache so it's always current.
    if (url.pathname === "/api/push-log") {
      let entries: unknown[] = [];
      if (env.PUSH_LOG) {
        try {
          const raw = await env.PUSH_LOG.get(PUSH_LOG_KEY);
          entries = raw ? JSON.parse(raw) : [];
        } catch {
          entries = [];
        }
      }
      return json({ count: entries.length, entries }, 200, cors);
    }

    // /api/round-summary — a SUMMARY board for the Push Activity page: for every
    // known grade, the latest relevant round with ALL its fixtures, each joined
    // to its latest pushed score from the PUSH_LOG. Lets an operator scan "what
    // is the current scoreline for every fixture this round" across 40+
    // divisions without wading through hundreds of raw log rows. Assembled here
    // because the Worker is the only component that enumerates every grade, can
    // fetch each grade's games behind the edge cache, and owns PUSH_LOG. Never
    // throws out (empty board instead of a 5xx) — see design §1.1. Short-TTL
    // edge cache so a roomful of pollers collapses to one assembly per window.
    if (url.pathname === "/api/round-summary") {
      const boardKey = new Request("https://playhq-cache/round-summary");
      const boardHit = await cache.match(boardKey);
      if (boardHit) {
        return new Response(await boardHit.text(), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }

      try {
        // Same grade list the push pipeline + live resolution know about.
        const gradeIds = (env.KNOWN_GRADE_IDS ?? DEFAULT_GRADE_IDS.join(","))
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((id) => UUID_RE.test(id));

        // Read PUSH_LOG ONCE for the whole request and build the latest-per-
        // fixture index once; a malformed store degrades to an empty log.
        let pushLog: PushLogEntry[] = [];
        if (env.PUSH_LOG) {
          try {
            const rawLog = await env.PUSH_LOG.get(PUSH_LOG_KEY);
            pushLog = rawLog ? (JSON.parse(rawLog) as PushLogEntry[]) : [];
          } catch (e) {
            console.log(
              "round-summary: push-log read failed:",
              e instanceof Error ? e.message : "error"
            );
            pushLog = [];
          }
        }
        const pushIndex = indexLatestPushes(Array.isArray(pushLog) ? pushLog : []);

        const listTtl = Math.min(ttl, 60) || 60;
        const nowMs = Date.now();

        type RoundSummaryFixture = {
          id: string;
          match: string;
          scheduled: string | null;
          status: string;
          score: string | null;
          ok: boolean | null;
          ttId: number | null;
          lastPushTs: string | null;
        };
        type RoundSummaryDivision = {
          gradeId: string;
          competition: string;
          round: string;
          roundShort: string;
          roundNum: number | null;
          fixtures: RoundSummaryFixture[];
        };
        type GradeResult =
          | { ok: true; division: RoundSummaryDivision }
          | { ok: false; error: { gradeId: string; error: string } };

        // Per-grade: cache-read grade-games → fetch on miss (warming the shared
        // cache byte-for-byte like /api/grades/:id/games) → select the latest
        // round → build its fixtures joined to the push index. Never rejects
        // (mapPool settles), and a failed grade becomes an error record.
        const perGrade = async (gradeId: string): Promise<GradeResult> => {
          try {
            let games: Array<Record<string, unknown>> | null = null;
            const gKey = new Request(`https://playhq-cache/grade-games/${gradeId}`);
            const gHit = await cache.match(gKey);
            if (gHit) {
              try {
                const body = (await gHit.json()) as {
                  data?: Array<Record<string, unknown>>;
                };
                games = Array.isArray(body.data) ? body.data : null;
              } catch {
                games = null;
              }
            }
            if (!games) {
              const data = (await fetchGradeGames(gradeId, env)) as Array<
                Record<string, unknown>
              >;
              games = data;
              // Warm the shared grade-games cache (deliberate new write; mirrors
              // the /api/grades/:id/games handler's expressions byte-for-byte so
              // either writer produces an interchangeable entry).
              const bodyText = JSON.stringify({ gradeId, count: data.length, data });
              const toCache = new Response(bodyText, {
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": `public, max-age=${listTtl}`,
                },
              });
              ctx.waitUntil(cache.put(gKey, toCache));
            }

            const selected = selectLatestRound(games as RoundInputGame[], nowMs);
            // Competition label from any game of the grade (they share the slug).
            const competition = competitionLabel(
              (games[0]?.url as string | undefined) ?? undefined
            );
            if (!selected) {
              return {
                ok: true,
                division: {
                  gradeId,
                  competition,
                  round: "",
                  roundShort: "",
                  roundNum: null,
                  fixtures: [],
                },
              };
            }

            const inRound = games.filter(
              (g) =>
                String(((g.round ?? {}) as Record<string, unknown>).name ?? "") ===
                selected.roundName
            );

            const fixtures: RoundSummaryFixture[] = inRound.map((g) => {
              const comps = Array.isArray(g.competitors)
                ? (g.competitors as Array<Record<string, unknown>>)
                : [];
              const home = comps.find((c) => c.isHomeTeam === true);
              const away = comps.find((c) => c.isHomeTeam === false);
              const schedule = (g.schedule ?? {}) as Record<string, unknown>;
              const date = (schedule.date as string) ?? null;
              const time = (schedule.time as string) ?? null;
              const id = String(g.id ?? "");
              const p = pushIndex.get(id);
              return {
                id,
                match: `${stripGradeName((home?.name as string) ?? null)} vs ${stripGradeName((away?.name as string) ?? null)}`,
                scheduled: date ? `${date}T${time || "00:00:00"}` : null,
                status: displayStatus(g.status),
                score: p ? p.score : null,
                ok: p ? p.ok : null,
                ttId: p ? (p.ttId ?? null) : null,
                lastPushTs: p ? p.ts : null,
              };
            });

            // Deterministic order: by scheduled asc (nulls last), then match.
            fixtures.sort((a, b) => {
              if (a.scheduled !== b.scheduled) {
                if (a.scheduled === null) return 1;
                if (b.scheduled === null) return -1;
                return a.scheduled < b.scheduled ? -1 : 1;
              }
              return a.match.localeCompare(b.match);
            });

            return {
              ok: true,
              division: {
                gradeId,
                competition,
                round: selected.roundName,
                roundShort: shortRound(selected.roundName),
                roundNum: selected.roundNum,
                fixtures,
              },
            };
          } catch (err) {
            if (err instanceof UpstreamError) {
              return { ok: false, error: { gradeId, error: err.message } };
            }
            return { ok: false, error: { gradeId, error: "fetch_failed" } };
          }
        };

        const settled = await mapPool(gradeIds, 6, perGrade);
        const rounds: RoundSummaryDivision[] = [];
        const errors: { gradeId: string; error: string }[] = [];
        for (const r of settled) {
          if (r.status !== "fulfilled") continue; // mapPool never rejects, but guard
          if (r.value.ok) rounds.push(r.value.division);
          else errors.push(r.value.error);
        }

        // Sort rounds by competition, then by the round comparator.
        rounds.sort((a, b) => {
          const byComp = a.competition.localeCompare(b.competition);
          if (byComp !== 0) return byComp;
          return compareRounds(
            { roundName: a.round, roundNum: a.roundNum },
            { roundName: b.round, roundNum: b.roundNum }
          );
        });

        const bodyText = JSON.stringify({
          generatedAt: new Date(nowMs).toISOString(),
          rounds,
          errors,
        });
        // Short board cache (45s) so repeated polls collapse to one assembly.
        ctx.waitUntil(
          cache.put(
            boardKey,
            new Response(bodyText, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=45",
              },
            })
          )
        );
        return new Response(bodyText, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "MISS", ...cors },
        });
      } catch (e) {
        // Any unexpected failure still returns a valid empty board, never a 5xx.
        console.log(
          "round-summary: assembly failed:",
          e instanceof Error ? e.message : "error"
        );
        return json(
          {
            generatedAt: new Date().toISOString(),
            rounds: [],
            errors: [
              { gradeId: "*", error: e instanceof Error ? e.message : "error" },
            ],
          },
          200,
          cors
        );
      }
    }

    const m = url.pathname.match(
      /^\/api\/fixtures\/([^/]+)\/(live-scores|live|status)$/
    );
    if (!m) return json({ error: "not_found" }, 404, cors);

    const id = decodeURIComponent(m[1]);
    const kind = m[2];
    if (!ID_RE.test(id)) {
      return json({ error: "invalid_fixture_id" }, 400, cors);
    }

    // Edge cache keyed by the normalised request (one entry per fixture+kind).
    // Many dashboard tabs polling the same fixture within the TTL collapse to a
    // single upstream call.
    const cacheKey = new Request(
      `https://playhq-cache/${kind}/${id}`,
      { method: "GET" }
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "HIT",
          ...cors,
        },
      });
    }

    try {
      const game = (await fetchGame(id, env)) as Record<string, unknown>;
      // For the normalised /live payload, attach team id+name resolved from the
      // known grades' REST feeds (the spectator feed carries no team identity).
      const teams = kind === "live" ? await resolveGameTeams(id, env, ctx) : null;
      const payload =
        kind === "status"
          ? {
              id: game.id,
              status: game.status,
              updatedAt: game.updatedAt,
            }
          : kind === "live"
            ? normaliseLive(id, game, teams)
            : game;

      const bodyText = JSON.stringify(payload);

      // Live score endpoints get a SHORT TTL so in-play scores are near-live;
      // status (slow-moving) uses the longer TTL.
      const kindTtl =
        kind === "status"
          ? ttl
          : Math.max(0, Number(env.LIVE_TTL_SECONDS ?? "15") || 15);

      // Store in the edge cache with the kind's TTL (only when TTL > 0).
      if (kindTtl > 0) {
        const toCache = new Response(bodyText, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${kindTtl}`,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }

      return new Response(bodyText, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "MISS",
          // Tell the browser not to cache a live score beyond the edge TTL.
          "Cache-Control": `public, max-age=${kindTtl}`,
          ...cors,
        },
      });
    } catch (err) {
      if (err instanceof UpstreamError) {
        // Pass rate-limit / forbidden through so the poller can back off, and
        // hint a Retry-After on 429.
        const extra: HeadersInit =
          err.status === 429 ? { "Retry-After": "120", ...cors } : cors;
        return json({ error: err.message }, err.status, extra);
      }
      // Timeouts / network faults.
      return json({ error: "unable_to_retrieve_scores" }, 502, cors);
    }
  },

  // Cron trigger (see wrangler.toml [triggers]). Every run: find all live
  // fixtures across the known grades and push each one's score + team list to
  // the TT system. Runs independently of the browser-facing /live endpoints.
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const task = (async () => {
      const base = (env.TT_BASE_URL ?? TT_BASE_DEFAULT).replace(/\/$/, "");
      const ids = await liveFixtureIds(env);
      const ts = () => new Date().toISOString();
      if (ids.length === 0) {
        console.log(`[${ts()}] TT push: no live fixtures to send`);
        return;
      }
      console.log(`[${ts()}] TT push: ${ids.length} live fixture(s) -> ${base}`);
      const results: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const r = await pushFixtureToTT(id, env);
        logPushResult(r, base);
        results.push(r);
      }
      await recordPushLog(env, base, results);
    })();
    ctx.waitUntil(task);

    // Competitor-intelligence collector — runs on cron ticks that are a
    // multiple of COMPETITOR_POLL_MINUTES (default 30), independent of the
    // 2-minute score push. Polls competitor RSS/YouTube feeds into Supabase.
    const pollEvery = Math.max(2, Number(env.COMPETITOR_POLL_MINUTES ?? "30") || 30);
    const minutes = Math.floor(Date.now() / 60_000);
    if (minutes % pollEvery === 0) {
      ctx.waitUntil(
        collectCompetitorPosts(env).catch((e) =>
          console.log("competitor collector error:", e instanceof Error ? e.message : "err")
        )
      );
    }
  },
};
