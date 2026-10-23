// Deputy QUERY body builders + pagination/retry helpers. Framework-free and
// unit-testable (no Deno/Supabase imports).

export type DeputyQuery = {
  search?: Record<string, { field: string; type: string; data: unknown }>;
  start: number;
  max: number;
  sort?: Record<string, "asc" | "desc">;
  join?: string[];
};

// Build a paged QUERY body. Always sorts by Id asc for deterministic paging
// (the brief's verified pattern). An optional date window adds a range filter
// on the resource's date field.
export function buildQuery(opts: {
  start: number;
  max: number;
  dateField?: string;
  from?: string; // yyyy-mm-dd
  to?: string; // yyyy-mm-dd
}): DeputyQuery {
  const search: DeputyQuery["search"] = {
    s1: { field: "Id", type: "gt", data: 0 },
  };
  // Verified operators from the brief: Date ge "from" AND Date lt "to".
  if (opts.dateField && opts.from) {
    search.s2 = { field: opts.dateField, type: "ge", data: opts.from };
  }
  if (opts.dateField && opts.to) {
    search.s3 = { field: opts.dateField, type: "lt", data: opts.to };
  }
  return { search, start: opts.start, max: opts.max, sort: { Id: "asc" } };
}

// Decide whether to keep paging: stop when a page returns fewer than `max`
// rows, or is empty. Never relies on a total-count field (not guaranteed).
export function hasMorePages(pageLen: number, max: number): boolean {
  return pageLen > 0 && pageLen >= max;
}

// Normalise a Deputy response into an array of records. Confirmed shape is a
// bare array; also tolerate a {data:[...]} / {result:[...]} wrapper defensively.
export function toRecordArray(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["data", "result", "results", "records"]) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
  }
  return [];
}

// Dedupe a batch by deputy_id (guards the unique index + detects in-batch
// duplicate ids). Keeps the LAST occurrence (newest in a sorted page wins).
export function dedupeByDeputyId(
  rows: Record<string, unknown>[]
): { unique: Record<string, unknown>[]; duplicates: number } {
  const map = new Map<string, Record<string, unknown>>();
  let duplicates = 0;
  for (const r of rows) {
    const id = r.deputy_id as string | null;
    if (id == null) continue; // skip rows with no id rather than upsert a null key
    if (map.has(id)) duplicates += 1;
    map.set(id, r);
  }
  return { unique: [...map.values()], duplicates };
}

// Is this HTTP status worth retrying? Transient server/rate-limit errors yes;
// auth/validation no.
export function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// Exponential backoff with full jitter, honouring Retry-After when present.
export function backoffMs(attempt: number, retryAfterSec?: number | null): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 60_000);
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.floor(Math.random() * base); // full jitter
}
