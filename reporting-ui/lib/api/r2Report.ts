import type { R2Snapshot } from "../../../playhq-worker/src/r2Report";
import { BAD_CREDENTIALS_MESSAGE } from "@/lib/activity/storedPassword";

export type R2Scan = {
    status: "idle" | "running";
    objectsScanned: number;
    startedAt: string | null;
};

export type R2ReportResponse = {
    snapshot: R2Snapshot | null;
    scan: R2Scan;
    nextRescanAt: string | null;
};

export type RescanResult =
    | { ok: true; scan: R2Scan }
    | { ok: false; reason: "scan_running"; scan: R2Scan | null }
    | { ok: false; reason: "cooldown"; retryAfterSeconds: number };

async function post(username: string, password: string, action: "get" | "rescan"): Promise<Response> {
    const base = (process.env.NEXT_PUBLIC_PLAYHQ_WORKER_URL ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("Worker URL is not configured (NEXT_PUBLIC_PLAYHQ_WORKER_URL)");
    try {
        return await fetch(`${base}/api/r2-report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password, action }),
        });
    } catch {
        throw new Error("Couldn't reach the Worker. Check your connection and try again.");
    }
}

async function body(res: Response): Promise<Record<string, unknown>> {
    try {
        return (await res.json()) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function failure(res: Response, data: Record<string, unknown>): Error {
    if (res.status === 403) return new Error(BAD_CREDENTIALS_MESSAGE);
    if (res.status === 502) {
        return new Error("The admin check is unavailable. Has migration 013 been run in Supabase?");
    }
    if (res.status === 503) return new Error("The Worker has no R2 bucket binding yet. Deploy the Worker first.");
    const code = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    return new Error(`R2 report request failed (${code})`);
}

export async function fetchR2Report(username: string, password: string): Promise<R2ReportResponse> {
    const res = await post(username, password, "get");
    const data = await body(res);
    if (!res.ok) throw failure(res, data);
    return data as unknown as R2ReportResponse;
}

export async function rescanR2Report(username: string, password: string): Promise<RescanResult> {
    const res = await post(username, password, "rescan");
    const data = await body(res);
    if (res.status === 202) return { ok: true, scan: data.scan as R2Scan };
    if (res.status === 409) return { ok: false, reason: "scan_running", scan: (data.scan as R2Scan) ?? null };
    if (res.status === 429) {
        const header = Number(res.headers.get("Retry-After"));
        const secs = typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : header;
        return { ok: false, reason: "cooldown", retryAfterSeconds: Number.isFinite(secs) ? secs : 0 };
    }
    throw failure(res, data);
}
