import { describe, expect, it, vi } from "vitest";
import {
  AnalystNotFoundError,
  NotPermittedError,
  canSendTrainingPlan,
  sendTrainingPlanToAnalyst,
  type SendTrainingPlanDeps,
} from "./trainingPlanSend";
import { XLSX_MIME } from "./trainingPlanExcel";
import { buildTrainingPlan, type TrainingPlan } from "@/lib/comparison/trainingPlan";

vi.mock("@/lib/api/messages", () => ({
  findUserByAnalystName: vi.fn(),
  getOrCreateDirectConversation: vi.fn(),
  uploadAttachment: vi.fn(),
  sendMessage: vi.fn(),
}));

function makePlan(): TrainingPlan {
  return buildTrainingPlan(
    {
      result: {
        rows: [],
        tolerance: 3,
        summary: { masterTotal: 0, analystTotal: 0, exact: 0, wrongStat: 0, wrongPlayer: 0, wrongTeam: 0, missed: 0, extra: 0, accuracy: 0.9, avgTimeDrift: 0 },
        byCategory: [],
        byStat: [],
        byTeam: [],
      },
      scopeRows: [],
    },
    null,
    {
      analystName: "Sam",
      checkId: 5,
      checkCreatedAt: "2025-06-01T00:00:00Z",
      sport: "afl",
      matchLabel: "R1",
      masterFileName: null,
      videoUrl: null,
      checkCategory: null,
      teamLabel: (t) => t,
      scopeFilters: { team: "all", category: "all", stat: "all" },
      reviewBaseUrl: null,
      disputes: [],
    },
    { scope: "filters", window: { mode: "checks", n: 10 }, now: new Date("2025-06-02T00:00:00Z") }
  );
}

function deps(over: Partial<SendTrainingPlanDeps> = {}) {
  const order: string[] = [];
  const d = {
    findUserByAnalystName: vi.fn(async () => {
      order.push("find");
      return { id: 2, username: "sam", analystName: "Sam", role: "analyst" };
    }),
    getOrCreateDirectConversation: vi.fn(async () => {
      order.push("conversation");
      return 77;
    }),
    uploadAttachment: vi.fn(async () => {
      order.push("upload");
      return { url: "u", name: "n", type: "document" as const };
    }),
    sendMessage: vi.fn(async () => {
      order.push("send");
      return {} as never;
    }),
    buildWorkbook: vi.fn(async () => new ArrayBuffer(8)),
    ...over,
  } as unknown as SendTrainingPlanDeps;
  return { d, order };
}
const args = (over = {}) => ({
  sender: { id: 1, role: "admin" as const },
  plan: makePlan(),
  text: "  hello  ",
  analystName: "Sam",
  checkId: 5,
  ...over,
});

describe("canSendTrainingPlan", () => {
  it("allows only admin and super_admin", () => {
    expect(canSendTrainingPlan("admin")).toBe(true);
    expect(canSendTrainingPlan("super_admin")).toBe(true);
    expect(canSendTrainingPlan("analyst")).toBe(false);
    expect(canSendTrainingPlan(null)).toBe(false);
    expect(canSendTrainingPlan(undefined)).toBe(false);
  });
});

describe("sendTrainingPlanToAnalyst", () => {
  it("runs the calls in order with the expected arguments", async () => {
    const { d, order } = deps();
    const res = await sendTrainingPlanToAnalyst(args(), d);
    expect(order).toEqual(["find", "conversation", "upload", "send"]);
    expect(d.findUserByAnalystName).toHaveBeenCalledWith("Sam");
    expect(d.getOrCreateDirectConversation).toHaveBeenCalledWith(1, 2, { checkId: 5 });
    const [convId, file] = (d.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls[0] as [number, File];
    expect(convId).toBe(77);
    expect(file.type).toBe(XLSX_MIME);
    expect(file.name).toMatch(/^Training plan - Sam - check 5 - 2025-06-02\.xlsx$/);
    expect(d.sendMessage).toHaveBeenCalledWith(77, 1, "hello", { url: "u", name: "n", type: "document" });
    expect(res.conversationId).toBe(77);
  });

  it("throws NotPermittedError before any call for a non-admin", async () => {
    const { d } = deps();
    await expect(sendTrainingPlanToAnalyst(args({ sender: { id: 1, role: "analyst" } }), d)).rejects.toBeInstanceOf(NotPermittedError);
    expect(d.findUserByAnalystName).not.toHaveBeenCalled();
  });

  it("throws AnalystNotFoundError and calls nothing else", async () => {
    const { d } = deps({ findUserByAnalystName: vi.fn(async () => null) } as never);
    const err = await sendTrainingPlanToAnalyst(args(), d).catch((e) => e);
    expect(err).toBeInstanceOf(AnalystNotFoundError);
    expect(err.message).toContain('No app account found for analyst "Sam"');
    expect(d.getOrCreateDirectConversation).not.toHaveBeenCalled();
    expect(d.uploadAttachment).not.toHaveBeenCalled();
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to send to yourself", async () => {
    const { d } = deps();
    await expect(sendTrainingPlanToAnalyst(args({ sender: { id: 2, role: "admin" } }), d)).rejects.toThrow("You cannot send a plan to yourself.");
    expect(d.getOrCreateDirectConversation).not.toHaveBeenCalled();
  });

  it.each([
    ["conversation", "getOrCreateDirectConversation", "create the conversation", ["find", "conversation"]],
    ["upload", "uploadAttachment", "upload the attachment", ["find", "conversation", "upload"]],
    ["send", "sendMessage", "send the message", ["find", "conversation", "upload", "send"]],
  ])("stops and names the step when %s fails", async (_n, fn, label, expectedOrder) => {
    const { d, order } = deps();
    (d as unknown as Record<string, unknown>)[fn] = vi.fn(async () => {
      order.push(_n as string);
      throw new Error("db down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendTrainingPlanToAnalyst(args(), d)).rejects.toThrow(`Failed to ${label}: db down`);
    expect(order).toEqual(expectedOrder);
  });

  it("caps the message at 4000 characters", async () => {
    const { d } = deps();
    await sendTrainingPlanToAnalyst(args({ text: "x".repeat(5000) }), d);
    const sent = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(sent.length).toBe(4000);
    expect(sent.endsWith("…")).toBe(true);
  });
});
