// Overlap window — the single, shared, PURE definition of "the section the
// analyst actually coded". The compare page's live Overlap view and every
// stored-accuracy recompute path (save / update / propagate / backfill) derive
// the window through this one module, so there can only ever be one definition
// of "overlap" and the stored number provably matches what the Overlap view
// shows on screen.
//
// No DOM, no Supabase — only `.mid` / `.length` arithmetic — so it runs
// identically in the browser, in Node, and under Vitest, and can be applied to
// instances whether or not their teams have been canonicalised (it never reads
// `.team`).

import type { Instance } from "./xml-compare";

export type OverlapWindow = {
  start: number;
  end: number;
  /** Which side the window was derived from (the fewer-instance file). */
  source: "master" | "analyst";
};

/**
 * The overlap window = [min(mid), max(mid)] of whichever instance set has
 * FEWER instances (the coded section). Mirrors the compare page's
 * `analystWindow` EXACTLY: strict `<` on length so a tie keeps `master` (the
 * first candidate), min/max over `.mid`, inclusive bounds. Returns null when
 * neither side has instances (the caller then treats scope as "no filter" /
 * ungradeable).
 */
export function deriveOverlapWindow(
  master: Instance[],
  analyst: Instance[]
): OverlapWindow | null {
  const candidates: Array<{ arr: Instance[]; source: "master" | "analyst" }> =
    [];
  // Push master FIRST so the strict-`<` reduce below keeps master on a tie,
  // identical to the page's `[master, analyst].reduce(...)`.
  if (master.length > 0) candidates.push({ arr: master, source: "master" });
  if (analyst.length > 0) candidates.push({ arr: analyst, source: "analyst" });
  if (candidates.length === 0) return null;

  const smaller = candidates.reduce((a, b) =>
    b.arr.length < a.arr.length ? b : a
  );

  let start = Infinity;
  let end = -Infinity;
  for (const i of smaller.arr) {
    if (i.mid < start) start = i.mid;
    if (i.mid > end) end = i.mid;
  }
  return { start, end, source: smaller.source };
}

/** Inclusive both ends — identical to the compare page's `inRange`. */
export function inOverlap(i: Instance, w: OverlapWindow): boolean {
  return i.mid >= w.start && i.mid <= w.end;
}

/**
 * Filter a master+analyst pair to the overlap window. Call this on sets that
 * are ALREADY canonicalised (so the Home/Away labels match the full-set live
 * view). When the window can't be derived (one side empty) returns the inputs
 * unchanged with `window: null` — the downstream grader then yields the same
 * ungradeable result it does today.
 */
export function scopeToOverlap(
  master: Instance[],
  analyst: Instance[]
): { master: Instance[]; analyst: Instance[]; window: OverlapWindow | null } {
  const window = deriveOverlapWindow(master, analyst);
  if (!window) return { master, analyst, window: null };
  return {
    master: master.filter((i) => inOverlap(i, window)),
    analyst: analyst.filter((i) => inOverlap(i, window)),
    window,
  };
}
