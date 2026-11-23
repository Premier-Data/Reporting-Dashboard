"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Activity, ArrowDown, ArrowLeft, ArrowUp, Loader2, Lock, RefreshCw, Search } from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import { listUsers, ROLE_LABELS, type UserAccount } from "@/lib/api/auth";
import {
    fetchActivitySummary,
    loadDerivedEvents,
    type ActivitySummary,
} from "@/lib/api/activity";
import { formatDuration, mergedLength, presenceStatus } from "@/lib/activity/activity";
import { nextSort, rowComparator, type SortableRow, type SortKey, type SortState } from "@/lib/activity/sort";
import {
    clearStoredPassword,
    getStoredPassword,
    isBadCredentials,
    setStoredPassword,
} from "@/lib/activity/storedPassword";
import { StatusBadge } from "@/components/activity/StatusBadge";
import { sectionLabel } from "@/components/activity/ActivityTimeline";
import { LearnerActivityPanel } from "@/components/activity/LearnerActivityPanel";

type RangeKey = "today" | "7d" | "30d" | "custom";

const toInput = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function rangeFor(key: RangeKey, from: string, to: string) {
    const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = startOf(new Date());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (key === "today") return { from: today, to: tomorrow };
    if (key === "7d" || key === "30d") {
        const f = new Date(today);
        f.setDate(f.getDate() - (key === "7d" ? 6 : 29));
        return { from: f, to: tomorrow };
    }
    const f = from ? new Date(`${from}T00:00:00`) : today;
    const t = to ? new Date(`${to}T00:00:00`) : today;
    t.setDate(t.getDate() + 1);
    return { from: f, to: t };
}

interface Row extends SortableRow {
    lastSeen: string | null;
    lastActiveAt: string | null;
    section: string | null;
}

export default function ActivityPage() {
    return (
        <Suspense fallback={<div className="min-h-full bg-slate-100 p-8 text-slate-600">Loading...</div>}>
            <ActivityInner />
        </Suspense>
    );
}

function ActivityInner() {
    const { user } = useAuth();
    const searchParams = useSearchParams();
    const userParam = Number(searchParams.get("user"));
    const detailId = Number.isInteger(userParam) && userParam > 0 ? userParam : null;

    // The activity RPCs re-check the password on every call. It is remembered
    // in sessionStorage (this tab only) so a refresh does not ask again.
    const [password, setPassword] = useState("");
    const [restored, setRestored] = useState(false);
    const [draft, setDraft] = useState("");
    const [checking, setChecking] = useState(false);
    const [gateError, setGateError] = useState("");

    useEffect(() => {
        if (!user) return;
        setPassword(getStoredPassword(user.username) ?? "");
        setRestored(true);
    }, [user]);

    const lock = useCallback(() => {
        clearStoredPassword();
        setPassword("");
    }, []);

    async function unlock() {
        if (!user || !draft) return;
        setChecking(true);
        setGateError("");
        try {
            const now = new Date();
            await fetchActivitySummary(user.username, draft, now, now);
            setStoredPassword(user.username, draft);
            setPassword(draft);
            setDraft("");
        } catch (err) {
            setGateError(err instanceof Error ? err.message : "Couldn't verify password");
        } finally {
            setChecking(false);
        }
    }

    if (!user || !restored) return null;

    return (
        <div className="min-h-full bg-slate-100 text-slate-900">
            <div className="mx-auto max-w-7xl p-6 lg:p-8">
                {password && (
                    <div className="mb-4 flex justify-end">
                        <button
                            type="button"
                            onClick={lock}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                            title="Forget the password for this tab"
                        >
                            <Lock size={14} />
                            Lock
                        </button>
                    </div>
                )}
                {!password ? (
                    <>
                        <Header title="Activity Log" />
                        <div className="mx-auto mt-8 max-w-md rounded-2xl border border-slate-200 bg-white p-6">
                            <p className="flex items-center gap-2 font-semibold text-slate-900">
                                <Lock size={16} /> Confirm your password
                            </p>
                            <p className="mt-1 text-sm text-slate-500">
                                Activity is only released to an admin who confirms their password. It is remembered for this tab only, until you press Lock or close the tab.
                            </p>
                            <form
                                className="mt-4 flex gap-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    unlock();
                                }}
                            >
                                <input
                                    type="password"
                                    autoComplete="current-password"
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    placeholder="Password"
                                    className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                                />
                                <button
                                    type="submit"
                                    disabled={checking || !draft}
                                    className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                                >
                                    {checking ? "Checking..." : "Unlock"}
                                </button>
                            </form>
                            {gateError && <p className="mt-3 text-sm text-red-600">{gateError}</p>}
                        </div>
                    </>
                ) : detailId !== null ? (
                    <Detail userId={detailId} adminUsername={user.username} adminPassword={password} onAuthError={lock} />
                ) : (
                    <List adminUsername={user.username} adminPassword={password} onAuthError={lock} />
                )}
            </div>
        </div>
    );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div className="mb-6">
            <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
                <Activity size={26} /> {title}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
                {subtitle ??
                    "Who is online, and how long users have spent active on the dashboard. A gap of 5 minutes or more with no activity counts as a break. Times are shown in your local time zone."}
            </p>
        </div>
    );
}

