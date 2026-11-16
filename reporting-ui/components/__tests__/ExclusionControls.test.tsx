import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompetitionDashboard from "../competitions/CompetitionDashboard";
import TeamsDashboard from "../competitions/TeamsDashboard";
import type { ExclusionsController } from "../competitions/useCompetitionExclusions";
import { exclusionKeySets, type ExclusionRow } from "@/lib/analytics/exclusions";
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

const GAMES: SummaryRow[] = [
  game("Alpha League", "2024-03-02", "Zeta", "Beta"),
  game("Alpha League", "2024-03-09", "Zeta", "Beta"),
  game("Beta Cup 2024", "2024-03-16", "Zeta", "Gamma"),
];

const exRow = (id: number | null, kind: "competition" | "team", key: string, label: string): ExclusionRow => ({
  id,
  kind,
  key,
  label,
  reason: "because",
  created_by: "boss",
  created_at: "2025-01-02T00:00:00Z",
});

function controller(over: Partial<ExclusionsController> & { rows?: ExclusionRow[] } = {}) {
  const rows = over.rows ?? [];
  const { competitionKeys, teamKeys } = exclusionKeySets(rows);
  const c: ExclusionsController = {
    rows,
    status: "ready",
    notice: null,
    canPersist: true,
    competitionKeys,
    teamKeys,
    actor: "boss",
    refresh: vi.fn(async () => {}),
    add: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    ...over,
  };
  return c;
}

let root: Root | null = null;
let el: HTMLElement | null = null;

async function render(node: React.ReactNode) {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  el = null;
});

const click = (node: Element | null | undefined) =>
  act(async () => {
    (node as HTMLElement).click();
  });

const byLabel = (container: ParentNode, label: string) =>
  container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;

