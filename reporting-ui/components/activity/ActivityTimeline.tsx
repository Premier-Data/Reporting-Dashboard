"use client";

import { formatDuration, type DaySummary } from "@/lib/activity/activity";
import { PAGES } from "@/lib/api/auth";

const DAY_MS = 24 * 3600_000;
const TICKS = [0, 6, 12, 18, 24];

const time = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Readable name for a section (page key). */
export function sectionLabel(section: string | null | undefined): string {
    if (!section) return "Other pages";
    return PAGES.find((p) => p.key === section)?.label ?? (section === "dashboard" ? "Dashboard" : section);
}

/** A recorded action from elsewhere in the database (message, read, dispute...). */
export type TimelineEvent = {
    kind: string;
    at: string;
    end?: string;
    label: string;
};

export const EVENT_STYLE: Record<string, { dot: string; name: string }> = {
    message: { dot: "bg-sky-500", name: "Chat" },
    read: { dot: "bg-sky-500", name: "Chat" },
    dispute: { dot: "bg-amber-500", name: "Dispute" },
    joined: { dot: "bg-slate-700", name: "Account created" },
};

/**
 * One row per day (00:00-24:00): grey track, pink = between first and last
 * activity but on a break, green = active, light green = the stretch that is
 * still going right now, coloured ticks = recorded actions, red line = now.
 */
export function ActivityTimeline({
    days,
    liveSegmentEnd,
    events = [],
    now,
}: {
    days: DaySummary[];
    /** end (ms) of the stretch that is still open, if the user is active now */
    liveSegmentEnd?: number | null;
    events?: TimelineEvent[];
    /** current time (ms), refreshed by the caller on each load */
    now: number;
}) {
    return (
        <div>
            <div className="mb-1 grid grid-cols-[110px_1fr] gap-3">
                <div />
                <div className="relative h-4 text-[11px] text-slate-400">
                    {TICKS.map((h) => (
                        <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>
                            {`${h}:00`}
                        </span>
                    ))}
                </div>
            </div>

            <div className="space-y-3">
                {days.map((d) => {
                    const pct = (ms: number) =>
                        `${((Math.min(Math.max(ms, d.day), d.day + DAY_MS) - d.day) / DAY_MS) * 100}%`;
                    const isToday = now >= d.day && now < d.day + DAY_MS;
                    const dayEvents = events.filter((e) => {
                        const s = Date.parse(e.at);
                        return s >= d.day && s < d.day + DAY_MS;
                    });
                    const own = dayEvents.filter((e) => e.kind !== "joined");
                    return (
                        <div key={d.day}>
                            <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                                <div className="text-xs font-medium text-slate-600">
                                    {new Date(d.day).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
                                </div>
                                <div className="relative h-7 overflow-hidden rounded-md bg-slate-100">
                                    {[6, 12, 18].map((h) => (
                                        <div key={h} className="absolute inset-y-0 w-px bg-white/70" style={{ left: `${(h / 24) * 100}%` }} />
                                    ))}
                                    {d.first !== null && d.last !== null && (
                                        <div
                                            className="absolute inset-y-1 rounded bg-red-200/80"
                                            style={{ left: pct(d.first), width: `calc(${pct(d.last)} - ${pct(d.first)})` }}
                                            title={`On the dashboard ${time(d.first)}-${time(d.last)} (pink = break of 5+ min)`}
                                        />
                                    )}
                                    {d.segments.map((s, i) => {
                                        const live = !!liveSegmentEnd && Math.abs(s.end - liveSegmentEnd) < 1000;
                                        return (
                                            <div
                                                key={i}
                                                className={`absolute inset-y-0.5 rounded ${live ? "bg-emerald-400" : "bg-green-700"}`}
                                                style={{ left: pct(s.start), width: `max(3px, calc(${pct(s.end)} - ${pct(s.start)}))` }}
                                                title={`${time(s.start)}-${time(s.end)} · ${formatDuration(s.end - s.start)} · ${sectionLabel(s.section)}${live ? " · active now" : ""}`}
                                            />
                                        );
                                    })}
                                    {dayEvents.map((e, i) => {
                                        const s = Date.parse(e.at);
                                        return (
                                            <div
                                                key={`t${i}`}
                                                className={`absolute top-0.5 h-2.5 w-1 -translate-x-1/2 rounded-full ${EVENT_STYLE[e.kind]?.dot ?? "bg-slate-500"}`}
                                                style={{ left: pct(s) }}
                                                title={`${time(s)} · ${e.label}`}
                                            />
                                        );
                                    })}
                                    {isToday && (
                                        <div className="absolute inset-y-0 w-0.5 bg-red-600" style={{ left: pct(now) }} title={`Now ${time(now)}`} />
                                    )}
                                </div>
                            </div>
                            {(d.first !== null || own.length > 0) && (
                                <div className="mt-1 grid grid-cols-[110px_1fr] gap-3 text-[11px]">
                                    <div />
                                    <div className="flex flex-wrap gap-x-3">
                                        {d.first !== null ? (
                                            <>
                                                <span className="text-slate-500">
                                                    Used {formatDuration(d.usedMs)}{" "}
                                                    <span className="text-slate-400">({time(d.first)}-{time(d.last!)})</span>
                                                </span>
                                                <span className="font-medium text-green-700">Worked {formatDuration(d.workedMs)}</span>
                                                <span className="text-red-400">Breaks {formatDuration(Math.max(0, d.usedMs - d.workedMs))}</span>
                                            </>
                                        ) : (
                                            <span className="text-slate-500">
                                                No live tracking this day · {own.length} recorded action{own.length === 1 ? "" : "s"}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="mt-4 flex flex-wrap justify-center gap-4 text-[11px] text-slate-500">
                <Legend cls="bg-green-700" label="Active" />
                <Legend cls="bg-emerald-400" label="Active now" />
                <Legend cls="bg-red-200" label="Inactive (break of 5+ min)" />
                <Legend cls="bg-sky-500" label="Chat" />
                <Legend cls="bg-amber-500" label="Dispute" />
                <Legend cls="bg-slate-700" label="Account created" />
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-0.5 bg-red-600" /> Now
                </span>
            </div>
        </div>
    );
}

function Legend({ cls, label }: { cls: string; label: string }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${cls}`} />
            {label}
        </span>
    );
}
