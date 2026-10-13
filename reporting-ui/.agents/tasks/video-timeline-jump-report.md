# Video-review timeline "random jumping" — findings report

READ-ONLY investigation. No code was changed. No server was restarted. A throwaway
headless-driving probe was NOT run because no browser automation (Playwright/Puppeteer)
is installed in this repo (see "Evidence basis" below); the diagnosis is a rigorous
control-flow read of the handler and every ref/state/array it depends on, with a
concrete numeric trace.

---

## 1. Summary answer (root cause)

The jumping is caused by **Hypothesis 2 — a sort/field mismatch — amplified by the
forward-only index walk and the in-handler self-seek (parts of Hypotheses 1 and 3).**

Concretely:

- The review clip list (`reviewClips`) is built in **row order**, and the rows are
  sorted by **`mid`** (the per-stat "code time"), **not** by `start`.
  (`lib/comparison/xml-compare.ts:1225-1230` sorts `rows` by `master?.mid ?? analyst?.mid`;
  `app/accuracy-compare/page.tsx:1967-1990` maps those same rows to `{start, end}`.)
- But the auto-skip handler **seeks to `clips[idx].start`** and advances the index by
  comparing the playhead against **`clips[idx].end`**
  (`app/accuracy-compare/page.tsx:1245-1272`).
- `mid` is **not** `(start+end)/2` for many stats. `codeTime()` adds large per-stat
  offsets — up to **+45 s for a goal** and **+30 s for a behind**, plus +5…+9 s for
  corners/bounces/throw-ins/turnovers and ±2 s for touches/fouls/saves
  (`lib/comparison/xml-compare.ts:142-190`, `codeTime` at `201-227`).

Because `mid` carries variable offsets, **ordering rows by `mid` does not order their
`start` (or `end`) values monotonically.** So the clip array the handler walks is
"sorted" by a field it never uses for seeking. On a `timeupdate` tick the handler can
therefore pick a `clips[idx].start` that lies **behind or far ahead of** the current
playhead and slam `video.currentTime` to it, then the next tick picks another
out-of-order clip — the playhead ping-pongs. That is the "jumps to seemingly unrelated
positions" symptom.

This is **scoped to `autoSkip` being ON** (default `true`). With auto-skip off the
handler returns before any seek (`page.tsx:1257 if (!autoSkipRef.current) return;`), so
it only updates the row highlight and the video plays straight through. **Turning
auto-skip off stops the jumping** — which both confirms the diagnosis and gives the user
an immediate workaround.

---

## 2. The exact code paths

### 2a. How the clip list is ordered (by `mid`, not `start`)

`result.rows` is produced by `compareInstances` and sorted on the midpoint:

```
// lib/comparison/xml-compare.ts  (~1225)
rows.sort((r1, r2) => {
  const t1 = r1.master?.mid ?? r1.analyst?.mid ?? 0;
  const t2 = r2.master?.mid ?? r2.analyst?.mid ?? 0;
  return t1 - t2;
});
```

`Instance.mid` is the **code time**, deliberately offset from `start`:

```
// lib/comparison/xml-compare.ts  (~201)
export function codeTime(stat, start, end) {
  const rule = STAT_START_OFFSETS.find(...);
  if (rule) return start + rule.offset;   // e.g. goal => start + 45
  const mid = (start + end) / 2;
  if (s.includes("shot saved")) return mid - 2;
  if (touch/foul/claim/save)   return mid + 2;
  return mid;
}
```

`STAT_START_OFFSETS` (`xml-compare.ts:142-190`) includes:
`corner +5`, `uncontested mark +5`, `ball up +9`, `centre bounce +6`, `throw in +7`,
`kick in +6`, `turnover +7`, `effective/ineffective kick +5`, `rushed behind +6`,
**`behind +30`**, **`goal +45`**.

