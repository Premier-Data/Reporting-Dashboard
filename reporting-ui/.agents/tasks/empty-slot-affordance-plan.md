# Implementation Plan — Empty-slot dispute flag AFFORDANCE (option 1)

Source task: add the missing UI affordance so any permitted user can right-click
the EMPTY "— no entry —" cell of a missed/extra row to open the SAME FlagMenu,
with the dispute anchored to the OPPOSING populated instance. The PERMISSION
change (`canFlagRowPure` / `canFlagRow`) already shipped and is unchanged.

All paths relative to `c:\Users\AndyDin\reporting-dashboard\reporting-ui`.
Commands run on Windows/PowerShell, cwd = that directory.

## Scope guardrails (do NOT violate)
- Edit only `app/accuracy-compare/page.tsx` and, for the one new pure helper,
  `app/accuracy-compare/dispute-permissions.ts` (+ its test
  `app/accuracy-compare/dispute-permissions.test.ts`).
- Do NOT touch `lib/comparison/*`, `lib/api/disputes.ts`, `clubConfig.ts`,
  `clubLogos.ts`, or any unrelated file. No DB change, no disputes-API change.
- Edit in place on the current branch (`feature/empty-slot-dispute-permission`).
  Do NOT commit or push.
- Build: `npm run build` (next build). Test: `npm test` or `npx vitest --run`;
  scoped: `npx vitest --run app/accuracy-compare/dispute-permissions.test.ts`.
- This is client-side React/TypeScript only; no Next.js API/config change is
  expected. If `npm run build` surfaces a Next.js API/config error, read
  `node_modules/next/dist/docs/` before changing any Next.js API (per AGENTS.md).

## Verified facts the plan relies on (read from the code)
- `TimelineCell` (defined ~line 4075 in `app/accuracy-compare/page.tsx`) takes
  `{ instance, delta?, onSeek?, active?, flagged?, onFlag?, onEdit?, teamLabel? }`.
  When `instance == null` it early-returns an inert placeholder
  (`<div className="border-l border-slate-200 px-2 py-1"><span ...>— no entry —</span></div>`)
  that ignores `onFlag`, `flagged`, and `title`. The populated branch wires
  `onContextMenu={onFlag}`, applies `flagged ? "ring-2 ring-inset ring-amber-500"`,
  shows a `<Flag>` icon when `flagged`, and builds a `title` string.
- The review-pane loop is `videoRows.map((row, i) => { ... })` (~line 3650).
  In scope per row: `row` (`row.status`, `row.master`, `row.analyst`,
  `row.timeDelta`), `masterInstance`/`analystInstance` (the FILTER-ADJUSTED
  sides — null when the active stat/player filter hides that side), and the
  helpers `teamDisplay`, `seekVideo`, `editMasterInstance`, `canEditMaster`.
- The two `TimelineCell` call sites are ~lines 3715 (master) and ~3752 (analyst).
  Each already passes `flagged={!!<side>Instance && flaggedKeys.has(disputeKey(<side>Instance.id, "<side>"))}`
  and `onFlag={(canFlagRow(row.status) || canResolveDispute) && <side>Instance ? (e) => openFlagMenu(e, <side>Instance, "<side>", row.status) : undefined}`.
- `openFlagMenu(e, instance: Instance, side: DisputeSide, status: MatchStatus)`
  (~line 1332) computes `allowFlag = canFlagRow(status)`,
  `allowResolve = canResolveDispute && isFlagged`, returns early if neither, else
  `e.preventDefault()` and `setFlagMenu({ x, y, instance, side })`. It is anchor-
  agnostic: whatever `(instance, side)` it is handed becomes the dispute anchor.
- `canFlagRow(status)` (~line 970) wraps `canFlagRowPure`; `canResolveDispute`
  (~line 961) is admin/super_admin only. Both are unchanged by this task.
