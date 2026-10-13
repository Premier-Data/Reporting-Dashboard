# Empty-slot dispute permissions — requirements & design

## Summary

In the accuracy comparison video-review flow, raising ("flagging") a dispute is
currently gated to the **allocated analyst** of the loaded check (`canFlag`).
This task relaxes that gate for **empty-slot rows only**: any logged-in user
(any analyst or admin viewing the loaded timeline) may flag the single populated
side of a `missed` or `extra` row. Fully-populated rows keep the existing
allocated-analyst gate. Resolving disputes stays admin/super_admin only.

An empty-slot row is a `ComparisonRow` where exactly one side has an instance:

- `status === "missed"` → master has an instance, analyst slot is empty →
  dispute attaches to the **master** instance, `side = "master"`.
- `status === "extra"` → analyst has an instance, master slot is empty →
  dispute attaches to the **analyst** instance, `side = "analyst"`.

The dispute data model is unchanged. A dispute is keyed by
`(check_id, instance_id, side)` and always anchors to the populated side's
existing `instance.id`. There is no entity for the empty side, so the empty side
is never right-clickable.

## Grounding (verified against the code)

- `ComparisonRow` shape and statuses are defined in
  `lib/comparison/xml-compare.ts`: `{ status, master: Instance|null, analyst: Instance|null, timeDelta, alsoWrongPlayer? }`,
  `status ∈ exact | wrong_stat | wrong_player | wrong_team | missed | extra`.
  By construction of the matching engine, `missed` means "master instance, no
  analyst instance" and `extra` means "analyst instance with no master match".
  So on a `missed` row `row.master` is non-null and `row.analyst` is null; on an
  `extra` row `row.analyst` is non-null and `row.master` is null. A row with
  **both** sides empty is never produced (every row originates from at least one
  real instance). The four fully-populated statuses (`exact`, `wrong_stat`,
  `wrong_player`, `wrong_team`) always have both sides non-null.
- `app/accuracy-compare/page.tsx`:
  - `canFlag` (~line 951): `loadedCheckId != null && !!user && !!user.analyst_name && !!checkAnalystName && user.analyst_name.trim().toLowerCase() === checkAnalystName.trim().toLowerCase()`.
  - `canResolveDispute` (~line 960): `loadedCheckId != null && (user?.role === "admin" || user?.role === "super_admin")`.
  - `openFlagMenu` (~line 1320): computes `const allowFlag = canFlag;` and
    `const allowResolve = canResolveDispute && isFlagged;`, bails if neither.
  - `submitFlag` (~line 1333): creates the dispute from `flagMenu.instance` /
    `flagMenu.side`; records `raisedBy: user?.username ?? null`.
  - Review-pane timeline cells (~lines 3713–3745): `onFlag` is wired only when
    `(canFlag || canResolveDispute) && masterInstance` (master cell) and
    `(canFlag || canResolveDispute) && analystInstance` (analyst cell).
  - Hint text (~line 3464): shows "right-click an instance to flag it" when
    `canFlag`, else the resolve hint when `canResolveDispute`.
  - `FlagMenu` `mode` (~line 3773): `resolve` only when `canResolveDispute && flaggedKeys.has(...)`, else `flag`. Resolve mode is untouched by this change.
  - The review-pane loop (`videoRows.map((row, i) => { ... })`, ~line 3633)
    exposes `row.status` directly, plus `masterInstance` / `analystInstance`
    which are the **filter-adjusted** sides (null when the active stat/player
    filter hides that side). The raw sides are `row.master` / `row.analyst`.