`videoRows` just filters `result.rows` and preserves that `mid` order
(`page.tsx:1869-1925` — plain `.filter(...)`, no re-sort). `reviewClips` then maps each
row to its window using **`start`/`end`**:

```
// app/accuracy-compare/page.tsx  (~1967)
const reviewClips = useMemo(() => {
  ...
  return videoRows.map((row) => {
    const inst = m ?? a;
    return { start: inst?.start ?? 0, end: inst?.end ?? 0 };
  });
}, [videoRows, reviewPlayer, videoStatFilter, sportConfig]);
```

So `reviewClips[i].start` is in **`mid`-sorted order**, which is not `start`-monotonic.

### 2b. The handler walks the list forward-only, keyed on `end`, and seeks to `start`

```
// app/accuracy-compare/page.tsx  (~1212)
const t = e.currentTarget.currentTime;
const prev = lastTimeRef.current;
lastTimeRef.current = t;
...
const clips = reviewClipsRef.current;           // mid-sorted {start,end}[]
...
let idx = reviewIndexRef.current;
while (idx < clips.length && t > clips[idx].end - 0.05) {  // (A) end-keyed, forward-only
  idx += 1;
}
if (idx !== reviewIndexRef.current) { reviewIndexRef.current = idx; setReviewIndex(...); }

if (!autoSkipRef.current) return;               // (B) off => no seek, plays through
...
const GAP = 1;
const nextStart = clips[idx].start;             // (C) seeks to START
if (nextStart > t + GAP) {
  v.currentTime = Math.max(0, nextStart);       // (D) the jump
  lastTimeRef.current = nextStart;
  v.play().catch(() => {});
}
```

Three independent problems live in this block:

