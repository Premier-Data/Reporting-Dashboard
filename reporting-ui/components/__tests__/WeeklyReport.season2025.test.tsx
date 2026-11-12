// Regression: Weekly Report with Deputy-only season 2025 (no TT/soccer/OS rows).
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/supabase", () => {
  const chain: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: any) => res({ data: [], error: null });
      return () => chain;
    },
  });
  return { supabase: { from: () => chain } };
});
vi.mock("@/lib/api/deputyShifts", () => {
  const rows: any[] = [];
  const start = new Date("2025-03-12T00:00:00Z");
  const areas = ["Aussie Rules Home Analyst", "Soccer Office Analyst", "Customer Service"];
  for (let i = 0; i < 28; i++) {
    const iso = new Date(start.getTime() + i * 7 * 86400000).toISOString().slice(0, 10);
    rows.push({
      shift_key: `k${i}`,
      shift_date: iso,
      area_name: areas[i % 3],
      total_hours: 8,
      total_cost: 240,
      week: 24 + i,
      season: 2025,
      source: "deputy-api",
    });
  }
  return { getDeputyShiftAggregates: async () => rows };
});

import WeeklyReport from "../WeeklyReport";

describe("WeeklyReport season 2025 (Deputy only)", () => {
  for (const view of ["week", "month"]) {
    it(`renders ${view} view without games`, async () => {
      const errs: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...a) => {
        errs.push(a.map(String).join(" "));
      });
      const el = document.createElement("div");
      document.body.appendChild(el);
      const root = createRoot(el);
      await act(async () => {
        root.render(<WeeklyReport ttData={[]} />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      if (view === "month") {
        const sel = [...el.querySelectorAll("select")].find((s) =>
          [...s.options].some((o) => o.value === "month")
        )!;
        await act(async () => {
          sel.value = "month";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      expect(el.textContent).toContain("Weekly Report");
      expect(el.textContent).toContain("2025");
      expect(errs.filter((e) => /Error/.test(e))).toEqual([]);
      act(() => root.unmount());
      vi.restoreAllMocks();
    });
  }
});
