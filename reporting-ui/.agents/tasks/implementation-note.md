# Implementation note — Supabase request-volume reduction (3 behavior-preserving changes)

Worktree: `c:\Users\AndyDin\reporting-dashboard\.worktrees\req-reduction\reporting-ui`
All edits made in the worktree. No commit/push/merge performed (orchestrator handles git).

## Iteration status

`review.json` exists but is **stale / mismatched**: its `reviewDoc`
(`...\.worktrees\meta-cache\reporting-ui\...\2026-10-15-154808-review.md`) does
not exist, and its findings describe a *different* task (admin-check caching in
the `meta-cache` worktree — `getAccuracyChecksForAnalyst` / `getAllAccuracyChecks`),
not the three Supabase-volume changes in this worktree's `plan.md`. Confirmed by
inspecting the target files before editing: none of the three changes were
present (`Sidebar.tsx` still `[user, pathname]`; `getCompFacets` uncached;
`messages.ts` had no notify mechanism). `git log` shows no commits for these
changes. Treated this as the **FIRST iteration** and implemented all three from
scratch per the plan.

---

## CHANGE 1 — Sidebar unread badge: subscribe once per user, refresh on read (not per-nav)

Files: `components/layout/Sidebar.tsx`, `lib/api/messages.ts`.

### What changed
- `lib/api/messages.ts`: added a pure, Supabase-free in-process event:
  - `onUnreadShouldRefresh(cb): () => void` — register a listener (returns unsubscribe).
  - `notifyUnreadChanged()` — fire all listeners (guards each in try/catch).
  - `markConversationRead(...)` now calls `notifyUnreadChanged()` after a
    successful `last_read_at` update.
- `components/layout/Sidebar.tsx`:
  - Effect dependency changed from `[user, pathname]` to `[user]`.
  - Inside the same effect, the existing `refresh` is now subscribed to both
    `subscribeToAllMessages(refresh)` (live) **and** `onUnreadShouldRefresh(refresh)`
    (read trigger); both are torn down in cleanup.
  - `usePathname` import retained — `pathname` is still used for active-link
    highlighting (`pathname.startsWith(item.href)`), just no longer in the
    badge effect's deps.

### Proof the badge preserves all three behaviors

(a) **Initial count correct.** The `[user]` effect runs on first mount after
login (and whenever `user` changes). It calls `refresh()` immediately, which is
`getUnreadCount(uid)` → `setUnread(n)`. Identical first call to before; the only
removed trigger was the redundant per-pathname refetch. Code path:
`Sidebar.tsx` effect body `refresh()` → `getUnreadCount` (messages.ts) →
`setUnread`.

(b) **Live Realtime update.** `subscribeToAllMessages(refresh)` is still opened
in the effect and is UNCHANGED in `messages.ts` — it subscribes to `INSERT` on
the `messages` table and calls `onInsert()` (= `refresh`) on any new message, so
a new inbound message re-runs `getUnreadCount` and bumps the badge without any
navigation. Code path: Supabase `postgres_changes` INSERT → `subscribeToAllMessages`
callback → `refresh` → `getUnreadCount` → `setUnread`.

(c) **Clears / updates after reading.** Opening a conversation calls
`getMessages(conversationId, userId)` which calls `markConversationRead(...)`
(`app/messages/page.tsx` → `getMessages` → `markConversationRead`).
`markConversationRead` now, on success of the `last_read_at` update, calls
`notifyUnreadChanged()`, which invokes every `onUnreadShouldRefresh` listener —
the sidebar's `refresh` — so `getUnreadCount` re-reads the now-lower count and
the badge drops. This happens WITHOUT a route change. Code path:
`openConversation` → `getMessages` → `markConversationRead` (success) →
`notifyUnreadChanged` → sidebar `refresh` → `getUnreadCount` → `setUnread`.

(d) **No per-navigation refetch.** With deps `[user]`, navigating between
unrelated pages (Dashboard → Fixtures) does NOT re-run the effect, so it issues
NO new `conversation_members`/`messages` reads and does NOT tear down/reopen the
Realtime channel. The subscription persists for the lifetime of the user session
(the sidebar is mounted once in the authenticated layout). This is the request-
volume win. (Runtime Network/Realtime-panel confirmation left as a runtime check;
statically proven by the dependency-array change and the single mount point.)

The old mechanism relied on the pathname change to re-run `getUnreadCount` after
`markConversationRead`; the explicit `notifyUnreadChanged` trigger replaces that
exact dependency, so clears-after-read is preserved with no per-nav poll. The
"minimal fallback" (refresh only on leaving a conversation) was NOT needed —
every read routes through `markConversationRead`.

`getUnreadCount` is intentionally **left uncached** (see Change 2) so Realtime +
the explicit trigger stay authoritative.

---

## CHANGE 2 — Cache effectively-static reads behind lib/api/cache.ts

File: `lib/api/compFixtures.ts` (reuses `lib/api/cache.ts`, no change to cache.ts).

### Each read considered

