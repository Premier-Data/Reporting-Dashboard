# Verification note — fix/video-timeline-jumping

Scope of change (first iteration — no `review.json` present):
- `app/accuracy-compare/review-seek.ts` (NEW) — pure helpers: `buildSeekClips`,
  `currentSeekIndex`, `nextSkipIndex`, `nearestClipIndex`, `type SeekClip`.
- `app/accuracy-compare/review-seek.test.ts` (NEW) — 20 unit tests encoding the
  report's trace cases.
- `app/accuracy-compare/page.tsx` — wired a start-sorted seek list into the
  auto-skip handler, playhead-derived index, self-seek guard, nearest-clip
  manual-seek resync. No other files touched. `lib/comparison/*`, `disputes.ts`
  untouched.

## What was fixed (maps to brief items 1–5)

1. **Seek list ordered by start.** New `seekClips` memo
   (`buildSeekClips(reviewClips)`) is start-sorted (then end), each entry
   carries its display `rowIndex`. `reviewClipsRef` is now `SeekClip[]` and the
   handler walks THAT. Display order (reviewClips/videoRows) is unchanged;
   `reviewSeekTimes`, Prev/Next, and the "N / M" counter still use display
   order. Row highlight is already playhead-driven (`videoTime` vs
   start/end, page.tsx ~L3664), so it stays correct regardless of seek order.
2. **Current index from the playhead each tick.** `currentSeekIndex` (binary
   search, last clip with `start <= t`) replaces the forward-only drifting
   `while` walk. The display cursor (`reviewIndex`) is set from the mapped
   `rowIndex`, only when it actually changes.
3. **Self-seek guard.** `skippingRef` set to `true` immediately before we
   assign `currentTime`; the handler early-returns while set; `onSeeked` on the
   `<video>` clears it once the browser finishes the programmatic seek. User
   scrubs leave the flag false and are handled as manual seeks. Replaces the
   fragile `prev±` delta detector.
4. **Manual-seek resync picks nearest-in-time clip.** When the playhead is in a
   gap / before the first clip, the display cursor is set from
   `nearestClipIndex(clips, t)` instead of the first mid-order `findIndex`
   match.
5. **Preserved behavior.** Auto-skip OFF returns before any `currentTime`
   write (only highlight + cursor advance). Gap-skip only fires when the
   playhead is NOT inside a clip window and the next start is > t + GAP(1s);
   because the list is start-sorted the target is never backward. Clicking a
   row / Prev/Next (`seekVideo`/`goToClip`) still seeks to the instance start in
   display order. Dispute/flag logic and the comparison engine untouched.

## Commands run (cwd = worktree root reporting-ui)

- `npm install` → exit 0. `node_modules/.bin/vitest.cmd`, `node_modules/.bin/tsc.cmd`,
  and `node_modules/next/dist/docs` all present afterward.
- `npx tsc --noEmit` → **exit 0, clean** (no type errors).
- `npx vitest --run` → **exit 0. 31 tests passed across 3 files**:
  - `app/accuracy-compare/review-seek.test.ts` — 20 passed (NEW)
  - `lib/comparison/cross-exact.test.ts` — 6 passed
  - `lib/comparison/json-adapter.test.ts` — 5 passed
  No regressions.
- `npm run build` (`next build`, Next.js 16.2.10 Turbopack) → **exit 0.
  Compiled successfully, TypeScript finished, 35/35 static pages generated**
  (including `/accuracy-compare` and `/fixtures`).

## Known env artifacts

- The `/fixtures` static-prerender Supabase-env failure mentioned in the brief
  did NOT occur — `.env.local` and `.env` were present in the worktree, so the
  build generated all pages including `/fixtures` cleanly.
- Build emitted a benign multi-lockfile workspace-root warning (it detected
  `C:\Users\AndyDin\package-lock.json` plus the worktree lockfile). This is an
  environment warning only, not a code failure, and does not affect the build
  result.

## Pure-function test coverage (report trace cases)

- Reshuffle: display `[{100,104},{130,140},{110,170}]` (mids 102/135/155) →
  `buildSeekClips` returns start-sorted `[{100,104,row0},{110,170,row2},
  {130,140,row1}]`. ✓
- At `t=104`: `currentSeekIndex` = 0 (and `t<=end`), `nextSkipIndex` = 1
  (start 110) — next target forward, never backward. ✓
- Monotonic: `nextSkipIndex` and targeted start values non-decreasing across
  `t = 100→105→111→131`. ✓
- Goal-before-pass: display `[pass{90,94}, goal{50,170}]` → start-sorted
  `[{50,170,row1},{90,94,row0}]`; at `t=94` `nextSkipIndex` = length (no
  forward clip) so the handler does NOT yank back to start 50; the playhead at
  94 maps to the goal window. ✓
- `nearestClipIndex`: inside-window → that clip; gap → nearest start; before
  all → first; after all → last. ✓
- Self-seek guard property: re-deriving the index after a forward seek lands on
  the jumped-to clip, never earlier. ✓
- Empty list: `buildSeekClips([])`=[], `currentSeekIndex([],5)`=-1,
  `nearestClipIndex([],5)`=-1. ✓