- `flaggedKeys` (~line 1115) is a `useMemo`'d `Map<string, Dispute>` keyed by
  `disputeKey(instance_id, side)` (`"instanceId|side"`). It supports both `.has`
  (used by `openFlagMenu`'s `isFlagged` and the `FlagMenu` mode) and `.get`
  (used by `submitResolve` and the `FlagMenu` `dispute` prop). This change does
  not alter `flaggedKeys` or how it is read.
- `lib/api/disputes.ts`: `createDispute` upserts on `(check_id, instance_id, side)`;
  `DisputeSide = "master" | "analyst"`. No schema or API gap for this change.
- `components/auth/AuthContext.tsx`: `useAuth()` → `user` with `role` and
  `analyst_name`; `user` is null when not logged in.

## Functional requirements

1. Any authenticated user viewing a loaded check's timeline may raise a dispute
   on the populated side of a `missed` or `extra` row, with no allocation match.
2. On a `missed` row the flag targets `row.master` with `side = "master"`; on an
   `extra` row it targets `row.analyst` with `side = "analyst"`. The empty side
   is never flaggable (no instance to anchor to).
3. Fully-populated rows (`exact`, `wrong_stat`, `wrong_player`, `wrong_team`)
   remain flaggable **only** by the allocated analyst (`canFlag`), unchanged.
4. A user with no session (`user == null`) cannot flag any row.
5. Resolving a dispute stays admin/super_admin only (`canResolveDispute`),
   unchanged, including `FlagMenu` `mode === "resolve"`.
6. The video-review hint text must be accurate for a non-allocated user who can
   still flag empty-slot rows.

## Non-functional requirements

- Minimal, in-place change scoped to the empty-slot dispute permission. No
  refactor of unrelated `page.tsx` logic. No touch to `lib/api/clubConfig.ts`,
  `lib/api/clubLogos.ts`, or `lib/comparison/*`.
- No DB migration, no change to `lib/api/disputes.ts`.

## Design

### Technology stack (locked)

Client-side React + TypeScript inside the existing Next.js app
(`app/accuracy-compare/page.tsx`). No Next.js API or config changes are
introduced, so no deviation from this repo's Next.js conventions is required.
Supabase-backed `createDispute` is reused as-is.

### The permission predicate

Add one pure helper near `canFlag` / `canResolveDispute` (~line 960), taking the
row status and closing over the existing `canFlag` and `user`:

```ts
// A row where exactly one side has an instance.
const isEmptySlotStatus = (status: MatchStatus): boolean =>
  status === "missed" || status === "extra";

// Who may FLAG a given row:
//   - the allocated analyst may flag ANY row (existing gate), OR
//   - ANY logged-in user may flag an empty-slot (missed/extra) row.
// Fully-populated rows stay allocated-analyst-only.
const canFlagRow = (status: MatchStatus): boolean =>
  canFlag || (!!user && loadedCheckId != null && isEmptySlotStatus(status));
```

`MatchStatus` is already importable from `lib/comparison/xml-compare.ts` (the
page imports from that module). `canFlagRow` is pure w.r.t. its `status`
argument given the closed-over `canFlag`, `user`, `loadedCheckId`, which makes
the branch logic unit-testable by extracting an equivalent free function (see
Testability).

Chosen approach vs. alternative: the predicate keys off `row.status`, **not**
off `masterInstance != null` / `analystInstance != null`. The review pane's
`masterInstance` / `analystInstance` are filter-adjusted and go null when a
stat/player filter hides a side on a *fully-populated* row — using them would
wrongly treat a filtered populated row as empty-slot. `row.status` is the
authoritative, filter-independent signal, so it is the correct basis.

### Wiring point 1 — review-pane timeline onFlag (~lines 3713–3745)

Inside `videoRows.map((row) => ...)`, `row.status` is in scope. Replace the two
`onFlag` guards so empty-slot rows become right-clickable for any logged-in
user, while still requiring the populated instance to exist:

```tsx
// master cell
onFlag={
  (canFlagRow(row.status) || canResolveDispute) && masterInstance
    ? (e) => openFlagMenu(e, masterInstance, "master")
    : undefined
}

// analyst cell
onFlag={
  (canFlagRow(row.status) || canResolveDispute) && analystInstance
    ? (e) => openFlagMenu(e, analystInstance, "analyst")
    : undefined
}
```

This is a drop-in substitution of `canFlagRow(row.status)` for the bare
`canFlag`. Because `missed` rows have only a master instance and `extra` rows
only an analyst instance, the `&& masterInstance` / `&& analystInstance`
conjuncts already restrict the flag to the single populated side — the empty
side's cell has a null instance and stays non-flaggable. `canResolveDispute`
stays in the disjunction so admins keep right-click access to already-flagged
instances exactly as today.

Note the pre-existing `&& masterInstance` conjunct uses the **filter-adjusted**
side, so a filtered-out populated side is non-flaggable while the filter hides
it. That is existing, acceptable behaviour (the user can only flag what they can
see) and is unchanged by this task.

### Wiring point 2 — openFlagMenu internal guard (~line 1320)

`openFlagMenu` currently hard-codes `const allowFlag = canFlag;`, which would
silently block the newly-allowed users even though the cell now offers the
handler. It must derive the row status from the clicked side's row. The menu is
only ever opened from a timeline cell, so the clicked `instance` + `side`
determine the row: find the comparison row whose populated side matches.

Change the signature to accept the row status, passed by the call sites, which
already have `row.status` in scope:

```ts
const openFlagMenu = (
  e: React.MouseEvent,
  instance: Instance,
  side: DisputeSide,
  status: MatchStatus
) => {
  const isFlagged = flaggedKeys.has(disputeKey(instance.id, side));
  const allowFlag = canFlagRow(status);
  const allowResolve = canResolveDispute && isFlagged;
  if (!allowFlag && !allowResolve) return;
  e.preventDefault();
  setFlagMenu({ x: e.clientX, y: e.clientY, instance, side });
};
```

Call sites become `(e) => openFlagMenu(e, masterInstance, "master", row.status)`
and `(e) => openFlagMenu(e, analystInstance, "analyst", row.status)`.

Passing `row.status` explicitly is preferred over having `openFlagMenu`
re-derive the row by searching the comparison result: the status is already in
scope at both call sites, so passing it avoids an extra lookup and the ambiguity
of matching an instance back to its row. This keeps the guard a pure function of
its arguments and keeps non-allocated users blocked on fully-populated rows
(where `canFlagRow` returns false and the row isn't flagged, so both `allowFlag`
and `allowResolve` are false).

### Wiring point 3 — hint text (~line 3464)

The hint currently only mentions flagging when `canFlag`. Broaden it so a
non-allocated user who can still flag empty-slot rows sees an accurate hint.
A logged-in viewer can always flag at least the empty-slot rows, so:

```tsx
{canFlag
  ? " · right-click an instance to flag it"
  : user
    ? " · right-click a missed/extra instance to flag it"
    : ""}
{canResolveDispute
  ? " · right-click a flagged instance to resolve it"
  : ""}
```

Chosen wording keeps the allocated-analyst phrasing unchanged and adds a
narrower phrase for everyone else, naming the rows they can act on. The resolve
hint is split into its own conditional so an admin who is **not** the allocated
analyst sees both the empty-slot flag hint and the resolve hint (previously the
`else-if` chain showed only one). This is a copy-only change; it does not alter
permissions.

### FlagMenu resolve mode — unchanged

`FlagMenu`'s `mode` stays `canResolveDispute && flaggedKeys.has(...) ? "resolve" : "flag"`
(~line 3773). Newly-allowed empty-slot flaggers who are not admins get
`mode === "flag"`, which is correct. No change here.

### Dispute creation / DB — no change

`submitFlag` already builds the dispute from `flagMenu.instance` /
`flagMenu.side` and records `raisedBy: user?.username ?? null`. For an empty-slot
flag the populated instance's real `id` is used, and `createDispute` upserts on
`(check_id, instance_id, side)`. No new column, no new side value, no API
change. **No DB migration is required.** No gap was found.

## Error handling & validation

- **Not logged in** (`user == null`): `canFlagRow` returns false for every
  status (the `!!user` conjunct fails and `canFlag` is already false without a
  user), `openFlagMenu` returns early, and no `onFlag` handler is attached.
  Nothing is created. Not recoverable within the UI (user must log in); no log
  needed — this is a normal gated state, not an error.
- **No check loaded** (`loadedCheckId == null`): `canFlag` is false and the
  `loadedCheckId != null` conjunct in `canFlagRow` fails, so flagging is off;
  `submitFlag` also early-returns on `loadedCheckId == null`. Normal gated state.
- **Flag on a fully-populated row by a non-allocated user**: `canFlagRow`
  returns false, `openFlagMenu` returns early. If the row is already flagged and
  the user is an admin, `allowResolve` still opens the resolve menu — existing
  behaviour, intended.
- **`createDispute` failure** (network/Supabase): unchanged — `submitFlag`
  catches and shows `alert(err.message || "Failed to flag instance.")`;
  `createDispute` logs via `console.error`. Recoverable (user retries). No new
  handling introduced.
- **Validation of the flag input**: unchanged. `instance.id` is a required
  non-empty string from the parsed instance; `side` is a typed `DisputeSide`
  literal fixed by the cell (`"master"` / `"analyst"`); `reason` / `category`
  are optional and already trimmed/normalised by `createDispute`. The predicate
  adds no new external input — `row.status` is an internal typed `MatchStatus`.

## Invariants & ownership

- **"Empty side is never flaggable"** is enforced at the view layer: the
  `onFlag` guard requires the filter-adjusted populated instance
  (`&& masterInstance` / `&& analystInstance`) and the empty side's cell carries
  a null instance, so no handler is attached. The `page.tsx` review-pane owns
  this; it is the only surface that opens the flag menu.
- **"Fully-populated rows stay allocated-analyst-only"** is owned by
  `canFlagRow`: for non-empty-slot statuses it reduces to `canFlag`. Centralising
  the rule in one predicate (used by both the cell guard and `openFlagMenu`)
  keeps the two surfaces from diverging.
- **"A dispute always anchors to a real instance"** is owned by the data model
  (`createDispute` requires `instanceId`); the design never attempts to create a
  dispute for an empty side.

## Edge cases

- User who is BOTH the allocated analyst AND viewing: `canFlag` is true, so
  `canFlagRow` is true for every row — flags all rows as before. Unchanged.
- Admin who is NOT the allocated analyst: `canFlag` false; `canFlagRow` true for
  `missed`/`extra` (logged in) → may flag empty-slot rows now; false for
  fully-populated rows → still cannot flag those (but can still *resolve* any
  flagged row via `canResolveDispute`).
- Analyst allocated to a DIFFERENT check: `canFlag` false; may now flag
  empty-slot rows on the viewed check, cannot flag its fully-populated rows.
- Not-logged-in viewer: blocked on all rows (flag and resolve).
- Stat/player filter active hiding one side of an empty-slot row: that side's
  instance is filtered to null, so its cell is non-flaggable while hidden —
  existing, acceptable behaviour, not changed here.

## Per-case permission table

Logged-in = any authenticated user (any analyst or admin). Allocated = the
check's analyst (`canFlag` true). Admin = role admin/super_admin.

| Row status (populated side) | Not logged in | Logged in, not allocated, not admin | Logged in, not allocated, admin | Allocated analyst |
|---|---|---|---|---|
| `missed` (master) → flag `side="master"` | ❌ | ✅ flag | ✅ flag (+ resolve if flagged) | ✅ flag |
| `extra` (analyst) → flag `side="analyst"` | ❌ | ✅ flag | ✅ flag (+ resolve if flagged) | ✅ flag |
| `exact` (both) | ❌ | ❌ | ❌ flag; ✅ resolve if flagged | ✅ flag |
| `wrong_stat` (both) | ❌ | ❌ | ❌ flag; ✅ resolve if flagged | ✅ flag |
| `wrong_player` (both) | ❌ | ❌ | ❌ flag; ✅ resolve if flagged | ✅ flag |
| `wrong_team` (both) | ❌ | ❌ | ❌ flag; ✅ resolve if flagged | ✅ flag |

Resolve column reflects `canResolveDispute`, which is unchanged (admin/
super_admin only, and only on already-flagged instances).

## Testability

- **Unit-testable (pure):** extract the predicate as a free function
  `canFlagRow(status, { isAllocated, isLoggedIn, hasCheck })` and the
  `openFlagMenu` branch (`allowFlag || allowResolve`). Cover the full matrix
  above: each status × {not logged in, logged-in non-allocated, admin
  non-allocated, allocated} × {flagged, not flagged} for the resolve branch. No
  DOM or Supabase needed.
- **Integration-testable:** render the review pane with a loaded check and a
  mocked `useAuth`, assert that `onFlag` is attached only to the expected cells
  (populated side of `missed`/`extra` for a non-allocated user; both sides for
  the allocated analyst; none when logged out) and that `createDispute` is
  called with the correct `side` and the populated instance's `id`. The
  `createDispute` call itself is mocked, so no DB.
- A design note on isolation: because the predicate is centralised and pure, the
  two wiring surfaces (cell guard, `openFlagMenu`) can be tested through the same
  function, so they can't silently diverge.

## Out of scope

- Any change to the dispute schema, `lib/api/disputes.ts`, or resolve
  permissions.
- Flagging the empty side of a row (impossible — no instance).
- Changes to the comparison engine / matching in `lib/comparison/*`.
- The unrelated uncommitted changes on this branch
  (`lib/api/clubConfig.ts`, `lib/api/clubLogos.ts`, `lib/comparison/*`).
- Committing or pushing.

## Assumptions

- `MatchStatus` is already imported in `page.tsx` from
  `lib/comparison/xml-compare.ts` (verified: line 67, alongside `ComparisonRow`
  and `Instance`). No new import is needed.
- The video-review pane is the sole surface that opens the flag menu. Verified:
  the non-video comparison table (`filteredRows.map`, ~line 3366) wires only
  `onSeek` / `onEdit` on its `TimelineCell`s and renders flagged state via
  `flaggedKeys` — it attaches no `onFlag`, so no gating change is needed there.
