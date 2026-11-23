import { supabase } from "@/lib/supabase";
import { fetchAllPaged } from "@/lib/supabase/fetchAllPaged";

export interface HeartbeatSegment {
    id: string;
    started_at: string;
    ended_at: string;
}

export interface HeartbeatPayload {
    userId: number;
    username: string;
    /** Tab/page is closing: the user is marked offline straight away. */
    closing?: boolean;
    section: string;
    path: string;
    segment: HeartbeatSegment | null;
}

export interface ActivitySegmentRow {
    id: string;
    user_id: number;
    username: string;
    started_at: string;
    ended_at: string;
    section: string | null;
    path: string | null;
}

export interface PresenceRow {
    user_id: number;
    username: string | null;
    last_seen_at: string;
    last_active_at: string | null;
    section: string | null;
    path: string | null;
}

export interface ActivitySummary {
    segments: ActivitySegmentRow[];
    presence: PresenceRow[];
}

export interface ActivityUserDetail {
    segments: ActivitySegmentRow[];
    presence: PresenceRow | null;
}

export type DerivedEventKind = "message" | "read" | "dispute" | "joined";

export interface DerivedEvent {
    kind: DerivedEventKind;
    at: string;
    userId: number;
    detail: string | null;
}

function rpcArgs(p: HeartbeatPayload) {
    return {
        p_user_id: p.userId,
        p_username: p.username,
        p_segment_id: p.segment?.id ?? null,
        p_started_at: p.segment?.started_at ?? null,
        p_ended_at: p.segment?.ended_at ?? null,
        p_section: p.section,
        p_path: p.path,
        p_closing: !!p.closing,
    };
}

/**
 * Report the open stretch + presence. Never throws: tracking must not break
 * the app. With `keepalive` (tab hidden / closing) a raw fetch is used so the
 * request survives page unload (sendBeacon cannot set the apikey header).
 */
export async function sendHeartbeat(
    payload: HeartbeatPayload,
    opts: { keepalive?: boolean } = {}
): Promise<void> {
    try {
        const args = rpcArgs(payload);
        if (opts.keepalive) {
            const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
            const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
            if (!url || !key) return;
            await fetch(`${url}/rest/v1/rpc/activity_heartbeat`, {
                method: "POST",
                keepalive: true,
                headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(args),
            });
            return;
        }
        await supabase.rpc("activity_heartbeat", args);
    } catch {
        // ignore
    }
}

function viewerError(message: string | undefined): Error {
    const m = message ?? "Request failed";
    if (/does not exist|could not find the function/i.test(m)) {
        return new Error(
            "Activity tracking is not set up yet (run migrations/011_activity_tracking.sql)"
        );
    }
    if (/forbidden/i.test(m)) return new Error("Incorrect password or not an admin");
    return new Error(m);
}

/** Everyone's activity in [from, to). Requires an admin's credentials. */
export async function fetchActivitySummary(
    username: string,
    password: string,
    from: Date,
    to: Date
): Promise<ActivitySummary> {
    const { data, error } = await supabase.rpc("activity_admin_summary", {
        p_username: username,
        p_password: password,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
    });
    if (error) throw viewerError(error.message);
    return {
        segments: data?.segments ?? [],
        presence: data?.presence ?? [],
    };
}

/** One user's activity in [from, to). Requires an admin's credentials. */
export async function fetchActivityUser(
    username: string,
    password: string,
    userId: number,
    from: Date,
    to: Date
): Promise<ActivityUserDetail> {
    const { data, error } = await supabase.rpc("activity_admin_user", {
        p_username: username,
        p_password: password,
        p_user_id: userId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
    });
    if (error) throw viewerError(error.message);
    return {
        segments: data?.segments ?? [],
        presence: data?.presence ?? null,
    };
}

/**
 * Events derived at view time from existing tables (nothing extra is stored):
 * messages sent, conversations read, disputes raised/resolved, account joined.
 * `userId` null = everyone.
 */
export async function loadDerivedEvents(
    userId: number | null,
    username: string | null,
    from: Date,
    to: Date
): Promise<DerivedEvent[]> {
    const f = from.toISOString();
    const t = to.toISOString();
    const lname = username?.toLowerCase() ?? null;
    const inRange = (iso: string | null) => !!iso && iso >= f && iso < t;

    const [messages, members, disputes, accounts] = await Promise.all([
        fetchAllPaged<{ id: number; created_at: string; sender_id: number }>("messages", {
            select: "id, created_at, sender_id",
            order: ["created_at"],
            unique: "id",
            filters: (q) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let x: any = q;
                x = x.gte("created_at", f).lt("created_at", t);
                if (userId !== null) x = x.eq("sender_id", userId);
                return x;
            },
        }),
        fetchAllPaged<{ id: number; user_id: number; last_read_at: string | null }>(
            "conversation_members",
            {
                select: "id, user_id, last_read_at",
                order: ["last_read_at"],
                unique: "id",
                filters: (q) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let x: any = q;
                    x = x.gte("last_read_at", f).lt("last_read_at", t);
                    if (userId !== null) x = x.eq("user_id", userId);
                    return x;
                },
            }
        ),
        fetchAllPaged<{
            id: number;
            created_at: string;
            raised_by: string | null;
            resolved_by: string | null;
            resolved_at: string | null;
        }>("accuracy_disputes", {
            select: "id, created_at, raised_by, resolved_by, resolved_at",
            order: ["created_at"],
            unique: "id",
        }),
        fetchAllPaged<{ id: number; username: string; created_at: string }>("user_accounts", {
            select: "id, username, created_at",
            order: ["created_at"],
            unique: "id",
            filters: (q) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let x: any = q;
                x = x.gte("created_at", f).lt("created_at", t);
                if (userId !== null) x = x.eq("id", userId);
                return x;
            },
        }),
    ]);

    // Disputes are matched by username, so build the username -> id map.
    const idByName = new Map<string, number>();
    if (userId === null || lname) {
        const all = await fetchAllPaged<{ id: number; username: string }>("user_accounts", {
            select: "id, username",
            unique: "id",
        });
        for (const a of all) idByName.set(a.username.toLowerCase(), a.id);
    }

    const out: DerivedEvent[] = [];
    for (const m of messages) {
        out.push({ kind: "message", at: m.created_at, userId: m.sender_id, detail: null });
    }
    for (const m of members) {
        if (m.last_read_at) {
            out.push({ kind: "read", at: m.last_read_at, userId: m.user_id, detail: null });
        }
    }
    const pushDispute = (by: string | null, at: string | null, detail: string) => {
        if (!by || !inRange(at)) return;
        const id = idByName.get(by.toLowerCase());
        if (id === undefined) return;
        if (userId !== null && id !== userId) return;
        out.push({ kind: "dispute", at: at!, userId: id, detail });
    };
    for (const d of disputes) {
        pushDispute(d.raised_by, d.created_at, "Raised a dispute");
        pushDispute(d.resolved_by, d.resolved_at, "Resolved a dispute");
    }
    for (const a of accounts) {
        out.push({ kind: "joined", at: a.created_at, userId: a.id, detail: null });
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
