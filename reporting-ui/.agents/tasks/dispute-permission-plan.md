# Implementation Plan — Empty-slot dispute permissions

Source of truth: `.agents/tasks/dispute-permission-design.md` (APPROVED in
`.agents/tasks/design-review.md`). This plan turns that design into exact,
ordered edits. All paths are relative to `reporting-ui/`.

Scope guardrails (from the design, do NOT violate):
- Touch only `app/accuracy-compare/page.tsx` and the one new helper + test file
  below. Leave `lib/api/clubConfig.ts`, `lib/api/clubLogos.ts`, and
  `lib/comparison/*` untouched. No DB migration, no change to
  `lib/api/disputes.ts`.
- No commit/push steps.

Verified facts the plan relies on (confirmed by reading the code):
- `app/accuracy-compare/page.tsx` already imports `type MatchStatus`,
  `type ComparisonRow`, `type Instance` from `@/lib/comparison/xml-compare`
  (line ~67). No new import from that module is needed for the status type.
- `canFlag` is defined ~line 950, `canResolveDispute` ~line 960.
- `openFlagMenu` ~line 1319 hard-codes `const allowFlag = canFlag;` and has
  exactly two call sites (the review-pane cells).
- The review-pane loop is `videoRows.map((row, i) => { ... })` (~line 3633), so
  `row.status` is in scope at both `onFlag` call sites (~3718 master, ~3741
  analyst).
- Hint text chain is at ~line 3464.
- Tests are colocated with their module and use `import { describe, it, expect }
  from "vitest"`. `vitest.config.ts` includes `**/*.test.ts` / `**/*.test.tsx`
  and runs in a jsdom environment.
- Build command: `npm run build` (`next build`). Test command: `npm test`
  (`vitest --run`); a scoped run is `npx vitest --run <path>`.

Design decision recorded for the implementer (not re-deciding architecture):
The design's testability section asks for the predicate to be extracted as a
pure free function so a unit test can target it. Because `lib/comparison/*` is
out of scope and the predicate is specific to this page, the pure function lives
in a NEW colocated module `app/accuracy-compare/dispute-permissions.ts`, and its
test is `app/accuracy-compare/dispute-permissions.test.ts`. A `.ts`/`.test.ts`
file under `app/` is not a Next.js route segment (only `page`/`layout`/`route`
etc. are), so this is safe for the App Router and keeps the change inside the
allowed surface. `page.tsx` then defines a thin closure `canFlagRow(status)`
that calls this free function with the live `canFlag` / `user` / `loadedCheckId`
values — one rule, used by both wiring surfaces, so they cannot diverge.

---

- [ ] 1. Create the pure permission helper module.
      Create `app/accuracy-compare/dispute-permissions.ts` exporting two pure
      functions matching the design: `isEmptySlotStatus(status: MatchStatus):
      boolean` returning `status === "missed" || status === "extra"`; and
      `canFlagRowPure(status: MatchStatus, ctx: { isAllocated: boolean;
      isLoggedIn: boolean; hasCheck: boolean }): boolean` returning
      `ctx.isAllocated || (ctx.isLoggedIn && ctx.hasCheck &&
      isEmptySlotStatus(status))`. Import `type MatchStatus` from
      `@/lib/comparison/xml-compare` (type-only import; do not modify that file).
      Add a short doc comment stating the rule: allocated analyst may flag any
      row; any logged-in user with a loaded check may flag an empty-slot
      (missed/extra) row; fully-populated rows stay allocated-only.
      Files: `app/accuracy-compare/dispute-permissions.ts`
      Verify: `npx tsc --noEmit` (or defer to the build in step 6) shows no type
      error for the new file; it is also exercised by the test in step 2.

- [ ] 2. Add the unit test for the pure predicate.
      Create `app/accuracy-compare/dispute-permissions.test.ts` using
      `describe/it/expect` from `vitest`. Cover the full permission matrix from
      the design's "Per-case permission table" for the FLAG decision:
      for each status in `exact | wrong_stat | wrong_player | wrong_team |
      missed | extra`, assert `canFlagRowPure` for the four actor cases —
      (a) not logged in → always false; (b) logged-in, not allocated, has check
      → true only for `missed`/`extra`; (c) logged-in admin, not allocated →
      same as (b) for flagging (admin resolve is separate and not covered by
      this predicate); (d) allocated analyst (`isAllocated: true`) → true for
      every status. Also assert the guard interactions: `hasCheck: false` makes
      the empty-slot arm false even when logged in; `isAllocated: true` wins
      regardless of `hasCheck`/`isLoggedIn` combinations the caller would pass.
      Add a couple of direct `isEmptySlotStatus` assertions.
      Files: `app/accuracy-compare/dispute-permissions.test.ts`
      Verify: `npx vitest --run app/accuracy-compare/dispute-permissions.test.ts`
      — all new tests pass.

