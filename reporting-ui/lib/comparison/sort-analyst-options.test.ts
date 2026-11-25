import { describe, it, expect } from "vitest";
import { sortAnalystOptionsAZ } from "./sort-analyst-options";

describe("sortAnalystOptionsAZ", () => {
  it("orders A-Z case-insensitively, ignoring check counts", () => {
    const out = sortAnalystOptionsAZ([
      { name: "zoe", checks: 50 },
      { name: " Bob", checks: 10 },
      { name: "alice", checks: 1 },
    ]);
    expect(out.map((o) => o.name)).toEqual(["alice", " Bob", "zoe"]);
  });

  it("puts blank/unknown names last and does not mutate input", () => {
    const input = [{ name: "" }, { name: "—" }, { name: "Cam" }, { name: "Abe" }];
    const out = sortAnalystOptionsAZ(input);
    expect(out.map((o) => o.name)).toEqual(["Abe", "Cam", "", "—"]);
    expect(input[0].name).toBe("");
  });
});
