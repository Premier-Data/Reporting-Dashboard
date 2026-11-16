import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const auth = { user: null as null | { id: number; username: string; analyst_name: string | null; role: string } };
vi.mock("@/components/auth/AuthContext", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const findUserByAnalystName = vi.fn();
const getOrCreateDirectConversation = vi.fn();
const uploadAttachment = vi.fn();
const sendMessage = vi.fn();
vi.mock("@/lib/api/messages", () => ({
  findUserByAnalystName: (...a: unknown[]) => findUserByAnalystName(...a),
  getOrCreateDirectConversation: (...a: unknown[]) => getOrCreateDirectConversation(...a),
  uploadAttachment: (...a: unknown[]) => uploadAttachment(...a),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
vi.mock("@/lib/api/trainingPlanHistory", () => ({
  loadTrainingHistory: vi.fn(async () => ({ checks: [], allAnalystAverage: null, warnings: [] })),
}));
vi.mock("@/lib/exports/trainingPlanExcel", async (orig) => {
  const actual = await orig<typeof import("@/lib/exports/trainingPlanExcel")>();
  return {
    ...actual,
    buildTrainingPlanWorkbook: vi.fn(async () => new ArrayBuffer(8)),
    downloadTrainingPlanExcel: vi.fn(async () => {}),
  };
});

import TrainingPlanPanel from "../accuracy/TrainingPlanPanel";
import type { ComparisonResult, ComparisonRow, Instance } from "@/lib/comparison/xml-compare";

const inst = (id: string, over: Partial<Instance> = {}): Instance => ({
  id, start: 10, end: 14, mid: 12, team: "Home", playerNumber: 4, playerRaw: "4", stat: "Tackles", category: "Defence", code: "c", ...over,
});
const rows: ComparisonRow[] = [
  { status: "missed", master: inst("m1"), analyst: null, timeDelta: null },
  { status: "exact", master: inst("m2"), analyst: inst("a2"), timeDelta: 0 },
];
const result: ComparisonResult = {
  rows,
  tolerance: 3,
  summary: { masterTotal: 2, analystTotal: 1, exact: 1, wrongStat: 0, wrongPlayer: 0, wrongTeam: 0, missed: 1, extra: 0, accuracy: 0.5, avgTimeDrift: 0 },
  byCategory: [{ category: "Defence", total: 2, exact: 1, accuracy: 0.5 }],
  byStat: [],
  byTeam: [],
};
const context = {
  analystName: "Sam",
  checkId: 5,
  checkCreatedAt: "2025-06-01T00:00:00Z",
  sport: "afl" as const,
  matchLabel: null,
  masterFileName: null,
  videoUrl: null,
  checkCategory: null,
  teamLabel: (t: string) => t,
  scopeFilters: { team: "all", category: "all", stat: "all" },
  disputes: [],
};

let root: Root | null = null;
let el: HTMLElement | null = null;
async function render(open = true, onClose = () => {}) {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(<TrainingPlanPanel open={open} onClose={onClose} result={result} scopeRows={rows} context={context} />);
  });
  await flush();
}
async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const buttons = () => Array.from(document.body.querySelectorAll("button"));
const btn = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
const btnIncludes = (label: string) => buttons().find((b) => b.textContent?.includes(label));
async function click(b: HTMLElement | undefined) {
  expect(b).toBeTruthy();
  await act(async () => { b!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}
const asUser = (role: string) => { auth.user = { id: 1, username: "boss", analyst_name: null, role }; };

beforeEach(() => {
  vi.clearAllMocks();
  findUserByAnalystName.mockResolvedValue({ id: 2, username: "sam", analystName: "Sam", role: "analyst" });
  getOrCreateDirectConversation.mockResolvedValue(77);
  uploadAttachment.mockResolvedValue({ url: "u", name: "n", type: "document" });
  sendMessage.mockResolvedValue({});
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  el = null;
  auth.user = null;
});

describe("TrainingPlanPanel", () => {
  it("renders nothing when closed", async () => {
    asUser("admin");
    await render(false);
    expect(document.body.textContent).not.toContain("Recommended training plan");
  });

  it("shows the plan and export buttons but no Send for an analyst", async () => {
    asUser("analyst");
    await render();
    expect(document.body.textContent).toContain("Recommended training plan");
    expect(btnIncludes("Export Excel")).toBeTruthy();
    expect(btnIncludes("Export PDF")).toBeTruthy();
    expect(btnIncludes("Send to analyst")).toBeUndefined();
  });

  it.each(["admin", "super_admin"])("shows Send for %s", async (role) => {
    asUser(role);
    await render();
    expect(btnIncludes("Send to analyst")).toBeTruthy();
  });

  it("sends via the four messaging calls and shows success", async () => {
    asUser("admin");
    await render();
    await click(btnIncludes("Send to analyst"));
    expect(document.body.textContent).toContain("Full details in the attached workbook.");
    await click(btn("Send"));
    expect(findUserByAnalystName).toHaveBeenCalledWith("Sam");
    expect(getOrCreateDirectConversation).toHaveBeenCalledWith(1, 2, { checkId: 5 });
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment.mock.calls[0][0]).toBe(77);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0].slice(0, 2)).toEqual([77, 1]);
    expect(document.body.textContent).toContain("Sent to Sam");
  });

  it("shows a clear message and calls nothing else when the analyst has no account", async () => {
    asUser("admin");
    findUserByAnalystName.mockResolvedValue(null);
    await render();
    await click(btnIncludes("Send to analyst"));
    await click(btn("Send"));
    expect(document.body.textContent).toContain('No app account found for analyst "Sam"');
    expect(getOrCreateDirectConversation).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((btnIncludes("Export Excel") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows summary, strengths and key focus, with the full list in a collapsed appendix", async () => {
    asUser("analyst");
    await render();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Strengths (95-100% accuracy)");
    expect(text).toContain("No stats at 95%+ this check (min 10 instances)");
    expect(text).toContain("Key focus areas");
    expect(text).not.toContain("Trending stats");
    const details = document.body.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("All instances (1)");
    expect(details.querySelector("summary")!.textContent).toContain("Missed 1");
  });

  it("closes on Escape", async () => {
    asUser("admin");
    const onClose = vi.fn();
    await render(true, onClose);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