- `flaggedKeys` (~line 1128) is a `Map<string, Dispute>` keyed by
  `disputeKey(instanceId, side)`. `disputeKey` and `DisputeSide` are already
  imported from `@/lib/api/disputes`.
- `dispute-permissions.ts` already exports `isEmptySlotStatus` and
  `canFlagRowPure`; `page.tsx` imports `canFlagRowPure` from `./dispute-permissions`
  (line ~77). Its test file uses `describe/it/expect` from `vitest`,
  `import type { MatchStatus } from "@/lib/comparison/xml-compare"`, and runs in
  jsdom. `MatchStatus` is already imported in `page.tsx`.
- On a `missed` row `row.master` is non-null and `row.analyst` is null; on an
  `extra` row `row.analyst` is non-null and `row.master` is null. A row with
  BOTH sides null is never produced. (From the design doc, verified against the
  matching-engine contract.)

## Design decisions recorded for the implementer

- Decision 1 — ANCHOR SOURCE: the empty cell's dispute must anchor to the
  OPPOSING populated instance. Use the RAW `row.master`/`row.analyst`, NOT the
  filter-adjusted `masterInstance`/`analystInstance`, for the opposing anchor.
  Rationale: the opposing side of a missed/extra row is always populated in the
  raw row; the filter-adjusted var can be null when a stat/player filter is
  active, which would wrongly suppress the affordance even though the dispute
  target exists. `canFlagRow(row.status)` already gates permission off the
  filter-independent status, so the raw opposing instance is the correct anchor.
- Decision 2 — WHICH SIDE IS EMPTY: on a `missed` row the ANALYST cell is empty
  and the anchor is `row.master` with `side="master"`; on an `extra` row the
  MASTER cell is empty and the anchor is `row.analyst` with `side="analyst"`.
  The populated side keeps its existing `onFlag` untouched; both cells therefore
  open the SAME menu anchored to the SAME opposing/populated instance.
- Decision 3 — EXTRACT A PURE HELPER (yes). Extract a tiny pure function
  `emptyCellAnchor(status, { master, analyst })` into `dispute-permissions.ts`
  that returns the opposing `{ instance, side }` (or null) for an empty-slot
  row. It is a pure, status-driven mapping that is easy to get subtly wrong
  (which side is empty, which instance to anchor), the test harness already
  exists, and centralising it keeps both call sites consistent. Keep it in
  `dispute-permissions.ts` (the only in-scope non-page file) — a plain `.ts`
  under `app/` is not a route segment, so it is App-Router-safe.
- Decision 4 — TimelineCell SIGNATURE: extend `TimelineCell` with ONE optional
  prop, `emptyFlag?: { onFlag: (e: React.MouseEvent) => void; flagged: boolean; title: string }`,
  used ONLY by the `instance == null` branch. Rationale: the populated branch
  already has `onFlag`/`flagged`/`title`; threading a separate object for the
  empty branch keeps the populated path byte-for-byte unchanged and makes the
  empty-cell affordance explicit and self-contained. When `emptyFlag` is
  undefined the empty cell renders exactly the current inert placeholder.
  (A single `onFlag`+`flagged` pair reused across both branches is the
  alternative; it is rejected because the empty cell needs a DIFFERENT title and
  must stay inert unless explicitly made flaggable, and because the populated
  branch's `onFlag` is tied to its own instance — mixing them risks regressions
  in the populated path.)

---

