# Implementation Plan — Mobile Pull-to-Refresh (hard reload)

Worktree root (ALL paths below are inside this tree, NOT the main tree):
`c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui`

## Context discovered during exploration

- Next.js version is **16.2.10** (App Router). Per the repo rule (AGENTS.md: "This is NOT the Next.js you know") I read `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md` and `.../03-api-reference/01-directives/use-client.md`. Note: the worktree has **no `node_modules`** of its own; the installed `next` + its docs live in the main tree at `c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules\next\dist\docs`. Builds/tests in the worktree resolve modules through that shared install.
- **What differs from common Next.js knowledge (and what does NOT affect this task):** Next 16 removes synchronous `cookies`/`headers`/`params`/`searchParams`, renames `middleware`→`proxy`, makes Turbopack the default builder, and ships React 19.2. **None of these touch this feature.** This gesture is pure client-side DOM/touch code calling the plain browser API `window.location.reload()`; it uses no Next routing, data-fetching, caching, or request APIs. The only Next-specific requirement that applies is the **`'use client'` directive** (required for any file using state/effects/browser APIs, placed at the very top before imports) — confirmed from `use-client.md`. `window.location.reload()` is unaffected by Next 16's client-router overhaul.
- **Integration point (confirmed by reading the code):** `components/auth/AppShell.tsx` is a `'use client'` component. Its final authenticated return renders the single app-wide scroll container: `<main className="flex-1 overflow-auto">{children}</main>`. `app/layout.tsx` sets `<body className="h-screen overflow-hidden ...">`, so the browser's native pull-to-refresh never fires — a custom gesture is required. AppShell has three earlier returns that must NOT get the gesture: the public/login branch (`if (isPublic) return <>{children}</>`), the loading return, and the no-access return.
- **Test setup already present:** `vitest@^3.2.7` + `jsdom@^29` are devDependencies; `vitest.config.ts` sets `environment: "jsdom"` and `include: ["**/*.test.ts", "**/*.test.tsx"]`. `package.json` script `test` = `vitest --run`. Existing tests colocate beside source (e.g. `lib/comparison/cross-exact.test.ts`) and import `{ describe, it, expect } from "vitest"`. Follow that exact convention.
- **Path alias:** `@/*` → project root (tsconfig `paths`). Strict mode is on. Target ES2017, `lib` includes `dom`.
- No existing helper for `matchMedia`, reduced-motion, or touch detection exists, so the component owns that logic.

## Design decisions (chosen, with rationale)

- **Hook + indicator wired by AppShell, over a wrapping component.** The task requires `<main className="flex-1 overflow-auto">` to REMAIN the scroll container. A `usePullToRefresh` hook that attaches listeners to the existing `<main>` via a `ref` keeps that element untouched and adds no extra scroll-affecting DOM nesting. AppShell renders a small fixed indicator element as a sibling overlay. This is cleaner and lower-risk than inserting a wrapper div that could alter overflow/scroll behavior.
- **Pure math extracted to a testable function** `computePull(rawDeltaY, threshold, maxOffset)` in `lib/pwa/pull-to-refresh-math.ts`. The hook calls it; the test exercises it directly. Resistance = `rawDeltaY * 0.5`, capped at `maxOffset`. This isolates the only logic worth unit-testing from DOM/touch plumbing.
- **Transform the indicator only, not the content.** Rather than translating `{children}` (risk of layout/scroll side effects on every page), the indicator overlay animates down from the top edge as you pull. This satisfies the "spinner appears/spins past threshold" requirement without moving page content, keeping the blast radius to AppShell + new files. (If the design later wants content to follow the finger, that is a one-line transform on a wrapper — noted as a known deviation from "translate content down", chosen deliberately for safety per the "do not touch pages" constraint.)
- **Dependency-free**, inline styles / Tailwind classes only; no new npm package; no `globals.css` change.

## Gesture state machine

States: `idle → pulling → (release) → refreshing | idle`.

- **idle**: no touch tracking active. On `touchstart`, record `startY` and read `main.scrollTop`. Only arm tracking if `scrollTop === 0`.
- **pulling**: entered on first `touchmove` where `scrollTop === 0` AND `deltaY = currentY - startY > 0` (downward) AND the gesture is more vertical than horizontal. While pulling, call `preventDefault()` on the (non-passive) `touchmove`, compute `offset = computePull(deltaY, THRESHOLD, MAX_OFFSET)`, position/opacity the indicator; set a `crossed = offset >= THRESHOLD` flag that switches the indicator to the "ready/spinning" look. If the move is upward/horizontal or `scrollTop` is no longer 0, abort back to **idle** without preventing default (normal scroll continues).
- **release (touchend/touchcancel)**: if `crossed` → go to **refreshing**; else animate offset back to 0 and return to **idle**.
- **refreshing**: lock the indicator in a spinning state and call `window.location.reload()`. No state exit needed — the page reloads. (Set an internal `hasTriggered` guard so reload is called at most once.)

Constants (module-level in the hook file): `THRESHOLD = 70`, `MAX_OFFSET = 110`, `RESISTANCE = 0.5`.

## Pure-function signature + test

File: `lib/pwa/pull-to-refresh-math.ts`
```ts
/** Resisted vertical offset for a raw downward drag distance. */
export function computePull(rawDeltaY: number, threshold: number, maxOffset: number): {
  offset: number;        // resisted, clamped to [0, maxOffset]
  crossed: boolean;      // offset >= threshold
  progress: number;      // offset / threshold, clamped to [0, 1] (for indicator fill/opacity)
};
```
Behavior: negative/zero `rawDeltaY` → `{ offset: 0, crossed: false, progress: 0 }`; otherwise `offset = min(rawDeltaY * RESISTANCE, maxOffset)` (RESISTANCE applied here or passed by caller — keep RESISTANCE inside this module as a const and multiply here so the test pins it), `crossed = offset >= threshold`, `progress = min(offset / threshold, 1)`.

