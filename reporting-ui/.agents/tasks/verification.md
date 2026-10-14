# Verification — Mobile pull-to-refresh never binds

Worktree UI dir: `c:\Users\AndyDin\reporting-dashboard\.worktrees\ptr-bind-fix\reporting-ui`
Iteration: FIRST (no `.agents/tasks/review.json` present).

## What changed (in scope only)

- `components/pwa/usePullToRefresh.ts` — converted to own the scroll element via a **callback ref**:
  - Signature changed from `usePullToRefresh(scrollRef: RefObject<HTMLElement|null>)` to `usePullToRefresh()` (no argument).
  - Added `const [el, setEl] = useState<HTMLElement|null>(null);` and a stable
    `const setRef = useCallback((node) => setEl(node), []);`.
  - The binding `useEffect` now reads the `el` STATE value instead of `scrollRef.current`,
    and its dependency array changed from `[scrollRef]` to `[el]`.
  - `PullToRefresh` interface gained a `ref: (node: HTMLElement|null) => void` field; the hook
    returns `{ offset, progress, state, animated, ref: setRef }`.
  - Imports: added `useCallback`; removed the now-unused `RefObject` type import. `useRef` is kept
    (still used by the gesture bookkeeping refs).
  - EVERYTHING else in the effect — touchstart/move/end/cancel handlers, `isTouchDevice`,
    `prefersReducedMotion`, THRESHOLD/MAX_OFFSET/DIRECTION_SLOP, scrollTop===0 gating, downward
    DIRECTION_SLOP check, vertical-dominance check, non-passive `touchmove` + `preventDefault`,
    single `window.location.reload()` guarded by `triggeredRef`, spring-back `reset()`,
    reduced-motion `animated`, listener cleanup — is byte-for-byte unchanged. No gesture semantics regressed.

- `components/auth/AppShell.tsx` — wired the callback ref:
  - `const pull = usePullToRefresh();` (no arg).
  - Removed `const mainRef = useRef<HTMLElement>(null);` (it had no other consumer in the file).
  - `<main ref={pull.ref} className="flex-1 overflow-auto">` (was `ref={mainRef}`).
  - `<PullToRefreshIndicator {...pull} />` unchanged in placement; it destructures only
    `offset/progress/state/animated`, so the extra `ref` field is ignored.
  - Removed `useRef` from the React import (no longer used in the file).

No changes to `PullToRefreshIndicator.tsx`, `lib/pwa/pull-to-refresh-math.ts`, `manifest.json`,
`globals.css`, or any unrelated file.

## Commands run and results

All run from `c:\Users\AndyDin\reporting-dashboard\.worktrees\ptr-bind-fix\reporting-ui`.

- `npx tsc --noEmit` → **exit 0, clean.** No type errors, no unused-import errors (confirms the
  removed `RefObject`/`useRef` imports and the signature/return-type changes type-check end to end).

- `npm run build` (`next build`, Next.js 16.2.10 Turbopack) → **success.**
  - "Compiled successfully", "Finished TypeScript", all 35 static pages generated.
  - NO `/fixtures` missing-env prerender error occurred (env was present), so no known-artifact
    note is needed this run.
  - Benign warning only: Next.js multi-lockfile workspace-root inference warning (unrelated to this change).

- `npx vitest --run` → **6 test files, 56 tests, all passing** — INCLUDING the untouched
  `lib/pwa/pull-to-refresh-math.test.ts` (7 tests). No regressions.

### Important vitest environment note (worktree junction)

This worktree's `node_modules` is a **junction** to the main tree
(`c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules`). Running `npx vitest --run`
plainly from the worktree makes EVERY suite fail with `Error: No test suite found in file ...`
(including suites this task did not touch, and including the math test that passes fine in the main
tree). This is a vitest + junctioned-`node_modules` resolution artifact, NOT a code defect:
vitest's worker resolves its own module instance through the junction's canonical (main-tree) path,
which differs from the collector's path, so registered `describe`/`it` suites are not matched.

Fix for running the suite here: set `NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main`
before `npx vitest --run`. With that, the suite is green (6 files / 56 tests). This is purely a
local test-runner invocation detail; it does not require any config change and nothing in the repo
was modified to accommodate it (the temporary diagnostic config used to isolate the cause was deleted).

### Optional jsdom test — not shipped (honest note)

The plan recommended an optional jsdom test asserting the callback ref binds the four touch
listeners (with `touchmove` non-passive) only after a non-null element is attached. I wrote such a
test, but it cannot run under this project's vitest setup: the test must import the hook
(`./usePullToRefresh`), and the hook has a **value** import `import { computePull } from
"@/lib/pwa/pull-to-refresh-math"`. Vitest here has no resolver for the `@/` value alias (there is no
`resolve.alias` and no tsconfig-paths plugin in `vitest.config.ts`). The one existing test that
references `@/` (`app/accuracy-compare/dispute-permissions.test.ts`) only uses `import type` from
`@/` (erased before vite's import-analysis) and imports its runtime values relatively — so it never
exercises `@/` value resolution. Any hook-importing test hits
`Failed to resolve import "@/lib/pwa/pull-to-refresh-math"`.

Making the test runnable would require editing `vitest.config.ts` to add a `@/` alias, which is
out of scope for this task and which the plan explicitly flagged as not-present. Rather than commit
a red suite or expand scope, the optional test was removed. The fix remains verified by a clean
`tsc --noEmit`, a clean `next build`, and the logical proof below.

## Logical proof the fix binds listeners when <main> mounts after the pre-auth render

This is the crux of the fix.

1. On first mount, `AppShell` is in a PRE-AUTH early-return branch (`isPublic`, `!ready || !user`,
   `!allowed && !fallback`, or `!allowed`). None of those branches render `<main>`, so the hook's
   callback ref is never attached to any element. The element state `el` is therefore `null`.
2. The binding `useEffect` now depends on `[el]`. With `el === null`, the effect's guard
   `if (!el || !isTouchDevice()) return;` returns immediately — no listeners bind yet. Correct.
3. When auth resolves and AppShell renders the authenticated tree, `<main ref={pull.ref}>` mounts.
   React invokes the callback ref with the live `<main>` node, which calls `setEl(node)` →
   state transitions `null → node`.
4. Because the effect's dependency is the `el` STATE (not a stable ref object), React re-runs the
   effect after this state change. This time `el` is the real `<main>`, the guard passes (on touch
   devices), and `touchstart` / `touchmove` (`{ passive: false }`) / `touchend` / `touchcancel`
   bind to the live `<main>`.
5. On unmount/navigation that removes `<main>`, React calls the callback ref with `null` →
   `setEl(null)` → the effect's cleanup runs and removes the four listeners before the next run.

Contrast with the OLD code: it depended on `[scrollRef]`, a stable ref OBJECT whose identity never
changes. The effect ran exactly once on mount while `scrollRef.current` was `null`, returned early,
and never re-ran after `<main>` appeared — so listeners never bound. The callback-ref/`[el]`
dependency is exactly what makes the effect re-run on the `null → node` transition.

## Final confirmation requires a real device (cannot be automated here)

The actual pull-to-refresh gesture depends on real touch events and the installed/standalone PWA
context, neither of which is reproducible in this build/jsdom environment. Final confirmation that
pulling down at the top of a page triggers a reload must be done by the USER on a real mobile device
or installed PWA (hold and drag down at the top of the scroll area to reload).
