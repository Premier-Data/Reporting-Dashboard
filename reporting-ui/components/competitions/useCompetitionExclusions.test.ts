import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { ExclusionsTableMissingError } from "@/lib/api/competitionExclusions";
import { resolveExclusionState } from "./useCompetitionExclusions";

describe("resolveExclusionState", () => {
  it("uses the rows and allows saving on success", () => {
    const rows = [
      { id: 1, kind: "team" as const, key: "a", label: "A", reason: null, created_by: null, created_at: null },
    ];
    const s = resolveExclusionState({ rows });
    expect(s.rows).toBe(rows);
    expect(s.status).toBe("ready");
    expect(s.canPersist).toBe(true);
    expect(s.notice).toBeNull();
  });

  it("falls back to the built-in 8 with the migration notice when the table is missing", () => {
    const s = resolveExclusionState({ error: new ExclusionsTableMissingError() });
    expect(s.status).toBe("fallback");
    expect(s.fallbackReason).toBe("missing");
    expect(s.notice).toBe("Exclusions not set up yet: run migration 010");
    expect(s.canPersist).toBe(false);
    expect(s.rows).toHaveLength(8);
  });

  it("falls back with its own notice on other failures", () => {
    const s = resolveExclusionState({ error: new Error("network down") });
    expect(s.fallbackReason).toBe("error");
    expect(s.notice).toBe("Could not load exclusions (network down); using the built-in list");
    expect(s.canPersist).toBe(false);
    expect(s.rows).toHaveLength(8);
  });
});
