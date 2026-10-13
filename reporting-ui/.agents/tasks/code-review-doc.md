# Empty-slot dispute permissions for any logged-in viewer

Relaxes the dispute-flag gate so any authenticated user (analyst or admin) viewing a loaded accuracy check can raise a dispute on the single populated side of a `missed` or `extra` row, instead of only the allocated analyst. Fully-populated rows keep the allocated-analyst-only gate, resolve stays admin/super_admin, and logged-out viewers stay blocked. The approach centralises the rule in one pure predicate (`canFlagRowPure`) that both the review-pane cell guards and the `openFlagMenu` internal guard consume, so the two surfaces can't diverge. The dispute data model is unchanged — a flag still anchors to the populated side's existing instance id.

Watch for: nothing blocking. The predicate keys off `row.status` rather than the filter-adjusted sides, which is the correct choice (confirmed); the "comparison table" named in the task intent carries no flag surface, so only the hint text needed updating (confirmed).

**Verdict**: APPROVED

## High-level view

The permission rule is factored into a new `dispute-permissions.ts` module as a pure function closing over nothing: `canFlagRowPure(status, { isAllocated, isLoggedIn, hasCheck })` returns `isAllocated || (isLoggedIn && hasCheck && isEmptySlotStatus(status))`. The page wraps it in a thin `canFlagRow(status)` closure over the live `canFlag`, `!!user`, and `loadedCheckId != null`. Keying off `status` (not `masterInstance != null`) is deliberate and correct — the filter-adjusted sides go null when a stat/player filter hides a side of a fully-populated row, which would misclassify it as empty-slot.

Both flag-opening surfaces are the two `TimelineCell` `onFlag` handlers in the video review pane; both now gate on `canFlagRow(row.status)` and pass `row.status` into `openFlagMenu`, whose internal `allowFlag` guard was switched from the bare `canFlag` to `canFlagRow(status)`. The non-video comparison table attaches no `onFlag` at all, so the "comparison table" surface named in the intent reduces to the hint text, which was broadened to show a missed/extra flag hint to non-allocated logged-in users.

The empty side stays non-flaggable for free: on a `missed` row `row.analyst` is null, so the analyst cell's instance is null and no handler attaches; the retained `&& masterInstance` / `&& analystInstance` conjuncts enforce this. Resolve mode, `submitFlag`, and `createDispute` are untouched, so no instance is required or created on the empty side. Only `page.tsx` plus the two new sibling files changed; none of the excluded files were touched.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking action items. The change is faithful to the approved design.

</details>

<details>
<summary>Details</summary>

### The predicate and why it keys off status

`canFlagRowPure` (new `app/accuracy-compare/dispute-permissions.ts`) is `ctx.isAllocated || (ctx.isLoggedIn && ctx.hasCheck && isEmptySlotStatus(status))`, with `isEmptySlotStatus` true only for `missed`/`extra`. This matches the design's per-case table exactly: allocation wins on any row; a logged-in non-allocated user (analyst or admin alike, since the predicate doesn't inspect role) gets only empty-slot rows; a logged-out user gets nothing because both `isAllocated` and `isLoggedIn` are false; and the `hasCheck` conjunct keeps the empty-slot arm off until a check is loaded.

The page-side `canFlagRow` closure passes `isAllocated: canFlag`, `isLoggedIn: !!user`, `hasCheck: loadedCheckId != null`. `canFlag` and `canResolveDispute` are unchanged, so the allocated-analyst and admin-resolve semantics are preserved verbatim. Keying the empty-slot test off `row.status` rather than `masterInstance != null`/`analystInstance != null` is the one subtle correctness point, and it's right: `masterInstance`/`analystInstance` are the filter-adjusted sides (`sideShows(row.master) ? row.master : null`), so a stat/player filter hiding one side of a fully-populated row would make it look empty-slot and wrongly open flagging to non-allocated users. `row.status` is filter-independent and authoritative.

### Both surfaces wired, empty side stays non-flaggable

The flag menu is only ever opened from the two video-review `TimelineCell`s. Both `onFlag` guards changed from `(canFlag || canResolveDispute) && <side>Instance` to `(canFlagRow(row.status) || canResolveDispute) && <side>Instance`, and both call sites now pass `row.status` into `openFlagMenu`. The `&& masterInstance` / `&& analystInstance` conjuncts are retained, and because `missed` rows carry only a master instance and `extra` rows only an analyst instance, the empty side's cell has a null instance and gets no handler — the "empty side is never flaggable" invariant holds at the view layer with no data-model change.

