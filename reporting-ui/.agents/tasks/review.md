# Supabase request-volume reduction — three behavior-preserving reads cut

Three independent changes trim redundant Supabase traffic without altering what the user sees. The sidebar unread badge stops refetching and re-subscribing on every navigation (now set up once per user, refreshed live via Realtime and explicitly on read). The comp-fixtures facet scan — a full-table paged read run on three pages' mount — is cached per session behind the existing `cache.ts` keyed-cache pattern and invalidated on every comp-sync mutation. The master-timeline download fetches only `xml_master` instead of both XML blobs, halving its egress. All edits stay inside the files named in the plan; exported signatures are untouched.

Watch for: the Turbopack build and worktree vitest run both failed in the worktree and were only validated in the main tree (which does not contain these edits) — but the worktree `tsc --noEmit` and the worktree `--webpack` build both ran clean against the edited code, so type-safety and compilation of the changes are covered (confirmed). `purgeExcludedCompetitions` invalidates the facet cache only when `removed > 0`, which is correct because a zero-removal run changes nothing (confirmed).

**Verdict**: APPROVED

## High-level view

Change 1 is the gating behavioral change. The sidebar badge effect dependency moved from `[user, pathname]` to `[user]`, so the initial `getUnreadCount` fetch and the `subscribeToAllMessages` Realtime channel are established once per session instead of being torn down and rebuilt on every route change. The old "clears after read" behavior rode on the pathname re-run; it is now replaced by an explicit in-process event — `markConversationRead` fires `notifyUnreadChanged`, the sidebar's `refresh` is registered via `onUnreadShouldRefresh`, so the badge drops on read with no navigation. All three badge behaviors (initial count, live increment, clears-after-read) trace cleanly through the code.

Change 2 caches only `getCompFacets`, the one session-static full-table scan, keyed on the `accuracy`/`normal` variant and invalidated at the end of every function that writes `comp_fixtures` contents. The other candidate reads (`getUnreadCount`, `getRolePermissions`, allocation reads) are documented SKIPs with sound liveness reasoning — `getUnreadCount` in particular must stay uncached so Realtime and the Change-1 trigger remain authoritative.

Change 3 repoints the download's cold-path fallback from `getAccuracyChecksXml` (which selects `id, xml_master, xml_analyst`) to `getSavedMasterXml` (which selects `xml_master` only). Both read the same column for the same id and return the same string, so the serialized file is byte-identical; the only difference is the dropped unused analyst blob. The other `getAccuracyChecksXml` caller is untouched and its signature is unchanged.

The recorded verification is partially indirect: the worktree junction broke Turbopack and the jsdom-based vitest run, so the author ran the full suite in the main tree and relied on the worktree's clean `tsc` and `--webpack` build for the edits themselves. That split is explained rather than hidden, and the edited files carry no dedicated behavioral tests that a worktree run would have exercised beyond what `tsc` + build already cover.

<details>
<summary>Issues (2)</summary>

1. **Indirect test evidence** — worktree vitest and Turbopack build failed on a known junction artifact; the suite was validated in the main tree, which lacks the edits. Non-blocking: worktree `tsc --noEmit` and `--webpack` build ran clean against the actual edits, and the changed files have no dedicated behavioral tests, so the main-tree run would not have exercised the new behavior regardless. Runtime proofs (badge network panel, before/after file diff) remain the author's noted manual checks.
2. **Facet-cache liveness depends on sync invalidation discipline** — the cache is only dropped by the four comp-sync functions; any future direct writer to `comp_fixtures` sport/season/competition columns that bypasses them would serve stale facets. No such writer exists today (confirmed), so not blocking.

</details>

<details>
<summary>Details</summary>

## Sidebar badge: subscribe once per user, refresh on read instead of per-nav

The effect now keys on `[user]` alone (confirmed — diff line `}, [user];` replacing `[user, pathname]`). `usePathname` is retained because `pathname.startsWith(item.href)` still drives active-link highlighting (confirmed, Sidebar.tsx L362), so the retained import is live code, not a leftover.

The three badge behaviors hold up against the code:

(a) Initial count — the effect body calls `refresh()` on mount, which runs `getUnreadCount(uid)` → `setUnread(n)`, unchanged from before (confirmed).

(b) Live update — `subscribeToAllMessages(refresh)` is still opened inside the effect and is unchanged in `messages.ts`; a new inbound INSERT still calls `refresh`, bumping the badge with no navigation (confirmed — subscription code untouched in the diff, callback wiring intact).

(c) Clears after read — opening a conversation calls `getMessages`, which calls `markConversationRead` (confirmed, messages.ts L477). `markConversationRead` now calls `notifyUnreadChanged()` after the `last_read_at` update succeeds (confirmed, diff), which fires every `onUnreadShouldRefresh` listener — the sidebar's `refresh` — dropping the badge without a route change. This explicit trigger is a faithful replacement for the pathname re-run that previously drove the same refresh.

The new event mechanism is pure and Supabase-free: a module-level `Set<() => void>`, each listener guarded so one throwing callback cannot break the others. Cleanup unsubscribes both the Realtime channel and the read listener (confirmed, diff). With the subscription living for the session and the sidebar mounted once in the authenticated layout, unrelated navigation issues no new `conversation_members`/`messages` reads and does not reopen the channel — the request-volume win. The runtime Network-panel confirmation of (d) is left as a manual check, but it follows statically from the dependency-array change and the single mount point.

