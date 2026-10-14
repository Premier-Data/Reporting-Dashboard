// Pure helpers for the accuracy-compare video review auto-skip/seek logic.
//
// The timeline DISPLAY order is sorted by `mid` (code time, with per-stat
// offsets) in the comparison engine and MUST stay that way. The auto-skip
// handler, however, needs to walk clips in playback (time) order so it never
// seeks backward. These helpers derive a dedicated start-sorted "seek list"
// from the display clips and provide playhead-driven index selection, so the
// handler no longer relies on a forward-only drifting cursor.
//
// All functions here are pure (no React/DOM) so they can be unit-tested.

/**
 * A clip in the start-sorted seek list. `rowIndex` maps the seek clip back to
 * its position in the DISPLAY order (reviewClips/videoRows), so the handler can
 * keep the display-order cursor (reviewIndex: Prev/Next + "N / M" counter) in
 * sync with what is actually playing.
 */
export type SeekClip = { start: number; end: number; rowIndex: number };

/**
 * Build the start-sorted seek list from the display-order clips.
 *
 * Each display clip is tagged with its display index (`rowIndex`), then the
 * list is sorted by `start` ascending, tie-broken by `end` ascending. The sort
 * is stable, so clips sharing the same (start, end) keep their display order.
 * The input array is NOT mutated.
 */
export function buildSeekClips(
  clips: { start: number; end: number }[]
): SeekClip[] {
  return clips
    .map((c, i) => ({ start: c.start, end: c.end, rowIndex: i }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Index of the LAST clip whose `start <= t` (binary search), or `-1` when `t`
 * is before the first clip's start. The caller decides whether `t <= end`
 * (i.e. whether the playhead is actually inside that clip's window vs. in the
 * dead air after it).
 */
export function currentSeekIndex(sorted: SeekClip[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Index of the FIRST clip whose `start > t` (binary search), or `sorted.length`
 * when every clip starts at/before `t`. Used to find the next forward clip to
 * skip the dead air to. Because the list is start-sorted, the returned target
 * is always at/after the playhead — never backward.
 */
export function nextSkipIndex(sorted: SeekClip[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].start > t) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * Index of the clip NEAREST in time to `t`:
 *  - if some clip's `[start, end]` window contains `t`, return that clip;
 *  - otherwise return whichever of the clip starting after `t` and the clip
 *    before it has the smaller `|start - t|` (ties go to the earlier clip).
 * Returns `-1` only for an empty list.
 */
export function nearestClipIndex(sorted: SeekClip[], t: number): number {
  if (sorted.length === 0) return -1;

  // Prefer a clip whose window actually contains t.
  const cur = currentSeekIndex(sorted, t);
  if (cur >= 0 && t <= sorted[cur].end) return cur;

  // Otherwise compare the clip starting after t with the one before it.
  const after = nextSkipIndex(sorted, t); // first start > t
  const before = after - 1; // last start <= t (or -1)

  if (after >= sorted.length) return before; // nothing after -> the last clip
  if (before < 0) return after; // nothing before -> the first clip

  const distBefore = Math.abs(sorted[before].start - t);
  const distAfter = Math.abs(sorted[after].start - t);
  // Ties go to the earlier (before) clip.
  return distBefore <= distAfter ? before : after;
}
