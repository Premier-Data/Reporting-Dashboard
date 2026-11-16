// Send a training plan to the analyst as a direct in-app message with the
// Excel attached. Admin / super_admin only (re-checked here, not just in UI).

import {
  findUserByAnalystName,
  getOrCreateDirectConversation,
  sendMessage,
  uploadAttachment,
  type MessageUser,
} from "@/lib/api/messages";
import type { TrainingPlan } from "@/lib/comparison/trainingPlan";
import {
  XLSX_MIME,
  buildTrainingPlanWorkbook,
  trainingPlanFileName,
} from "@/lib/exports/trainingPlanExcel";

export const MESSAGE_MAX_CHARS = 4000;

export class AnalystNotFoundError extends Error {
  constructor(name: string) {
    super(
      `No app account found for analyst "${name}". You can still export the plan and share it manually.`
    );
    this.name = "AnalystNotFoundError";
  }
}
export class NotPermittedError extends Error {
  constructor() {
    super("Not permitted");
    this.name = "NotPermittedError";
  }
}

export interface SendTrainingPlanArgs {
  sender: { id: number; role: "analyst" | "admin" | "super_admin" };
  plan: TrainingPlan;
  text: string;
  analystName: string;
  checkId: number | null;
}

export interface SendTrainingPlanDeps {
  findUserByAnalystName: typeof findUserByAnalystName;
  getOrCreateDirectConversation: typeof getOrCreateDirectConversation;
  uploadAttachment: typeof uploadAttachment;
  sendMessage: typeof sendMessage;
  buildWorkbook: (plan: TrainingPlan) => Promise<ArrayBuffer>;
}

export function canSendTrainingPlan(role: string | null | undefined): boolean {
  return role === "admin" || role === "super_admin";
}

export function capMessage(text: string): string {
  const t = text.trim();
  return t.length > MESSAGE_MAX_CHARS ? `${t.slice(0, MESSAGE_MAX_CHARS - 1)}…` : t;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Training plan send failed at: ${name}`, err);
    throw new Error(
      `Failed to ${name}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function sendTrainingPlanToAnalyst(
  args: SendTrainingPlanArgs,
  deps: Partial<SendTrainingPlanDeps> = {}
): Promise<{ conversationId: number; recipient: MessageUser }> {
  const d: SendTrainingPlanDeps = {
    findUserByAnalystName,
    getOrCreateDirectConversation,
    uploadAttachment,
    sendMessage,
    buildWorkbook: buildTrainingPlanWorkbook,
    ...deps,
  };
  if (!canSendTrainingPlan(args.sender.role)) throw new NotPermittedError();

  const name = args.analystName.trim();
  const target = name
    ? await step("find the analyst account", () => d.findUserByAnalystName(name))
    : null;
  if (!target) throw new AnalystNotFoundError(name);
  if (target.id === args.sender.id) {
    throw new Error("You cannot send a plan to yourself.");
  }

  const buffer = await step("build the Excel file", () => d.buildWorkbook(args.plan));
  const file = new File([buffer], trainingPlanFileName(args.plan), {
    type: XLSX_MIME,
  });
  const conversationId = await step("create the conversation", () =>
    d.getOrCreateDirectConversation(args.sender.id, target.id, {
      checkId: args.checkId,
    })
  );
  const attachment = await step("upload the attachment", () =>
    d.uploadAttachment(conversationId, file)
  );
  await step("send the message", () =>
    d.sendMessage(conversationId, args.sender.id, capMessage(args.text), attachment)
  );
  return { conversationId, recipient: target };
}
