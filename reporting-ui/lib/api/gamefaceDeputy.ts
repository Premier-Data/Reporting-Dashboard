// Browser client for the gameface-deputy-read Edge Function (the second
// company's Deputy data). The admin username and password go in the POST body,
// never in the URL; the function re-checks them in SQL before returning data.
import {
  parseDeputyBody,
  type DeputyReadOptions,
  type DeputyReadResult,
  type DeputyRosterRow,
  type DeputyTimesheetRow,
} from "@/lib/api/deputy";
import { BAD_CREDENTIALS_MESSAGE } from "@/lib/activity/storedPassword";
import type { DeputySource } from "@/lib/deputy/source";

type Dataset = "rosters" | "timesheets";

async function callWithMeta<T>(
  username: string,
  password: string,
  dataset: Dataset,
  opts?: DeputyReadOptions
): Promise<DeputyReadResult<T>> {
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/gameface-deputy-read`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${anon}`,
      apikey: anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      password,
      dataset,
      ...(opts?.from ? { from: opts.from } : {}),
      ...(opts?.to ? { to: opts.to } : {}),
      ...(opts?.sync ? { sync: true } : {}),
    }),
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
  return parseDeputyBody<T>((await res.json()) as { rows?: T[]; synced?: unknown });
}

export function makeGamefaceDeputySource(username: string, password: string): DeputySource {
  return {
    getRosters: async (opts) => (await callWithMeta<DeputyRosterRow>(username, password, "rosters", opts)).rows,
    getRostersWithMeta: (opts) => callWithMeta<DeputyRosterRow>(username, password, "rosters", opts),
    getTimesheets: async (opts) => (await callWithMeta<DeputyTimesheetRow>(username, password, "timesheets", opts)).rows,
  };
}

// ---------------------------------------------------------------------------
// Fixture allocations (gameface-fixture-allocations Edge Function).
// ---------------------------------------------------------------------------
export type GamefaceAllocation = {
  id: number;
  comp_fixture_id: string;
  roster_deputy_id: string;
  employee_name: string;
  shift_date: string;
  allocated_by: string;
  allocated_at: string;
};

export const ALREADY_ALLOCATED_MESSAGE =
  "This fixture is already allocated to a shift. Unallocate it there first.";

export class AlreadyAllocatedError extends Error {
  constructor() {
    super(ALREADY_ALLOCATED_MESSAGE);
    this.name = "AlreadyAllocatedError";
  }
}

const ALLOCATION_422: Record<string, string> = {
  fixture_not_allocatable: "This fixture can no longer be allocated (it must be a synced AFL fixture).",
  shift_not_allocatable: "This shift can no longer take fixtures (it must be a published, assigned shift).",
};

async function allocationCall<T>(
  username: string,
  password: string,
  payload: Record<string, unknown>
): Promise<T> {
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/gameface-fixture-allocations`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${anon}`,
      apikey: anon,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password, ...payload }),
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error(BAD_CREDENTIALS_MESSAGE);
    if (res.status === 404) {
      let code = "";
      try {
        const b = (await res.json()) as { error?: unknown } | null;
        if (typeof b?.error === "string") code = b.error;
      } catch {
        // non-JSON body: function missing
      }
      if (code === "not_found") throw new Error("This allocation no longer exists. Refresh and try again.");
      throw new Error("GameFace allocation function is not deployed yet");
    }
    if (res.status === 409) throw new AlreadyAllocatedError();
    if (res.status === 502) throw new Error("The admin check is unavailable. Has migration 015 been run?");
    let code = "";
    try {
      const b = (await res.json()) as { error?: unknown } | null;
      if (typeof b?.error === "string") code = b.error;
    } catch {
      // non-JSON body: status only
    }
    if (res.status === 422 && ALLOCATION_422[code]) throw new Error(ALLOCATION_422[code]);
    throw new Error(`gameface-fixture-allocations failed: ${res.status}${code ? ` ${code}` : ""}`);
  }
  return (await res.json()) as T;
}

export function makeGamefaceAllocator(username: string, password: string) {
  return {
    list: async (from: string, to: string): Promise<GamefaceAllocation[]> => {
      const body = await allocationCall<{ rows?: GamefaceAllocation[] }>(username, password, {
        action: "list",
        from,
        to,
      });
      return Array.isArray(body.rows) ? body.rows : [];
    },
    allocate: async (args: {
      compFixtureId: string;
      rosterId: string;
      employeeName: string;
    }): Promise<GamefaceAllocation> =>
      (await allocationCall<{ row: GamefaceAllocation }>(username, password, { action: "allocate", ...args })).row,
    unallocate: async (allocationId: number): Promise<void> => {
      await allocationCall<{ row: GamefaceAllocation }>(username, password, { action: "unallocate", allocationId });
    },
  };
}

export type GamefaceAllocator = ReturnType<typeof makeGamefaceAllocator>;