1. **(A) assumes `end` increases with index.** It does not (it's `mid`-sorted). After a
   goal row (long window, late `end`) the next row's `end` may be *smaller*, so the
   `while` loop stops too early (or too late), leaving `idx` pointing at a clip whose
   `start` is nowhere near the playhead.
2. **(C/D) seeks to `start` of a `mid`-ordered neighbour.** `clips[idx].start` can be
   well behind the current `t`. The guard `nextStart > t + GAP` only blocks *backward or
   tiny-forward* seeks; a clip ordered later by `mid` but with a `start` **far ahead**
   (e.g. a goal whose `start` is 45 s before its `mid`) passes the guard and yanks the
   playhead forward to an unrelated spot.
3. **(D) is a self-seek inside `onTimeUpdate`.** Setting `currentTime` fires another
   `timeupdate`. The code tries to suppress re-entry with `lastTimeRef.current = nextStart`,
   but the very next organic tick re-evaluates `clips[idx]` against the same mis-ordered
   array and can seek again — an oscillation (Hypothesis 3 contributes, but it is a
   *consequence* of the ordering bug, not the primary cause).

### 2c. The "manual seek" detector misfires on the auto-seeks it causes

```
// app/accuracy-compare/page.tsx  (~1230)
const seeked = t < prev - 0.4 || t > prev + 1;
```

Any auto-skip in 2b moves `currentTime` by more than 1 s, so the *next* tick is
classified as a user "seek". That branch re-syncs `reviewIndexRef` by scanning the
`clips` array for a window containing `t`:

```
let synced = clips.findIndex((c) => t >= c.start && t <= c.end);
if (synced === -1) { synced = clips.findIndex((c) => c.start >= t); ... }
```

`findIndex` returns the **first** array match in `mid` order — again not the nearest in
time — so the resynced index can point at an earlier clip, feeding the next tick a
backward target. User scrubbing and auto-skip genuinely fight each other here, but the
loop is self-sustaining even with no user input because auto-skip's own seeks trip the
"seeked" detector.

---

## 3. Concrete trace of a jump

Filtered review list (football) containing, in capture order by `start`:

| row | stat   | start | end | mid (code time)        |
|-----|--------|-------|-----|------------------------|
| P   | Pass   | 100   | 104 | 102  (= (100+104)/2)   |
| G   | Goal   | 110   | 170 | 155  (= 110 + 45)      |
| C   | Corner | 130   | 140 | 135  (= 130 + 5)       |

Sorted by **`mid`** (how the rows/clips actually come out): **P(102), C(135), G(155)**.
So `reviewClips = [ {100,104}, {130,140}, {110,170} ]` — index 2's `start=110` is
**earlier** than index 1's `start=130`. The array is not `start`-monotonic.

Playback with auto-skip ON, starting at the Pass:

1. `t≈104`, `idx=0`. `while`: `104 > 104-0.05` → `idx=1` (clip C). `nextStart=130`,
   `130 > 104+1` → **seek to 130** (skip dead air to the corner). Fine so far.
2. `t≈130`→ next organic tick `t≈130.3`, but the previous tick jumped so `seeked` is
   true → resync. `findIndex(window contains 130.3)` → clip C (idx 1). OK, keep playing.
3. `t≈140`, `idx=1`. `while`: `140 > 140-0.05` → `idx=2` (clip **G**). `nextStart =
   clips[2].start = 110`. Guard `110 > 140+1`? No — so **no forward seek**… but the row
   highlight now claims we're in the Goal clip while we're at t≈140, and `idx` is parked
   at 2 whose window is `[110,170]`.
4. Playback continues to `t≈141`. `while`: `141 > clips[2].end-0.05 = 169.95`? No. `idx`
   stays 2. We now sit "inside" the goal window numerically, so the handler will **not**
   skip the ~29 s of real dead air between the corner and the goal's actual code moment —
   the opposite failure (it drags through gaps it was meant to skip).

Now the symmetric case that produces the *visible backward jump*. Suppose instead the
goal's `start` is the earliest in the list but its `mid` sorts it last:

| row | stat | start | end | mid         |
|-----|------|-------|-----|-------------|
| G   | Goal | 50    | 170 | 95 (50+45)  |
| P   | Pass | 90    | 94  | 92          |

Sorted by `mid`: **P(92), G(95)** → `reviewClips = [ {90,94}, {50,170} ]`.
Play from the Pass: at `t≈94`, `idx=0`, `while` advances to `idx=1` (Goal). `nextStart =
clips[1].start = 50`. Guard `50 > 94+1`? No, so this particular tick won't seek — **but**
the "seeked" resync in step 2c can land `idx` on the Goal clip while `t` is small, and on
the next pass the handler compares against `clips[idx].end=170` and treats the whole
`[50,170]` span as "current," so clicking a Prev/Next or any resync drops the playhead
back toward 50. Across a real filtered list with dozens of goals/behinds/corners
interleaved with normal stats, these forward-and-backward mis-targets alternate tick to
tick, which is exactly the "jumping randomly" the user reports.

**Key invariant that is violated:** the handler assumes
`clips[i].start` and `clips[i].end` are **non-decreasing in i**. They are only
non-decreasing in `mid`. Any stat with a nonzero `codeTime` offset breaks the invariant,
and goals (+45) / behinds (+30) break it dramatically.

---

## 4. The responsible state / refs / logic

- `reviewClips` / `reviewClipsRef` — built from `mid`-sorted `videoRows`, carrying
  `{start,end}` that are not sorted by `start`/`end`
  (`page.tsx:1967-1997`, feeding from `xml-compare.ts:1225`).
- `handleVideoTimeUpdate` — `page.tsx:1212-1278`:
  - forward-only `while (t > clips[idx].end - 0.05)` index walk (`1245-1252`),
  - seek-to-`start` auto-skip `v.currentTime = Math.max(0, nextStart)` (`1271-1276`),
  - self-seek inside `onTimeUpdate` with a weak re-entry guard (`lastTimeRef`),
  - the `seeked = t < prev-0.4 || t > prev+1` detector that its own seeks trigger
    (`1230-1241`), re-syncing via `findIndex` (first `mid`-order match, not nearest).
- `reviewIndexRef` — only ever advanced forward during steady playback; never
  recomputed from the true playhead against a correctly-ordered list, so it drifts
  (Hypothesis 1 contributes once the ordering bug sends it to a wrong clip).

Hypotheses **4** (array identity churn) and **5** (GAP off-by-one) are **not** the root
cause: `reviewClips` is memoised and only changes identity when a filter changes
(`page.tsx:1967-1990`), and `reviewIndex` is intentionally reset to 0 only on scope
change (`page.tsx:1857-1859`); the GAP guard behaves as written. The defect is the field
the list is **ordered by** versus the field the handler **seeks/compares** on.

---

## 5. Recommended fix (not implemented)

Primary (fixes the root cause):

1. **Order the clips by the field you actually seek on.** Either sort `reviewClips`
   by `start` ascending, or (cleaner) derive a dedicated, memoised array that is
   guaranteed `start`-monotonic and keep it separate from the `mid`-sorted display rows.
   Keep the timeline *display* sorted by `mid` if desired, but the **seek list must be
   sorted by `start`**. This single change restores the invariant the handler assumes.
2. **Compute the current clip index from the real playhead each tick** instead of
   walking a drifting `reviewIndexRef`: binary-search the sorted `start` array for the
   last clip with `start <= t` (and verify `t <= end`). This removes the forward-only
   drift and the dependence on prior ticks entirely.
3. **Guard the self-seek so it can't retrigger a skip.** Set a `skippingRef`/`isSeeking`
   flag before assigning `currentTime`, clear it on the next tick (or on an `onSeeked`
   handler), and early-return from the auto-skip branch while it is set. Right now there
   is only `onTimeUpdate` bound (`page.tsx:3628`); adding `onSeeking`/`onSeeked` lets you
   distinguish programmatic seeks from user scrubs cleanly instead of inferring from the
   `prev±` delta.

Secondary:

4. **Fix the manual-seek resync** to pick the clip **nearest in time** to `t`, not the
   first `mid`-order match (`page.tsx:1234-1239`). Once the list is `start`-sorted a
   binary search gives the correct nearest clip.
5. **Gate/debounce auto-skip while the user is scrubbing** so a user seek is honoured for
   a few hundred ms before auto-skip may fire again — removes the user-vs-auto fight even
   in edge cases.

Note the two-sided nature once (1) lands: ordering by `start` fixes the *random* jumps
and also makes the gap-skipping correct (it currently both over-jumps and under-skips
depending on how `mid` reshuffles neighbours).

---

## 6. autoSkip scoping (confirmation)

- Default is ON: `const [autoSkip, setAutoSkip] = useState(true)` (`page.tsx:1149`),
  mirrored into `autoSkipRef` (`page.tsx:1153`, synced at `1162-1164`).
- The entire seek path is behind `if (!autoSkipRef.current) return;` (`page.tsx:1257`).
  With auto-skip OFF the handler only sets `videoTime` and advances the highlight index;
  it **never** writes `currentTime`, so the video cannot jump.
- Therefore the bug is **entirely attributable to the auto-skip seek logic**, and
  toggling auto-skip off is a valid immediate workaround while the fix is made. This
  scopes the fix to the clip-ordering + the auto-skip branch of `handleVideoTimeUpdate`.

---

## Evidence basis

- No headless browser (Playwright or Puppeteer) is installed in
  `reporting-ui/node_modules`, so execution-based observation of `currentTime` on the
  running port-3000 app was not possible. Per the brief, the fallback is a rigorous
  control-flow read, provided above with a numeric trace. The dev server on port 3000 was
  left untouched; no probe files were created.
- All line references are from the files read during this investigation:
  `app/accuracy-compare/page.tsx` and `lib/comparison/xml-compare.ts`
  (midpoint sort also mirrored in `lib/comparison/json-adapter.ts:291`). Line numbers are
  approximate anchors from the current file state.
