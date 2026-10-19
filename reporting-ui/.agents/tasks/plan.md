# Implementation Plan — Player Category Volume (analyst vs master)

Scope: build the per-player, per-category VOLUME tally section below the Golden
Player Accuracy cards on the Accuracy Comparison page. Only three files are
touched: the new pure module `lib/comparison/player-category-tally.ts`, its
test `lib/comparison/player-category-tally.test.ts`, and
`app/accuracy-compare/page.tsx`. No change to `player-accuracy.ts` exported
behaviour, the Golden computation, the comparison engine (`xml-compare.ts`), the
DB, or any unrelated file. Follows the approved design at
`.agents/tasks/design.md`.

All paths below are relative to the worktree root
`c:\Users\AndyDin\reporting-dashboard\.worktrees\player-category-tally\reporting-ui`.

Environment confirmed during exploration:
- Test runner: Vitest (`package.json` → `"test": "vitest --run"`, `vitest@^3.2.7`,
  `vitest.config.ts` with `environment: "jsdom"`, `include: ["**/*.test.ts","**/*.test.tsx"]`).
- Build: `npm run build` (Next.js `next build`). Lint: `npm run lint` (ESLint 9).
- Style reference for tests: `lib/round-summary/roundSummary.test.ts`
  (`import { describe, it, expect } from "vitest"`).
- `Instance` type (from `lib/comparison/xml-compare.ts`) fields for fixtures:
  `id, start, end, mid, team, playerNumber, playerRaw, stat, category, code`.
- `player-accuracy.ts` exports confirmed present and importable:
  `initFootballCounts`, `bumpFootball`, `deriveFootball`, `FOOTBALL_GROUPS`,
  and the `FootballCounts` type. `FOOTBALL_GROUPS` keys are
  `passing | offensive | defensive | goalkeeper | other`, each with
  `{ label, parts: [{ key, label }] }`.
- Golden `playerAccuracy` useMemo lives at `page.tsx` ~line 2067; its scope is
  `inRange(i) && (teamFilter === "all" || i.team === teamFilter)` over
  `canonical.master`/`canonical.analyst`, deps
  `[canonical, sport, tolerance, effectiveRange, teamFilter]` with an
  `eslint-disable react-hooks/exhaustive-deps`.
- `playerTable` useMemo (~line 2149): key/display is `` `${team} - #${number ?? "?"}` ``,
  sort is `analystOnly`-last → `a.team !== b.team` localeCompare → `(number ?? 999)`,
  `analystOnly = inAnalyst && !inMaster`, filtered by `sportConfig.relevant`.
- `relevant()` (football, `page.tsx` ~line 633) sums a DIFFERENT key set than the
  five displayed categories — the new drop rule is NOT this filter and is not
  imported from it.
