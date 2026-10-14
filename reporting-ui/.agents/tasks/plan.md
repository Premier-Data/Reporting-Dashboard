# Implementation Plan — Fix video-review timeline random jumping

Branch: `fix/video-timeline-jumping`
Worktree root: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui`

## Scope (hard constraints)

- Edit ONLY:
  - `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\page.tsx`
  - NEW `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\review-seek.ts` (pure helpers)
  - NEW `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\review-seek.test.ts` (unit tests)
- Do NOT touch `lib/comparison/*` (the `mid`/`codeTime` offsets are correct and intentional), `disputes.ts`, or any unrelated file.
- Do NOT commit or push. Do NOT restart the main dev server on port 3000. If a dev server is ever needed from the worktree, use port 3200 and stop it when done.

## Key facts established by investigation (do not re-derive)

- `videoRows` (page.tsx ~L1855) is `ComparisonRow[]` sorted by `mid` (code time) via the comparison engine; this is the DISPLAY order and MUST stay as-is.
- `reviewClips` (page.tsx ~L1953) maps `videoRows` to `{ start, end }[]` in that SAME mid order. `reviewClipsRef` mirrors it (effect ~L1982) and feeds the auto-skip handler.
- `handleVideoTimeUpdate` (page.tsx ~L1199–1282) is the bug site: forward-only `while (t > clips[idx].end - 0.05)` walk, seek-to-`clips[idx].start`, a `seeked = t<prev-0.4 || t>prev+1` manual-seek detector that its own seeks trip, and a `findIndex` resync that returns the first mid-order match. It assumes `start`/`end` are non-decreasing by index, which is FALSE for mid order (goals +45s, behinds +30s, corners +5s, etc. per `STAT_START_OFFSETS`/`codeTime` in `lib/comparison/xml-compare.ts`).
- IMPORTANT (reduces risk): the timeline ROW HIGHLIGHT does NOT read `reviewIndex`. It is computed directly from the playhead: `masterActive = videoTime >= start && videoTime <= end` (page.tsx ~L3668–3675). So reordering the seek list does NOT affect the highlight — the highlight is already playhead-driven and correct for any order.
- `reviewIndex` is used ONLY for: the Prev/Next buttons via `goToClip(reviewIndex ± 1, reviewSeekTimes)` (page.tsx ~L3575/3588) and the "N / M" counter (~L3585). `reviewSeekTimes = reviewClips.map(c => c.start)` (~L1977), in display order. Prev/Next must keep stepping in DISPLAY order so the counter stays consistent with the visible list.
- The `<video>` binds only `onTimeUpdate={handleVideoTimeUpdate}` (page.tsx ~L3611). No `onSeeking`/`onSeeked` yet.
- The worktree has NO `node_modules`; it must be installed before building/testing (also required so `node_modules/next/dist/docs/` exists per AGENTS.md).

## Design decisions (chosen, with rationale)

1. Keep display order (mid) untouched; introduce a SEPARATE start-sorted seek array. Rationale: the handler's invariant is "start/end non-decreasing by index"; satisfy it with a dedicated array rather than disturbing the engine or the visible list.
2. Carry the display-row index on each seek clip (`{ start, end, rowIndex }`) so the handler can map a seek clip back to its display row and keep `reviewIndex` (Prev/Next cursor + counter) in sync with playback. Rationale: avoids introducing a second index space in the UI; `reviewIndex` stays a display-order index everywhere it's read.
3. Derive the current clip from the playhead each tick via binary search (last clip with `start <= t`), replacing the forward-only drifting walk. Rationale: removes drift and dependence on prior ticks (root-cause fix).
4. Use a `skippingRef` flag plus `onSeeking`/`onSeeked` bindings to distinguish programmatic seeks from user scrubs, instead of the fragile `prev±` delta. Rationale: eliminates the self-seek re-entry oscillation deterministically.
5. Extract ordering + index-from-playhead + nearest-clip as PURE functions in `review-seek.ts` so they are unit-testable without a DOM. Rationale: the brief's verification strategy; the handler becomes a thin wrapper.

---

## Steps

- [ ] 1. Install dependencies in the worktree so build/test/docs are available.
      This is a prerequisite for every later verification and for the AGENTS.md Next.js docs rule. No code change.
      Files: none (installs into `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\node_modules`).
      Verify: run `npm install` in `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui`; confirm it exits 0 and that `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\node_modules\.bin\vitest.cmd` and `node_modules\next\dist\docs` now exist.

- [ ] 2. Create the pure-helper module `review-seek.ts` with the ordering, index-from-playhead, and nearest-clip functions.
      Export a `SeekClip` type `{ start: number; end: number; rowIndex: number }` and these pure functions:
        - `buildSeekClips(clips: { start: number; end: number }[]): SeekClip[]` — maps each display clip to `{ start, end, rowIndex: i }`, then returns a COPY sorted by `start` ascending, tie-broken by `end` ascending (stable; preserve input `rowIndex`). Must not mutate the input.
        - `currentSeekIndex(sorted: SeekClip[], t: number): number` — binary search for the LAST clip with `start <= t`; returns that index, or `-1` if `t` is before the first clip's start. (Caller decides whether `t <= end`.)
        - `nextSkipIndex(sorted: SeekClip[], t: number): number` — index of the first clip with `start > t` (binary search), or `sorted.length` if none. Used to find the next gap to skip to.
        - `nearestClipIndex(sorted: SeekClip[], t: number): number` — if a clip's `[start,end]` window contains `t`, return it; otherwise return the clip whose `start` is nearest to `t` (compare the candidate at `nextSkipIndex` and the one before it, pick smaller `|start - t|`; ties go to the earlier index). Returns `-1` only for an empty array.
      All functions are O(log n), pure, no React/DOM imports.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\review-seek.ts`
      Verify: `npx tsc --noEmit` passes (run in the worktree root).

- [ ] 3. Add unit tests `review-seek.test.ts` encoding the report's trace cases.
      Use `import { describe, it, expect } from "vitest"` and import from `./review-seek`. Cover:
        a. Ordering/reshuffle: input display clips with starts `[100,110,130]` whose mids `[102,155,135]` reshuffle display order to P(102)/C(135)/G(155) i.e. input `[{100,104},{130,140},{110,170}]` → `buildSeekClips` returns start-sorted `[{100,104,rowIndex:0},{110,170,rowIndex:2},{130,140,rowIndex:1}]`.
        b. `currentSeekIndex` at `t=104` on that sorted list returns `0` (last start<=104 is the 100 clip), and `t<=end` holds; `nextSkipIndex` at `t=104` returns `1` (clip starting 110) — i.e. the next target is 110, NEVER a backward target.
        c. Monotonic/no-backseek: assert `nextSkipIndex` is non-decreasing as `t` increases across `100→105→111→131`, and that the targeted `start` values are non-decreasing (never yanks backward).
        d. Goal-before-pass case: display clips `[{50,170}/*goal mid95*/, {90,94}/*pass mid92*/]` arrive mid-sorted as pass then goal → input to `buildSeekClips` is `[{90,94},{50,170}]`; result start-sorted is `[{50,170,rowIndex:1},{90,94,rowIndex:0}]`. After playing past the pass (`t=94`), `nextSkipIndex(sorted,94)` returns `2` (length) — there is NO clip starting after 94 — so the handler will NOT seek back to the goal's start 50. Assert this explicitly (the "must not yank the playhead back to 50" case).
        e. `nearestClipIndex`: on sorted `[{100,104},{110,170},{130,140}]`, `t=120` (inside the 110–170 window) → index 1; `t=107` (gap) → nearest start is 110 → index 1; `t=50` (before all) → index 0.
        f. Empty list: `buildSeekClips([])` → `[]`; `currentSeekIndex([],5)` → `-1`; `nearestClipIndex([],5)` → `-1`.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\review-seek.test.ts`
      Verify: `npx vitest --run app/accuracy-compare/review-seek.test.ts` — all new tests pass.