- [ ] 3. Wire the closure predicate into `page.tsx` near the permission flags.
      Import `canFlagRowPure` from `./dispute-permissions` (add to the existing
      import block near the top of `app/accuracy-compare/page.tsx`). Immediately
      after `canResolveDispute` (~line 960), add a thin memo/closure:
      `const canFlagRow = (status: MatchStatus): boolean =>
      canFlagRowPure(status, { isAllocated: canFlag, isLoggedIn: !!user,
      hasCheck: loadedCheckId != null });`. Keep the redundant-looking
      `hasCheck` guard — it gates the empty-slot arm for non-allocated users and
      must not be "simplified" away (design review NIT #1). Do not change
      `canFlag` or `canResolveDispute` themselves.
      Files: `app/accuracy-compare/page.tsx`
      Verify: covered by the build in step 6; no behavioural change yet because
      nothing calls `canFlagRow` until steps 4–5.

- [ ] 4. Update `openFlagMenu` to gate on row status (wiring point 2).
      Change the signature to
      `const openFlagMenu = (e: React.MouseEvent, instance: Instance, side:
      DisputeSide, status: MatchStatus) => { ... }` and replace
      `const allowFlag = canFlag;` with `const allowFlag = canFlagRow(status);`.
      Leave `isFlagged`, `allowResolve = canResolveDispute && isFlagged`, the
      early return, and `setFlagMenu(...)` exactly as they are so the admin
      resolve-on-flagged-full-row path stays reachable (design review NIT #3).
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` fails until step 5 updates the two call sites to
      pass `status` (expected — do steps 4 and 5 together before building).

- [ ] 5. Update the two review-pane `onFlag` guards and call sites (wiring point 1).
      In the `videoRows.map((row, i) => ...)` loop (~lines 3713–3745), master
      cell: change the guard to `(canFlagRow(row.status) || canResolveDispute)
      && masterInstance` and the handler to `(e) => openFlagMenu(e,
      masterInstance, "master", row.status)`. Analyst cell: change the guard to
      `(canFlagRow(row.status) || canResolveDispute) && analystInstance` and the
      handler to `(e) => openFlagMenu(e, analystInstance, "analyst",
      row.status)`. Keep the `&& masterInstance` / `&& analystInstance`
      conjuncts (filter-adjusted side) so the empty side stays non-flaggable.
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` (next build) completes with no type errors — the
      `openFlagMenu` signature from step 4 now matches both call sites.

- [ ] 6. Broaden the video-review hint text (wiring point 3).
      At the hint chain (~line 3464), replace the `canFlag ? ... :
      canResolveDispute ? ... : ""` structure with two independent conditionals
      per the design: a flag hint — `canFlag ? " · right-click an instance to
      flag it" : user ? " · right-click a missed/extra instance to flag it" :
      ""` — followed by a separate resolve hint — `canResolveDispute ? " ·
      right-click a flagged instance to resolve it" : ""`. This is copy-only; it
      changes no permissions. (Design review NIT #2's optional `videoRows.some`
      tightening is not required and should be skipped to keep the change
      minimal.)
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` completes clean.

- [ ] 7. Full verification pass.
      Run the build and the whole test suite to confirm the feature compiles and
      no existing tests regressed.
      Files: none (verification only).
      Verify: `npm run build` succeeds, then `npx vitest --run` (or `npm test`)
      — the new `dispute-permissions.test.ts` passes and all pre-existing
      `lib/comparison/*.test.ts` suites still pass.

## Notes / assumptions

- No `useMemo` is strictly needed for `canFlagRow` (step 3) since it closes over
  primitives and is called in render; a plain arrow function is fine and matches
  the design. If the implementer prefers `useCallback`/`useMemo` for lint
  cleanliness, that is acceptable and non-substantive.
- `DisputeSide`, `Instance`, and `disputeKey` are already in scope in `page.tsx`
  (used by the current `openFlagMenu`), so no new imports beyond
  `canFlagRowPure` and the already-present `MatchStatus` type.
- If the project lints as part of CI, `npm run lint` may be run after step 7,
  but it is not required by this task's verification.
