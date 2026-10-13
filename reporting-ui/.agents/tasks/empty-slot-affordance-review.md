# Empty-slot dispute affordance for missed/extra timeline cells

Any logged-in, permitted user can now right-click the empty "— no entry —" cell of a missed or extra row in the accuracy-compare video-review pane and raise a dispute. Because the dispute data model anchors every dispute to an existing instance/side, the empty cell's flag attaches to the OPPOSING populated instance: a Missed row's empty analyst cell anchors to the master instance with `side="master"`, and an Extra row's empty master cell anchors to the analyst instance with `side="analyst"`. The work is confined to a new pure helper (`emptyCellAnchor`) in `dispute-permissions.ts`, its unit test, and the two `TimelineCell` call sites plus one new optional `emptyFlag` prop on `TimelineCell` in `page.tsx`. No DB, disputes-API, or dispute-kind changes.

Watch for: nothing blocking. The opposing-anchor mapping, permission gating, both-null defense, and flagged-ring visual are all correct and the populated path is untouched. One minor UX nuance (confirmed): a flagged missed/extra row now paints the amber ring on BOTH the populated cell and the empty cell — this is the intended discoverability behavior per the plan, not a bug.

**Verdict**: APPROVED

## High-level view

The anchor selection is driven by a single pure function. `emptyCellAnchor(status, { master, analyst })` returns `{ master, "master" }` for `missed`, `{ analyst, "analyst" }` for `extra`, and `null` for every fully-populated status or when the expected populated side is somehow absent. That mapping matches the data-model contract (a dispute must attach to a real instance) and the "never flag when both sides null" guard falls straight out of the null returns.

Permission and existence gating is layered correctly. `emptyFlagAllowed` requires a non-null anchor AND (`canFlagRow(row.status)` OR `canResolveDispute`), reusing the exact predicates the populated path uses. Each call site adds its own side-match guard (`emptyAnchor.side === "analyst"` on the master cell, `=== "master"` on the analyst cell) plus `!instance && !rawSide`, so the empty affordance only wires up on the genuinely-empty side with a real opposing anchor. A logged-out user fails `canFlagRow` and `canResolveDispute`, so `emptyFlag` is undefined and the cell renders the original inert placeholder.

The anchor deliberately reads the RAW `row.master`/`row.analyst` rather than the filter-adjusted `masterInstance`/`analystInstance`. This keeps the affordance available when a stat/player filter blanks a side, which is correct because permission is gated on the filter-independent `row.status`.

The flagged-state visual uses `flaggedKeys.has(disputeKey(opposingInstance.id, opposingSide))`, so the empty cell shows the amber ring and Flag icon exactly when the opposing dispute exists — the same key the populated cell uses.

The populated path is untouched: its `onFlag`, `flagged`, `title`, seek behavior, and the admin-only resolve gate (`canResolveDispute && isFlagged` inside `openFlagMenu`) are all unchanged. The empty cell gets `onContextMenu` and a title but no `onClick`/`onSeek`, so it is not made seekable.

<details>
<summary>Issues (1)</summary>

1. **Dual amber ring on flagged empty-slot rows** (informational, intended) — a flagged missed/extra row paints the amber ring on both the populated cell and the empty cell because both derive `flagged` from the same opposing dispute key. The plan calls this out as the intended discoverability improvement; no action needed.

</details>

<details>
<summary>Details</summary>

## Opposing-anchor selection

`emptyCellAnchor` is the single source of truth for which instance an empty cell's dispute targets:

```
missed  -> analyst slot empty -> { instance: master,  side: "master"  }
extra   -> master slot empty  -> { instance: analyst, side: "analyst" }
other   -> null
```

The helper short-circuits on `!isEmptySlotStatus(status)` and, for the empty-slot statuses, returns `null` if the expected populated side is absent — so the both-sides-null case and any degenerate single-null case cannot produce an anchor with a null instance. The call sites then additionally require the side to match the cell they belong to:

- Master cell wires `emptyFlag` only when `!masterInstance && !row.master && emptyAnchor.side === "analyst"`. An Extra row is the only status where `row.master` is null, and on that row the anchor side is `"analyst"`, so this branch fires precisely for the Extra row's empty master cell and anchors to the analyst instance.
- Analyst cell wires `emptyFlag` only when `!analystInstance && !row.analyst && emptyAnchor.side === "master"`. A Missed row is the only status with `row.analyst` null and anchor side `"master"`, so this fires for the Missed row's empty analyst cell and anchors to the master instance.

Both cells on a flagged row open the SAME FlagMenu for the SAME opposing/populated instance.

## Permission and null-safety gating

