"use client";

import { ArrowDown, Loader2 } from "lucide-react";
import type { PullToRefresh } from "@/components/pwa/usePullToRefresh";

/**
 * Presentational overlay for the pull-to-refresh gesture. Pinned to the
 * top-center of the scroll column and translated down by the current pull
 * offset. Shows a fading/rotating arrow while pulling (flipping to "ready"
 * once progress hits 1) and a spinner once refreshing.
 *
 * Renders nothing meaningful when idle at rest, has no layout impact
 * (absolutely positioned, pointer-events-none), and is purely visual.
 */
export default function PullToRefreshIndicator({
    offset,
    progress,
    state,
    animated,
}: PullToRefresh) {
    const refreshing = state === "refreshing";
    const ready = progress >= 1;
    const visible = offset > 0 || refreshing;

    return (
        <div
            aria-hidden={visible ? undefined : true}
            role={visible ? "status" : undefined}
            className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
            style={{
                transform: `translateY(${offset}px)`,
                opacity: visible ? 1 : 0,
                transition: animated
                    ? "transform 200ms ease-out, opacity 200ms ease-out"
                    : "none",
            }}
        >
            <div className="mt-2 flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-600 shadow-md ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
                {refreshing ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                    <ArrowDown
                        className="h-5 w-5 transition-transform"
                        style={{
                            opacity: Math.max(0.3, progress),
                            transform: `rotate(${ready ? 180 : 0}deg)`,
                        }}
                    />
                )}
            </div>
        </div>
    );
}
