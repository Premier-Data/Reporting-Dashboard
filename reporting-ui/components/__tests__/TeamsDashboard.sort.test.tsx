import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect } from "vitest";

import TeamsDashboard from "../competitions/TeamsDashboard";
import type { SummaryRow } from "@/lib/analytics/competitionSummary";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const game = (Date: string, home: string, away: string): SummaryRow => ({
  Competition: "League",
  Date,
  home_team: home,
  away_team: away,
  home_allocated: "Sam",
  away_allocated: "Sam",
});

// Zeta plays 3 games, Alpha 1 (Alpha 2024 is merged into Alpha), Beta 2.
const GAMES: SummaryRow[] = [
  game("2024-03-02", "Zeta", "Beta"),
  game("2024-03-09", "Zeta", "Beta"),
  game("2024-03-16", "Zeta", "Alpha 2024"),
];

describe("TeamsDashboard", () => {
  it("renders headline cards and changes row order when a header is clicked", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(<TeamsDashboard games={GAMES} loading={false} error={null} />);
    });

    expect(el.textContent).toContain("Unique teams (all years)");
    expect(el.textContent).toContain("Teams active this season");

    const table = el.querySelectorAll("table")[1];
    const header = (text: string) =>
      [...table.querySelectorAll("th[scope=col]")].find((th) => th.textContent?.includes(text))!;
    const order = () =>
      [...table.querySelectorAll("tbody th[scope=row]")].map((th) => th.textContent!.split("also")[0].trim());

    expect(header("Games").getAttribute("aria-sort")).toBe("descending");
    expect(order()).toEqual(["Zeta", "Beta", "Alpha"]);

    await act(async () => {
      (header("Team").querySelector("button") as HTMLButtonElement).click();
    });
    expect(header("Team").getAttribute("aria-sort")).toBe("ascending");
    expect(order()).toEqual(["Alpha", "Beta", "Zeta"]);

    await act(async () => root.unmount());
    el.remove();
  });
});
