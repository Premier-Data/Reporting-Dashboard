import { describe, it, expect, vi } from "vitest";

// auth.ts imports the Supabase client, which needs env vars at import time.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { pageKeysForPath } from "./auth";

describe("pageKeysForPath", () => {
  it("opens Operations reporting to deputy-api OR deputy-insights", () => {
    expect(pageKeysForPath("/operations-reporting")).toEqual([
      "deputy-api",
      "deputy-insights",
    ]);
  });

  it("does not confuse /operations-reporting with Live Board (/operations)", () => {
    expect(pageKeysForPath("/operations")).toEqual(["operations"]);
  });

  it("keeps single-key and aliased routes unchanged", () => {
    expect(pageKeysForPath("/reporting")).toEqual(["reporting"]);
    expect(pageKeysForPath("/vn-soccer")).toEqual(["reporting"]);
    expect(pageKeysForPath("/deputy-api")).toEqual(["deputy-api"]);
  });

  it("returns [] for unknown routes", () => {
    expect(pageKeysForPath("/nope")).toEqual([]);
  });
});
