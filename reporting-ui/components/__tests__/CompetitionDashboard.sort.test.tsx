import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect } from "vitest";

import CompetitionDashboard from "../competitions/CompetitionDashboard";
import type { SummaryRow } from "@/lib/analytics/competitionSummary";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const game = (Competition: string, Date: string, home: string, away: string): SummaryRow => ({
  Competition,
  Date,
  home_team: home,
  away_team: away,
  home_allocated: "Sam",
  away_allocated: "Sam",
});

// Zeta has more games than Alpha, so the default (Games desc) puts Zeta first.
const GAMES: SummaryRow[] = [
  game("Zeta League", "2024-03-02", "A", "B"),
  game("Zeta League", "2024-03-09", "A", "C"),
  game("Zeta League", "2024-03-16", "B", "C"),
  game("Alpha League", "2024-03-02", "D", "E"),
];

describe("CompetitionDashboard sorting", () => {
  it("changes aria-sort and row order when a header is clicked", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(<CompetitionDashboard games={GAMES} loading={false} error={null} />);
    });

    const table = el.querySelectorAll("table")[1];
    const header = (text: string) =>
      [...table.querySelectorAll("th[scope=col]")].find((th) => th.textContent?.includes(text))!;
    const order = () =>
      [...table.querySelectorAll("tbody th[scope=row]")].map((th) =>
        th.textContent?.includes("Zeta") ? "Zeta" : "Alpha"
      );

    expect(header("Games").getAttribute("aria-sort")).toBe("descending");
    expect(header("Competition").getAttribute("aria-sort")).toBe("none");
    expect(order()).toEqual(["Zeta", "Alpha"]);

    const click = async (th: Element) => {
      await act(async () => {
        (th.querySelector("button") as HTMLButtonElement).click();
      });
    };

    await click(header("Competition"));
    expect(header("Competition").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Games").getAttribute("aria-sort")).toBe("none");
    expect(order()).toEqual(["Alpha", "Zeta"]);

    await click(header("Competition"));
    expect(header("Competition").getAttribute("aria-sort")).toBe("descending");
    expect(order()).toEqual(["Zeta", "Alpha"]);

    // Per-season table headers are sortable too.
    const seasonTable = el.querySelectorAll("table")[0];
    expect(seasonTable.querySelectorAll("th[scope=col] button").length).toBe(12);

    await act(async () => root.unmount());
    el.remove();
  });
});
