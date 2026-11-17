// Overlap window — the single, shared, PURE definition of "the section the
// analyst actually coded". The compare page's live Overlap view and every
// stored-accuracy recompute path (save / update / propagate / backfill) derive
// the window through this one module, so there can only ever be one definition
// of "overlap" and the stored number provably matches what the Overlap view
// shows on screen.
//
// No DOM, no Supabase, so it runs identically in the browser, in Node, and
// under Vitest. The window itself is `.mid` / `.length` arithmetic only; the
// paired-edge extension (pairedEdgeIds) also runs the pure compareInstances
// matcher, so call it on already-canonicalised sets.

import { compareInstances, type Instance } from "./xml-compare";

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

/** Ids of the edge instances kept by {@link pairedEdgeIds}, per side. */
export type EdgeKeepIds = { master: Set<string>; analyst: Set<string> };

/**
 * Edge instances to add to the overlap window. The window is the smaller
 * file's [min, max] mid, so the other file's event for the SAME first/last
 * action can sit a second or two outside it (e.g. an analyst opening Kick Off
 * at 79s vs the master's at 80s) and be cut before matching, leaving the
 * master's event "missed".
 *
 * An instance in the tolerance band just outside the window is kept ONLY when
 * it pairs with an in-window event the window-only grade left unmatched:
 *   - an analyst edge event pairing with a MISSED master event (any status —
 *     missed -> matched never lowers accuracy and leaves extras unchanged);
 *   - a master edge event pairing EXACTLY with an EXTRA analyst event (adds
 *     one master and one exact, so accuracy can't drop; extras go down).
 * Unpaired edge events stay dropped. As a final guard, if grading with the
 * kept edges would raise missed/extra or lower accuracy versus the window-only
 * grade, nothing is kept. Pass the SAME (already-canonical) sets, tolerance
 * and master file name used to grade.
 */
export function pairedEdgeIds(
  master: Instance[],
  analyst: Instance[],
  tolerance: number,
  masterFileName?: string | null
): EdgeKeepIds {
  const none: EdgeKeepIds = { master: new Set(), analyst: new Set() };
  const window = deriveOverlapWindow(master, analyst);
  if (!window || !(tolerance > 0)) return none;

  const inBand = (i: Instance) =>
    !inOverlap(i, window) &&
    i.mid >= window.start - tolerance &&
    i.mid <= window.end + tolerance;
  const mEdge = master.filter(inBand);
  const aEdge = analyst.filter(inBand);
  if (mEdge.length === 0 && aEdge.length === 0) return none;

  const mBase = master.filter((i) => inOverlap(i, window));
  const aBase = analyst.filter((i) => inOverlap(i, window));
  const base = compareInstances(mBase, aBase, tolerance, masterFileName);

  const missedIds = new Set<string>();
  const extraIds = new Set<string>();
  for (const r of base.rows) {
    if (r.status === "missed" && r.master) missedIds.add(r.master.id);
    if (r.status === "extra" && r.analyst) extraIds.add(r.analyst.id);
  }
  const mEdgeIds = new Set(mEdge.map((i) => i.id));
  const aEdgeIds = new Set(aEdge.map((i) => i.id));

  // Pair edge events only against the window's leftover (unmatched) events,
  // so no existing in-window match is disturbed.
  const second = compareInstances(
    [...mBase.filter((i) => missedIds.has(i.id)), ...mEdge],
    [...aBase.filter((i) => extraIds.has(i.id)), ...aEdge],
    tolerance,
    masterFileName
  );
  const keep: EdgeKeepIds = { master: new Set(), analyst: new Set() };
  for (const r of second.rows) {
    if (!r.master || !r.analyst) continue;
    const mIsEdge = mEdgeIds.has(r.master.id);
    const aIsEdge = aEdgeIds.has(r.analyst.id);
    if (aIsEdge && !mIsEdge && missedIds.has(r.master.id)) {
      keep.analyst.add(r.analyst.id);
    } else if (
      mIsEdge &&
      !aIsEdge &&
      extraIds.has(r.analyst.id) &&
      r.status === "exact"
    ) {
      keep.master.add(r.master.id);
    }
  }
  if (keep.master.size === 0 && keep.analyst.size === 0) return none;

  // Guard: the full regrade must be no worse than the window-only grade.
  const final = compareInstances(
    [...mBase, ...mEdge.filter((i) => keep.master.has(i.id))],
    [...aBase, ...aEdge.filter((i) => keep.analyst.has(i.id))],
    tolerance,
    masterFileName
  ).summary;
  const b = base.summary;
  if (
    final.missed > b.missed ||
    final.extra > b.extra ||
    final.accuracy < b.accuracy
  ) {
    return none;
  }
  return keep;
}

/**
 * {@link scopeToOverlap} plus the paired edge instances from
 * {@link pairedEdgeIds}. This is the overlap scope used for grading (live
 * Overlap view and every stored-accuracy path).
 */
export function scopeToOverlapPaired(
  master: Instance[],
  analyst: Instance[],
  tolerance: number,
  masterFileName?: string | null
): {
  master: Instance[];
  analyst: Instance[];
  window: OverlapWindow | null;
  edge: EdgeKeepIds;
} {
  const window = deriveOverlapWindow(master, analyst);
  if (!window) {
    return {
      master,
      analyst,
      window: null,
      edge: { master: new Set(), analyst: new Set() },
    };
  }
  const edge = pairedEdgeIds(master, analyst, tolerance, masterFileName);
  return {
    master: master.filter((i) => inOverlap(i, window) || edge.master.has(i.id)),
    analyst: analyst.filter(
      (i) => inOverlap(i, window) || edge.analyst.has(i.id)
    ),
    window,
    edge,
  };
}