- [ ] 4. Wire the start-sorted seek array into page.tsx and point the handler ref at it.
      After the `reviewClips` memo (~L1953–1975), add `const seekClips = useMemo(() => buildSeekClips(reviewClips), [reviewClips]);` and import `buildSeekClips, currentSeekIndex, nextSkipIndex, nearestClipIndex, type SeekClip` from `./review-seek`. Change `reviewClipsRef` to type `SeekClip[]` (declaration ~L1141) and change the sync effect (~L1982) to `reviewClipsRef.current = seekClips;` with dep `[seekClips]`. Leave `reviewClips`, `reviewSeekTimes`, `videoRows`, and the display render untouched (Prev/Next and the counter keep using display-order `reviewSeekTimes`).
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\page.tsx`
      Verify: `npx tsc --noEmit` passes.

- [ ] 5. Add the self-seek guard ref and bind `onSeeking`/`onSeeked` to the `<video>`.
      Near the other refs (~L1138–1145) add `const skippingRef = useRef(false);`. On the `<video>` element (~L3607–3614) add `onSeeking={() => { skippingRef.current = true; }}` is NOT correct for user scrubs; instead set `skippingRef` to true ONLY when WE assign `currentTime` (step 6), and add `onSeeked={() => { skippingRef.current = false; }}` to clear it once the browser finishes the programmatic seek. Keep `onTimeUpdate={handleVideoTimeUpdate}`. (User scrubs fire `seeking`/`seeked` too but with `skippingRef` false, so they are treated as manual seeks by the handler.)
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\page.tsx`
      Verify: `npx tsc --noEmit` passes.

