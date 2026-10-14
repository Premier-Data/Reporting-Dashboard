# Verification — Mobile Pull-to-Refresh (hard reload)

Worktree: `c:\Users\AndyDin\reporting-dashboard\.worktrees\pull-to-refresh\reporting-ui`

## Repo rule compliance (AGENTS.md: "This is NOT the Next.js you know")

Read before writing code:
- `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` — confirms the `'use client'` directive must sit at the very top of the file, before any imports. All new client files (`usePullToRefresh.ts`, `PullToRefreshIndicator.tsx`) and the edited `AppShell.tsx` follow this.
- The plan (`.agents/tasks/plan.md`) records the Next 16 breaking changes (removed sync `cookies`/`headers`/`params`/`searchParams`, `middleware`→`proxy`, Turbopack default, React 19.2). None touch this feature: it is pure client-side DOM/touch code calling the plain browser API `window.location.reload()`. No Next routing/data/caching APIs are used.

## Environment note

The worktree shipped with no `node_modules` of its own, so `npx tsc`/`vitest`/`next` could not resolve modules (tsc walked up to `C:\Users\AndyDin\node_modules`). Created a directory **junction** `node_modules` → `c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules` (the shared install) so the worktree's own binaries and type packages resolve. This is a local, reversible setup aid; no source, git, or dependency changes were made. `.env` and `.env.local` were already present in the worktree.

## Commands run + results

All from the worktree root, using the worktree's own `node_modules\.bin` (via the junction):

1. **`tsc --noEmit`** → `---TSC EXIT 0---`. Clean, no type errors.
2. **`vitest --run`** → `Test Files 3 passed (3)`, `Tests 18 passed (18)`. Includes the new `lib/pwa/pull-to-refresh-math.test.ts` (7 cases: upward drag, zero drag, below-threshold resistance, RESISTANCE pinned to 0.5, exact threshold crossing, past threshold, max-offset clamp). No regressions in the existing comparison tests.
3. **`next build`** → exit `0`. `✓ Compiled successfully`, `Finished TypeScript`, `✓ Generating static pages (35/35)`. `/fixtures` prerendered as static with **no** Supabase env error (env files present), so there is no env artifact to note. The only console warning was Next's multiple-lockfile workspace-root inference — unrelated to this change and pre-existing.

The main-tree dev server on port 3000 was not touched; no worktree dev server was started.

## Touch gesture: this cannot be exercised headlessly

There is no Playwright/Puppeteer here and a real touch gesture needs a touch device/emulator. No visual/touch test was run. Below is the reasoned state-machine walkthrough proving the required invariants from the code.

## State-machine walkthrough (`components/pwa/usePullToRefresh.ts`)

Listeners are bound in a `useEffect` to the `<main>` element passed by ref, and ONLY when `isTouchDevice()` is true (`'ontouchstart' in window || navigator.maxTouchPoints > 0`) and `scrollRef.current` exists. On SSR/desktop/non-touch, the effect returns early: **no listeners bound, state stays `idle`, `offset` stays 0** → the indicator renders invisible (`opacity:0`, `aria-hidden`) with no layout impact. Invariant: **inert on non-touch / no desktop visual change.** ✔

Refs track the live gesture without re-binding: `startY/startX`, `pulling` (engaged), `crossed` (past threshold), `triggered` (one-shot reload guard).

- **touchstart** — If `triggered` is already set, ignore (reload in flight). If `el.scrollTop > 0`, clear `pulling` and do nothing else: the gesture can only ever arm from the very top. Else record `startY/startX`, leave `pulling=false` (not engaged yet). Invariant: **only the top can begin a pull.** ✔

- **touchmove (registered `{ passive: false }`)** — If `triggered`, ignore. Compute `deltaY`, `deltaX` from the start point.
  - While **not yet engaged** (`pulling=false`): engage only if ALL hold — still at top (`scrollTop === 0`), downward beyond slop (`deltaY > 6`), and more vertical than horizontal (`|deltaY| > |deltaX|`). Otherwise `return` **without** calling `preventDefault`, so an upward, horizontal, or not-at-top move leaves native scrolling completely untouched. Invariant: **engages only at scrollTop 0 on a downward, vertical move; normal scrolling unaffected when scrolled down.** ✔
  - Once engaged, if the container has since scrolled (`scrollTop > 0`), `reset()` and bail (no preventDefault) → scroll resumes.
  - While actively engaged at the top, call `e.preventDefault()` (guarded by `e.cancelable`) to stop native scroll/rubber-band fighting, then `computePull(deltaY, 70, 110)` sets `offset`/`progress` and records `crossed`. Invariant: **non-passive touchmove preventDefault ONLY while actively pulling at the top.** ✔

- **touchend / touchcancel** — If `triggered`, ignore. If not engaged, `reset()` → `idle` (handles a tap or an aborted pull). If engaged:
  - `crossed === true` → set `triggered=true` (one-shot), state `refreshing`, lock the indicator, and call `window.location.reload()`. The `triggered` guard plus every handler's early `return` on `triggered` means reload fires **exactly once**; the spinner stays until the browser replaces the page. Invariant: **hard reload exactly once, indicator keeps spinning.** ✔
  - `crossed === false` → `reset()` animates `offset` back to 0 and returns to `idle` with no reload. Invariant: **spring back below threshold.** ✔

**Pure math (`lib/pwa/pull-to-refresh-math.ts`, unit-tested):** `rawDeltaY <= 0` → `{offset:0, crossed:false, progress:0}`; else `offset = min(rawDeltaY * 0.5, maxOffset)`, `crossed = offset >= threshold`, `progress = min(offset/threshold, 1)`. Resistance 0.5, threshold 70, cap 110.

**Reduced motion:** `prefersReducedMotion()` sets `animated=false`, which drops the 200ms spring-back easing on the indicator (snap instead). Behavior is otherwise identical; the arrow/spinner still show.

## Scope confirmation

New files: `lib/pwa/pull-to-refresh-math.ts`, `lib/pwa/pull-to-refresh-math.test.ts`, `components/pwa/usePullToRefresh.ts`, `components/pwa/PullToRefreshIndicator.tsx`. Edited: `components/auth/AppShell.tsx` only — hook/ref declared unconditionally at the top (Rules of Hooks), consumed solely in the authenticated return; `<main className="flex-1 overflow-auto">` keeps its class and still wraps `{children}` (now with `ref`); the indicator is a sibling inside the main column, which gained `relative` so the absolutely-positioned overlay anchors to it. The `isPublic`, loading, and no-access early returns are untouched. No changes to routing, auth, data fetching, any page, `app/layout.tsx`, `globals.css`, `Sidebar`, `TopBar`, or `ChatWidget`. Dependency-free (reused `lucide-react`, already present). No commit/push/merge/worktree removal.