- Golden cards JSX block `{playerAccuracy && ( … )}` opens ~line 2921 and closes
  `)}` ~line 2946, immediately before the "Category breakdown + per-stat
  breakdown" grid (`<div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">`).
- Player stats table render (~line 3131+): outer wrapper, `max-h-[520px]
  overflow-auto`, sticky header `bg-slate-50 text-xs font-semibold uppercase
  tracking-wider text-slate-500`, row `group border-b border-slate-100
  last:border-b-0 hover:bg-slate-50/60` (+ `bg-red-50/60` when analystOnly),
  sticky player `<td>` `sticky left-0 z-10 whitespace-nowrap px-4 py-2
  font-medium text-slate-800` (+ `bg-red-50`/`bg-white`, `group-hover:bg-slate-50`),
  `analyst only` badge `ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px]
  font-semibold text-red-700`, and `tfoot` `sticky bottom-0 z-10` with totals row
  `border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900` and a sticky
  label `<td>` `sticky left-0 z-20 whitespace-nowrap bg-slate-100 px-4 py-2.5 text-left`.

---

- [ ] 1. Create the pure module `lib/comparison/player-category-tally.ts`.
      Implement, per design D2, exactly these exports and nothing that mutates
      or re-implements classification logic: the `CategoryKey` type and
      `CATEGORY_KEYS = ["passing","offensive","defensive","goalkeeper","other"] as const`;
      `CATEGORY_LABELS: Record<CategoryKey,string>` read from
      `FOOTBALL_GROUPS[key].label`; the `CategoryCell` type `{ a:number; m:number;
      pct:number|null }`; the pure metric `categoryAccuracy(a,m)` —
      `m===0 ⇒ { a, m, pct:null }`, else `pct = Math.max(0, Math.min(1, (m - Math.abs(a-m))/m))`;
      a private `categoryTotal(derived: FootballCounts, key: CategoryKey)` that
      sums `FOOTBALL_GROUPS[key].parts.map(p => derived[p.key] ?? 0)`; the
      `PlayerCategoryRow` type `{ key, team, number, display, analystOnly,
      cells: Record<CategoryKey,CategoryCell> }`; and the aggregator
      `computePlayerCategoryTally(masterInstances: Instance[], analystInstances:
      Instance[]): PlayerCategoryRow[]` following D2.4 steps 1–9 — build a
      `Map` keyed `` `${i.team.toLowerCase()}|${i.playerNumber ?? "?"}` ``, seed
      sides with `initFootballCounts()`, remember first-seen `team` (original
      case) + `number`, `bumpFootball(side, i.stat.toLowerCase())` for each
      instance (set `inMaster`/`inAnalyst`), `deriveFootball` both sides, fill
      `cells[key] = categoryAccuracy(categoryTotal(da,key), categoryTotal(dm,key))`,
      set `display = `${team} - #${number ?? "?"}`` and `analystOnly =
      inAnalyst && !inMaster`, DROP a row iff the sum of all five displayed
      category totals is 0 on BOTH sides, then sort with the exact `playerTable`
      guarded comparator (`analystOnly` last → `a.team !== b.team` localeCompare →
      `(number ?? 999)`). Import `initFootballCounts, bumpFootball, deriveFootball,
      FOOTBALL_GROUPS, type FootballCounts` from `./player-accuracy` and
      `type Instance` from `./xml-compare`. Add the D2.3/D5 code comment recording
      the key/display/sort-parity-with-`playerTable` relationship and that the row
      set deliberately differs (sourced from `canonical.*`, five-category drop
      rule, not `relevant()`). Do not call `canonicaliseTeams` (D3 — the page
      already canonicalised).
      Files: `lib/comparison/player-category-tally.ts`
      Verify: `npx tsc --noEmit` reports no new errors in the module (full
      type-check is exercised in step 3's build).

- [ ] 2. Create the unit test `lib/comparison/player-category-tally.test.ts`.
      Use Vitest (`import { describe, it, expect } from "vitest"`), mirroring
      `lib/round-summary/roundSummary.test.ts` style. Add a small inline
      `inst(partial)` factory producing a valid `Instance` (fill `id,start,end,mid,
      team,playerNumber,playerRaw,stat,category,code`). Cover: AC1 `categoryAccuracy(6,6)
      ⇒ {a:6,m:6,pct:1}`; AC2 `(4,6) ⇒ pct` ≈ `2/3` (assert `toBeCloseTo(2/3)`);
      AC3 `(0,3) ⇒ pct:0`; AC4 `(0,0) ⇒ pct === null` (STRICT identity); AC5
      `(9,6) ⇒ pct:0.5`; AC6 `(20,6) ⇒ pct:0`. For `computePlayerCategoryTally`:
      AC7 — a player with master defensive labels
      `["Interceptions","Clearances","Blocks","Tackles Successful"]` and analyst
      `["Interceptions","Clearances"]` yields Defensive `{a:2,m:4,pct:0.5}` and
      Passing `pct === null` (strict); AC8 — master-only player has analyst cells 0,
      analyst-only player has master cells 0 and `analystOnly === true`; AC8a — a
      GK-only player (`["Save","Save","Catch"]`) or blocks-only player is KEPT
      (has Goalkeeper/Defensive volume); AC8b — a player with only
      `["Ball Recovery","Aerial Win"]` is DROPPED (maps to no displayed category);
      AC9 — sort order is `analystOnly`-last then team (localeCompare) then
      `number ?? 999`, matching `playerTable`.
      Files: `lib/comparison/player-category-tally.test.ts`
      Verify: `npm test -- lib/comparison/player-category-tally.test.ts` — all new
      tests pass (`npm test` runs `vitest --run`).

- [ ] 3. Wire the tally into `app/accuracy-compare/page.tsx` and render the section.
      (a) Add an import of `computePlayerCategoryTally, categoryAccuracy,
      CATEGORY_KEYS, CATEGORY_LABELS, type CategoryCell` from
      `@/lib/comparison/player-category-tally` alongside the existing
      `player-accuracy` import. (b) Add a `playerCategoryTally` useMemo directly
      after the Golden `playerAccuracy` useMemo (~line 2082): return `null` when
      `!canonical || sport !== "football"`; build `inScope = (i) => inRange(i) &&
      (teamFilter === "all" || i.team === teamFilter)`; call
      `computePlayerCategoryTally(canonical.master.filter(inScope),
      canonical.analyst.filter(inScope))`; deps
      `[canonical, sport, tolerance, effectiveRange, teamFilter]` with the same
      `// eslint-disable-next-line react-hooks/exhaustive-deps` line the Golden
      memo uses. Do NOT call `compareInstances` (volume reconciliation needs no
      pairing). (c) Add a local `CategoryTallyCell({ cell }: { cell: CategoryCell })`
      component near the other local cell components (per D6): muted when
      `cell.m===0 && cell.a===0`, `pctText = cell.pct == null ? "—" :
      `${Math.round(cell.pct*100)}%``, amber emphasis when
      `cell.pct != null && cell.a !== cell.m`, markup/classes as in D6.
      (d) Insert the section JSX immediately AFTER the Golden block's closing `)}`
      (~line 2946) and BEFORE the "Category breakdown" grid, gated
      `{playerCategoryTally && playerCategoryTally.length > 0 && ( … )}`: a
      heading "Player category volume (analyst vs master)" with the one-line
      sub-caption, using the Golden block's label styling (`text-xs font-semibold
      uppercase tracking-wider text-slate-500`) and a scope chip
      (`teamFilter === "all" ? "Both teams" : teamDisplay(teamFilter)`); a table
      reusing the Player stats table's wrapper/scroll/sticky-header/row/
      player-cell/badge classes (verified ~line 3131+), one header cell per
      category from `CATEGORY_LABELS` in `CATEGORY_KEYS` order, rows rendering
      `row.display` + `analyst only` badge when `row.analystOnly`, and a
      `CategoryTallyCell` per category; and a `tfoot` "Team totals" row (D6)
      summing each category's `a` and `m` across visible rows and running the two
      sums through `categoryAccuracy`, reusing the verified footer classes.
      Files: `app/accuracy-compare/page.tsx`
      Verify: `npm run build` succeeds (type-check + Next.js compile pass) and
      `npm run lint` reports no new errors.

- [ ] 4. Full verification and cleanup.
      Run the whole test suite and the build together to confirm nothing else
      regressed, then remove any scratch/temporary files created during
      development. Confirm only the three intended files changed
      (`git status --short` shows exactly `lib/comparison/player-category-tally.ts`,
      `lib/comparison/player-category-tally.test.ts`,
      `app/accuracy-compare/page.tsx`).
      Files: (none — verification only)
      Verify: `npm test` (all tests pass) AND `npm run build` (succeeds); and
      `git status --short` lists only the three expected paths.
