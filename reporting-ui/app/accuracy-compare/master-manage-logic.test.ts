import { describe, it, expect } from "vitest";
import {
  isMasterDeletable,
  isValidMasterName,
  normalizeMasterName,
  sameMasterName,
  masterAffordance,
} from "./master-manage-logic";

describe("isMasterDeletable", () => {
  it("is deletable only when exactly one active check is in the group", () => {
    expect(isMasterDeletable(0)).toBe(false);
    expect(isMasterDeletable(1)).toBe(true);
    expect(isMasterDeletable(2)).toBe(false);
    expect(isMasterDeletable(3)).toBe(false);
  });
});

describe("isValidMasterName", () => {
  it("rejects empty / whitespace-only names", () => {
    expect(isValidMasterName("")).toBe(false);
    expect(isValidMasterName("   ")).toBe(false);
    expect(isValidMasterName("\t \n")).toBe(false);
  });

  it("accepts names with real characters (even if padded)", () => {
    expect(isValidMasterName("a")).toBe(true);
    expect(isValidMasterName(" a ")).toBe(true);
    expect(isValidMasterName("Game1.xml")).toBe(true);
  });
});

describe("normalizeMasterName", () => {
  it("trims surrounding whitespace but preserves inner case", () => {
    expect(normalizeMasterName(" Game1.XML ")).toBe("Game1.XML");
    expect(normalizeMasterName("\tGame1.xml\n")).toBe("Game1.xml");
    expect(normalizeMasterName("Game1.xml")).toBe("Game1.xml");
  });
});

describe("sameMasterName", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(sameMasterName("Game1.xml", "game1.xml ")).toBe(true);
    expect(sameMasterName(" Game1.xml ", "GAME1.XML")).toBe(true);
    expect(sameMasterName("  game1.xml", "game1.xml  ")).toBe(true);
  });

  it("distinguishes genuinely different names", () => {
    expect(sameMasterName("Game1.xml", "Game2.xml")).toBe(false);
    expect(sameMasterName("Game1.xml", "Game1.json")).toBe(false);
  });
});

describe("masterAffordance", () => {
  it("offers nothing to a non-admin regardless of count", () => {
    for (const count of [0, 1, 2]) {
      expect(masterAffordance(count, false)).toEqual({
        canManage: false,
        canRename: false,
        canDelete: false,
        mustReplaceToRemove: false,
      });
    }
  });

  it("lets an admin rename, and delete only when count === 1", () => {
    expect(masterAffordance(1, true)).toEqual({
      canManage: true,
      canRename: true,
      canDelete: true,
      mustReplaceToRemove: false,
    });
  });

  it("forces an admin to Replace (not delete) when count > 1", () => {
    expect(masterAffordance(2, true)).toEqual({
      canManage: true,
      canRename: true,
      canDelete: false,
      mustReplaceToRemove: true,
    });
  });

  it("lets an admin manage/rename but neither delete nor replace when count === 0", () => {
    expect(masterAffordance(0, true)).toEqual({
      canManage: true,
      canRename: true,
      canDelete: false,
      mustReplaceToRemove: false,
    });
  });
});
