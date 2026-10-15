// Pure, Supabase-free promise caches for the data layer.
//
// Mirrors the proven in-repo pattern in `lib/api/clubConfig.ts` and
// `lib/api/fixtureMap.ts`: a module-level `Promise<T> | null` populated once
// and reused, with the fetch's `.catch` resetting the slot so a failed fetch
// never poisons the cache. Extracted here so the cache *mechanism*
// (populate-once, dedupe-concurrent, reset-on-error, invalidate) is
// unit-testable without a mocked Supabase client. The data modules wrap their
// existing fetch bodies with these helpers; the exported fetch signatures stay
// identical.
//
// IMPORTANT — treat cached results as READ-ONLY. On a cache hit the SAME
// array/object instance is handed to every caller. Callers must not mutate it
// in place (no in-place sort/splice/push); derive a new array via
// map/filter/[...spread] instead, or a mutation would corrupt the shared cache
// for the next reader.

/** Single-value cache: populate once, dedupe concurrent callers, reset on error. */
export function createCache<T>(fetcher: () => Promise<T>): {
  get: () => Promise<T>;
  invalidate: () => void;
} {
  let cache: Promise<T> | null = null;
  return {
    get() {
      if (!cache) {
        cache = fetcher().catch((e) => {
          cache = null; // never poison the cache
          throw e;
        });
      }
      return cache;
    },
    invalidate() {
      cache = null;
    },
  };
}

/** Keyed cache: one entry per normalized key; invalidate clears the whole map. */
export function createKeyedCache<T>(
  fetcher: (arg: string) => Promise<T>,
  keyFn: (arg: string) => string = (s) => s
): {
  get: (arg: string) => Promise<T>;
  invalidate: () => void;
} {
  const map = new Map<string, Promise<T>>();
  return {
    get(arg) {
      const key = keyFn(arg);
      let p = map.get(key);
      if (!p) {
        p = fetcher(arg).catch((e) => {
          map.delete(key);
          throw e;
        });
        map.set(key, p);
      }
      return p;
    },
    invalidate() {
      map.clear();
    },
  };
}
