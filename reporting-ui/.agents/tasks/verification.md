# Verification — Soccer JSON adapter keys the comparison stat on `statTypeName`

Feature: the soccer (football) JSON adapter now references the feed's
`statTypeName` for the comparison timeline/stat instead of the
`statTypeCode`-derived canonical label. Implemented in
`lib/comparison/json-adapter.ts` (`defaultMapStatName` inverted to
name-primary) plus re-baselined/extended tests in
`lib/comparison/json-adapter.test.ts`.

## Iteration note — the on-disk review.json is STALE

`.agents/tasks/review.json` reads `"verdict":"APPROVED","findings":[]` but its
`reviewDoc` points at the UNRELATED `player-category-tally` worktree, and the
on-disk `verification.md` described `player-category-tally` / `afl-golden`, not
this task. The branch `feat/json-stat-name` sat at `origin/main` with NO
json-stat-name commit, and `defaultMapStatName` in source was still code-primary
— i.e. the core change had not been made. So those artifacts are leftovers from
other features sharing this `.agents/tasks` dir; this was implemented from
scratch per `json-stat-name-plan.md`. This note replaces the stale content.

## AGENTS.md Next.js-docs rule

N/A for new Next.js API surface. The change is pure TypeScript inside
`lib/comparison/` (a stat-mapping function + tests). No Next.js API is touched,
so no guide under `node_modules/next/dist/docs/` applied. Rule acknowledged.

## Core change (`lib/comparison/json-adapter.ts`)

- `defaultMapStatName(statTypeName, statTypeCode)` INVERTED to name-primary:
  a non-empty trimmed `statTypeName` is returned as-is as the canonical stat
  label. The code path (`STAT_CODE_MAP[code]` → else `deCamel(code)` → else
  `""`) is now the FALLBACK, used only when the name is missing/empty.
- `STAT_CODE_MAP`, `deCamel`, `defaultMapCategory`, `classifyCategory`, and the
  native export round-trip (`CANONICAL_TO_NATIVE` / `serializeInstancesToJson`)
  are UNCHANGED. `classifyCategory` already buckets the fixture's name-based
  labels correctly (shot→Shots, keeper→Goal Keeper, pass→Passing, header→General
  Play), so no regex change was warranted.
- `isExcludedStatLabel` still checks both code and name (unchanged).
- AFL untouched (AFL uses XML via `afl-player-accuracy.ts`, not this adapter).

## Tests (`lib/comparison/json-adapter.test.ts`)

Re-baselined per the user directive (name-based wins):
- "maps JSON statTypeCode to the exact XML stat labels" → rewritten as
  "uses the feed statTypeName as the canonical stat (name-primary)": each real
  fixture `code|name` pair now asserts the NAME (e.g. `ShortPassEffective|Pass`
  → "Pass", `Goal|Shot in Play` → "Shot in Play").
- Added "falls back to the code-derived label only when the name is empty":
  `("","ShortPassEffective")`→"Short Passes Successful",
  `("   ","CrossIneffective")`→"Crosses Unsuccesful" (keeps XML misspelling),
  `("","SomeNewCode")`→"Some New Code", `("","")`→"".
- "runs the full comparison…": the `paired > 500` magic number was replaced
  with `paired > 100` plus a comment. Against the XML master the name-keyed feed
  now pairs on fewer stats (observed `paired = 251`, down from ~500+) because the
  coarse feed names ("Pass", "Shot in Play") do not line up with the XML's
  fine-grained labels. This is the intended consequence of name-keying, which is
  designed for JSON-vs-JSON (same platform, same names), not JSON-vs-XML. The
  self-consistency assertions (buckets sum to masterTotal, accuracy in [0,1])
  are kept.

New `describe("JSON adapter — name-primary stat mapping")`:
- `Instance.stat` equals the feed name for `ShotOffTarget|Header Shot`,
  `Goal|Shot in Play`, `Save|Keeper` (not the code labels).
- Two events with the same name pair on that name.
- Empty name falls back to the code-derived label.
- Category still resolves: `ShotOffTarget`/`Goal`→"Shots", `Save`→"Goal Keeper",
  `Header`→"General Play", `ShortPassEffective`→"Passing"; plus the name-only
  `classifyCategory` fallback path.
- Exclusions still drop Start Half (code) and Substitution (name).
- End-to-end: two JSON feeds with the SAME names at the same player/team/time
  produce EXACT matches (accuracy 1) through `compareInstances`.
- Native export round-trip: a name-based non-canonical label ("Header Shot")
  exports as code "" + name "Header Shot" and re-imports to the same name; a
  canonical label ("Carries") exports its native name "Carry" and re-imports to
  "Carry" (documented name-primary shift).

## Commands — run directly in the worktree app, exit 0

Tree: `c:\Users\AndyDin\reporting-dashboard\.worktrees\json-stat-name\reporting-ui`

1. `npx vitest --run lib/comparison/json-adapter.test.ts`
   → `Test Files 1 passed (1)`, `Tests 14 passed (14)`, exit 0.
2. `npx vitest --run` (full suite)
   → `Test Files 13 passed (13)`, `Tests 176 passed (176)`, exit 0.
   All other suites (xml-compare, afl, player-category-tally, check-category,
   player-accuracy, etc.) stay green — no regression.
3. `npx tsc --noEmit` → clean, exit 0.
4. `npm run build` → succeeded, exit 0; all 34 app routes generated including
   `/accuracy-compare`, `/accuracy-checks`, `/fixture-review`. No dev server.

## Cleanup / staging

- No scratch files created. `.env` / `.env.local` NOT staged.
- Staged source + test + task artifacts only.