- **`getCompFacets` (Change 2c) — CACHED.** Full-table scan of `comp_fixtures`
  (`sport,season,competition`) paged in 1000-row chunks, tallied client-side, run
  on mount by three pages (`comp-fixtures`, `accuracy-fixture`, `fixture-review`).
  Session-static — only changes on a comp re-sync.
  - Wrapped via `createKeyedCache(fetchCompFacets, (k) => k)`, keyed on the
    string `"accuracy"` vs `"normal"` (derived from `options.accuracyOnly`), so
    the two variants cache independently.
  - Exported signature `getCompFacets(options?: { accuracyOnly?: boolean })`
    UNCHANGED; now just returns `compFacetsCached.get(key)`.
  - Returned object is a shared READ-ONLY instance. Verified the three caller
    pages only read / `setState` the `sports`/`years` arrays (no in-place
    sort/push/splice), so sharing is safe. Documented in a code comment.
  - **Invalidation** wired on every mutation that changes `comp_fixtures`:
    `fullSync` (end), `incrementalSync` (end), `resyncCompetitions` (end),
    `purgeExcludedCompetitions` (when `removed > 0`). `incrementalSync` also
    calls `purgeExcludedCompetitions`, but has its own invalidate too so a
    changed/added-without-purge run still drops the cache.

- **`getUnreadCount` (Change 2a) — SKIPPED.** Must stay live; Realtime + the
  Change-1 explicit trigger keep it authoritative. Caching would make the badge
  stale. Change 1 already removes its per-nav refetch (the real volume win).

- **`getRolePermissions` (Change 2b) — SKIPPED.** `lib/api/auth.ts` left
  untouched. Already loaded once per session by `AuthContext.reloadPermissions`
  (mount/login/explicit reload); the only other caller is the permissions admin
  editor, which must read fresh after `setRolePermission`. A module cache adds
  staleness risk for near-zero volume benefit.

- **`getCompAllocationGames` / `getAssignmentsForFixtures` — SKIPPED.**
  Allocations DO change within a session via `assignCompFixture` /
  `unassignCompFixture`; caching risks stale allocations. Only the sport/season/
  competition facets are session-static and safe.

---

## CHANGE 3 — Master-timeline download fetches only xml_master

Files: `app/accuracy-checks/page.tsx` (download caller only). `lib/api/accuracyChecks.ts`
unchanged — `getSavedMasterXml` (selects ONLY `xml_master`) already existed.

### What changed
In `downloadMasterTimeline` (~L1142), the cold-path fallback changed from:
```ts
const fetched = await getAccuracyChecksXml([first.id]);
raw = fetched.get(first.id)?.xml_master ?? null;
```
to:
```ts
raw = await getSavedMasterXml(first.id);
```
`getSavedMasterXml` added to the existing `@/lib/api/accuracyChecks` import.

### Proof the file is byte-identical
- Warm-cache path is UNCHANGED and still tried first:
  `let raw = xmlById.get(first.id)?.xml_master ?? null;`.
- `getAccuracyChecksXml([first.id]).get(first.id).xml_master` and
  `getSavedMasterXml(first.id)` both read the SAME column `xml_master` for the
  SAME check id and return the SAME raw string (`getAccuracyChecksXml` selects
  `id, xml_master, xml_analyst`; `getSavedMasterXml` selects `xml_master` only).
  The only difference is the dropped (unused) `xml_analyst` blob.
- `raw` then flows through the unchanged `instancesFromRaw(raw)` →
  `serializeInstances` / `serializeInstancesToJson`, so the exported XML/JSON is
  identical. (Runtime before/after diff left as a runtime check; statically the
  same input string yields the same output.)

### Other caller unchanged
`getAccuracyChecksXml`'s other caller — the per-check player-accuracy fallback
effect (~L1017, selects BOTH blobs because it needs `xml_analyst`) — is
UNTOUCHED. `getAccuracyChecksXml` signature/behavior unchanged.

---

## Verification

| Command | Tree | Result |
|---|---|---|
| `npx tsc --noEmit` | worktree | **clean** (exit 0) |
| `npm run build -- --webpack` | worktree | **clean** — all 36 pages generated; in-build TypeScript check passed |
| `npm run build` (Turbopack) | worktree | panicked: `Symlink [project]/node_modules ... points out of the filesystem root` — KNOWN junction artifact, not a real failure; retried with `--webpack` per brief |
| `npx vitest --run` | worktree | 9 suites "No test suite found" — KNOWN junction artifact (jsdom env fails to resolve via the junctioned node_modules) |
| `npx vitest --run` | MAIN tree (`c:\Users\AndyDin\reporting-dashboard\reporting-ui`) | **9 passed / 92 tests passed** — confirms the test files are valid and the worktree failures are purely the junction artifact. (Main tree does not contain the worktree edits.) |

`createKeyedCache` (the mechanism Change 2 relies on) is already covered by the
passing `lib/api/cache.test.ts` suite (populate-once, dedupe-concurrent,
reset-on-error, invalidate-clears-all).

---

## Request-volume impact

- **Log ingestion (request COUNT) reduced:**
  - **Change 1** — the biggest win. The sidebar badge no longer refetches
    `getUnreadCount` (two Supabase reads: `conversation_members` + `messages`)
    and no longer tears down/reopens a Realtime channel on EVERY navigation,
    app-wide. Now set up once per user session; refresh only on actual reads /
    live inbound messages.
  - **Change 2** — the three-page `getCompFacets` full-table facet scan (paged
    1000-row reads) now runs at most once per variant per session until a
    comp-sync mutation invalidates the cache, instead of on every page mount.

- **Egress (bytes) reduced:**
  - **Change 3** — the master-timeline download fetches only `xml_master` for
    the one representative check instead of `xml_master` + `xml_analyst`,
    roughly halving the download's egress.
  - **Change 2** also trims egress slightly (fewer repeated facet scans).

## Functionality unchanged
Same data, same UX. Badge preserves initial count, live Realtime updates, and
clears-after-read. Facet dropdowns show identical values (invalidated on sync).
Master download produces a byte-identical file. No exported signatures changed;
no touched comparison engine, grading, DB schema, or pollers.
