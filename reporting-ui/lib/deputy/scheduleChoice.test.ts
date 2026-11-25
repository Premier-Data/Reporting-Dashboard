import { describe, it, expect } from "vitest";
import { resolveScheduleDeputy } from "./scheduleChoice";

describe("resolveScheduleDeputy", () => {
  it("defaults to Premier Data", () => {
    expect(resolveScheduleDeputy(null, true)).toBe("premier");
    expect(resolveScheduleDeputy("premier", true)).toBe("premier");
    expect(resolveScheduleDeputy("nonsense", true)).toBe("premier");
  });
  it("selects GameFace only when the user has access", () => {
    expect(resolveScheduleDeputy("gameface", true)).toBe("gameface");
    expect(resolveScheduleDeputy("gameface", false)).toBe("premier");
  });
});
