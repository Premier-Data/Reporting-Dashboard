// Browser client for the gameface-deputy-read Edge Function (the second
// company's Deputy data). The admin username and password go in the POST body,
// never in the URL; the function re-checks them in SQL before returning data.
import { parseDeputyBody, type DeputyRosterRow, type DeputyTimesheetRow } from "@/lib/api/deputy";
import { BAD_CREDENTIALS_MESSAGE } from "@/lib/activity/storedPassword";
import type { DeputySource } from "@/lib/deputy/source";

type Dataset = "rosters" | "timesheets";

async function call<T>(
  username: string,
  password: string,
  dataset: Dataset,
  sync: boolean
): Promise<T[]> {
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/gameface-deputy-read`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${anon}`,
      apikey: anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password, dataset, ...(sync ? { sync: true } : {}) }),
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error(BAD_CREDENTIALS_MESSAGE);
    if (res.status === 404) throw new Error("GameFace Deputy functions are not deployed yet");
    if (res.status === 502) throw new Error("The admin check is unavailable. Has migration 014 been run?");
    let code = "";
    try {
      const b = (await res.json()) as { error?: unknown } | null;
      if (typeof b?.error === "string") code = ` ${b.error}`;
    } catch {
      // non-JSON body: status only
    }
    throw new Error(`gameface-deputy-read ${dataset} failed: ${res.status}${code}`);
  }
  return parseDeputyBody<T>((await res.json()) as { rows?: T[]; synced?: unknown }).rows;
}

export function makeGamefaceDeputySource(username: string, password: string): DeputySource {
  return {
    getRosters: () => call<DeputyRosterRow>(username, password, "rosters", false),
    getTimesheets: (opts) => call<DeputyTimesheetRow>(username, password, "timesheets", opts?.sync === true),
  };
}
