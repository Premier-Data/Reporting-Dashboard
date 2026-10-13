# Verification — Empty-slot dispute permissions

Iteration: first (no `.agents/tasks/code-review.json` present).

## What changed

- NEW `app/accuracy-compare/dispute-permissions.ts` — pure, testable predicate:
  - `isEmptySlotStatus(status)` → true for `missed` / `extra`.
  - `canFlagRowPure(status, { isAllocated, isLoggedIn, hasCheck })` →
    `isAllocated || (isLoggedIn && hasCheck && isEmptySlotStatus(status))`.
- NEW `app/accuracy-compare/dispute-permissions.test.ts` — 7 vitest cases
  covering the full flag matrix.
- `app/accuracy-compare/page.tsx`:
  - Import `canFlagRowPure` from `./dispute-permissions`.
  - Added thin closure `canFlagRow(status)` right after `canResolveDispute`,
    passing live `canFlag` / `!!user` / `loadedCheckId != null`.
  - `openFlagMenu` now takes a `status: MatchStatus` arg; its guard is
    `allowFlag = canFlagRow(status)` (was `canFlag`). `allowResolve`,
    `isFlagged`, early-return, `setFlagMenu` unchanged.
  - Both review-pane `onFlag` guards changed from `canFlag` to
    `canFlagRow(row.status)` and both call sites pass `row.status`. The
    `&& masterInstance` / `&& analystInstance` conjuncts are kept, so the empty
    side stays non-flaggable.
  - Hint text broadened: allocated analyst sees the original flag hint; any
    other logged-in user sees "right-click a missed/extra instance to flag it";
    the resolve hint is now an independent conditional so a non-allocated admin
    sees both.
- `canFlag` and `canResolveDispute` left unchanged. No touch to
  `lib/comparison/*`, `lib/api/disputes.ts`, `lib/api/clubConfig.ts`,
  `lib/api/clubLogos.ts`.

## Commands run and results

### Build — `npm run build`

Note: a parallel `next build` held `.next/lock` on the first attempt
("Another next build process is already running"); after that build released
the lock, the re-run succeeded.

Result: SUCCESS. Next.js 16.2.10 (Turbopack). "Compiled successfully",
"Finished TypeScript in 23.0s" with no type errors, all 35 routes generated
(`/accuracy-compare` included). Exit code 0.

### Tests — `npx vitest --run`

Result: SUCCESS. Exit code 0.

```
Test Files  3 passed (3)
     Tests  18 passed (18)
```

- `app/accuracy-compare/dispute-permissions.test.ts` — 7/7 passed (new).
- `lib/comparison/cross-exact.test.ts` — 6/6 passed (pre-existing, no regression).
- `lib/comparison/json-adapter.test.ts` — 5/5 passed (pre-existing, no regression).

## Behaviour confirmed against the design's per-case table

- Logged out → cannot flag any row.
- Logged-in non-allocated (analyst or admin) → can flag `missed` (master side)
  and `extra` (analyst side) only; cannot flag fully-populated rows.
- Allocated analyst → can flag every row (unchanged).
- Resolve stays admin/super_admin via unchanged `canResolveDispute`.
- Empty side never flaggable (no instance to anchor; `&& masterInstance` /
  `&& analystInstance` guards retained).
