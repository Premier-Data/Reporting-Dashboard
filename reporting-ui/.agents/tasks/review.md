# Mobile pull-to-refresh (hard reload) via touch gesture on the app `<main>`

Adds a touch-only pull-to-refresh gesture to the authenticated app shell. A `usePullToRefresh` hook binds touch listeners to the existing `<main className="flex-1 overflow-auto">` scroll container through a ref, drives a small overlay indicator, and triggers `window.location.reload()` once when the user drags past a resisted threshold from the very top. The pull math (resistance, clamp, threshold, progress) is extracted into a pure `computePull` function with unit tests; the DOM/touch plumbing and the presentational indicator stay thin around it. The gesture is inert on non-touch devices and SSR, so desktop is visually unchanged.

Watch for: nothing blocking. The hook correctly registers `touchmove` non-passive and only calls `preventDefault` while actively pulling at `scrollTop === 0` (confirmed). The one deliberate deviation from a literal reading of the plan is that content does not translate with the finger — only the indicator moves — which the plan called out as an intentional safety choice to avoid touching page layout (confirmed, acceptable). The actual on-device gesture could not be exercised here; the verification relies on a reasoned state-machine walkthrough plus pure-math tests, which is the correct ceiling for a touch gesture in this environment (confirmed).

**Verdict**: APPROVED

## High-level view

The gesture is a hook, not a wrapper. `usePullToRefresh(mainRef)` attaches listeners to the pre-existing `<main>` element rather than nesting a new scroll container, so `<main>` keeps its class and remains the single app-wide scroll container. This is the lowest-risk way to satisfy the "main must remain the scroll container" constraint.

Gating is handled on three axes and all three hold: touch-only (bound only when `'ontouchstart' in window || maxTouchPoints > 0`, no mouse handlers anywhere), top-only (arms only at `scrollTop === 0`), and direction (engages only on a downward move that is more vertical than horizontal). Until all engage conditions are met the handler returns without `preventDefault`, so normal scrolling and horizontal/upward gestures are never intercepted.

Hooks are declared unconditionally at the top of `AppShell` and consumed only in the authenticated return. The `isPublic`, loading, and no-access early returns render no indicator and attach no ref, so the gesture never wires into the login or guard branches. This respects the Rules of Hooks while keeping the feature scoped to the authenticated shell.

The reload is a one-shot. A `triggered` ref latches on threshold-crossed release and every handler early-returns on it, so `window.location.reload()` fires at most once and the spinner stays locked until the browser replaces the page. Below threshold, release springs back to idle with no reload.

Known gaps: the live touch gesture was not exercised (no emulator/Playwright here), and content does not follow the finger (indicator-only animation, a deliberate scope choice). Neither is blocking.

<details>
<summary>Issues (1)</summary>

1. **Reduced-motion read is not reactive** (non-blocking) — `prefersReducedMotion()` is sampled only when the effect runs (`[scrollRef]`), so toggling the OS setting mid-session isn't reflected until remount. Optional: subscribe to the media query if live updates matter; otherwise leave as-is.

Informational, not actionable: the on-device gesture was validated by reasoning rather than execution (no emulator available), and indicator-only animation is a deliberate deviation from "translate content down" documented in the plan.

</details>

<details>
<summary>Details</summary>

### Gesture lives on the existing `<main>`, which stays the scroll container

`AppShell` declares `const mainRef = useRef<HTMLElement>(null)` and `const pull = usePullToRefresh(mainRef)` at the top with the other hooks, then attaches `ref={mainRef}` to the unchanged `<main className="flex-1 overflow-auto">{children}</main>`. The class is untouched and `{children}` still renders directly inside, so `<main>` remains the one scroll container — the hook adds listeners, not DOM nesting. The only structural edit is adding `relative` to the enclosing `<div className="flex min-w-0 flex-1 flex-col overflow-hidden">` so the absolutely-positioned indicator anchors to the main column rather than the viewport. That `relative` is confined to the authenticated branch and does not alter overflow or scroll behavior.

The indicator is rendered as a sibling before `<main>` inside the main column, `absolute inset-x-0 top-0` with `pointer-events-none`, so it overlays without participating in layout or intercepting touches destined for the scroll area.

### Touch-only, inert on non-touch and SSR

Listeners bind inside a `useEffect` only when `scrollRef.current` exists and `isTouchDevice()` returns true (`'ontouchstart' in window || navigator.maxTouchPoints > 0`), and `isTouchDevice` returns false when `window` is undefined. There are no mouse/pointer handlers anywhere in the hook. On desktop/SSR the effect returns early: no listeners, state stays `idle`, `offset` stays 0, and the indicator renders with `opacity: 0` and `aria-hidden`, so there is no desktop visual change.

### Engage conditions and the non-passive `preventDefault`

