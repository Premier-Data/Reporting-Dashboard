# PWA Pull-to-Refresh — Root Cause Investigation (READ-ONLY)

## Summary answer

**Definitive root cause: Hypothesis 1 (ref/effect timing).** The pull-to-refresh listeners are **never attached to the live `<main>` element**. `usePullToRefresh(mainRef)` runs its binding effect once on mount, at which point `mainRef.current` is `null` because `AppShell` is rendering one of its pre-auth early-return trees (which do **not** contain `<main>`). When auth finishes and `<main>` finally mounts, the effect does **not** re-run — its dependency array is `[scrollRef]`, and `scrollRef` is a stable ref object that never changes identity. So the `addEventListener` calls happen only in the dead first pass where `el` is `null`, hit the `if (!el …) return` guard, and bind nothing. The listeners are never wired to the element that actually exists and scrolls.

**Scope: this is NOT standalone-only — it fails on mobile browser too, and in fact on every touch device.** The failure is in React effect/mount ordering, not in anything PWA/standalone-specific. Standalone mode is a red herring here. (The manifest `display: "standalone"` and the CSS are fine; see Hypotheses 2–4 below.) The reason it was first noticed in the installed PWA is simply that that is how the user opened it; the same gesture would also do nothing in mobile Safari/Chrome.

**Recommended fix (not implemented): switch the hook to a callback ref** (or otherwise re-run the binding effect once the real element mounts) so the listeners attach to `<main>` the moment it appears. Details in the Recommendations section.

---

## Evidence

### 1. The binding effect and its dependency array

`components/pwa/usePullToRefresh.ts`:

- The effect begins:
  ```ts
  useEffect(() => {
      const el = scrollRef.current;
      if (!el || !isTouchDevice()) return;
      ...
      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: false });
      el.addEventListener("touchend", onTouchEnd, { passive: true });
      el.addEventListener("touchcancel", onTouchEnd, { passive: true });
      return () => { ...removeEventListener... };
  }, [scrollRef]);          // ← dependency is the ref OBJECT
  ```
- `scrollRef` is the `mainRef` created in `AppShell` via `useRef<HTMLElement>(null)`. A `useRef` return value is a **stable object for the lifetime of the component** — its identity never changes across renders. Therefore `[scrollRef]` behaves like `[]`: **the effect runs exactly once, on mount, and never again.**
- Mutating `mainRef.current` from `null` to the DOM node (which React does when it attaches the `ref` prop to `<main>`) does **not** trigger a re-render and does **not** change `scrollRef`'s identity, so it cannot re-trigger the effect. This is the standard "ref assignment is invisible to the effect dependency system" trap.

### 2. Mount-order trace proving `el` is `null` when the effect fires

`components/auth/AppShell.tsx` declares the hook unconditionally at the top (correctly, for hook rules):

```ts
const mainRef = useRef<HTMLElement>(null);
const pull = usePullToRefresh(mainRef);
```

But `<main ref={mainRef}>` only exists in the **final authenticated return**. Before that there are early returns that render completely different trees:

1. `if (isPublic) return <>{children}</>;` — no `<main>`.
2. `if (!ready || !user) return (<div …>Loading...</div>);` — no `<main>`.
3. `if (!allowed && !fallback) return (<div …>No pages available</div>);` — no `<main>`.
4. `if (!allowed) return (<div …>Loading...</div>);` — no `<main>`.
5. Only the final `return (<div className="flex h-full"> … <main ref={mainRef} className="flex-1 overflow-auto">{children}</main> …)` contains `<main>`.

Now the auth timing, from `components/auth/AuthContext.tsx`:

- `const [ready, setReady] = useState(false);` — **`ready` starts `false`.**
- `ready` only flips to `true` inside the mount effect, *after* an `await reloadPermissions()` network round-trip:
  ```ts
  useEffect(() => {
    (async () => {
      ...restore user from localStorage...
      await reloadPermissions();   // async network call
      if (!cancelled) setReady(true);
    })();
  }, [reloadPermissions]);
  ```

**Timeline on a normal load:**

| Phase | `ready` | AppShell renders | `mainRef.current` | PTR effect |
|-------|---------|------------------|-------------------|------------|
| First client render / hydration | `false` | Branch 2 "Loading..." — **no `<main>`** | `null` | **Runs once; `el === null` → early return; binds nothing** |
| After `await reloadPermissions()` resolves, `setReady(true)` | `true` | Final tree — **`<main>` mounts** | the DOM node | **Does NOT re-run** (`[scrollRef]` unchanged) |

So the one and only execution of the binding effect happens in the "Loading..." phase where `<main>` does not exist. By the time `<main>` is live, nothing re-binds. **The touch listeners are permanently absent from `<main>`.** This is the complete, definitive mechanism for "never works."

Note the component is **not** remounted when `ready` flips (there is no `key` change and `AppShell` stays mounted across the whole transition), which is exactly why the effect's single run is wasted on the null ref rather than being re-run on a fresh mount.

Confirmed via git: the feature shipped as a single commit `16d6211 feat(pwa): mobile pull-to-refresh with hard reload` on branch `feature/pull-to-refresh`; the brief's note that it was never device-tested is consistent with this latent mount-order bug.

### 3. Hypothesis 2 — scroll container / `scrollTop` (NOT the cause)

