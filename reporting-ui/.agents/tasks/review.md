# Start-sorted seek list and playhead-derived index for accuracy-compare video review

The auto-skip/manual-seek logic in the accuracy-compare video review used a forward-only drifting cursor over the *display-ordered* (mid-sorted) clip list, which let the playhead jump backward and ping-pong whenever the display order diverged from playback (time) order. This change introduces a dedicated start-sorted "seek list" (`buildSeekClips`) that the auto-skip handler walks, derives the current clip from the real playhead each tick via binary search instead of a stateful walk, adds a self-seek guard so a programmatic `currentTime` assignment can't retrigger a skip, and resyncs manual seeks to the clip nearest in time. The display timeline (rows, Prev/Next, the "N / M" counter) stays mid-sorted and is unchanged. The pure index/ordering logic is extracted into `review-seek.ts` with a 20-case unit test file.

Watch for:
- (confirmed) The self-seek guard clears only on `onSeeked`; a `currentTime` write that the browser treats as a no-op (target == current time) would not fire `onSeeked` and could leave `skippingRef` stuck. In practice the write only happens when `nextStart > t + 1s`, so a real seek always occurs and `onSeeked` fires. Non-blocking.
- (confirmed) `seekVideo` (row click / Prev-Next / deep-link) writes `currentTime` without setting `skippingRef`; this is intentional and correct — those are treated as manual seeks and resync rather than retrigger a skip.

**Verdict**: APPROVED

## High-level view

The fix cleanly separates the two orderings the feature needs. Display order stays mid-sorted (`reviewClips` / `videoRows` are untouched), and a new `seekClips` memo produces a start-sorted projection carrying each clip's display `rowIndex`. The auto-skip handler now walks only the start-sorted list, so by construction it can never target a backward clip — the root cause of the random jumping.

Index selection is now stateless: each `timeupdate` tick binary-searches the playhead against the start-sorted list (`currentSeekIndex` for the containing/last-started clip, `nextSkipIndex` for the next forward gap target). This replaces the forward-only `while` walk that could drift out of sync after a manual scrub.

A `skippingRef` flag set immediately before the programmatic `currentTime` write and cleared on the `<video>` `onSeeked` event stops the handler's own seek from being read as a new manual seek and retriggering. Manual scrubs leave the flag false and fall through to a nearest-in-time resync (`nearestClipIndex`), replacing the old first-match `findIndex`.

The row highlight remains driven directly off `videoTime` against each instance's start/end, so it stays correct for whatever is actually playing regardless of the seek list's order. Scope is tight: only `page.tsx` plus the new sibling helper and its test; the comparison engine, disputes, and unrelated files are untouched.

<details>
<summary>Issues (2)</summary>

1. **Stuck guard on no-op seek** — if a programmatic `currentTime` write targets the current time, `onSeeked` may not fire and `skippingRef` stays true. Guarded in practice by the `>1s` gap threshold; no action required, noted for future edits.
2. **seekVideo bypasses the guard** — row click / Prev-Next write `currentTime` without setting `skippingRef`, so they're handled as manual seeks. This is the intended behavior; documenting it so a future change doesn't "fix" it by adding the guard and breaking manual seek resync.

</details>

<details>
<summary>Details</summary>

### Two orderings, cleanly separated

The core design choice is to keep the existing mid-sorted display list and derive a second, start-sorted list purely for playback. `buildSeekClips` maps each display clip to `{start, end, rowIndex}` and sorts by `start` then `end`, without mutating the input. Because the sort key is `start`, walking this list forward can never produce a backward seek — this is the structural fix for the jumping, not a heuristic patch. The `rowIndex` carried on each entry is the bridge back to display order, so the Prev/Next cursor and the "N / M" counter (both built off `reviewSeekTimes`, which is still `reviewClips.map(c => c.start)` in display order) stay consistent with what's playing.

The tie-break (`a.start - b.start || a.end - b.end`) with a stable sort gives deterministic ordering for clips sharing a start, and the test `tie-breaks equal starts by end ascending, stably` pins that down.

### Playhead-derived index instead of a drifting cursor

The old handler kept `reviewIndexRef` as a forward-only cursor advanced by a `while (t > clips[idx].end)` walk, and separately detected manual seeks by comparing `t` against the previous tick's time with magic deltas (`t < prev - 0.4 || t > prev + 1`). Both are gone. Each tick now computes:

```
cur      = currentSeekIndex(clips, t)   // last clip with start <= t, else -1
inWindow = cur >= 0 && t <= clips[cur].end
```

`currentSeekIndex` is a correct "rightmost start <= t" binary search (returns `-1` before the first start, last index past all starts). `inWindow` distinguishes "inside a clip" from "in the dead air after it," which is exactly the signal the auto-skip gap logic needs. The trace case from the report — display `[{100,104},{130,140},{110,170}]`, mids reshuffling to pass/corner/goal — start-sorts to `[{100,104,r0},{110,170,r2},{130,140,r1}]`, and at `t=104` yields `cur=0, inWindow=true`, with `nextSkipIndex=1` (start 110). Forward, never backward. The test suite encodes this directly.

### Auto-skip gap logic

