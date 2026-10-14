# Implementation Plan — Mobile pull-to-refresh never binds

## Context (grounded in the two in-scope files)

- `components/pwa/usePullToRefresh.ts` takes a `RefObject<HTMLElement|null>` and binds touch listeners inside a single `useEffect` whose dependency array is `[scrollRef]`. `scrollRef` is a stable ref object; its identity never changes, so the effect runs exactly once on mount.
- `components/auth/AppShell.tsx` calls `usePullToRefresh(mainRef)` unconditionally at the top, but has multiple PRE-AUTH early returns (`isPublic`, `!ready || !user`, `!allowed && !fallback`, `!allowed`) that render `Loading...` / message trees WITHOUT the `<main ref={mainRef}>` scroll container. On first mount AppShell is in one of those branches, so `mainRef.current === null` when the effect runs. The effect returns early (`if (!el ...) return;`), no listeners attach, and because the dep array never changes it never re-runs after the authenticated `<main>` finally mounts. Result: the gesture never binds.

Root cause confirmed by the brief. Fix = make the hook own the element via a **callback ref** so the binding effect re-runs when `<main>` mounts (null → node) and unmounts (node → null).

## Design decisions

1. **Callback ref owned by the hook (preferred approach from the brief).** The hook holds the element in `useState` and exposes a stable `useCallback` setter. The binding effect depends on that state value (`el`), so React re-runs it precisely when the DOM node attaches/detaches. This is cleaner than a MutationObserver/retry and needs no polling. Chosen over the RefObject-robustness alternative because it is the idiomatic React way to "run an effect when a specific element mounts."
2. **Preserve `mainRef` in AppShell via a merged ref only if it is still needed.** Reading AppShell: `mainRef` is used ONLY for `usePullToRefresh(mainRef)` and as `<main ref={mainRef}>`. There is no other consumer. So `mainRef` can be removed entirely and replaced by the hook's callback ref — no merged-ref helper needed. (If a future reader finds another `mainRef` use, fall back to a tiny merged-ref callback; not required now.)
3. **Hook return shape** changes from `PullToRefresh` to `PullToRefresh & { ref: (node: HTMLElement | null) => void }` (add a `ref` field) so `<PullToRefreshIndicator {...pull} />` keeps working: the indicator destructures only `offset/progress/state/animated` and ignores the extra `ref` field, so its contract is unaffected. Verified against `PullToRefreshIndicator.tsx`, which destructures exactly those four props.
4. **Gesture semantics are copied verbatim.** The entire effect body (touchstart/move/end/cancel handlers, `isTouchDevice`, `prefersReducedMotion`, THRESHOLD/MAX_OFFSET/DIRECTION_SLOP, non-passive `touchmove` + `preventDefault`, `window.location.reload()`, spring-back `reset()`, reduced-motion `animated`, the `triggeredRef`/`pullingRef`/`crossedRef` bookkeeping) is unchanged. ONLY the element source (`scrollRef.current` → `el` state) and the dependency array (`[scrollRef]` → `[el]`) change.

## Plan

- [ ] 1. Rewrite `usePullToRefresh` to own the element via a callback ref.
      - Change the signature to take NO argument: `export function usePullToRefresh(): PullToRefresh`.
      - Add element state + stable setter near the top of the hook:
        `const [el, setEl] = useState<HTMLElement | null>(null);`
        `const setRef = useCallback((node: HTMLElement | null) => setEl(node), []);`
      - In the binding `useEffect`, replace `const el = scrollRef.current;` with using the `el` state value directly (remove the `scrollRef.current` read; keep `if (!el || !isTouchDevice()) return;`).
      - Change the effect dependency array from `[scrollRef]` to `[el]`.
      - Extend the return type and value: add `ref` to the `PullToRefresh` interface
        `/** Callback ref to attach to the scroll container. */ ref: (node: HTMLElement | null) => void;`
        and return `{ offset, progress, state, animated, ref: setRef }`.
      - Update imports: add `useCallback`; remove the now-unused `useRef`-for-ref? (NOTE: `useRef` is STILL needed for `startYRef/startXRef/pullingRef/crossedRef/triggeredRef` — keep it). Remove the unused `RefObject` import.
      - Leave EVERYTHING else in the effect byte-for-byte identical (handlers, listener options, cleanup, math import).
      Files: `components/pwa/usePullToRefresh.ts`
      Verify: `npx tsc --noEmit` is clean (no unused-import or signature errors) — run after step 2 so AppShell is updated too.

- [ ] 2. Wire the callback ref in AppShell and drop the obsolete `mainRef`.
      - Change `const pull = usePullToRefresh(mainRef);` to `const pull = usePullToRefresh();`.
      - Delete `const mainRef = useRef<HTMLElement>(null);`.
      - Change `<main ref={mainRef} className="flex-1 overflow-auto">` to `<main ref={pull.ref} className="flex-1 overflow-auto">`.
      - Keep `<PullToRefreshIndicator {...pull} />` exactly where it is (the extra `ref` field is harmless; the indicator ignores it).
      - Remove `useRef` from the React import IF it is no longer used elsewhere in the file (grep the file: `useEffect`/`useState` remain; `useRef` is only used by `mainRef`, so remove it from the import list).
      Files: `components/auth/AppShell.tsx`
      Verify: `npx tsc --noEmit` is clean; `npm run build` (`next build`) completes with no type/lint errors.