The wiring is otherwise correct: `<body>` is `h-screen overflow-hidden` (`app/layout.tsx`), the shell columns are `overflow-hidden`, and `<main className="flex-1 overflow-auto">` is the genuine scroll container, so `el.scrollTop === 0` at rest would be satisfied and `el` is the right target. There is no competing inner scroller in the shell itself. This guard logic would work fine — **if the listeners were ever attached.** They are not, so this is moot. Not the cause.

### 4. Hypothesis 3 — standalone-specific / manifest / CSS (NOT the cause)

- `public/manifest.json`: `"display": "standalone"`, `"orientation": "portrait"`, `start_url` `/live-scores`, `scope` `/`. Nothing here affects touch event binding.
- `app/globals.css`: there is **no** `overscroll-behavior` and **no** `touch-action` rule on `html`/`body`/`main` anywhere. The only non-trivial CSS is inside `@media print`, which is irrelevant to touch. So no CSS is intercepting or disabling the non-passive `touchmove`.
- Because the root cause is React effect timing (identical in browser and standalone webview), there is **no standalone-only behavior** at play. Refutes Hypothesis 3 as a cause.

Caveat for the eventual fix: once listeners DO bind, note the gesture relies on `e.preventDefault()` in a **non-passive** `touchmove` to suppress native rubber-band/overscroll at the top. Adding `overscroll-behavior-y: contain` on `<main>` is a sensible belt-and-braces addition (see Recommendations) but is not required for the gesture to fire.

### 5. Hypothesis 4 — `isTouchDevice()` gate (NOT the cause)

```ts
function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}
```

On a real mobile device / installed PWA webview this returns `true` (touch points present). It is evaluated **inside** the effect, which only runs client-side, so SSR is not an issue. Even if this returned `true`, the effect still early-returns on `!el` first. So this gate is not the blocker. Not the cause. (It would only matter after the ref problem is fixed, and it is correct for mobile.)

### 6. Hypothesis 5 — `triggeredRef` never resets (noted, not the cause)

Confirmed: once a successful pull sets `triggeredRef.current = true` and calls `window.location.reload()`, nothing resets it. In practice the full-page reload throws the JS context away, so it self-resets via reload — acceptable for the hard-reload design. **Not** related to "never works." Worth a comment but no action needed.

### 7. Tooling for execution-based evidence

No Playwright/Puppeteer is available as a project dependency. `package.json` devDependencies are `vitest`, `jsdom`, `eslint`, `tailwind`, `typescript` only. The only `playwright*` files on disk are inside `node_modules/next/dist/.../testmode/` (Next's internal test helper) and docs — not an installed, usable browser-automation harness. Per the brief, I therefore fall back to the control-flow / mount-order analysis above, which is conclusive on its own. (The pure math is already unit-tested via `lib/pwa/pull-to-refresh-math.ts` + `vitest`, but that never exercises the DOM binding, which is precisely why the bug slipped through.)

---

## Conclusions

1. **Root cause (Hypothesis 1, confirmed):** the binding effect in `usePullToRefresh` runs once while `AppShell` is in a pre-auth early-return tree where `<main>` does not exist, so `scrollRef.current` is `null` and no listeners bind. The effect's `[scrollRef]` dependency never changes, so it never re-runs after `<main>` mounts. The gesture is dead on arrival.
2. **Scope:** mobile-general, not standalone-only. Mobile browser and installed PWA are equally affected. Manifest and CSS are not implicated.
3. Hypotheses 2, 3, 4 are refuted as causes; Hypothesis 5 is a benign observation.

## Recommendations (not implemented)

Primary fix — make binding depend on the real element, not a stable ref object. Any one of these resolves it; the callback-ref option is the cleanest:

- **Callback ref (recommended).** Have the hook expose a `setNode` callback ref that `AppShell` passes to `<main ref={setNode}>`. React calls it with the node when `<main>` mounts and with `null` when it unmounts. Store the node in state (`const [node, setNode] = useState<HTMLElement|null>(null)`) and key the effect on `[node]`. This binds exactly when `<main>` appears and cleans up when it disappears — robust across the auth transition and any future remounts.
- **Alternative:** keep the ref API but add the live element to the dependency array by mirroring it into state (e.g. an effect/`ResizeObserver` or a short retry that reads `scrollRef.current` and `setNode(...)`), then depend on that state. Heavier than the callback ref; same outcome.
- **Alternative:** move the hook so it only runs in the authenticated subtree where `<main>` is guaranteed to exist on first render (e.g. a small child component rendered only in the final return that owns the ref). This guarantees the ref is populated when the effect first fires.

Secondary / belt-and-braces (optional, only after binding is fixed):
- Add `overscroll-behavior-y: contain` (or `none`) to `<main>` so the browser's native pull-to-refresh / rubber-band doesn't compete with the custom gesture on some mobile browsers.
- Consider resetting `triggeredRef` on a spring-back path for completeness, though the hard reload makes it moot.

How to make it reliably testable:
- Add a DOM-level test (vitest + jsdom) that renders `AppShell` (or the hook against a container that mounts *after* first render) and asserts a `touchmove` listener is actually attached once the element appears — i.e. reproduce the mount-after-render ordering and assert the gesture fires. The existing math test does not cover binding, which is the gap that let this ship.
- For manual verification, device-test in BOTH mobile browser and the installed PWA (they should now behave identically); pull down from the very top of a page whose content is at `scrollTop === 0`.