With `inWindow` true, the handler returns before any seek, so clusters/overlapping stats in the same window play through naturally — preserving the documented "don't replay within a window" behavior. With `inWindow` false, `nextSkipIndex(clips, t)` finds the first clip starting after `t`; if there is none and the playhead is past the last clip, it pauses (avoids running into unrelated game action); otherwise it skips only when `nextStart > t + GAP` (1s). Because the list is start-sorted, `nextStart` is always ≥ the playhead, so the gap skip is strictly forward.

The goal-before-pass case is the important edge: display `[pass{90,94,r0}, goal{50,170,r1}]` start-sorts to `[{50,170,r1},{90,94,r0}]`. At `t=94` the playhead is inside the goal window `[50,170]`, so `cur=1, inWindow=true` and the handler returns — it does *not* yank back to start 50. If instead the playhead were in dead air there, `nextSkipIndex(…,94)` returns `length` (no forward clip), so again no backward seek. Both are covered by tests.

### Self-seek guard

`skippingRef` is set to `true` on the line immediately before `v.currentTime = nextStart`, and the `timeupdate` handler early-returns while it's set, so the echo tick from the browser settling the programmatic seek can't trigger a second skip. The `<video>` `onSeeked` handler clears it once the seek completes. This replaces the fragile prev±delta detector, which could misclassify a legitimate playback hiccup as a manual seek.

Two behavioral notes worth recording. First, if the programmatic write ever targeted the current time (a no-op seek), the browser may not fire `onSeeked` and the flag would stick, suppressing auto-skip until the next real seek clears it. The `nextStart > t + 1s` precondition means the write always moves the playhead by more than a second, so a real seek — and thus `onSeeked` — always occurs. This is a latent coupling to keep in mind, not a current bug.

Second, `seekVideo` (used by row click, Prev/Next via `goToClip`, and the deep-link path) writes `currentTime` directly and does *not* set `skippingRef`. That's correct: those are user-intent jumps and should be handled as manual seeks (resync to nearest, don't force-skip the tick), not suppressed. A future change that "symmetrically" wrapped `seekVideo` in the guard would break manual-seek resync — hence flagging it.

### Manual-seek resync to nearest-in-time

When the playhead is not inside a clip window, the display cursor is set from `nearestClipIndex(clips, t)` rather than the old first-`findIndex` match. `nearestClipIndex` prefers a window containing `t`, else compares the nearest start before and after `t` (ties to the earlier clip), and returns `-1` only for an empty list. This maps the Prev/Next cursor to the closest instance in time instead of the first display-order match, which is the behavior a user expects after scrubbing. The cursor update is gated on an actual change (`rowIdx !== reviewIndexRef.current`) so it doesn't thrash React state every tick.

Note the handler maps `rowSource` (an index into the start-sorted list) back through `clips[rowSource].rowIndex` to a display index before setting `reviewIndex` — so the cursor is always a valid display-order index. Correct bridging between the two orderings.

### Highlight vs seek mapping

The row highlight (`masterActive` / `analystActive` / `rowActive`) is computed directly from `videoTime` against each instance's start/end in the `videoRows.map` render, entirely independent of the seek list. So even though the seek order differs from display order, the highlighted row always corresponds to the clip actually playing. This separation is what makes the start-sorted seek list safe to introduce without touching the display.

### Scope and tests

Only `page.tsx` and the two new sibling files were changed. `reviewClips`, `reviewSeekTimes`, `videoRows`, `seekVideo`, `goToClip`, the comparison engine (`lib/comparison/*`), and `disputes.ts` are untouched — verified by diff and grep. Per the verification note, `tsc --noEmit` is clean, `next build` succeeds (35/35 pages), and `vitest --run` passes 31 tests across 3 files including the 20 new helper tests. The new test file covers the reshuffle trace, forward-monotonic skip targets, the goal-before-pass no-yank guarantee, `nearestClipIndex` for inside/gap/before/after/empty, and the re-derivation property that underpins the self-seek guard.

Not tested (acceptable — these are DOM/React integration seams, not pure logic): the `onSeeked`-clears-`skippingRef` wiring and the `seekVideo` manual-seek path are only exercisable with a real `<video>` element, so they're covered by reasoning rather than unit tests. No automated regression guards that `reviewClips` display order stays mid-sorted; it's preserved by not being touched.

The two new files (`review-seek.ts`, `review-seek.test.ts`) are present on disk but untracked in git, so they don't appear in `git diff main`; they were read directly from the worktree.

</details>

<details>
<summary>File map</summary>

- `app/accuracy-compare/page.tsx` — swapped the forward-only cursor + prev-delta seek detector for a start-sorted seek list, playhead-derived binary-search index, self-seek guard (`skippingRef` + `onSeeked`), and nearest-in-time manual resync; added the `seekClips` memo.
- `app/accuracy-compare/review-seek.ts` (new, untracked) — pure helpers `buildSeekClips`, `currentSeekIndex`, `nextSkipIndex`, `nearestClipIndex`, `type SeekClip`.
- `app/accuracy-compare/review-seek.test.ts` (new, untracked) — 20 unit tests encoding the report trace cases.

Full diff: `git diff main -- app/accuracy-compare/page.tsx` (new files are untracked; read from the worktree).

</details>