Test file: `lib/pwa/pull-to-refresh-math.test.ts` (colocated, mirrors `lib/comparison/*.test.ts` style; `import { describe, it, expect } from "vitest"`).

---

# Implementation Plan

- [ ] 1. Create the pure math module `computePull`.
      Add resistance/clamp/threshold logic exactly as specified in the signature above. Pure, no DOM, no imports.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui\lib\pwa\pull-to-refresh-math.ts`
      Verify: builds in the next step's typecheck; covered by tests in item 2.

- [ ] 2. Add unit tests for `computePull`.
      Cover: upward/zero drag → zero offset, not crossed; small drag below threshold → correct resisted offset (e.g. 100px raw * 0.5 = 50 < 70 → crossed false, progress ≈ 0.714); drag past threshold → crossed true; very large drag → offset clamped to `maxOffset` (110) and progress clamped to 1. Use `describe`/`it`/`expect` from `vitest`.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui\lib\pwa\pull-to-refresh-math.test.ts`
      Verify (run from the worktree root): `npm test -- lib/pwa/pull-to-refresh-math.test.ts` — all new tests pass. (Equivalently `npx vitest --run lib/pwa`.)

- [ ] 3. Create the `usePullToRefresh` hook.
      `'use client'` at the top (file uses `useRef`/`useState`/`useEffect` and touch APIs). Signature: `usePullToRefresh(scrollRef: React.RefObject<HTMLElement | null>): { offset: number; progress: number; state: 'idle' | 'pulling' | 'refreshing' }`. In a `useEffect`, bind `touchstart` (passive), `touchmove` (passive: **false**, so `preventDefault` is allowed while pulling), `touchend` and `touchcancel` to `scrollRef.current`; implement the state machine above using `computePull`. Guard for non-touch (`if (typeof window === 'undefined' || !('ontouchstart' in window))` → bind nothing, stay idle) so it is inert on desktop/SSR. On threshold-crossed release, set state `refreshing`, set a one-shot `hasTriggered` ref, and call `window.location.reload()`. Honor `matchMedia('(prefers-reduced-motion: reduce)')` by skipping the spring-back transition timing (snap instead) — behavior still works; only the animation is reduced. Clean up all listeners on unmount. Do NOT bind any mouse events.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui\components\pwa\usePullToRefresh.ts`
      Verify: typecheck/build in item 5 (hook is consumed in item 4, so build only passes once both exist).

- [ ] 4. Create the indicator component `PullToRefreshIndicator`.
      `'use client'`. Small presentational component that takes `{ offset, progress, state }` and renders a fixed/absolute overlay pinned to the top-center of the scroll area that translates down by `offset`, fades/rotates an arrow via `progress`, and shows a spinning `Loader2` from `lucide-react` (already a dependency) when `state === 'refreshing'` (and the arrow flips to "ready" when `progress >= 1`). Use Tailwind classes + inline `transform`/`opacity` style driven by props. `pointer-events-none`, `aria-hidden` while idle, otherwise `role="status"`. No layout impact when `offset === 0` (hidden). No `globals.css` changes.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui\components\pwa\PullToRefreshIndicator.tsx`
      Verify: build in item 5.

- [ ] 5. Wire the hook + indicator into AppShell's authenticated return ONLY.
      In the final `return (...)` (the one rendering `<Sidebar/>`, `<TopBar/>`, `<main>`, `<ChatWidget/>`), add `const mainRef = useRef<HTMLElement>(null);` and `const pull = usePullToRefresh(mainRef);`. Attach `ref={mainRef}` to the existing `<main className="flex-1 overflow-auto">` WITHOUT changing its className or that it wraps `{children}`. Render `<PullToRefreshIndicator {...pull} />` as a sibling inside the `<div className="flex min-w-0 flex-1 flex-col overflow-hidden">` (so it overlays the main column). Do NOT add anything to the `isPublic` branch, the loading return, or the no-access return. Keep `Sidebar`, `TopBar`, `ChatWidget` untouched. Hooks must be called unconditionally at the top of the component (before the early returns) to satisfy the Rules of Hooks — declare `mainRef`/`pull` alongside the existing `useState`/`useEffect` near the top, and only consume them in the authenticated JSX.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui\components\auth\AppShell.tsx`
      Verify: `npx tsc --noEmit` (run from worktree root) — no type errors.

- [ ] 6. Full verification.
      Run, from the worktree root `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui`:
      1. `npx tsc --noEmit` — clean.
      2. `npm test` (= `vitest --run`) — all tests pass, including the new `pull-to-refresh-math.test.ts`.
      3. `npm run build` (`next build`, Turbopack by default in Next 16) — build succeeds with no new errors/warnings tied to the changed files.
      Files: none (verification only).
      Verify: all three commands exit 0.

## Notes / assumptions

- Manual device testing of the actual touch gesture (drag-at-top, threshold spring-back, reload) can only be confirmed on a real touch device/emulator; the automated verification above covers the pure math, type-safety, and build. Flag this gap to the user if device validation is required before merge.
- Scope held to: 2 new files under `components/pwa/`, 2 new files under `lib/pwa/` (impl + test), and a minimal edit to `AppShell.tsx`. No changes to routing, auth, data fetching, any page, `app/layout.tsx`, `globals.css`, `Sidebar`, `TopBar`, or `ChatWidget`.
- Do NOT commit or push (per task constraints).