function Detail({
    userId,
    adminUsername,
    adminPassword,
    onAuthError,
}: {
    userId: number;
    adminUsername: string;
    adminPassword: string;
    onAuthError: () => void;
}) {
    const [target, setTarget] = useState<UserAccount | null | undefined>(undefined);

    useEffect(() => {
        let alive = true;
        listUsers()
            .then((us) => alive && setTarget(us.find((u) => u.id === userId) ?? null))
            .catch(() => alive && setTarget(null));
        return () => {
            alive = false;
        };
    }, [userId]);

    return (
        <>
            <Link
                href="/activity"
                className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
                <ArrowLeft size={14} /> All users
            </Link>
            {target === undefined ? (
                <div className="flex justify-center py-16">
                    <Loader2 className="animate-spin text-slate-400" size={26} />
                </div>
            ) : target === null ? (
                <p className="text-sm text-slate-500">User not found.</p>
            ) : (
                <>
                    <Header
                        title={target.username}
                        subtitle={`${ROLE_LABELS[target.role]}${target.analyst_name ? ` · ${target.analyst_name}` : ""}${target.email ? ` · ${target.email}` : ""}`}
                    />
                    <LearnerActivityPanel
                        userId={target.id}
                        userName={target.username}
                        adminUsername={adminUsername}
                        adminPassword={adminPassword}
                        onAuthError={onAuthError}
                    />
                </>
            )}
        </>
    );
}

