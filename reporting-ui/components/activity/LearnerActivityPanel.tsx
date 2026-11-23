"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Loader2 } from "lucide-react";
import {
    ActivityTimeline,
    EVENT_STYLE,
    sectionLabel,
    type TimelineEvent,
} from "@/components/activity/ActivityTimeline";
import { StatusBadge, timeAgo } from "@/components/activity/StatusBadge";
import {
    BREAK_MS,
    formatDuration,
    mergedLength,
    presenceStatus,
    summariseDays,
} from "@/lib/activity/activity";
import {
    fetchActivityUser,
    loadDerivedEvents,
    type ActivityUserDetail,
    type DerivedEvent,
} from "@/lib/api/activity";
import { isBadCredentials } from "@/lib/activity/storedPassword";

const toInput = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function eventLabel(e: DerivedEvent): string {
    if (e.kind === "message") return "Sent a message";
    if (e.kind === "read") return "Read a conversation";
    if (e.kind === "joined") return "Account created";
    return e.detail ?? "Dispute";
}

/** Live status + daily activity timeline + activity log for one user. */
export function LearnerActivityPanel({
    userId,
    userName,
    adminUsername,
    adminPassword,
    onAuthError,
}: {
    userId: number;
    userName: string;
    adminUsername: string;
    adminPassword: string;
    onAuthError?: () => void;
}) {
    const [from, setFrom] = useState(() => {
        const f = new Date();
        f.setDate(f.getDate() - 6);
        return toInput(f);
    });
    const [to, setTo] = useState(() => toInput(new Date()));
    const [data, setData] = useState<ActivityUserDetail | null>(null);
    const [events, setEvents] = useState<TimelineEvent[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [now, setNow] = useState(0);

    const fromDate = useMemo(() => new Date(`${from}T00:00:00`), [from]);
    const toDate = useMemo(() => new Date(`${to}T00:00:00`), [to]);

    const load = useCallback(async () => {
        const end = new Date(toDate);
        end.setDate(end.getDate() + 1);
        try {
            const [detail, derived] = await Promise.all([
                fetchActivityUser(adminUsername, adminPassword, userId, fromDate, end),
                loadDerivedEvents(userId, userName, fromDate, end),
            ]);
            setData(detail);
            setEvents(derived.map((e) => ({ kind: e.kind, at: e.at, label: eventLabel(e) })));
            setError("");
            setNow(Date.now());
        } catch (err) {
            if (isBadCredentials(err)) onAuthError?.();
            setError(err instanceof Error ? err.message : "Couldn't load activity.");
        } finally {
            setLoading(false);
        }
    }, [adminUsername, adminPassword, userId, userName, fromDate, toDate, onAuthError]);

    useEffect(() => {
        load();
        const t = setInterval(load, 30_000);
        return () => clearInterval(t);
    }, [load]);

    const days = useMemo(
        () => (data ? summariseDays(data.segments, fromDate, toDate) : []),
        [data, fromDate, toDate]
    );

    const perSection = useMemo(() => {
        const by = new Map<string, { start: number; end: number }[]>();
        for (const d of days) {
            for (const s of d.segments) {
                const k = s.section ?? "";
                by.set(k, [...(by.get(k) ?? []), s]);
            }
        }
        return [...by.entries()]
            .map(([section, parts]) => ({ section, ms: mergedLength(parts) }))
            .sort((a, b) => b.ms - a.ms);
    }, [days]);

    const totals = useMemo(() => {
        const worked = days.reduce((n, d) => n + d.workedMs, 0);
        const used = days.reduce((n, d) => n + d.usedMs, 0);
        const own = events.filter((e) => e.kind !== "joined");
        const ownDays = new Set(own.map((e) => new Date(e.at).toDateString()));
        const activeDays = days.filter(
            (d) => d.first !== null || ownDays.has(new Date(d.day).toDateString())
        ).length;
        return { worked, used, breaks: Math.max(0, used - worked), activeDays, actions: own.length };
    }, [days, events]);

    const status = presenceStatus(data?.presence?.last_seen_at, data?.presence?.last_active_at);

    const liveEnd = useMemo(() => {
        if (!data || status !== "active" || data.segments.length === 0) return null;
        const last = Math.max(...data.segments.map((s) => Date.parse(s.ended_at)));
        return now - last < BREAK_MS ? last : null;
    }, [data, status, now]);

    function setPreset(daysBack: number) {
        const t = new Date();
        const f = new Date(t);
        f.setDate(f.getDate() - daysBack);
        setFrom(toInput(f));
        setTo(toInput(t));
    }

    return (
        <div className="space-y-6">
            {error && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{error}</div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                {data && (
                    <StatusBadge
                        status={status}
                        lastSeen={data.presence?.last_seen_at ?? null}
                        lastActive={data.presence?.last_active_at ?? null}
                    />
                )}
                {data && status !== "offline" && (
                    <span className="text-xs text-slate-500">in {sectionLabel(data.presence?.section)}</span>
                )}
                {data?.presence?.last_active_at && (
                    <span className="text-xs text-slate-500" title={new Date(data.presence.last_active_at).toLocaleString()}>
                        · Last active {timeAgo(data.presence.last_active_at)}
                    </span>
                )}
            </div>

            <div className="grid gap-4 sm:grid-cols-4">
                <Stat label="Active time" value={formatDuration(totals.worked)} tone="text-green-700" />
                <Stat label="On the dashboard (first → last)" value={formatDuration(totals.used)} />
                <Stat label="Breaks (5+ min idle)" value={formatDuration(totals.breaks)} tone="text-red-500" />
                <Stat label="Days active" value={`${totals.activeDays}${totals.actions ? ` · ${totals.actions} actions` : ""}`} />
            </div>

            <section className="rounded-2xl border border-slate-200 bg-white p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-semibold text-slate-900">Activity timeline</h2>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-slate-500">From</span>
                        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" />
                        <span className="text-slate-500">To</span>
                        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" />
                        <button onClick={() => setPreset(0)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50">
                            Today
                        </button>
                        <button onClick={() => setPreset(6)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700">
                            <CalendarRange size={14} />
                            Last 7 days
                        </button>
                        <button onClick={() => setPreset(29)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50">
                            30 days
                        </button>
                        <button onClick={() => setPreset(89)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50">
                            90 days
                        </button>
                    </div>
                </div>
                {loading ? (
                    <div className="flex justify-center py-12">
                        <Loader2 className="animate-spin text-slate-400" size={24} />
                    </div>
                ) : (
                    <ActivityTimeline days={days} liveSegmentEnd={liveEnd} events={events} now={now} />
                )}
            </section>

            <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
                <section className="rounded-2xl border border-slate-200 bg-white">
                    <h2 className="border-b border-slate-200 px-5 py-4 font-semibold text-slate-900">
                        Active time per section <span className="font-normal text-slate-400">(selected dates)</span>
                    </h2>
                    <table className="w-full text-sm">
                        <tbody className="divide-y divide-slate-100">
                            {perSection.map((c) => (
                                <tr key={c.section}>
                                    <td className="px-5 py-3 font-medium text-slate-900">{sectionLabel(c.section || null)}</td>
                                    <td className="px-5 py-3 text-right font-semibold tabular-nums">{formatDuration(c.ms)}</td>
                                    <td className="w-40 px-5 py-3">
                                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                                            <div
                                                className="h-full rounded-full bg-green-700"
                                                style={{ width: `${totals.worked ? Math.min(100, (c.ms / totals.worked) * 100) : 0}%` }}
                                            />
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {perSection.length === 0 && (
                                <tr>
                                    <td className="px-5 py-10 text-center text-slate-400">No activity in this range.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white">
                    <h2 className="border-b border-slate-200 px-5 py-4 font-semibold text-slate-900">Activity log</h2>
                    <div className="max-h-[480px] overflow-y-auto">
                        {days
                            .map((d) => ({
                                d,
                                evs: events.filter((e) => {
                                    const s = Date.parse(e.at);
                                    return s >= d.day && s < d.day + 24 * 3600_000;
                                }),
                            }))
                            .filter(({ d, evs }) => d.first !== null || evs.length > 0)
                            .map(({ d, evs }) => {
                                const items: { kind: string; start: number; end: number; section: string | null; label?: string }[] = [];
                                const segs = [...d.segments].sort((a, b) => a.start - b.start);
                                let lastEnd: number | null = null;
                                for (const s of segs) {
                                    if (lastEnd !== null && s.start - lastEnd >= BREAK_MS) {
                                        items.push({ kind: "break", start: lastEnd, end: s.start, section: null });
                                    }
                                    items.push({ kind: "active", start: s.start, end: s.end, section: s.section });
                                    lastEnd = Math.max(lastEnd ?? 0, s.end);
                                }
                                for (const e of evs) {
                                    const at = Date.parse(e.at);
                                    items.push({ kind: e.kind, start: at, end: at, section: null, label: e.label });
                                }
                                items.sort((a, b) => a.start - b.start || (a.kind === "active" ? -1 : 1));
                                return (
                                    <div key={d.day} className="border-b border-slate-100 last:border-0">
                                        <p className="sticky top-0 bg-slate-50 px-5 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                                            {new Date(d.day).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })}
                                        </p>
                                        <table className="w-full text-sm">
                                            <tbody>
                                                {items.reverse().map((it, i) => (
                                                    <tr key={i} className={it.kind === "break" ? "bg-red-50/60" : ""}>
                                                        <td className="w-32 whitespace-nowrap px-5 py-2 tabular-nums text-slate-600">
                                                            {it.end > it.start ? `${time(it.start)}-${time(it.end)}` : time(it.start)}
                                                        </td>
                                                        <td className="px-2 py-2">
                                                            {it.kind === "break" ? (
                                                                <span className="text-red-500">Break</span>
                                                            ) : it.kind !== "active" ? (
                                                                <span className="inline-flex items-center gap-2 text-slate-700">
                                                                    <span className={`h-2 w-2 shrink-0 rounded-full ${EVENT_STYLE[it.kind]?.dot ?? "bg-slate-400"}`} />
                                                                    {it.label}
                                                                </span>
                                                            ) : (
                                                                <span className="text-slate-800">{sectionLabel(it.section)}</span>
                                                            )}
                                                        </td>
                                                        <td className={`px-5 py-2 text-right tabular-nums ${it.kind === "break" ? "text-red-500" : it.kind === "active" ? "font-medium text-green-700" : "text-slate-400"}`}>
                                                            {it.end > it.start ? formatDuration(it.end - it.start) : ""}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                );
                            })}
                        {totals.activeDays === 0 && events.length === 0 && (
                            <p className="px-5 py-10 text-center text-sm text-slate-400">No activity in this range.</p>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}

function Stat({ label, value, tone = "text-slate-900" }: { label: string; value: string; tone?: string }) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p className={`mt-2 text-3xl font-bold ${tone}`}>{value}</p>
        </div>
    );
}
