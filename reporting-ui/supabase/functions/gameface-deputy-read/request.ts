// Pure request parsing for gameface-deputy-read (no Deno imports).
import { parseDateRange } from "../deputy-read/shape.ts";

export type ReadRequest = {
  username: string;
  password: string;
  dataset: "rosters" | "timesheets";
  from?: string;
  to?: string;
  sync: boolean;
};

export type ParsedReadRequest =
  | { ok: true; value: ReadRequest }
  | { ok: false; error: "bad_request" | "unknown_dataset" | "invalid_date" };

export function parseReadRequest(body: unknown): ParsedReadRequest {
  if (!body || typeof body !== "object") return { ok: false, error: "bad_request" };
  const b = body as Record<string, unknown>;
  if (typeof b.username !== "string" || b.username.trim() === "") {
    return { ok: false, error: "bad_request" };
  }
  if (typeof b.password !== "string" || b.password === "") {
    return { ok: false, error: "bad_request" };
  }
  if (b.dataset !== "rosters" && b.dataset !== "timesheets") {
    return { ok: false, error: "unknown_dataset" };
  }
  const from = b.from == null ? null : typeof b.from === "string" ? b.from : "";
  const to = b.to == null ? null : typeof b.to === "string" ? b.to : "";
  const range = parseDateRange(from, to);
  if (!range.ok) return { ok: false, error: "invalid_date" };
  return {
    ok: true,
    value: {
      username: b.username,
      password: b.password,
      dataset: b.dataset,
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
      sync: b.sync === true,
    },
  };
}
