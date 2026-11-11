import { describe, it, expect, vi, beforeEach } from "vitest";

const namesFn = vi.fn();
vi.mock("@/lib/api/deputyShifts", () => ({
  getDeputyShiftEmployeeNames: () => namesFn(),
}));

const fromSpy = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      fromSpy(table);
      return {
        select: () => ({
          order: () =>
            Promise.resolve({
              data: [{ id: 1, name: "Zoe Analyst", email: null, location: null, created_at: "" }],
              error: null,
            }),
        }),
      };
    },
  },
}));

import { getPlatformAnalystNames } from "./analysts";

beforeEach(() => {
  namesFn.mockReset();
  fromSpy.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getPlatformAnalystNames", () => {
  it("unions the analysts table with Deputy API names, case-insensitively de-duplicated", async () => {
    namesFn.mockResolvedValue(["Amy Lee", "zoe analyst"]);
    expect(await getPlatformAnalystNames()).toEqual(["Amy Lee", "Zoe Analyst"]);
  });

  it("returns only the analysts-table names when Deputy fails, and reads no other table", async () => {
    namesFn.mockRejectedValue(Object.assign(new Error("down"), { code: "http" }));
    expect(await getPlatformAnalystNames()).toEqual(["Zoe Analyst"]);
    expect(console.error).toHaveBeenCalledWith(
      "getPlatformAnalystNames: deputy names unavailable",
      "http"
    );
    expect(fromSpy.mock.calls.map((c) => c[0])).toEqual(["analysts"]);
  });
});
