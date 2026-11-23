"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
    BREAK_MS,
    HEARTBEAT_MS,
    sectionFromPath,
} from "@/lib/activity/activity";
import { sendHeartbeat } from "@/lib/api/activity";

// Records user activity as continuous "stretches" (same rules as lms-platform):
//  - any click / key / scroll / touch / mouse movement, or a playing video,
//    counts as activity;
//  - 5 minutes with no activity ends the stretch (the gap is a break) and the
//    next interaction starts a new one;
//  - moving into a different section (page) also starts a new stretch, so time
//    per section is exact.
// The open stretch is reported every 30s (and when the tab is hidden/closed);
// the same call refreshes the user's online presence.
const EVENTS = ["mousedown", "keydown", "scroll", "wheel", "touchstart", "mousemove"] as const;

type Seg = { id: string; start: number; last: number; section: string; path: string };

function uuid(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export default function ActivityTracker({
    userId,
    username,
}: {
    userId: number;
    username: string;
}) {
    const pathname = usePathname();
    const seg = useRef<Seg | null>(null);
    const lastMark = useRef(0);
    const section = useRef<string>(sectionFromPath(pathname));
    const path = useRef(pathname);
    const playing = useRef(new Set<unknown>());

    function send(s: Seg | null, opts: { keepalive?: boolean; closing?: boolean } = {}) {
        void sendHeartbeat(
            {
                userId,
                username,
                closing: opts.closing,
                section: section.current,
                path: path.current,
                segment: s
                    ? {
                          id: s.id,
                          started_at: new Date(s.start).toISOString(),
                          ended_at: new Date(s.last).toISOString(),
                      }
                    : null,
            },
            { keepalive: opts.keepalive }
        );
    }

    /** Close the current stretch (report it) and forget it. */
    function finish(keepalive = false) {
        if (seg.current) send(seg.current, { keepalive });
        seg.current = null;
    }

    function markActive() {
        const now = Date.now();
        // mousemove fires constantly; one mark per second is plenty.
        if (now - lastMark.current < 1000) return;
        lastMark.current = now;
        const s = seg.current;
        if (s && now - s.last <= BREAK_MS && s.section === section.current) {
            s.last = now;
            return;
        }
        // Break (or section change): report the old stretch, start a new one.
        if (s) finish();
        seg.current = {
            id: uuid(),
            start: now,
            last: now,
            section: section.current,
            path: path.current,
        };
        send(seg.current); // report the start straight away so "Active now" is instant
    }

    // Section / page changes
    useEffect(() => {
        const next = sectionFromPath(pathname);
        if (next !== section.current) {
            if (seg.current) {
                // End the old section's stretch now and continue in the new one.
                seg.current.last = Math.max(seg.current.last, Date.now());
                finish();
            }
            section.current = next;
            path.current = pathname;
            lastMark.current = 0;
            markActive(); // navigating is an interaction
        } else {
            path.current = pathname;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    useEffect(() => {
        const onPlay = (e: Event) => playing.current.add(e.target);
        const onStop = (e: Event) => playing.current.delete(e.target);
        for (const n of EVENTS) window.addEventListener(n, markActive, { passive: true });
        document.addEventListener("play", onPlay, true);
        document.addEventListener("pause", onStop, true);
        document.addEventListener("ended", onStop, true);

        // A playing video keeps the user active without clicks.
        const mediaTimer = setInterval(() => {
            if (playing.current.size > 0) {
                lastMark.current = 0;
                markActive();
            }
        }, 15_000);

        // Heartbeat: report the open stretch and refresh presence.
        const beat = setInterval(() => {
            const s = seg.current;
            if (s && Date.now() - s.last > BREAK_MS) {
                // Went quiet: the stretch ended at its last activity.
                finish();
                send(null);
                return;
            }
            send(s);
        }, HEARTBEAT_MS);

        const onHide = () => {
            if (document.visibilityState === "hidden" && seg.current) {
                send(seg.current, { keepalive: true });
            }
        };
        const onLeave = () => {
            send(seg.current, { keepalive: true, closing: true });
        };
        document.addEventListener("visibilitychange", onHide);
        window.addEventListener("pagehide", onLeave);

        // Opening the dashboard counts as the first interaction.
        markActive();

        return () => {
            clearInterval(mediaTimer);
            clearInterval(beat);
            for (const n of EVENTS) window.removeEventListener(n, markActive);
            document.removeEventListener("play", onPlay, true);
            document.removeEventListener("pause", onStop, true);
            document.removeEventListener("ended", onStop, true);
            document.removeEventListener("visibilitychange", onHide);
            window.removeEventListener("pagehide", onLeave);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return null;
}

