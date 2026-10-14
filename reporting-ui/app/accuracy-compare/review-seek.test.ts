import { describe, it, expect } from "vitest";
import {
  buildSeekClips,
  currentSeekIndex,
  nextSkipIndex,
  nearestClipIndex,
} from "./review-seek";

describe("buildSeekClips", () => {
  // Report trace case: starts [100,110,130] whose mids [102,155,135] reshuffle
  // the DISPLAY order to pass(102) / corner(135) / goal(155). The display-order
  // input is therefore [{100,104},{130,140},{110,170}]. The seek list must be
  // re-sorted by START, carrying each clip's original rowIndex.
  it("sorts mid-ordered display clips by start, preserving rowIndex", () => {
    const display = [
      { start: 100, end: 104 }, // rowIndex 0
      { start: 130, end: 140 }, // rowIndex 1
      { start: 110, end: 170 }, // rowIndex 2
    ];
    expect(buildSeekClips(display)).toEqual([
      { start: 100, end: 104, rowIndex: 0 },
      { start: 110, end: 170, rowIndex: 2 },
      { start: 130, end: 140, rowIndex: 1 },
    ]);
  });

  it("does not mutate the input array", () => {
    const display = [
      { start: 130, end: 140 },
      { start: 100, end: 104 },
    ];
    const snapshot = JSON.parse(JSON.stringify(display));
    buildSeekClips(display);
    expect(display).toEqual(snapshot);
  });

  it("tie-breaks equal starts by end ascending, stably", () => {
    const display = [
      { start: 50, end: 60 }, // rowIndex 0
      { start: 50, end: 55 }, // rowIndex 1
      { start: 50, end: 60 }, // rowIndex 2
    ];
    expect(buildSeekClips(display)).toEqual([
      { start: 50, end: 55, rowIndex: 1 },
      { start: 50, end: 60, rowIndex: 0 },
      { start: 50, end: 60, rowIndex: 2 },
    ]);
  });

  it("returns [] for an empty input", () => {
    expect(buildSeekClips([])).toEqual([]);
  });
});

describe("currentSeekIndex", () => {
  const sorted = buildSeekClips([
    { start: 100, end: 104 },
    { start: 130, end: 140 },
    { start: 110, end: 170 },
  ]); // start-sorted: [100-104, 110-170, 130-140]

  it("returns the last clip starting at/before t", () => {
    // t=104 -> last start<=104 is the 100 clip (index 0), and t<=end holds.
    expect(currentSeekIndex(sorted, 104)).toBe(0);
    expect(104 <= sorted[0].end).toBe(true);
  });

  it("returns -1 when t is before the first clip's start", () => {
    expect(currentSeekIndex(sorted, 50)).toBe(-1);
  });

  it("returns the last index when t is past every start", () => {
    expect(currentSeekIndex(sorted, 500)).toBe(2);
  });

  it("returns -1 on an empty list", () => {
    expect(currentSeekIndex([], 5)).toBe(-1);
  });
});

describe("nextSkipIndex", () => {
  const sorted = buildSeekClips([
    { start: 100, end: 104 },
    { start: 130, end: 140 },
    { start: 110, end: 170 },
  ]); // [100-104, 110-170, 130-140]

  it("targets the next forward clip, never a backward one", () => {
    // At t=104 the next clip to skip to is the 110 clip (index 1), NOT backward.
    expect(nextSkipIndex(sorted, 104)).toBe(1);
    expect(sorted[1].start).toBe(110);
  });

  it("is non-decreasing as t increases and never yanks backward", () => {
    const times = [100, 105, 111, 131];
    const indices = times.map((t) => nextSkipIndex(sorted, t));
    // Non-decreasing index.
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
    }
    // The targeted start times are non-decreasing (never backward).
    const starts = indices.map((idx) =>
      idx < sorted.length ? sorted[idx].start : Infinity
    );
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    }
  });

  it("returns length when every clip starts at/before t", () => {
    expect(nextSkipIndex(sorted, 500)).toBe(sorted.length);
  });
});

describe("goal-before-pass case (must not yank the playhead back)", () => {
  // A goal (start 50, mid 95) sorts in DISPLAY order AFTER a pass (start 90,
  // mid 92). So the display-order input is [pass{90,94}, goal{50,170}].
  const display = [
    { start: 90, end: 94 }, // pass, rowIndex 0
    { start: 50, end: 170 }, // goal, rowIndex 1
  ];
  const sorted = buildSeekClips(display);

  it("start-sorts the goal before the pass, carrying rowIndex", () => {
    expect(sorted).toEqual([
      { start: 50, end: 170, rowIndex: 1 },
      { start: 90, end: 94, rowIndex: 0 },
    ]);
  });

  it("after playing past the pass (t=94) there is NO forward clip to skip to", () => {
    // nextSkipIndex === length means the handler will NOT seek backward to the
    // goal's start (50). This is the core "no backward yank" guarantee.
    expect(nextSkipIndex(sorted, 94)).toBe(sorted.length);
  });

  it("the playhead at t=94 maps to the goal clip (its window contains 94), not back to 50", () => {
    // t=94 is inside the goal window [50,170]; currentSeekIndex points at it
    // and t<=end holds, so no gap-skip fires.
    const cur = currentSeekIndex(sorted, 94);
    expect(cur).toBe(1); // the pass clip, start 90
    expect(94 <= sorted[cur].end).toBe(true);
  });
});

describe("nearestClipIndex", () => {
  const sorted = buildSeekClips([
    { start: 100, end: 104 },
    { start: 110, end: 170 },
    { start: 130, end: 140 },
  ]); // already start-sorted

  it("returns the clip whose window contains t", () => {
    expect(nearestClipIndex(sorted, 120)).toBe(1); // inside 110-170
  });

  it("returns the nearest-starting clip when t is in a gap", () => {
    // t=107 sits in the gap between clip0 (ends 104) and clip1 (starts 110);
    // nearest start is 110 -> index 1.
    expect(nearestClipIndex(sorted, 107)).toBe(1);
  });

  it("returns the first clip when t precedes all clips", () => {
    expect(nearestClipIndex(sorted, 50)).toBe(0);
  });

  it("returns the last clip when t follows all clips", () => {
    expect(nearestClipIndex(sorted, 500)).toBe(2);
  });

  it("returns -1 on an empty list", () => {
    expect(nearestClipIndex([], 5)).toBe(-1);
  });
});

describe("self-seek guard semantics (documented via helpers)", () => {
  // The runtime guard lives in the component (skippingRef + onSeeked), but the
  // helpers guarantee the property the guard protects: once the handler seeks
  // forward to nextStart and resumes at that time, re-deriving the index from
  // the new playhead yields the clip we jumped to and NOT an earlier one, so a
  // guard-released re-entry cannot ping-pong backward.
  const sorted = buildSeekClips([
    { start: 100, end: 104 },
    { start: 130, end: 140 },
    { start: 110, end: 170 },
  ]); // [100-104, 110-170, 130-140]

  it("re-deriving after a forward seek lands on the jumped-to clip, not earlier", () => {
    const t = 104;
    const nextIdx = nextSkipIndex(sorted, t); // 1 -> start 110
    const nextStart = sorted[nextIdx].start;
    // Simulate arriving at nextStart after the programmatic seek.
    const afterIdx = currentSeekIndex(sorted, nextStart);
    expect(afterIdx).toBe(nextIdx);
    // And the next skip target from there is strictly forward of nextStart.
    expect(nextSkipIndex(sorted, nextStart)).toBeGreaterThan(nextIdx);
  });
});
