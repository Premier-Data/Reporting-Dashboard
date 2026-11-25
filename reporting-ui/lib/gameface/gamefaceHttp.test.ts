import { describe, it, expect } from "vitest";
import { buildQueryUrl, validateBaseUrl } from "../../supabase/functions/gameface-deputy-sync/deputyHttp";

const BASE = "https://abc123.au.deputy.com/api/v1";

describe("validateBaseUrl", () => {
  it("accepts a deputy.com install url, with or without trailing slash", () => {
    expect(validateBaseUrl(BASE)).toBe(BASE);
    expect(validateBaseUrl(`${BASE}/`)).toBe(BASE);
  });
  it("rejects http, other hosts, userinfo, ports, queries and wrong paths", () => {
    for (const bad of [
      "http://abc123.au.deputy.com/api/v1",
      "https://deputy.com.evil.io/api/v1",
      "https://evil.com/api/v1",
      "https://deputy.com/api/v1",
      "https://user:pw@abc123.au.deputy.com/api/v1",
      "https://abc123.au.deputy.com:8443/api/v1",
      "https://abc123.au.deputy.com/api/v1?x=1",
      "https://abc123.au.deputy.com/api/v2",
      "https://abc123.au.deputy.com/",
      "not a url",
      "",
    ]) {
      expect(validateBaseUrl(bad), bad).toBeNull();
    }
  });
});

describe("buildQueryUrl", () => {
  it("only emits resource QUERY urls for the six read resources", () => {
    for (const r of ["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"]) {
      expect(buildQueryUrl(BASE, r)).toBe(`${BASE}/resource/${r}/QUERY`);
    }
  });
  it("throws for paths, other resources and bad bases", () => {
    expect(() => buildQueryUrl(BASE, "Roster/123")).toThrow();
    expect(() => buildQueryUrl(BASE, "Timesheet/1/approve")).toThrow();
    expect(() => buildQueryUrl(BASE, "Memo")).toThrow();
    expect(() => buildQueryUrl(BASE, "")).toThrow();
    expect(() => buildQueryUrl("https://evil.com/api/v1", "Roster")).toThrow();
  });
});