`touchmove` is registered `{ passive: false }` while `touchstart`/`touchend`/`touchcancel` stay passive — only `touchmove` needs to suppress native scroll. Before engaging, the move handler requires all of: still at top (`el.scrollTop === 0`), downward beyond a 6px slop (`deltaY > DIRECTION_SLOP`), and vertical dominance (`|deltaY| > |deltaX|`). If any fail it returns without `preventDefault`, leaving native scrolling, upward drags, and horizontal swipes intact. `preventDefault` (guarded by `e.cancelable`) is called only after engagement and only while still at the top; if the container has scrolled since engaging, it resets and bails without preventing default so scroll resumes. This matches the requirement that `preventDefault` fire only while actively pulling at `scrollTop === 0`.

Arming is also top-gated at `touchstart`: if `el.scrollTop > 0` it clears the pulling flag and records nothing, so a pull can only ever begin from the very top.

### Threshold, resistance, and the pure math

`computePull(rawDeltaY, 70, 110)` returns a reset result for non-positive drags, otherwise `offset = min(rawDeltaY * 0.5, maxOffset)`, `crossed = offset >= threshold`, and `progress = min(offset / threshold, 1)`. Resistance (0.5) is a module constant inside the math file and is asserted by a test, so the feel can't silently drift. The tests cover upward drag, zero drag, below-threshold resistance (100→50, not crossed), the pinned RESISTANCE value, exact threshold crossing (140→70, crossed, progress 1), past-threshold (200→100), and the max-offset clamp (1000→110) — meaningful boundary cases, not placeholder assertions. The hook consumes the result to set `offset`/`progress` and records `crossed` for the release decision.

### One-shot reload and spring-back

On release while engaged: if `crossed`, the hook sets `triggered = true`, enters `refreshing`, locks the indicator to the threshold position, and calls `window.location.reload()`. Every handler early-returns when `triggered` is set, so even a stray late event can't fire a second reload — the gesture triggers the reload exactly once, and the spinner remains until navigation replaces the page. If not crossed, `reset()` returns to idle and animates the offset back to 0 with no reload. A release that never engaged (a tap or aborted pull) also just resets.

### Reduced motion and the indicator

`prefersReducedMotion()` is read once per effect run; when set, `animated` is false, which drops the 200ms transform/opacity transition on the indicator (snap instead of ease) while preserving the gesture behavior and the arrow/spinner visuals. During an active drag `animated` is also forced false so the indicator tracks the finger instantly rather than lagging through the easing. The indicator flips the arrow 180° at `progress >= 1` and swaps to a spinning `Loader2` while refreshing, both from `lucide-react` (already a dependency). It sets `role="status"` when visible and `aria-hidden` at rest.

One minor note, non-blocking: `prefersReducedMotion()` is evaluated only when the effect runs (deps `[scrollRef]`), so a user toggling the OS reduced-motion setting mid-session wouldn't be reflected until remount. This is a cosmetic edge (easing on a transient spring-back) and well within acceptable bounds for this feature.

### Scope and the Next.js repo rule

`git diff main --name-only` confirms the only tracked modification is `components/auth/AppShell.tsx`; the new `components/pwa/` and `lib/pwa/` files are untracked additions. No changes to `app/layout.tsx`, `globals.css`, `Sidebar`, `TopBar`, `ChatWidget`, routing, auth, or data fetching. No npm dependency was added (`lucide-react` was already present). All three new client files and the edited shell carry `'use client'` at the top before imports. The plan and verification note record that the authors read `node_modules/next/dist/docs/.../use-client.md` and reasoned through the Next 16 breaking changes, concluding (correctly) that none touch a pure client-side DOM/touch feature calling `window.location.reload()`. The AGENTS.md rule was honored.

### Verification evidence

The coder's note records `tsc --noEmit` exit 0, `vitest --run` 18/18 passing (including the 7 new math cases), and `next build` exit 0 with 35/35 static pages. The evidence is internally consistent and complete; per the task I did not re-run the suites. The one build warning (multiple-lockfile workspace-root inference) is pre-existing and unrelated. The on-device touch gesture was validated by state-machine reasoning rather than execution, which is the correct ceiling given no touch emulator is available here — not grounds for rejection.

</details>

<details>
<summary>Files changed</summary>

- `components/auth/AppShell.tsx` — declares the ref/hook unconditionally, attaches `ref` to the unchanged `<main>`, adds `relative` to the main column, renders the indicator as a sibling. Authenticated branch only.
- `components/pwa/usePullToRefresh.ts` (new) — touch-only gesture state machine; binds non-passive `touchmove`; one-shot reload; inert on non-touch/SSR.
- `components/pwa/PullToRefreshIndicator.tsx` (new) — presentational overlay, arrow→spinner, reduced-motion aware, no layout impact.
- `lib/pwa/pull-to-refresh-math.ts` (new) — pure `computePull` (resistance/clamp/threshold/progress).
- `lib/pwa/pull-to-refresh-math.test.ts` (new) — 7 boundary-case unit tests.

Full diff: `git diff main` from the worktree root. New files are untracked; read them directly.

</details>
