# Callback-ref rebind so mobile pull-to-refresh listeners attach when `<main>` mounts

The hook `usePullToRefresh` never bound its touch listeners on mobile because its binding effect ran once while `AppShell` was still in a pre-auth early-return branch — no `<main>` existed, the passed `scrollRef.current` was `null`, the effect returned early, and `[scrollRef]` (a stable ref object) never changed so the effect never re-ran after `<main>` appeared. The fix inverts ownership of the element: the hook now holds the scroll node in React state via a callback ref it returns (`pull.ref`), and the binding effect depends on that state (`[el]`) instead of the ref object. When `<main>` finally mounts post-auth, the callback ref fires, state transitions `null → node`, and the effect re-runs and binds the listeners. On unmount it transitions `node → null` and the effect cleanup detaches them. The entire gesture body — gating, direction slop, non-passive `touchmove`, threshold reload, spring-back, reduced-motion, non-touch inertness — is carried over unchanged.

Watch for: nothing blocking. The optional jsdom test was not shipped (confirmed) because the hook's `@/` value import has no resolver in the project's `vitest.config.ts`; the author documented this rather than expand scope. Final gesture confirmation still requires a real touch device (confirmed — not automatable here).

**Verdict**: APPROVED

## High-level view

The binding-timing fix is correct and matches the prescribed approach. The hook owns the element through a callback ref stored in state, and the binding effect's dependency is that state value, so the effect re-runs exactly on the `null → node` transition that happens when `<main>` mounts after the auth gate resolves. This is precisely the transition the old `[scrollRef]` dependency could never observe. Detach-on-unmount and re-attach-on-change both follow from the same state dependency.

Gesture semantics are preserved. The constants (`THRESHOLD=70`, `MAX_OFFSET=110`, `DIRECTION_SLOP=6`), the `scrollTop === 0` arming, the downward-and-vertical-dominant engage check, the non-passive `touchmove` with `preventDefault`, the single `window.location.reload()` guarded by `triggeredRef`, the spring-back `reset()`, the reduced-motion `animated` flag, and the non-touch/SSR early return are all byte-for-byte carried from the previous version. The only semantic shift is that `el` is now the state value instead of a once-captured `scrollRef.current`, which is what the fix is for.

Scope is clean. Exactly four files are modified: the hook, `AppShell.tsx`, and the two task docs (`plan.md`, `verification.md`). No change touched the indicator component, the pure math module, `manifest.json`, `globals.css`, or any unrelated file. No test file was added.

Verification evidence is present and sufficient. The author's note records a clean `tsc --noEmit`, a successful `next build` (35 pages), and a green vitest run (6 files / 56 tests) with a documented `NODE_OPTIONS` workaround for a junctioned-`node_modules` artifact that is environmental, not a code defect.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking action items. The two informational notes below (optional test not shipped; real-device confirmation outstanding) are documented by the author and require no code change.

</details>

<details>
<summary>Details</summary>

### Binding re-runs on the `null → node` transition

The core of the fix. The hook holds the scroll element in state:

```ts
const [el, setEl] = useState<HTMLElement | null>(null);
const setRef = useCallback((node: HTMLElement | null) => setEl(node), []);
```

and the binding effect depends on `[el]`, guarding with `if (!el || !isTouchDevice()) return;`. `AppShell` attaches `setRef` as `<main ref={pull.ref}>`. On first render the shell is in a pre-auth branch (`isPublic`, `!ready || !user`, `!allowed && !fallback`, or `!allowed`) — none render `<main>`, so `el` stays `null` and the effect no-ops. When auth resolves and the authenticated tree renders, React invokes the callback ref with the live node, `setEl(node)` flips state `null → node`, and because the dependency is the state value (not a stable ref object) the effect re-runs and binds `touchstart`/`touchmove`/`touchend`/`touchcancel`. On navigation that unmounts `<main>`, the ref fires with `null`, the effect cleanup detaches the four listeners before the next run. If React ever swapped the `<main>` node for a different element, the state change would detach from the old and re-attach to the new — the dependency makes attach/detach symmetric. This is exactly the transition the previous `[scrollRef]` dependency could not observe, since a ref object's identity never changes.

