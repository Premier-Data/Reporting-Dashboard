import { describe, it, expect } from "vitest";
import { parseReadRequest } from "../../supabase/functions/gameface-deputy-read/request";

const ok = { username: "admin", password: "pw", dataset: "rosters" };

describe("parseReadRequest", () => {
  it("accepts valid input", () => {
    expect(parseReadRequest(ok)).toEqual({ ok: true, value: { ...ok, sync: false } });
    expect(parseReadRequest({ ...ok, dataset: "timesheets", from: "2026-05-01", to: "2026-05-31", sync: true })).toEqual({
      ok: true,
      value: { ...ok, dataset: "timesheets", from: "2026-05-01", to: "2026-05-31", sync: true },
    });
  });
  it("rejects missing or non-string credentials", () => {
    for (const b of [null, "x", {}, { ...ok, username: "" }, { ...ok, username: 5 }, { ...ok, password: "" }, { ...ok, password: undefined }]) {
      expect(parseReadRequest(b)).toEqual({ ok: false, error: "bad_request" });
    }
  });
  it("rejects unknown datasets", () => {
    expect(parseReadRequest({ ...ok, dataset: "employees" })).toEqual({ ok: false, error: "unknown_dataset" });
  });
  it("rejects bad dates", () => {
    for (const d of [{ from: "2026-02-31" }, { from: "nope" }, { to: "" }, { from: 5 }, { from: "2026-05-10", to: "2026-05-01" }]) {
      expect(parseReadRequest({ ...ok, ...d })).toEqual({ ok: false, error: "invalid_date" });
    }
  });
  it("only treats sync === true as a sync request", () => {
    expect(parseReadRequest({ ...ok, sync: "1" })).toMatchObject({ ok: true, value: { sync: false } });
  });
});