const buttonByText = (container: ParentNode, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;

describe.each([
  ["CompetitionDashboard", "Alpha League"],
  ["TeamsDashboard", "Beta"],
] as const)("%s exclusion controls", (name, firstLabel) => {
  const Dash: any = name === "CompetitionDashboard" ? CompetitionDashboard : TeamsDashboard;
  const kind = name === "CompetitionDashboard" ? "competition" : "team";
  const props = (ex: ExclusionsController, canManage: boolean) => ({
    games: GAMES,
    allGames: GAMES,
    loading: false,
    error: null,
    exclusions: ex,
    canManage,
  });

  it("shows checkboxes and the action bar to admins only", async () => {
    const admin = await render(<Dash {...props(controller(), true)} />);
    expect(byLabel(admin, "Select all shown rows")).not.toBeNull();
    const rowBox = byLabel(admin, `Select ${firstLabel}`)!;
    expect(rowBox).not.toBeNull();
    expect(admin.querySelector('[data-testid="exclusion-action-bar"]')).toBeNull();
    await click(rowBox);
    expect(admin.querySelector('[data-testid="exclusion-action-bar"]')!.textContent).toContain("1 selected");
    expect(buttonByText(admin, "Exclude selected")).not.toBeNull();
    await click(buttonByText(admin, "Clear selection"));
    expect(admin.querySelector('[data-testid="exclusion-action-bar"]')).toBeNull();
  });

  it("shows no checkboxes or action bar to analysts", async () => {
    const analyst = await render(<Dash {...props(controller(), false)} />);
    expect(byLabel(analyst, "Select all shown rows")).toBeNull();
    expect(byLabel(analyst, `Select ${firstLabel}`)).toBeNull();
    expect(analyst.querySelector('[data-testid="exclusion-action-bar"]')).toBeNull();
    expect(buttonByText(analyst, "Exclude selected")).toBeNull();
  });

  it("header checkbox selects only the rows matching the search", async () => {
    const e = await render(<Dash {...props(controller(), true)} />);
    const input = e.querySelector('input[type="search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, firstLabel === "Alpha League" ? "alpha" : "beta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byLabel(e, "Select all shown rows"));
    const bar = e.querySelector('[data-testid="exclusion-action-bar"]')!.textContent!;
    // Competitions: "alpha" matches 1. Teams: "beta" matches the team Beta and the "Beta Cup" competition's teams.
    expect(bar).toMatch(/^\d+ selected/);
    const n = Number(bar.split(" ")[0]);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(name === "CompetitionDashboard" ? 2 : 4);
  });

  it("exclude flow: dialog with names/counts, confirm calls add, success clears selection", async () => {
    const ex = controller();
    const e = await render(<Dash {...props(ex, true)} />);
    await click(byLabel(e, `Select ${firstLabel}`));
    await click(buttonByText(e, "Exclude selected"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain(firstLabel);
    expect(dialog.textContent).toMatch(/\d+ games?/);
    const ta = dialog.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(ta, "test data");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttonByText(dialog, "Exclude"));
    expect(ex.add).toHaveBeenCalledTimes(1);
    const items = (ex.add as any).mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind,
      key: firstLabel.toLowerCase(),
      label: firstLabel,
      reason: "test data",
      created_by: "boss",
    });
    expect(e.textContent).toContain("Excluded 1");
    const live = [...e.querySelectorAll('[role="status"]')].find((n) => n.textContent?.includes("Excluded 1"));
    expect(live).toBeDefined();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(e.querySelector('[data-testid="exclusion-action-bar"]')).toBeNull();
  });

  it("a rejected add shows an alert and keeps the selection", async () => {
    const ex = controller({ add: vi.fn(async () => Promise.reject(new Error("nope"))) });
    const e = await render(<Dash {...props(ex, true)} />);
    await click(byLabel(e, `Select ${firstLabel}`));
    await click(buttonByText(e, "Exclude selected"));
    await click(buttonByText(document.body.querySelector('[role="dialog"]')!, "Exclude"));
    expect(e.querySelector('[role="alert"]')!.textContent).toContain("nope");
    expect(e.querySelector('[data-testid="exclusion-action-bar"]')!.textContent).toContain("1 selected");
  });

  it("Escape cancels the dialog", async () => {
    const e = await render(<Dash {...props(controller(), true)} />);
    await click(byLabel(e, `Select ${firstLabel}`));
    await click(buttonByText(e, "Exclude selected"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Excluded (N) is read-only for analysts and restorable for admins", async () => {
    const rows = [exRow(7, kind, "zzz", "Zzz Thing")];
    const analyst = await render(<Dash {...props(controller({ rows }), false)} />);
    const toggle = buttonByText(analyst, "Excluded (1)")!;
    expect(toggle).not.toBeNull();
    await click(toggle);
    expect(analyst.textContent).toContain("Zzz Thing");
    expect(analyst.textContent).toContain("because");
    expect(byLabel(analyst, "Select Zzz Thing")).toBeNull();
    expect(buttonByText(analyst, "Restore selected")).toBeNull();
    await act(async () => root!.unmount());
    el!.remove();

    const ex = controller({ rows });
    const admin = await render(<Dash {...props(ex, true)} />);
    await click(buttonByText(admin, "Excluded (1)"));
    await click(byLabel(admin, "Select Zzz Thing"));
    await click(buttonByText(admin, "Restore selected"));
    expect(ex.restore).toHaveBeenCalledWith([7]);
  });

  it("built-in fallback rows are not selectable and the notice shows; exclude is disabled", async () => {
    const rows = [exRow(null, "competition", "intra", "Intra"), exRow(null, "team", "zzz", "Zzz")];
    const ex = controller({
      rows,
      canPersist: false,
      status: "fallback",
      notice: "Exclusions not set up yet: run migration 010",
    });
    const e = await render(<Dash {...props(ex, true)} />);
    expect(e.textContent).toContain("Exclusions not set up yet: run migration 010");
    await click(byLabel(e, `Select ${firstLabel}`));
    expect((buttonByText(e, "Exclude selected") as HTMLButtonElement).disabled).toBe(true);
    await click(buttonByText(e, "Excluded (1)"));
    expect(byLabel(e, `Select ${kind === "team" ? "Zzz" : "Intra"}`)).toBeNull();
  });
});

describe("Teams table Competition column", () => {
  it("sorts by primary competition and shows +N with a tooltip listing competitions", async () => {
    const e = await render(
      <TeamsDashboard games={GAMES} loading={false} error={null} />
    );
    const table = e.querySelectorAll("table")[1];
    const header = [...table.querySelectorAll("th[scope=col]")].find((th) =>
      th.textContent?.trim().startsWith("Competition") && !th.textContent.includes("Competitions")
    )!;
    expect(header.getAttribute("aria-sort")).toBe("none");
    await click(header.querySelector("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    const rows = [...table.querySelectorAll("tbody tr")];
    const zeta = rows.find((r) => r.querySelector("th")!.textContent!.startsWith("Zeta"))!;
    const cell = zeta.querySelectorAll("td")[0];
    expect(cell.textContent).toContain("Alpha League");
    expect(cell.textContent).toContain("+1");
    expect(cell.getAttribute("title")).toBe("Alpha League (2 games)\nBeta Cup (1 game)");
    const order = rows.map((r) => r.querySelectorAll("td")[0].textContent!.trim());
    expect(order[0]).toContain("Alpha League");
    await click(header.querySelector("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
  });
});
