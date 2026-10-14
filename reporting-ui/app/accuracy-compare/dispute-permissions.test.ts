import { describe, it, expect } from "vitest";
import type { MatchStatus } from "@/lib/comparison/xml-compare";
import type { Instance } from "@/lib/comparison/xml-compare";
import {
  isEmptySlotStatus,
  canFlagRowPure,
  emptyCellAnchor,
} from "./dispute-permissions";

const FULLY_POPULATED: MatchStatus[] = [
  "exact",
  "wrong_stat",
  "wrong_player",
  "wrong_team",
];
const EMPTY_SLOT: MatchStatus[] = ["missed", "extra"];
const ALL_STATUSES: MatchStatus[] = [...FULLY_POPULATED, ...EMPTY_SLOT];

describe("isEmptySlotStatus", () => {
  it("is true only for missed and extra", () => {
    expect(isEmptySlotStatus("missed")).toBe(true);
    expect(isEmptySlotStatus("extra")).toBe(true);
    expect(isEmptySlotStatus("exact")).toBe(false);
    expect(isEmptySlotStatus("wrong_stat")).toBe(false);
    expect(isEmptySlotStatus("wrong_player")).toBe(false);
    expect(isEmptySlotStatus("wrong_team")).toBe(false);
  });
});

describe("canFlagRowPure", () => {
  it("blocks a logged-out viewer on every row", () => {
    const ctx = { isAllocated: false, isLoggedIn: false, hasCheck: true };
    for (const status of ALL_STATUSES) {
      expect(canFlagRowPure(status, ctx)).toBe(false);
    }
  });

  it("lets a logged-in non-allocated user flag only empty-slot rows", () => {
    const ctx = { isAllocated: false, isLoggedIn: true, hasCheck: true };
    for (const status of EMPTY_SLOT) {
      expect(canFlagRowPure(status, ctx)).toBe(true);
    }
    for (const status of FULLY_POPULATED) {
      expect(canFlagRowPure(status, ctx)).toBe(false);
    }
  });

  it("treats a logged-in admin (non-allocated) the same as any viewer for flagging", () => {
    // The admin resolve gate is separate; this predicate only covers flagging.
    const ctx = { isAllocated: false, isLoggedIn: true, hasCheck: true };
    for (const status of EMPTY_SLOT) {
      expect(canFlagRowPure(status, ctx)).toBe(true);
    }
    for (const status of FULLY_POPULATED) {
      expect(canFlagRowPure(status, ctx)).toBe(false);
    }
  });

  it("lets the allocated analyst flag every row", () => {
    const ctx = { isAllocated: true, isLoggedIn: true, hasCheck: true };
    for (const status of ALL_STATUSES) {
      expect(canFlagRowPure(status, ctx)).toBe(true);
    }
  });

  it("gates the empty-slot arm on hasCheck for a non-allocated user", () => {
    const ctx = { isAllocated: false, isLoggedIn: true, hasCheck: false };
    for (const status of ALL_STATUSES) {
      expect(canFlagRowPure(status, ctx)).toBe(false);
    }
  });

  it("lets allocation win regardless of isLoggedIn/hasCheck", () => {
    for (const status of ALL_STATUSES) {
      expect(
        canFlagRowPure(status, {
          isAllocated: true,
          isLoggedIn: false,
          hasCheck: false,
        })
      ).toBe(true);
    }
  });
});

describe("emptyCellAnchor", () => {
  // Only `id` is read by the helper; cast a minimal literal to Instance to
  // avoid depending on the full shape (mirrors the lightweight test style).
  const master = { id: "m1" } as Instance;
  const analyst = { id: "a1" } as Instance;

  it("anchors a missed row to the master instance (side=master)", () => {
    expect(emptyCellAnchor("missed", { master, analyst })).toEqual({
      instance: master,
      side: "master",
    });
  });

  it("anchors an extra row to the analyst instance (side=analyst)", () => {
    expect(emptyCellAnchor("extra", { master, analyst })).toEqual({
      instance: analyst,
      side: "analyst",
    });
  });

  it("returns null for every fully-populated status", () => {
    for (const status of FULLY_POPULATED) {
      expect(emptyCellAnchor(status, { master, analyst })).toBeNull();
    }
  });

  it("returns null for a missed row whose master side is absent", () => {
    expect(emptyCellAnchor("missed", { master: null, analyst })).toBeNull();
  });

  it("returns null for an extra row whose analyst side is absent", () => {
    expect(emptyCellAnchor("extra", { master, analyst: null })).toBeNull();
  });

  it("returns null when both sides are null for empty-slot statuses", () => {
    for (const status of EMPTY_SLOT) {
      expect(
        emptyCellAnchor(status, { master: null, analyst: null })
      ).toBeNull();
    }
  });
});
