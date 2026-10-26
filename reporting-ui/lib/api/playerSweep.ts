// ======================================================================
// Competition player sweep — typed client for the two FEAT-001 worker
// endpoints:
//   GET  {WORKER_BASE}/api/competition/:seasonId/grades   (public, no token)
//   GET|POST {WORKER_BASE}/api/admin/sweep-competition      (token-gated)
//
// The sweep endpoint processes ONE small grade slice per call and returns a
// resumable cursor (`next`), so the UI drives the loop client-side (the
// Cloudflare free plan caps subrequests per invocation). The BACKFILL_TOKEN
// is supplied from a UI input and passed per request — NEVER embedded here or
// in env.
// ======================================================================

// Worker base URL — resolved the SAME way as lib/api/players.ts (each client
// declares its own local constant). Falls back to the workers.dev default so
// the feature works before a custom domain is wired up. NOT hardcoded.
const WORKER_BASE =
  process.env.NEXT_PUBLIC_PLAYHQ_WORKER_URL?.replace(/\/$/, "") ||
  "https://playhq-scores.premier-data-enterprise.workers.dev";

/** One grade in a season (short ids as returned by the PlayHQ GraphQL API). */
export type SeasonGrade = {
  id: string;
  name: string;
  gender: string | null;
  age: string | null;
  day?: string | null;
};

/** The cleaned season/competition/organisation/grades shape from the worker. */
export type SeasonGradesResponse = {
  season: { id: string; name: string; status?: string | null };
  competition: { id: string; name: string; type?: string | null };
  organisation: { id: string; name: string; type?: string | null };
  grades: SeasonGrade[];
};

/** One resumable sweep slice result (mirrors the worker's cursor JSON). */
export type SweepBatchResult = {
  season: { id: string; name: string };
  competition: { id: string; name: string; type?: string | null };
  organisation: { id: string; name: string; type?: string | null };
  grades: SeasonGrade[];
  gradeIndex: number;
  gradeId: string;
  gradeName: string;
  totalGames: number;
  offset: number;
  limit: number;
  processed: number;
  skipped: number;
  done: boolean;
  next: { gradeIndex: number; offset: number } | null;
};

/**
 * Extract the SEASON short id from a pasted PlayHQ URL, or return the trimmed
 * input unchanged when it's not a URL (assumed to already be a season id).
 *
 * Forgiving by design: PlayHQ season/competition pages carry the season short
 * id as the last path segment, e.g.
 *   https://www.playhq.com/afl/org/<org>/<comp-slug>/<SEASON_ID>
 * so we take the last id-like segment of the path.
 *
 * NOTE: a game-centre URL carries a GAME id (not the season id); this function
 * cannot turn a game id into a season id — in that case the fallback returns
 * the trimmed input verbatim, and the caller should surface the hint to paste
 * the SEASON id or a season-page URL instead.
 */
export function parseSeasonId(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return trimmed;

  // Only treat it as a URL when it looks like one.
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("playhq.com")) {
    try {
      const url = new URL(
        /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
      );
      const segments = url.pathname.split("/").filter(Boolean);
      // The season id is the last short-id-like segment of the path.
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (/^[a-zA-Z0-9_-]{4,64}$/.test(seg)) return seg;
      }
    } catch {
      /* not a parseable URL — fall through to the trimmed-input fallback */
    }
  }

  return trimmed;
}

// Map a failed worker response to an Error carrying its { error } field, the
// same way lib/api/players.ts getPlayerCareer does.
async function errorFrom(res: Response, label: string): Promise<Error> {
  let message = `${label} (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = `${label} (${body.error})`;
  } catch {
    /* non-JSON error body — keep the generic message */
  }
  return new Error(message);
}

/**
 * Preview a season's grades (competition + organisation + grade list). Public,
 * read-only, no token. Throws an Error carrying the worker's { error } field on
 * a non-ok response (mirrors getPlayerCareer).
 */
export async function getSeasonGrades(
  seasonId: string
): Promise<SeasonGradesResponse> {
  const res = await fetch(
    `${WORKER_BASE}/api/competition/${encodeURIComponent(seasonId)}/grades`,
    { cache: "no-store" }
  );

  if (!res.ok) throw await errorFrom(res, "Failed loading season grades");

  return (await res.json()) as SeasonGradesResponse;
}

/**
 * Process ONE grade slice and return the resumable cursor. The token is a
 * function argument only (the user pastes BACKFILL_TOKEN into the UI) — it is
 * never stored in code or env. Throws an Error carrying the worker's { error }
 * field on a non-ok response.
 */
export async function sweepCompetitionBatch(args: {
  season: string;
  gradeIndex: number;
  offset: number;
  limit: number;
  token: string;
}): Promise<SweepBatchResult> {
  const { season, gradeIndex, offset, limit, token } = args;

  const qs =
    `season=${encodeURIComponent(season)}` +
    `&gradeIndex=${encodeURIComponent(String(gradeIndex))}` +
    `&offset=${encodeURIComponent(String(offset))}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&token=${encodeURIComponent(token)}`;

  const res = await fetch(
    `${WORKER_BASE}/api/admin/sweep-competition?${qs}`,
    { cache: "no-store" }
  );

  if (!res.ok) throw await errorFrom(res, "Sweep batch failed");

  return (await res.json()) as SweepBatchResult;
}
