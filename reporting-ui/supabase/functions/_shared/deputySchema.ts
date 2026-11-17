// Shared helpers for detecting and riding out "the Supabase Data API is not
// exposing the `deputy` schema" (PostgREST PGRST106, HTTP 406). Pure TS: no
// Deno-only APIs, so vitest can import it too.
//
// Incident 2026-11-16: the Data API briefly stopped exposing `deputy`, so every
// `.schema("deputy")` call failed with 406 / PGRST106 "Invalid schema: deputy".

export const SCHEMA_NOT_EXPOSED_MESSAGE =
  "The Supabase Data API is not exposing the 'deputy' schema. In Supabase: Project Settings -> Data API -> Exposed schemas, add 'deputy'.";

type ErrLike = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
};

/** Error thrown by withSchemaRetry once all attempts hit schema-not-exposed. */
export class SchemaNotExposedError extends Error {
  readonly tag = "deputy_schema_not_exposed" as const;
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "SchemaNotExposedError";
    this.detail = detail;
  }
}

/** True when `err` is PostgREST's "schema not exposed" failure. */
export function isSchemaNotExposed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof SchemaNotExposedError) return true;
  const e = err as ErrLike;
  if (e.code === "PGRST106") return true;
  const text = [e.message, e.details, e.hint]
    .filter((x): x is string => typeof x === "string")
    .join(" ");
  if (/Invalid schema:\s*deputy/i.test(text)) return true;
  return e.status === 406 && /schema/i.test(text);
}

/** Short, secret-free description of a PostgREST error. */
export function describeError(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown";
  const e = err as ErrLike;
  const code = typeof e.code === "string" && e.code ? `${e.code}: ` : "";
  const msg = typeof e.message === "string" ? e.message : "unknown";
  return `${code}${msg}`.slice(0, 300);
}

export type RetryOptions = {
  attempts?: number;
  delaysMs?: number[];
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` (a supabase-js call resolving to `{ data, error }`, or any promise)
 * and retries ONLY when it fails with schema-not-exposed, whether returned as
 * `result.error` or thrown. After the last attempt throws SchemaNotExposedError.
 * Any other result or error is returned/thrown untouched on the first try.
 */
export async function withSchemaRetry<T>(
  fn: () => PromiseLike<T> | T,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delaysMs = opts.delaysMs ?? [500, 1500];
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      const resErr = (res as { error?: unknown } | null)?.error;
      if (!resErr || !isSchemaNotExposed(resErr)) return res;
      lastErr = resErr;
    } catch (e) {
      if (!isSchemaNotExposed(e)) throw e;
      lastErr = e;
    }
    if (i < attempts - 1) {
      await sleep(delaysMs[Math.min(i, delaysMs.length - 1)] ?? 0);
    }
  }
  throw new SchemaNotExposedError(describeError(lastErr));
}
