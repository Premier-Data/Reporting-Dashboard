import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations-reporting",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=games"),
}));
vi.mock("@/lib/api/soccerGames", () => ({ fetchSoccerGamesForOps: vi.fn(async () => []) }));
vi.mock("@/lib/api/ttGames", () => ({
  fetchTTGamesForOps: vi.fn(async () => [
    { game_key: "a", Date: "2026-10-07", Week: 1, season: 2026, home_allocated: "AB", away_allocated: "CD", Location: "AUS" },
    { game_key: "b", Date: "2026-10-14", Week: 2, season: 2026, home_allocated: "AB", away_allocated: "CD", Location: "IND" },
  ]),
}));

import GamesWeeklyView from "@/components/operations/GamesWeeklyView";

const left = (el: Element) => parseInt((el as HTMLElement).style.left, 10);

describe("GamesWeeklyView frozen columns", () => {
  it("freezes the first four columns with increasing left offsets; week cells are not sticky", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(<GamesWeeklyView />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const table = el.querySelector("table")!;
    expect(table).toBeTruthy();
    const rows = Array.from(table.querySelectorAll("tr")) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(3); // header + summary + analysts
    for (const row of rows) {
      const cells = Array.from(row.children) as HTMLElement[];
      expect(cells.length).toBeGreaterThan(4);
      const frozen = cells.slice(0, 4);
      frozen.forEach((c) => expect(c.style.position).toBe("sticky"));
      const lefts = frozen.map(left);
      expect(lefts[0]).toBe(0);
      for (let i = 1; i < 4; i++) expect(lefts[i]).toBeGreaterThan(lefts[i - 1]);
      cells.slice(4).forEach((c) => {
        expect(c.style.left).toBe("");
        // header week cells stick to the top only
        if (c.tagName === "TD") expect(c.style.position).toBe("");
      });
    }
    const headerRow = rows[0];
    (Array.from(headerRow.children) as HTMLElement[]).forEach((c) => expect(c.style.top).toBe("0px"));
  });
});