- [ ] 3. (Optional, recommended) Add a lightweight jsdom test proving listeners bind when the element attaches later.
      - Create `components/pwa/usePullToRefresh.test.tsx`.
      - Constraints discovered during exploration: environment is already `jsdom` (see `vitest.config.ts`); include glob already covers `**/*.test.tsx`. **`@testing-library/react` is NOT installed and there is no `resolve.alias` for `@/` in vitest config** — so DO NOT use testing-library or `@/` imports. Use React 19's own `react-dom/client` `createRoot` + `react`'s `act`, and import the hook with a relative path (`./usePullToRefresh`), mirroring how `pull-to-refresh-math.test.ts` imports `./pull-to-refresh-math`.
      - Test outline:
        - Force touch-capable env: set `window.ontouchstart = null` (or stub `navigator.maxTouchPoints`) BEFORE render so `isTouchDevice()` returns true in jsdom.
        - Create a real `document.createElement("div")`, spy on `el.addEventListener`.
        - Render a tiny component that calls `usePullToRefresh()` and, via `useState`-gated conditional, FIRST renders without attaching the node (simulating the pre-auth branch where `pull.ref` is never called), asserts `addEventListener` NOT yet called; THEN attaches `ref={pull.ref}` to a mounted element and asserts `addEventListener` is called with `touchstart`, `touchmove` (with `{ passive: false }`), `touchend`, `touchcancel`. Wrap state changes/renders in `act(...)`.
        - Simpler acceptable variant if driving a component tree is fiddly: render a component that attaches `pull.ref` to a `<div>` and assert that after mount the div has the four touch listeners bound (spy on `Element.prototype.addEventListener` or pass a known node through the callback ref directly and assert `addEventListener` was invoked). The essential assertion: listeners bind only once a non-null element is passed to the callback ref, and the non-passive option is set on `touchmove`.
      - Keep the existing `lib/pwa/pull-to-refresh-math.test.ts` untouched.
      Files: `components/pwa/usePullToRefresh.test.tsx` (new)
      Verify: `npx vitest --run` passes all tests, including the existing `pull-to-refresh-math` suite and the new file.

## Verification checklist (run from the worktree UI dir)

- [ ] `npx tsc --noEmit` → clean (no errors). Confirms the hook signature change and AppShell rewiring type-check, and no unused imports (`RefObject`, `useRef` in AppShell).
- [ ] `npm run build` → `next build` completes successfully (no type/lint failures).
- [ ] `npx vitest --run` → all tests pass, including the untouched `lib/pwa/pull-to-refresh-math.test.ts` and (if added) the new `components/pwa/usePullToRefresh.test.tsx`.
- [ ] Manual-reasoning check (no code change): the binding effect now depends on `[el]`; when AppShell transitions from a pre-auth early-return branch to the authenticated tree, `<main ref={pull.ref}>` mounts, the callback ref fires with the live node, `setEl` updates state, the effect re-runs, and the four touch listeners attach to the live `<main>`. On unmount the callback ref fires with `null`, the effect cleanup removes listeners.

## Gesture-semantics preservation checklist (must all remain true)

- [ ] Touch-only: `if (!el || !isTouchDevice()) return;` still guards the effect; non-touch devices bind nothing.
- [ ] Engages only at `el.scrollTop === 0` on a downward move past `DIRECTION_SLOP`, more vertical than horizontal.
- [ ] `touchmove` registered with `{ passive: false }` and calls `e.preventDefault()` while actively pulling.
- [ ] Threshold crossing triggers a single `window.location.reload()` (guarded by `triggeredRef`).
- [ ] Spring-back `reset()` on release below threshold; reduced-motion drives `animated`.
- [ ] Listeners removed in the effect cleanup (now also on element detach, which is an improvement, not a regression).

## Out of scope (do NOT touch)

`components/pwa/PullToRefreshIndicator.tsx`, `lib/pwa/pull-to-refresh-math.ts` (except the optional new test file lives under `components/pwa/`), `manifest.json`, `globals.css`, and any unrelated files.

## Notes / assumptions

- AGENTS.md requires reading the Next.js guide under `node_modules/next/dist/docs/` before relying on Next APIs. This change is pure React hooks/DOM (callback ref + effect deps) and does not introduce any Next.js API; `next build` is used only as the build verifier. No Next-specific API decision arises, so no guide read is required for correctness — if the implementer hits a build/config question, consult that docs dir first.
- No merged-ref helper is needed because `mainRef` has no other consumer in AppShell (verified by reading the file).