## Comp-fixtures facet cache keyed on the accuracyOnly variant

The body of `getCompFacets` moved into a private `fetchCompFacets(key)` and the export now returns `compFacetsCached.get(options.accuracyOnly ? "accuracy" : "normal")`. The exported signature `getCompFacets(options?: { accuracyOnly?: boolean })` is unchanged (confirmed). Keying on the two-valued string means the accuracy and normal variants cache independently — important, since they tally different competition subsets from the same scan.

```
getCompFacets(accuracyOnly?) ──► compFacetsCached.get("accuracy"|"normal")
                                        │ miss
                                        ▼
                                 fetchCompFacets(key)  (paged full-table scan)
   fullSync ───────────────┐
   incrementalSync ────────┤
   resyncCompetitions ─────┼──► compFacetsCached.invalidate()  (map.clear)
   purgeExcludedCompetitions (removed>0) ┘
```

Every function that writes `comp_fixtures` contents invalidates the cache. The underlying writer is `syncOne`'s delete+insert, reached only through `fullSync`, `resyncCompetitions`, and `incrementalSync`, each of which invalidates at the end (confirmed — all five `syncOne` call sites traced). `purgeExcludedCompetitions` deletes directly and invalidates when `removed > 0`; a zero-removal run leaves the table and the facets unchanged, so skipping the invalidate there is correct, not a gap. Allocation writes target the separate `comp_fixture_assignments` table and do not touch the facet columns, so they correctly do not invalidate.

The cache hands back a shared read-only instance, so the three caller pages must only read / `setState` the arrays — an in-place sort/push would corrupt the shared entry per the `cache.ts` contract. The code comment asserts this holds for the current callers; it is the one invariant a future caller could silently break.

The SKIP decisions are sound and documented. `getUnreadCount` stays uncached so Realtime plus the Change-1 trigger remain authoritative — caching it would reintroduce the staleness Change 1 is designed to avoid. `getRolePermissions` is already loaded once per session by `AuthContext`, and the allocation reads change within a session, so neither is a safe cache target. These are documented SKIPs, which the brief treats as acceptable rather than findings.

## Master-timeline download fetches only xml_master

```
downloadMasterTimeline:
  raw = xmlById.get(first.id)?.xml_master      (warm cache, unchanged, tried first)
  if (!raw) raw = await getSavedMasterXml(first.id)   ◄── was getAccuracyChecksXml([first.id])
  instancesFromRaw(raw) ─► serializeInstances / serializeInstancesToJson
```

`getSavedMasterXml` selects `xml_master` only and returns `data?.xml_master ?? null` (confirmed, accuracyChecks.ts). `getAccuracyChecksXml` selects `id, xml_master, xml_analyst` and the download read `.get(first.id)?.xml_master` from it. Both read the same `xml_master` column for the same id, so `raw` is the same string on either path; the dropped `xml_analyst` was never consumed by the download. Since `raw` flows unchanged into `instancesFromRaw` and the serializers, the exported XML and JSON are byte-identical — the before/after file diff remains the author's noted manual confirmation, but it follows from identical input.

The warm-cache path (`xmlById.get(first.id)?.xml_master`) is unchanged and still tried first (confirmed, diff). The other `getAccuracyChecksXml` caller — the per-check player-accuracy fallback that needs both blobs — is untouched, and `getAccuracyChecksXml`'s signature and behavior are unchanged, so no existing caller breaks (confirmed). `getSavedMasterXml` also has a pre-existing internal caller in `mergeAccuracyChecks`; its signature is unchanged, so that path is unaffected.

## Verification evidence

The recorded evidence is internally consistent and transparent about its one limitation. In the worktree, `tsc --noEmit` ran clean (exit 0) and `npm run build -- --webpack` generated all 36 pages with the in-build TypeScript check passing — both against the edited code, covering type-safety and compilation of all three changes. The Turbopack build panicked and the jsdom vitest run reported "No test suite found", both attributed to the worktree being a filesystem junction; the author re-ran the full vitest suite in the main tree (9 suites / 92 tests passing) to show the test files are themselves valid. The main tree does not contain the edits, so that run does not validate the new behavior — but the changed files carry no dedicated behavioral tests, so a worktree run would not have exercised the new badge/cache/download paths beyond what `tsc` and the webpack build already confirm. The `createKeyedCache` mechanism Change 2 relies on is covered by the passing `cache.test.ts`. The behavioral proofs are static walkthroughs, independently re-traced against the code above.

</details>

<details>
<summary>Files changed</summary>

- `components/layout/Sidebar.tsx` — badge effect keyed on `[user]`; subscribes to new read-refresh event alongside Realtime.
- `lib/api/messages.ts` — adds pure `onUnreadShouldRefresh` / `notifyUnreadChanged` event; `markConversationRead` fires it on success.
- `lib/api/compFixtures.ts` — `getCompFacets` wrapped in `createKeyedCache`; invalidation added to the four comp-sync mutations.
- `app/accuracy-checks/page.tsx` — download cold-path fallback switched to `getSavedMasterXml` (master-only fetch).
- `.agents/tasks/plan.md`, `.agents/tasks/implementation-note.md` — planning/record docs (not production code).

Full working-tree diff: `git diff` in `c:\Users\AndyDin\reporting-dashboard\.worktrees\req-reduction` (branch `perf/request-reduction`).

</details>
