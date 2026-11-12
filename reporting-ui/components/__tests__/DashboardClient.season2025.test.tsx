// Regression: a season that has Deputy shifts but NO games (2025) must never
// blank the dashboard. Renders DashboardClient with 2025 selected and walks
// every tab, failing on any thrown render error or empty page.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Chainable, awaitable supabase stub returning no rows.
vi.mock("@/lib/supabase", () => {
  const chain: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: any) => res({ data: [], error: null });
      }
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return { supabase: { from: () => chain, rpc: () => chain } };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/reporting",
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));
// next/dynamic -> React.lazy so the real chart components render.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<any>) => {
    const Lazy = React.lazy(loader);
    return (props: any) => (
      <React.Suspense fallback={null}>
        <Lazy {...props} />
      </React.Suspense>
    );
  },
}));

import DashboardClient from "../DashboardClient";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const AREAS = ["Home Analyst", "Office Analyst", "Office Admin"];
function deputyRows2025() {
  const rows: any[] = [];
  // Wed 2025-03-12 .. Sep 2025, weekly, two employees
  const start = new Date("2025-03-12T00:00:00Z");
  for (let i = 0; i < 28; i++) {
    const d = new Date(start.getTime() + i * 7 * 86400000);
    const iso = d.toISOString().slice(0, 10);
    for (const emp of ["Alice Smith", "Bob Jones"]) {
      rows.push({
        shift_key: `${emp}-${iso}`,
        employee_name: emp,
        shift_date: iso,
        start_time: "09:00",
        end_time: "17:00",
        total_hours: 8,
        total_cost: 240,
        hourly_rate: 30,
        area_name: AREAS[i % AREAS.length],
        day_name: "Wednesday",
        month_name: "March",
        week: String(24 + i),
        season: 2025,
      });
    }
  }
  return rows;
}
const ttRows = [
  {
    Date: "2026-10-10",
    Week: "1",
    week: "1",
    season: 2027,
    home_allocated: "Alice Smith",
    away_allocated: "Bob Jones",
    Location: "Melbourne",
    game_key: "g1",
    Competition: "AFL",
    home_team: "A",
    away_team: "B",
  },
  {
    Date: "2026-04-10",
    Week: "30",
    week: "30",
    season: 2026,
    home_allocated: "Alice Smith",
    away_allocated: "Bob Jones",
    Location: "Melbourne",
    game_key: "g2",
    Competition: "AFL",
    home_team: "C",
    away_team: "D",
  },
];

let container: HTMLDivElement;
let root: Root;
let errors: string[];
let errSpy: any;

beforeEach(() => {
  (globalThis as any).ResizeObserver = RO;
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    text: async () => "",
    json: async () => [],
  }));
  errors = [];
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
    errors.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const clickText = async (text: string) => {
  const el = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  );
  expect(el, `button "${text}" present`).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

describe("DashboardClient with a Deputy-only season (2025)", () => {
  for (const seasonLabel of ["2025", "All"]) {
    it(`renders and survives every tab with season ${seasonLabel}`, async () => {
      await act(async () => {
        root.render(
          <DashboardClient deputyData={deputyRows2025()} ttData={ttRows} />
        );
      });
      await flush();
      // The page must not be blank.
      expect(container.textContent).toContain("Reporting Dashboard");
      await clickText(seasonLabel);
      expect(container.textContent).toContain("Reporting Dashboard");

      for (const tab of [
        "Overview",
        "Weekly Report",
        "AWS",
        "Cloudflare",
        "TT Games",
        "Performance",
        "Bonus",
      ]) {
        await clickText(tab);
        if (tab === "TT Games") {
          await clickText("Soccer");
          await clickText("Aussie Rules");
        }
        expect(container.textContent, `after ${tab}`).toContain(
          "Reporting Dashboard"
        );
        expect(container.textContent).not.toContain("Something went wrong");
      }
      const thrown = errors.filter((e) =>
        /The above error occurred|Uncaught|TypeError|RangeError|Error:/.test(e)
      );
      expect(thrown).toEqual([]);
    });
  }
});