The `useCallback` on `setRef` keeps the callback-ref identity stable across renders, so React does not spuriously fire it `null`/`node` on every render — the ref only runs on genuine mount/unmount. That keeps the binding effect from thrashing.

### Gesture semantics carried over intact

Comparing the previous `HEAD` version against the working tree, the handler body is unchanged apart from the element source. Arming still requires `el.scrollTop === 0` on `touchstart`; engagement still requires a downward move past `DIRECTION_SLOP` that is more vertical than horizontal; `touchmove` is still registered `{ passive: false }` with `e.preventDefault()` (guarded by `e.cancelable`) only while actively pulling; crossing the threshold still sets `triggeredRef` and fires a single `window.location.reload()`; releasing short still springs back through `reset()`; `animated` still follows `prefers-reduced-motion`; and the whole effect is still inert on non-touch devices and during SSR via `isTouchDevice()`/the `typeof window` guards. The handlers read `el` (the state value) in the same positions the old code read its once-captured `const el = scrollRef.current`, and since the effect re-binds whenever `el` changes, each handler closure captures the correct, current element.

### Scope

Four files modified: `components/pwa/usePullToRefresh.ts` and `components/auth/AppShell.tsx` (both in scope), plus `.agents/tasks/plan.md` and `.agents/tasks/verification.md` (documentation). `git status` in the worktree shows nothing else. `PullToRefreshIndicator.tsx`, `lib/pwa/pull-to-refresh-math.ts`, `manifest.json`, and `globals.css` are untouched. In `AppShell`, the now-unused `mainRef`/`useRef` were removed and the `useRef` import dropped; `PullToRefreshIndicator {...pull}` still destructures only `offset/progress/state/animated`, so the extra `ref` field in the spread is ignored. In the hook, `RefObject` was dropped from the imports and `useCallback` added; `useRef` is retained for the gesture bookkeeping refs.

### Verification evidence

The author's note records `tsc --noEmit` clean (which also catches the removed `RefObject`/`useRef` imports and the signature/return-type change), a successful `next build` on Next.js 16 Turbopack with 35 pages generated, and vitest green at 6 files / 56 tests including the untouched math suite. Running vitest from this worktree required `NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main` because `node_modules` is a junction to the main tree and vitest's worker otherwise resolves a second module instance through the canonical path, failing collection — an environmental invocation detail, not a repo change (no config was modified; the temporary diagnostic config was deleted). Per instruction, these suites were not re-run here; the note is the evidence and it covers build, tsc, and vitest.

The optional jsdom test asserting listener binding was deliberately not shipped: the test must import the hook, which has a value import through the `@/` alias, and `vitest.config.ts` has no `resolve.alias`/tsconfig-paths plugin to resolve `@/` value imports. Adding one is out of scope. Shipping no test rather than a red suite or an out-of-scope config change is the right call for this task; the binding logic is covered by the clean type-check, build, and the logical proof. Final gesture behavior on a real device cannot be reproduced in this environment and remains for user confirmation.

</details>

<details>
<summary>File map</summary>

- `components/pwa/usePullToRefresh.ts` — hook now owns the scroll element via a callback ref held in state; binding effect depends on `[el]`; returns `ref: setRef`. Gesture body unchanged.
- `components/auth/AppShell.tsx` — consumes `pull.ref` on `<main>`; removed the local `mainRef`/`useRef`.
- `.agents/tasks/plan.md` — plan doc update (documentation).
- `.agents/tasks/verification.md` — verification note with build/tsc/vitest results and the binding-timing proof (documentation).

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\ptr-bind-fix\reporting-ui diff`

</details>
