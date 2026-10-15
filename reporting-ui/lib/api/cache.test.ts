// Pure-mechanism tests for the data-layer promise caches. No network, no
// Supabase — each helper is driven by a counting/throwing stub `fetcher` so the
// cache state machine (populate-once, dedupe-concurrent, invalidate-forces-
// refetch, error-does-not-poison) is exercised in isolation. These are the
// risky part of the caching change; the data-module wiring is review-verified
// against the invalidation matrix.
import { describe, it, expect } from "vitest";
import { createCache, createKeyedCache } from "./cache";

describe("createCache", () => {
  it("populates once: two sequential gets call the fetcher exactly once", async () => {
    let calls = 0;
    const cache = createCache(async () => {
      calls += 1;
      return { n: calls };
    });

    const a = await cache.get();
    const b = await cache.get();

    expect(calls).toBe(1);
    expect(a).toBe(b); // same resolved instance
  });

  it("dedupes concurrent callers: two gets before resolve share one fetch", async () => {
    let calls = 0;
    const cache = createCache(async () => {
      calls += 1;
      return { n: calls };
    });

    const [a, b] = await Promise.all([cache.get(), cache.get()]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("invalidate forces a re-fetch", async () => {
    let calls = 0;
    const cache = createCache(async () => {
      calls += 1;
      return calls;
    });

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(calls).toBe(2);
  });

  it("error does not poison: a rejected fetch resets the slot and the next get retries", async () => {
    let calls = 0;
    const cache = createCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "ok";
    });

    await expect(cache.get()).rejects.toThrow("boom");
    await expect(cache.get()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("createKeyedCache", () => {
  it("isolates keys: distinct keys each call the fetcher once", async () => {
    let calls = 0;
    const cache = createKeyedCache(async (arg: string) => {
      calls += 1;
      return arg.toUpperCase();
    });

    const a = await cache.get("a");
    const b = await cache.get("b");
    const a2 = await cache.get("a");

    expect(calls).toBe(2); // one per distinct key, "a" reused
    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(a2).toBe("A");
  });

  it("normalization collapses keys", async () => {
    let calls = 0;
    const cache = createKeyedCache(
      async (arg: string) => {
        calls += 1;
        return arg;
      },
      (s) => s.trim().toLowerCase()
    );

    await cache.get("Jane");
    await cache.get(" jane ");
    await cache.get("JANE");

    expect(calls).toBe(1);
  });

  it("invalidate clears all keys", async () => {
    let calls = 0;
    const cache = createKeyedCache(async (arg: string) => {
      calls += 1;
      return arg;
    });

    await cache.get("a");
    await cache.get("b");
    expect(calls).toBe(2);

    cache.invalidate();

    await cache.get("a");
    await cache.get("b");
    expect(calls).toBe(4);
  });

  it("error does not poison a key: a rejected fetch is deleted and the next get retries", async () => {
    let calls = 0;
    const cache = createKeyedCache(async (arg: string) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return arg;
    });

    await expect(cache.get("a")).rejects.toThrow("boom");
    await expect(cache.get("a")).resolves.toBe("a");
    expect(calls).toBe(2);
  });
});
