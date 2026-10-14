"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { computePull } from "@/lib/pwa/pull-to-refresh-math";

/** Resisted offset in px needed to arm the reload. */
const THRESHOLD = 70;
/** Hard cap on how far the indicator travels, regardless of drag distance. */
const MAX_OFFSET = 110;
/** Minimum vertical dominance so a mostly-horizontal swipe never engages. */
const DIRECTION_SLOP = 6;

export type PullState = "idle" | "pulling" | "refreshing";

export interface PullToRefresh {
    offset: number;
    progress: number;
    state: PullState;
    /** True while the spring-back animation should be eased (reduced-motion off). */
    animated: boolean;
    /** Callback ref to attach to the scroll container. */
    ref: (node: HTMLElement | null) => void;
}

function isTouchDevice(): boolean {
    if (typeof window === "undefined") return false;
    return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function prefersReducedMotion(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Attaches a touch-only pull-to-refresh gesture to a scroll container. The
 * hook owns the element via a callback ref (returned as `ref`): attach it to
 * the scroll container with `<main ref={pull.ref}>`.
 *
 * The gesture engages ONLY when the container is scrolled to the very top and
 * the first move is downward. Releasing past the threshold triggers a single
 * hard reload (`window.location.reload()`); releasing before springs back.
 *
 * Because the binding effect depends on the element STATE set by the callback
 * ref, it re-runs when the container mounts (null → node) or unmounts
 * (node → null). This matters when the container only appears after an initial
 * render that did not include it (e.g. an auth gate), where a plain RefObject
 * would leave the effect bound to a null element forever.
 *
 * Inert on non-touch devices and during SSR: no listeners are bound and the
 * returned state stays idle, so desktop sees no visual change.
 */
export function usePullToRefresh(): PullToRefresh {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const setRef = useCallback((node: HTMLElement | null) => setEl(node), []);

    const [offset, setOffset] = useState(0);
    const [progress, setProgress] = useState(0);
    const [state, setState] = useState<PullState>("idle");
    const [animated, setAnimated] = useState(true);

    // Mutable gesture bookkeeping that must survive re-renders without
    // re-binding listeners.
    const startYRef = useRef(0);
    const startXRef = useRef(0);
    const pullingRef = useRef(false);
    const crossedRef = useRef(false);
    const triggeredRef = useRef(false);

    useEffect(() => {
        if (!el || !isTouchDevice()) return;

        const reduce = prefersReducedMotion();

        const reset = () => {
            pullingRef.current = false;
            crossedRef.current = false;
            setAnimated(!reduce);
            setOffset(0);
            setProgress(0);
            setState("idle");
        };

        const onTouchStart = (e: TouchEvent) => {
            if (triggeredRef.current) return;
            // Only arm when already at the very top of the scroll area.
            if (el.scrollTop > 0) {
                pullingRef.current = false;
                return;
            }
            const touch = e.touches[0];
            startYRef.current = touch.clientY;
            startXRef.current = touch.clientX;
            pullingRef.current = false; // not engaged until a downward move
            crossedRef.current = false;
        };

        const onTouchMove = (e: TouchEvent) => {
            if (triggeredRef.current) return;

            const touch = e.touches[0];
            const deltaY = touch.clientY - startYRef.current;
            const deltaX = touch.clientX - startXRef.current;

            if (!pullingRef.current) {
                // Decide whether to engage. Require: still at top, moving
                // downward, and more vertical than horizontal.
                if (el.scrollTop > 0) return;
                if (deltaY <= DIRECTION_SLOP) return; // upward / too small
                if (Math.abs(deltaY) <= Math.abs(deltaX)) return; // horizontal
                pullingRef.current = true;
                setState("pulling");
                // During an active, animation-free drag the indicator should
                // track the finger instantly.
                setAnimated(false);
            }

            // If the container somehow scrolled, abort and let scroll resume.
            if (el.scrollTop > 0) {
                reset();
                return;
            }

            // Actively pulling at the top: suppress native scroll/rubber-band.
            if (e.cancelable) e.preventDefault();

            const { offset: nextOffset, crossed, progress: nextProgress } =
                computePull(deltaY, THRESHOLD, MAX_OFFSET);
            crossedRef.current = crossed;
            setOffset(nextOffset);
            setProgress(nextProgress);
        };

        const onTouchEnd = () => {
            if (triggeredRef.current) return;
            if (!pullingRef.current) {
                reset();
                return;
            }

            if (crossedRef.current) {
                // Lock into the refreshing state and hard-reload exactly once.
                triggeredRef.current = true;
                pullingRef.current = false;
                setAnimated(!reduce);
                setState("refreshing");
                setOffset(THRESHOLD);
                setProgress(1);
                window.location.reload();
                return;
            }

            // Not past threshold → spring back to idle.
            reset();
        };

        // touchmove must be NON-passive so preventDefault() is honored while
        // actively pulling. The others can stay passive.
        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd, { passive: true });
        el.addEventListener("touchcancel", onTouchEnd, { passive: true });

        return () => {
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
            el.removeEventListener("touchcancel", onTouchEnd);
        };
    }, [el]);

    return { offset, progress, state, animated, ref: setRef };
}