function List({
    adminUsername,
    adminPassword,
    onAuthError,
}: {
    adminUsername: string;
    adminPassword: string;
    onAuthError: () => void;
}) {
    const [users, setUsers] = useState<UserAccount[]>([]);
    const [summary, setSummary] = useState<ActivitySummary>({ segments: [], presence: [] });
    const [actions, setActions] = useState<Map<number, number>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [range, setRange] = useState<RangeKey>("today");
    const [from, setFrom] = useState(toInput(new Date()));
    const [to, setTo] = useState(toInput(new Date()));
    const [search, setSearch] = useState("");
    const [showAdmins, setShowAdmins] = useState(false);
    const [statusFilter, setStatusFilter] = useState<"all" | "online">("all");
    const [sort, setSort] = useState<SortState>(null);

    const r = useMemo(() => rangeFor(range, from, to), [range, from, to]);

    const load = useCallback(async () => {
        try {
            const [us, sum, derived] = await Promise.all([
                listUsers(),
                fetchActivitySummary(adminUsername, adminPassword, r.from, r.to),
                loadDerivedEvents(null, null, r.from, r.to),
            ]);
            const counts = new Map<number, number>();
            for (const e of derived) {
                if (e.kind === "joined") continue;
                counts.set(e.userId, (counts.get(e.userId) ?? 0) + 1);
            }
            setUsers(us);
            setSummary(sum);
            setActions(counts);
            setError("");
        } catch (err) {
            if (isBadCredentials(err)) onAuthError();
            setError(err instanceof Error ? err.message : "Couldn't load activity.");
        } finally {
            setLoading(false);
        }
    }, [adminUsername, adminPassword, r, onAuthError]);

    useEffect(() => {
        load();
        const t = setInterval(load, 30_000);
        return () => clearInterval(t);
    }, [load]);

    const cmp = useMemo(() => rowComparator(sort), [sort]);

    const table = useMemo(() => {
        const fromMs = r.from.getTime();
        const toMs = r.to.getTime();
        const parts = new Map<number, { start: number; end: number }[]>();
        for (const s of summary.segments) {
            const start = Math.max(Date.parse(s.started_at), fromMs);
            const end = Math.min(Date.parse(s.ended_at), toMs);
            if (end < start) continue;
            parts.set(s.user_id, [...(parts.get(s.user_id) ?? []), { start, end }]);
        }
        const presence = new Map(summary.presence.map((p) => [p.user_id, p]));
        const s = search.toLowerCase();
        return users
            .filter((u) => showAdmins || u.role === "analyst")
            .filter(
                (u) =>
                    !s ||
                    u.username.toLowerCase().includes(s) ||
                    (u.analyst_name ?? "").toLowerCase().includes(s) ||
                    (u.email ?? "").toLowerCase().includes(s)
            )
            .map((u) => {
                const ps = parts.get(u.id) ?? [];
                const p = presence.get(u.id);
                const status = presenceStatus(p?.last_seen_at, p?.last_active_at);
                const row: Row = {
                    name: u.analyst_name || u.username,
                    username: u.username,
                    sectionText: status !== "offline" ? sectionLabel(p?.section ?? null) : null,
                    workedMs: mergedLength(ps),
                    eventCount: actions.get(u.id) ?? 0,
                    firstActive: ps.length ? Math.min(...ps.map((x) => x.start)) : null,
                    lastActive: ps.length ? Math.max(...ps.map((x) => x.end)) : null,
                    status,
                    lastSeen: p?.last_seen_at ?? null,
                    lastActiveAt: p?.last_active_at ?? null,
                    section: p?.section ?? null,
                };
                return { user: u, a: row };
            })
            .filter((x) => statusFilter === "all" || x.a.status !== "offline")
            .sort((x, y) => cmp(x.a, y.a));
    }, [users, summary, actions, search, showAdmins, statusFilter, r, cmp]);

    const onSort = (k: SortKey) => setSort((s) => nextSort(s, k));

    const online = table.filter((x) => x.a.status !== "offline").length;
    const activeNow = table.filter((x) => x.a.status === "active").length;
    const totalWorked = table.reduce((n, x) => n + x.a.workedMs, 0);

    return (
        <>
            <Header title="Activity Log" />

            <div className="mb-5 grid gap-4 sm:grid-cols-3">
                <Stat label="Active now" value={String(activeNow)} />
                <Stat label="Online (active or idle)" value={String(online)} />
                <Stat label="Total active time in range" value={formatDuration(totalWorked)} />
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
                    {(
                        [
                            ["today", "Today"],
                            ["7d", "Last 7 days"],
                            ["30d", "Last 30 days"],
                            ["custom", "Custom"],
                        ] as [RangeKey, string][]
                    ).map(([k, label]) => (
                        <button
                            key={k}
                            onClick={() => setRange(k)}
                            className={`px-3 py-2 font-medium transition ${
                                range === k ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {range === "custom" && (
                    <div className="flex items-center gap-2 text-sm">
                        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" />
                        <span className="text-slate-400">to</span>
                        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" />
                    </div>
                )}
                <div className="relative min-w-[200px] flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search username, analyst name or email..."
                        className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-500"
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as "all" | "online")}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                    <option value="all">Everyone</option>
                    <option value="online">Online only</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" checked={showAdmins} onChange={(e) => setShowAdmins(e.target.checked)} />
                    Include admins
                </label>
                <button
                    onClick={load}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                    title="Refreshes automatically every 30 seconds"
                >
                    <RefreshCw size={14} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{error}</div>
            )}

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {loading ? (
                    <div className="flex justify-center py-16">
                        <Loader2 className="animate-spin text-slate-400" size={26} />
                    </div>
                ) : (
                    <div className="max-h-[65vh] overflow-auto">
                        <table className="w-full whitespace-nowrap text-left text-sm">
                            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-700">
                                <tr>
                                    <SortTh label="User" k="user" sort={sort} onSort={onSort} />
                                    <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
                                    <SortTh label="Currently in" k="section" sort={sort} onSort={onSort} />
                                    <SortTh label="First active" k="first" sort={sort} onSort={onSort} />
                                    <SortTh label="Last active" k="last" sort={sort} onSort={onSort} />
                                    <SortTh label="Active time" k="worked" sort={sort} onSort={onSort} right />
                                    <SortTh label="Actions" k="actions" sort={sort} onSort={onSort} right title="Messages sent, conversations read, disputes raised or resolved" />
                                    <th className="px-4 py-3" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {table.map(({ user: u, a }) => (
                                    <tr key={u.id} className="hover:bg-slate-50/60">
                                        <td className="px-4 py-3">
                                            <p className="font-medium text-slate-900">{u.analyst_name || u.username}</p>
                                            <p className="text-xs text-slate-500">
                                                {u.username} · {ROLE_LABELS[u.role]}
                                                {u.email ? ` · ${u.email}` : ""}
                                            </p>
                                        </td>
                                        <td className="px-4 py-3">
                                            <StatusBadge status={a.status} lastSeen={a.lastSeen} lastActive={a.lastActiveAt} />
                                        </td>
                                        <td className="px-4 py-3 text-slate-600">
                                            {a.status !== "offline" ? sectionLabel(a.section) : "—"}
                                        </td>
                                        <td className="px-4 py-3 text-slate-600">{fmtWhen(a.firstActive, range)}</td>
                                        <td className="px-4 py-3 text-slate-600">{fmtWhen(a.lastActive, range)}</td>
                                        <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                                            {a.workedMs ? formatDuration(a.workedMs) : "—"}
                                        </td>
                                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{a.eventCount || "—"}</td>
                                        <td className="px-4 py-3 text-right">
                                            <Link
                                                href={`/activity?user=${u.id}`}
                                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                            >
                                                <Activity size={13} />
                                                Timeline
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                                {table.length === 0 && (
                                    <tr>
                                        <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                                            No users match.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </>
    );
}

function SortTh({
    label,
    k,
    sort,
    onSort,
    right,
    title,
}: {
    label: string;
    k: SortKey;
    sort: SortState;
    onSort: (k: SortKey) => void;
    right?: boolean;
    title?: string;
}) {
    const dir = sort?.key === k ? sort.dir : null;
    return (
        <th
            className={`px-4 py-3 font-semibold ${right ? "text-right" : ""}`}
            aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
        >
            <button
                type="button"
                onClick={() => onSort(k)}
                title={title}
                className={`inline-flex items-center gap-1 font-semibold hover:text-slate-900 ${right ? "flex-row-reverse" : ""}`}
            >
                {label}
                {dir === "asc" ? (
                    <ArrowUp size={13} />
                ) : (
                    <ArrowDown size={13} className={dir ? "" : "opacity-0"} />
                )}
            </button>
        </th>
    );
}

function fmtWhen(ms: number | null, range: RangeKey) {
    if (ms === null) return "—";
    const d = new Date(ms);
    const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return range === "today" ? t : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${t}`;
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
        </div>
    );
}