- [ ] 1. Add the pure opposing-anchor helper to `dispute-permissions.ts`.
      Add `export const emptyCellAnchor = (status, sides): { instance; side } | null`.
      Signature:
      `emptyCellAnchor(status: MatchStatus, sides: { master: Instance | null; analyst: Instance | null }): { instance: Instance; side: DisputeSide } | null`.
      Behaviour: return `null` unless `isEmptySlotStatus(status)`; for `"missed"`
      return `{ instance: sides.master, side: "master" }` when `sides.master` is
      non-null else `null`; for `"extra"` return `{ instance: sides.analyst, side: "analyst" }`
      when `sides.analyst` is non-null else `null`. This defensively returns null
      if the expected populated side is somehow absent (honours the "never flag
      when both sides null" guard). Import the needed types with a type-only
      import: `import type { Instance } from "@/lib/comparison/xml-compare"` and
      `import type { DisputeSide } from "@/lib/api/disputes"` (type-only — do not
      modify those modules). Add a short doc comment: for a missed/extra row this
      returns the OPPOSING populated instance the empty cell's dispute anchors to.
      Files: `app/accuracy-compare/dispute-permissions.ts`
      Verify: covered by the test in step 2 and the build in step 7; no runtime
      behaviour changes until page.tsx uses it.

- [ ] 2. Unit-test `emptyCellAnchor`.
      Extend `app/accuracy-compare/dispute-permissions.test.ts` with a new
      `describe("emptyCellAnchor")` block. Build two minimal `Instance` fixtures
      (`master` / `analyst`) — only the fields the helper reads (`id`) need real
      values; cast a small literal `as Instance` to avoid depending on the full
      shape, mirroring the existing test's lightweight style. Cover: (a) `missed`
      with both sides present → `{ instance: master, side: "master" }`;
      (b) `extra` with both present → `{ instance: analyst, side: "analyst" }`;
      (c) every FULLY_POPULATED status → `null`; (d) `missed` with
      `master: null` → `null`; (e) `extra` with `analyst: null` → `null`;
      (f) both sides null for `missed`/`extra` → `null`.
      Files: `app/accuracy-compare/dispute-permissions.test.ts`
      Verify: `npx vitest --run app/accuracy-compare/dispute-permissions.test.ts`
      — new tests pass and the existing `canFlagRowPure`/`isEmptySlotStatus`
      tests still pass.

- [ ] 3. Import `emptyCellAnchor` into `page.tsx`.
      Add `emptyCellAnchor` to the existing
      `import { canFlagRowPure } from "./dispute-permissions";` (line ~77),
      making it `import { canFlagRowPure, emptyCellAnchor } from "./dispute-permissions";`.
      Files: `app/accuracy-compare/page.tsx`
      Verify: covered by the build in step 7 (no behavioural change yet).

- [ ] 4. Extend `TimelineCell` to support a flaggable empty cell.
      In the prop type (~line 4082) add `emptyFlag?: { onFlag: (e: React.MouseEvent) => void; flagged: boolean; title: string };`
      and destructure `emptyFlag` in the params. In the `if (!instance)` branch
      (~line 4096): when `emptyFlag` is provided, render the placeholder with the
      affordance — add `onContextMenu={emptyFlag.onFlag}`, a `title={emptyFlag.title}`,
      a hover/interactive style (`cursor-context-menu hover:bg-amber-50/60` added
      to the existing `border-l border-slate-200 px-2 py-1`), the amber flagged
      ring when `emptyFlag.flagged` (`ring-2 ring-inset ring-amber-500`), and a
      small `<Flag size={10} className="fill-amber-500 text-amber-600" />` next to
      the "— no entry —" text when `emptyFlag.flagged`. When `emptyFlag` is
      undefined, render EXACTLY the current inert placeholder (no handlers, no
      title, no hover). Do NOT make the empty cell seekable (no `onClick`/
      `onSeek`). Leave the entire populated branch (`instance != null`)
      byte-for-byte unchanged.
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` (combined with step 5–6) — type-checks; empty cells
      without `emptyFlag` are unchanged.

- [ ] 5. Wire the MASTER `TimelineCell` call site for the Extra-row empty master cell.
      At the master `TimelineCell` (~line 3715), add an `emptyFlag` prop computed
      once per row. Compute `const anchor = emptyCellAnchor(row.status, { master: row.master, analyst: row.analyst });`
      near the top of the row body (step 6 reuses it for the analyst cell).
      Pass `emptyFlag` to the master cell ONLY when the master side is the empty
      one and permitted:
      `emptyFlag={!masterInstance && !row.master && anchor && anchor.side === "analyst" && (canFlagRow(row.status) || canResolveDispute) ? { onFlag: (e) => openFlagMenu(e, anchor.instance, anchor.side, row.status), flagged: flaggedKeys.has(disputeKey(anchor.instance.id, anchor.side)), title: "right-click to dispute this extra event" } : undefined}`.
      Rationale: an Extra row has `row.master == null` (so the master cell is the
      empty one) and `anchor.side === "analyst"` (the opposing populated side);
      the populated master branch is unreachable here because `masterInstance` is
      null. Do NOT change the existing `onFlag` on the populated path — it still
      runs when `masterInstance` is non-null.
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` (with steps 4 & 6).

- [ ] 6. Wire the ANALYST `TimelineCell` call site for the Missed-row empty analyst cell.
      At the analyst `TimelineCell` (~line 3752), pass `emptyFlag` ONLY when the
      analyst side is the empty one and permitted, reusing `anchor` from step 5:
      `emptyFlag={!analystInstance && !row.analyst && anchor && anchor.side === "master" && (canFlagRow(row.status) || canResolveDispute) ? { onFlag: (e) => openFlagMenu(e, anchor.instance, anchor.side, row.status), flagged: flaggedKeys.has(disputeKey(anchor.instance.id, anchor.side)), title: "right-click to dispute this missing event" } : undefined}`.
      Rationale: a Missed row has `row.analyst == null` and `anchor.side === "master"`.
      This anchors the dispute to `row.master` with `side="master"` — the same
      anchor the populated master cell uses — so both cells open the same menu.
      Leave the existing analyst-side `onFlag` on the populated path unchanged.
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` completes with no type errors.

- [ ] 7. Full build + test pass and UI reasoning.
      Run `npm run build` and `npx vitest --run`. Confirm no type errors and no
      test regressions (existing `dispute-permissions.test.ts` plus any
      `lib/comparison/*.test.ts`). Then reason through and record each UI case
      against the final code:
      (a) MISSED row, permitted user: analyst cell is empty, `emptyFlag` set,
      right-click → `openFlagMenu(e, row.master, "master", "missed")` →
      `canFlagRow("missed")` passes → FlagMenu opens; submit → `createDispute`
      upserts on `(check_id, row.master.id, "master")`.
      (b) EXTRA row, permitted user: master cell empty, `emptyFlag` set,
      right-click → anchor `row.analyst`, `side="analyst"` → dispute on the
      analyst instance.
      (c) FLAGGED state: once the opposing dispute exists,
      `flaggedKeys.has(disputeKey(anchor.instance.id, anchor.side))` is true, so
      the empty cell shows the amber ring + Flag icon (mirrors the populated
      cell).
      (d) POPULATED-side right-click still works: its `onFlag` is unchanged and
      opens the same menu for the same anchor.
      (e) LOGGED-OUT user: `canFlagRow` false and `canResolveDispute` false →
      `emptyFlag` is undefined → empty cell stays the inert "— no entry —" with
      no `onContextMenu`/title/hover.
      (f) RESOLVE stays admin-only: `openFlagMenu`'s `allowResolve` and the
      `FlagMenu` `mode` are untouched; a non-admin empty-cell flagger gets
      `mode === "flag"`.
      (g) DEFENSIVE: `emptyCellAnchor` returns null when the opposing side is
      absent, so `emptyFlag` is never wired with a null instance (both-null and
      filtered-populated-row cases are safe).
      Files: none (verification only).
      Verify: `npm run build` succeeds; `npx vitest --run` all green.

## Notes / assumptions
- `anchor` is computed once per row (step 5) and reused by both cells (steps 5–6)
  to avoid double computation; it is a cheap pure call.
- The empty-cell `emptyFlag.flagged` uses the OPPOSING instance's key, so a
  flagged Missed row shows the flag on BOTH the master cell and the (empty)
  analyst cell — the intended discoverability improvement.
- No `useMemo` is needed; `emptyCellAnchor` is a trivial pure call in render,
  matching the existing `canFlagRow` pattern.
- If `npm run lint` runs in CI it may be run after step 7, but it is not part of
  this task's required verification.

## Verification note (iteration 1 — implemented)

Commands run (Windows/PowerShell, cwd = `c:\Users\AndyDin\reporting-dashboard\reporting-ui`):
- `npx vitest --run app/accuracy-compare/dispute-permissions.test.ts` → 13 passed
  (6 existing `canFlagRowPure`/`isEmptySlotStatus` + 7 new `emptyCellAnchor`).
- `npx vitest --run` (full suite) → 24 passed across 3 files, no regressions
  (`dispute-permissions`, `cross-exact`, `json-adapter`).
- `npm run build` (Next.js 16.2.10, Turbopack) → "Compiled successfully",
  TypeScript finished with no type errors, all 35 static pages generated,
  exit code 0.

What changed:
- `dispute-permissions.ts`: added pure `emptyCellAnchor(status, { master, analyst })`
  returning the OPPOSING populated `{ instance, side }` for missed/extra, else null.
- `dispute-permissions.test.ts`: added `describe("emptyCellAnchor")` with 7 cases
  (missed→master, extra→analyst, all fully-populated→null, missing-side→null,
  both-null→null).
- `page.tsx`: imported `emptyCellAnchor`; extended `TimelineCell` with an optional
  `emptyFlag` prop used ONLY by the `instance == null` branch (adds
  `onContextMenu`, `title`, `cursor-context-menu hover:bg-amber-50/60`, amber ring
  + `<Flag>` icon when flagged); computed `emptyAnchor`/`emptyFlagAllowed` once per
  review row and wired `emptyFlag` onto the master cell (Extra row, anchor side
  "analyst") and the analyst cell (Missed row, anchor side "master"). Populated
  branch and existing `onFlag` paths left unchanged.

UI case reasoning against the final code:
- (a) MISSED row, permitted user: analyst cell has `instance == null`,
  `emptyAnchor = { row.master, "master" }`, `emptyFlagAllowed` true →
  `emptyFlag` set → right-click → `openFlagMenu(e, row.master, "master", "missed")`
  → `allowFlag = canFlagRow("missed")` true → FlagMenu opens; submit →
  `createDispute` upserts on `(check_id, row.master.id, "master")`. ✓
- (b) EXTRA row, permitted user: master cell empty, `emptyAnchor = { row.analyst,
  "analyst" }` → dispute on the analyst instance, side "analyst". ✓
- (c) FLAGGED state: `emptyFlag.flagged =
  flaggedKeys.has(disputeKey(emptyAnchor.instance.id, emptyAnchor.side))`, so once
  the opposing dispute exists the empty cell shows the amber ring + Flag icon,
  mirroring the populated cell. A flagged Missed row shows the flag on both the
  master cell and the empty analyst cell. ✓
- (d) POPULATED-side right-click: existing `onFlag` on the populated branch is
  untouched; it opens the same menu for the same opposing/populated anchor. ✓
- (e) LOGGED-OUT: `canFlagRow` and `canResolveDispute` both false →
  `emptyFlagAllowed` false → `emptyFlag` undefined → empty cell renders the inert
  "— no entry —" with no `onContextMenu`/title/hover. ✓
- (f) RESOLVE stays admin-only: `openFlagMenu`'s `allowResolve = canResolveDispute
  && isFlagged` and the FlagMenu `mode` are untouched; a non-admin empty-cell
  flagger gets flag mode only. ✓
- (g) DEFENSIVE: `emptyCellAnchor` returns null when the opposing side is absent
  (both-null guard) and the call sites also require `!row.master`/`!row.analyst`
  plus `emptyAnchor.side` matching the empty side, so `emptyFlag` is never wired
  with a null instance; using RAW `row.master`/`row.analyst` keeps the affordance
  present under an active stat/player filter. ✓