```
missed row:  row.master = Instance   row.analyst = null
             master cell: canFlagRow("missed")=T && masterInstance  -> onFlag set
             analyst cell: ... && analystInstance(null)             -> undefined
extra row:   row.master = null        row.analyst = Instance
             master cell: ... && masterInstance(null)               -> undefined
             analyst cell: canFlagRow("extra")=T && analystInstance -> onFlag set
```

`openFlagMenu` gained a `status: MatchStatus` parameter and now computes `allowFlag = canFlagRow(status)` instead of the hard-coded `canFlag`; `allowResolve`, the early return, and `setFlagMenu` are unchanged. Both (and only those two) call sites were updated to the new four-arg signature, so there's no stale caller — consistent with the clean type-check in the recorded build.

### Comparison table and hint text

The task intent names "comparison table/hint text" as a surface. The non-video comparison table (`filteredRows.map`, ~line 3380) wires only `onSeek`/`onEdit` on its cells and renders flagged state via `flaggedKeys`; it attaches no `onFlag` and never opens the flag menu, so there is no gating change to make there. The intent's "comparison table" therefore reduces to the hint text in the video-review header, which was broadened: the allocated analyst keeps "right-click an instance to flag it"; any other logged-in user now sees "right-click a missed/extra instance to flag it"; logged-out users see nothing. The resolve hint was split into its own independent conditional, so a non-allocated admin now correctly sees both the empty-slot flag hint and the resolve hint (the previous `else-if` chain showed only one). The wording accurately names the rows a non-allocated user can act on.

### Resolve, logged-out, and data model

Resolve stays admin/super_admin: `canResolveDispute` is untouched, `allowResolve = canResolveDispute && isFlagged` is unchanged, and the `FlagMenu` mode (`canResolveDispute && flaggedKeys.has(...)`) was not modified, so a newly-allowed non-admin flagger gets `mode === "flag"`. Logged-out viewers are blocked everywhere: `canFlagRow` returns false for every status when `!!user` is false, and no `onFlag` handler attaches. `submitFlag` and `createDispute` are not in the diff — the empty-slot flag reuses the populated instance's real id and the existing `(check_id, instance_id, side)` upsert, so no instance is required or created on the empty side.

### Scope and test coverage

The diff touches only `app/accuracy-compare/page.tsx` (+38/-8) plus two new sibling files (`dispute-permissions.ts`, `dispute-permissions.test.ts`). None of the excluded files (`lib/api/clubConfig.ts`, `lib/api/clubLogos.ts`, `lib/comparison/*`, `lib/api/disputes.ts`) were modified, and no DB migration was added. The new test file covers the full flag matrix as pure cases: logged-out blocked on all statuses, logged-in non-allocated allowed only on empty-slot, admin treated the same as any viewer for flagging, allocated analyst allowed on all, and the `hasCheck` gate. Per `verification.md` the build compiled with no type errors (all 35 routes, including `/accuracy-compare`) and vitest ran 18/18 across 3 files with no regression in the pre-existing `lib/comparison` suites.

Not tested: the integration wiring (that `onFlag` is attached only to the expected cells for each user class, and that `createDispute` receives the populated instance id and correct side) is exercised only by the pure predicate tests, not by a rendered-pane test. The design listed this as integration-testable but optional; the pure coverage plus the retained instance conjuncts make the wiring low-risk, so this is a note, not a blocking gap.

</details>

<details>
<summary>File map</summary>

- `app/accuracy-compare/page.tsx` — import `canFlagRowPure`; add `canFlagRow` closure; `openFlagMenu` takes `status` and gates on `canFlagRow(status)`; both review-pane `onFlag` guards + call sites use `canFlagRow(row.status)` and pass `row.status`; hint text broadened with split resolve conditional.
- `app/accuracy-compare/dispute-permissions.ts` — new pure `isEmptySlotStatus` + `canFlagRowPure`.
- `app/accuracy-compare/dispute-permissions.test.ts` — new 7-case vitest matrix for the predicate.

Full diff: `git diff main -- reporting-ui/app/accuracy-compare/page.tsx` plus the two untracked files above.

</details>