`emptyFlagAllowed = !!emptyAnchor && (canFlagRow(row.status) || canResolveDispute)` mirrors the populated path's permission expression and additionally requires a non-null anchor. `canFlagRow` wraps the already-shipped `canFlagRowPure`, which allows the allocated analyst on any row and any logged-in user with a loaded check on an empty-slot row. A logged-out user has `isLoggedIn=false` and `canResolveDispute=false`, so `emptyFlagAllowed` is false and `emptyFlag` is undefined — the cell renders the original inert `<div>` with no `onContextMenu`, no title, no hover. The both-sides-null guard is covered twice over: `emptyCellAnchor` returns null, and the call-site `emptyAnchor && emptyAnchor.side === ...` checks would reject it anyway.

Because `openFlagMenu` is anchor-agnostic — it re-derives `allowFlag`/`allowResolve` from the `(instance, side, status)` it is handed — passing the opposing instance is sufficient; nothing else in the flag/resolve flow needs to know the dispute originated from an empty cell.

## Filter-independence of the anchor

The anchor is computed from `row.master`/`row.analyst` (raw) rather than `masterInstance`/`analystInstance` (filter-adjusted). The filter-adjusted vars go null when a stat/player filter hides a side, which would wrongly suppress the affordance even though the dispute target still exists; permission is gated on the filter-independent `row.status`, so the raw opposing instance is the correct anchor.

## Flagged-state visual and resolve gating

`emptyFlag.flagged = flaggedKeys.has(disputeKey(emptyAnchor.instance.id, emptyAnchor.side))`. The empty branch applies `ring-2 ring-inset ring-amber-500` and renders a small `<Flag>` icon when flagged, mirroring the populated cell. One consequence worth noting (confirmed, and intended per the plan): since both the populated and empty cells of a flagged row read the same opposing key, a flagged missed/extra row shows the amber ring on both cells. This is the deliberate discoverability improvement, not a defect.

Resolve remains admin-only and unchanged: `openFlagMenu` computes `allowResolve = canResolveDispute && isFlagged`, and `canResolveDispute` is `admin`/`super_admin` with a loaded check. A non-admin empty-cell flagger passes `allowFlag` and gets flag mode; nothing in the resolve path was touched.

## TimelineCell changes and seek behavior

`TimelineCell` gains one optional prop, `emptyFlag?: { onFlag; flagged; title }`, consumed ONLY inside the `if (!instance)` branch. When `emptyFlag` is present the empty cell renders with `onContextMenu`, a `title`, a `cursor-context-menu hover:bg-amber-50/60` affordance, and the conditional amber ring + Flag icon; when absent it returns the original inert placeholder verbatim. The populated branch (`instance != null`) is byte-for-byte unchanged — same `onClick`/`onSeek`, `onContextMenu={onFlag}`, flagged ring, and title. The empty cell gets no `onClick`/`onSeek`, so it is not seekable, as required.

## Test coverage

`dispute-permissions.test.ts` adds a `describe("emptyCellAnchor")` block covering the two positive mappings (missed→master, extra→analyst), all fully-populated statuses → null, each single-missing-side → null, and both-null → null. The coder recorded `npx vitest --run` → 24 passed across 3 files and `npm run build` → compiled successfully with no type errors (Next.js 16.2.10, Turbopack), consistent with the diff I reviewed.

Not tested: the `page.tsx` call-site wiring and the `TimelineCell` empty-branch rendering are not under automated test (no component/render test exists in this area), so the side-match guards and the dual-ring visual are verified by code reading and the coder's recorded UI-case reasoning rather than an executed test. This matches the existing test posture for this file and is acceptable for the scope.

## Scope

Only the three in-scope files changed: `dispute-permissions.ts` (new pure helper + two type-only imports), `dispute-permissions.test.ts` (new describe block), and `page.tsx` (import, per-row anchor computation, two `emptyFlag` props, one new optional `TimelineCell` prop). No changes to `lib/comparison/*`, `lib/api/disputes.ts`, `clubConfig.ts`, `clubLogos.ts`, and no DB/API/dispute-kind changes. The type-only imports of `Instance` and `DisputeSide` do not modify those modules.

</details>

<details>
<summary>File map</summary>

- `app/accuracy-compare/dispute-permissions.ts` — adds the pure `emptyCellAnchor(status, { master, analyst })` helper returning the opposing populated `{ instance, side }` or null; two type-only imports.
- `app/accuracy-compare/dispute-permissions.test.ts` — adds `describe("emptyCellAnchor")` with 7 cases (positive mappings, fully-populated→null, missing-side→null, both-null→null).
- `app/accuracy-compare/page.tsx` — imports `emptyCellAnchor`; computes `emptyAnchor`/`emptyFlagAllowed` per review row; wires `emptyFlag` onto the master cell (Extra row, side "analyst") and analyst cell (Missed row, side "master"); adds one optional `emptyFlag` prop to `TimelineCell` consumed only in the empty branch.

Full diff: `git diff -- reporting-ui/app/accuracy-compare/` on branch `feature/empty-slot-dispute-permission`.

</details>