- [ ] 6. Rewrite the body of `handleVideoTimeUpdate` (~L1199–1282) to use the pure helpers and the guard.
      New logic, in order:
        1. `const t = e.currentTarget.currentTime; setVideoTime(t);` Keep updating `lastTimeRef` for compatibility but do not use `prev±` for seek detection.
        2. `const clips = reviewClipsRef.current; if (clips.length === 0) return;` (now `SeekClip[]`, start-sorted).
        3. If `skippingRef.current` is true, this tick is the result of OUR programmatic seek — early-return WITHOUT seeking again (the `onSeeked` handler clears the flag). This is the self-seek guard (brief item 3).
        4. Compute the current clip from the playhead: `const curSorted = currentSeekIndex(clips, t);` Map to display row for the counter: if `curSorted >= 0` set `const rowIdx = clips[curSorted].rowIndex;` and, when it changed, `reviewIndexRef.current = rowIdx; setReviewIndex(rowIdx);` (keeps Prev/Next cursor + "N / M" in sync with playback, in DISPLAY order). This replaces the forward-only `while` walk (brief item 2). Do NOT setState every tick if unchanged.
        5. `if (!autoSkipRef.current) return;` — auto-skip OFF plays straight through, only the highlight (playhead-driven) and the row cursor advance; NEVER writes `currentTime` (brief item 5).
        6. Gap-skip: `const nextIdx = nextSkipIndex(clips, t);` If `nextIdx >= clips.length`: we're at/after the last clip's start. Only `pause()` if also past the last clip's `end` (so clusters/overlaps play through); otherwise return. If `nextIdx < clips.length`: `const nextStart = clips[nextIdx].start; const GAP = 1;` and only when we are NOT currently inside a clip window (`currentSeekIndex`'s clip has `t > its end`, i.e. real dead air) AND `nextStart > t + GAP`, perform the skip: set `skippingRef.current = true; const v = videoRef.current; if (v) { v.currentTime = Math.max(0, nextStart); lastTimeRef.current = nextStart; v.play().catch(() => {}); }`. Because `clips` is start-sorted, `nextStart` is always `>= t` within GAP tolerance — never backward (brief items 1 & 5, gap behavior preserved and correct).
      Remove the old `seeked`/`findIndex` manual-resync block entirely; manual scrubs are now handled naturally because `currentSeekIndex` recomputes the row cursor from the playhead every tick and the skip only fires on genuine forward gaps.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\page.tsx`
      Verify: `npx tsc --noEmit` passes; `npx vitest --run` passes (helper tests green).

- [ ] 7. Fix the manual-seek resync to pick the nearest-in-time clip (brief item 4).
      The explicit `seeked` branch is removed in step 6; the equivalent behavior (jump the row cursor to where the user scrubbed) is now provided by `currentSeekIndex` each tick. For the case where `t` sits in a gap (no clip contains it), update the row cursor using `nearestClipIndex(clips, t)` so the highlighted/active Prev-Next cursor matches the clip NEAREST in time rather than the first mid-order match. Apply this only when `currentSeekIndex` returns `-1` or its clip's window does not contain `t`.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui\app\accuracy-compare\page.tsx`
      Verify: `npx tsc --noEmit` passes; `npx vitest --run` passes.

- [ ] 8. Confirm untouched behaviors still hold by inspection + build.
      Re-read Prev/Next (`goToClip` ~L1189, buttons ~L3575/3588), `seekVideo` (~L1171), and the row-highlight block (~L3668) to confirm: clicking a timeline row and Prev/Next still seek to the instance `start` in display order; the counter still reads display order; the dispute/flag logic and `lib/comparison/*` are unchanged. No code change unless a regression is found.
      Files: none expected (verification/inspection step).
      Verify: `npm run build` completes successfully (Next.js production build) AND `npx tsc --noEmit` is clean AND `npx vitest --run` passes — all in `c:\Users\AndyDin\reporting-dashboard\.worktrees\video-timeline-fix\reporting-ui`.

## Final acceptance

- `npm run build` succeeds, `npx tsc --noEmit` clean, `npx vitest --run` green.
- Auto-skip ON: playhead advances start-sorted, skipping only genuine forward gaps; never ping-pongs backward (helper tests c/d encode this).
- Auto-skip OFF: plays straight through, highlight/cursor advance only, no `currentTime` writes.
- Row highlight and Prev/Next counter remain correct in display (mid) order.
- Changes confined to `app/accuracy-compare/page.tsx`, `app/accuracy-compare/review-seek.ts`, `app/accuracy-compare/review-seek.test.ts`. No commit, no push.

## Notes / assumptions

- Assumption: binding `onSeeked` to clear `skippingRef` is reliable in the target browsers; a defensive fallback is to also clear `skippingRef` on the first `onTimeUpdate` tick where `skippingRef` was set and `t` is within ~0.5s of the intended `nextStart`. Implement the `onSeeked` path first; add the fallback only if manual testing shows a stuck flag.
- `lastTimeRef` is retained only for minimal churn; the new logic does not depend on it for correctness.
