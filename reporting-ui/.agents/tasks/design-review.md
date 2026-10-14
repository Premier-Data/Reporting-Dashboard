# Design review — Empty-slot dispute permissions

Reviewed: `.agents/tasks/dispute-permission-design.md`
Scope verified against: `app/accuracy-compare/page.tsx`, `lib/comparison/xml-compare.ts`,
`components/auth/AuthContext.tsx`, `lib/api/disputes.ts`.

## Verdict

APPROVED. No HIGH or MEDIUM findings. The design is precise, its assumptions
are confirmed against the actual source, and it covers all eight required
checks (per-row predicate, populated-side-only attachment, allocated-analyst
gate on full rows, admin-only resolve, logged-out block, both wiring surfaces +
the `openFlagMenu` guard, the no-DB-change justification, and the edge-case
matrix).

## Findings

1. **NIT — Redundant `loadedCheckId != null` in `canFlagRow`'s empty-slot branch.**
   The predicate is
   `canFlag || (!!user && loadedCheckId != null && isEmptySlotStatus(status))`.
   `canFlag` already encodes `loadedCheckId != null`, but that short-circuits
   only the allocated-analyst arm; the empty-slot arm legitimately needs its own
   `loadedCheckId != null` guard so a non-allocated user can't flag with no check
   loaded. This is correct, not a defect — keep it. Noting only so the
   implementer doesn't "simplify" it away. No change required.

2. **NIT — Hint wording can name rows that aren't present.**
   Wiring point 3 shows `user ? " · right-click a missed/extra instance to flag it"`
   for any logged-in non-allocated viewer. If the loaded check happens to have no
   `missed`/`extra` rows, the hint still advertises them. Harmless copy
   imprecision; the permission logic is unaffected. Optional tightening: only
   show the phrase when `videoRows.some(r => r.status === "missed" || r.status === "extra")`.
   Not required.

3. **NIT — `openFlagMenu` resolve-on-full-row path depends on `canFlagRow(status)` returning false, which it does, but the design should state the admin-resolve case explicitly stays reachable.**
   The design's new guard is `allowFlag = canFlagRow(status)` and
   `allowResolve = canResolveDispute && isFlagged`. For an admin who is not the
   allocated analyst, right-clicking an already-flagged *fully-populated* row:
   `allowFlag` is false but `allowResolve` is true, so the menu still opens in
   resolve mode. The design's edge-case list and permission table already assert
   this; the guard code confirms it. Called out only to confirm the branch was
   not accidentally narrowed. No change required.

## Verified assumptions (checked against source)

- `MatchStatus` and `ComparisonRow` live in `lib/comparison/xml-compare.ts`
  with the exact shape the design states:
  `status ∈ exact | wrong_stat | wrong_player | wrong_team | missed | extra`,
  `{ status, master: Instance|null, analyst: Instance|null, timeDelta, alsoWrongPlayer? }`.
  **Verified.**
- The matching engine constructs `missed` rows as
  `{ status: "missed", master: m, analyst: null }` (line ~1226) and `extra` rows
  as `{ status: "extra", master: null, analyst: a }` (line ~1264). The design's
  central claim — exactly one populated side per empty-slot row, master for
  `missed`, analyst for `extra` — is confirmed from the engine, not taken on the
  design's word. **Verified.**
- `canFlag` (page.tsx ~951) is the allocated-analyst gate the design quotes,
  including `loadedCheckId != null` and the `analyst_name`/`checkAnalystName`
  case-insensitive compare. **Verified.**
- `canResolveDispute` (~960) is admin/super_admin only and `loadedCheckId`-gated.
  **Verified.**
- `openFlagMenu` (~1319) currently hard-codes `const allowFlag = canFlag;` and
  has exactly two call sites, both in the review-pane cells, both with
  `row.status` in scope — so the proposed signature change
  `(e, instance, side, status)` is safe and complete. **Verified** (grep: only
  two call sites).
- Review-pane cells (~3718 / 3741) wire `onFlag` as
  `(canFlag || canResolveDispute) && masterInstance` /
  `… && analystInstance`, matching the design's "drop-in substitution" target.
  `masterInstance`/`analystInstance` are the filter-adjusted sides. **Verified.**
- Hint text (~3464) is the `canFlag ? … : canResolveDispute ? … : ""` chain the
  design proposes to broaden. **Verified.**
- `FlagMenu` `mode` (~3773) is
  `canResolveDispute && flaggedKeys.has(...) ? "resolve" : "flag"`, which the
  design leaves untouched. **Verified.**
- The non-video comparison table (`filteredRows.map`, ~3366) wires only
  `onSeek`/`onEdit`/`flagged` on its `TimelineCell`s and attaches **no** `onFlag`.
  The design's claim that this surface needs no gating change is **verified** —
  it is not a second flag entry point.
- `createDispute` (lib/api/disputes.ts) upserts on
  `(check_id, instance_id, side)`, `DisputeSide = "master" | "analyst"`,
  `submitFlag` records `raisedBy: user?.username ?? null`. No schema/API change
  is needed for an empty-slot flag because it anchors to the populated
  instance's real `id`. **Verified** — no DB migration required.
- `useAuth()` returns `user` (null when logged out) with `role` and
  `analyst_name` (AuthContext.tsx). The `!!user` block for logged-out users is
  sound. **Verified.**
- `MatchStatus` is imported in page.tsx (line 67, type import) alongside
  `ComparisonRow` and `Instance`, so no new import is needed and the
  `openFlagMenu` type annotation compiles. **Verified.**

## Unverified / wrong assumptions

None. Every grounding claim in the design was checked against the cited file and
line region and matched. The design's "A row with both sides empty is never
produced" invariant follows directly from the engine always pushing a row from a
real master or analyst instance, which the row-construction code confirms.
