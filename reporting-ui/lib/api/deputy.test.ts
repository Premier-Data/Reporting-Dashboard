import { describe, it, expect } from "vitest";
import { parseDeputyBody } from "./deputy";

describe("parseDeputyBody", () => {
  it("returns rows and synced true", () => {
    expect(parseDeputyBody({ rows: [1, 2], synced: true })).toEqual({
      rows: [1, 2],
      synced: true,
    });
  });

  it("defaults synced to false and rows to []", () => {
    expect(parseDeputyBody({})).toEqual({ rows: [], synced: false });
    expect(parseDeputyBody({ rows: [1], synced: "yes" })).toEqual({
      rows: [1],
      synced: false,
    });
  });
});
