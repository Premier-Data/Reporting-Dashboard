# Consistent scoreboard layout + fixed crest badges on match & teamlists pages

Ports the proven Live Scores LIST page pattern (`app/live-scores/page.tsx` @ `d254cd4`) onto the match and teamlists scoreboard headers. Each `Crest` becomes a fixed-size circular badge locked on all six box axes with `overflow-hidden` + `bg-white/10`, and both headers are rebuilt into a symmetric `[home | centre | away]` grid where each team's crest+score sit together on the outer edge, the club name truncates to a single line below, and the centre is a fixed-width clamped column holding the FT pill + a truncating venue. The change is scoped to exactly the two files' `Crest` component and scoreboard-header markup; no shared lib, tabs, rosters, or data fetching was touched.

Watch for: nothing blocking. The two files are byte-for-byte identical in the reviewed regions and both faithfully reproduce the reference pattern. (confirmed)

**Verdict**: APPROVED

## High-level view

The crest fix locks the badge box on width/height/minWidth/minHeight/maxWidth/maxHeight so flex can neither grow nor shrink it, wraps the `<img>` in an `overflow-hidden rounded-full bg-white/10` span, and sets the `<img>` to `h-full w-full object-contain`. This is the reference pattern verbatim, so home and away crests render at exactly 52px regardless of sibling content and a letterboxed non-square logo reads as a full badge without cropping — satisfying invariant 1.

Scores no longer share a centre flex row with the venue. Each score block moved out beside its team's crest in the outer `1fr` track (home pushed left, away mirrored via `flex-row-reverse` and pushed right), and the centre is a `108px`/`128px` column with equal min and max width holding only the FT pill and a truncating venue. A long venue can no longer widen the track into the scores — satisfying invariant 2.

Team names are `block w-full truncate` with a `title` tooltip, one line with ellipsis, home `text-left` / away `text-right`, and the grid is `items-start` so neither block grows taller than the other — satisfying invariants 3 and 4.

The two files are structurally identical in the changed regions; teamlists references `logos.home/away` and match references `teamLogos.home/away`, which is the only intended difference. Scope is held to the two files — satisfying invariant 5.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings against the invariants.

</details>

<details>
<summary>Details</summary>

### Fixed-size crest badge (invariant 1)

Both `Crest` components replace the old `dim = { width, height }` with a six-axis `box` clamping `width/height/minWidth/minHeight/maxWidth/maxHeight = size`. Because min and max are equal on both axes, a flex parent cannot stretch or compress the badge, so the home and away crests are guaranteed equal size (52px in these headers). This is the mechanism the previous crest-only attempt was missing.

The logo branch now wraps the `<img>` in `<span class="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10" style={box}>` with the image at `h-full w-full rounded-full object-contain`. `overflow-hidden` clips any bleed into the adjacent score, `object-contain` preserves aspect ratio without cropping, and `bg-white/10` fills the letterbox gaps so a non-square admin logo still reads as a full-size badge. This is identical to the reference `ClubCrest`. The initials fallback uses the same `box` and bumps `fontSize` from `0.38` to `0.4` of size, matching the reference exactly. The added `aria-hidden="true"` on the initials fallback and the `alt={`${name} logo`}` on the image are reasonable a11y touches carried from the reference.

One intentional difference from the reference: these pages resolve the logo via `safeImageUrl(logoUrl) || clubLogo(name)` where the list page uses `clubLogoOverride(name) || clubLogo(name)`. That resolution line is unchanged by this diff — the override still flows through the `logoUrl` prop (`teamLogos`/`logos`) — so data behaviour is preserved.

### Scores pulled to the edges, centre column clamped (invariant 2)

The old layout placed `[homeScore][FT+venue][awayScore]` in a single centre flex row, so a wide venue could push the scores. The new layout moves each score block beside its own crest in the outer `1fr` grid track: home `items-start` with `flex items-center gap-2` (crest then score), away mirrored with `flex-row-reverse` and `items-end`. The centre is `w-[108px] min-w-[108px] max-w-[108px]` (`md:[128px]`) holding only the FT pill and the venue span at `block w-full min-w-0 truncate`. With equal min/max width the column cannot widen, and the venue truncates inside it, so the scores — now against the card edges — cannot be overlapped.

### Single-line truncated names, mirrored blocks (invariants 3 & 4)

Each name span is `block w-full truncate` with `title={name}` for the full value, home `text-left` and away `text-right`. `truncate` forces one line with an ellipsis, so a long club name can no longer wrap and make one side taller. The grid wrapper is `grid-cols-[1fr_auto_1fr] items-start`, and the away block is an exact mirror of home (`items-end` + `flex-row-reverse` on the crest/score row), so the two sides stay symmetric and top-aligned at any name/venue length.

### Scope (invariant 5)

`git status --porcelain` reports only `app/live-scores/match/page.tsx` and `app/live-scores/teamlists/page.tsx` modified (plus the untracked `.agents/` task-artifact directory). The reference `app/live-scores/page.tsx` is untouched. The diffs are confined to the `Crest` function and the scoreboard-header grid; the winner/margin line and `border-b … px-4 pb-4 pt-4` wrapper on the match page, the teamlists wrapper, and all tabs/rosters/toggles/stat-tables/data-fetching are outside the changed hunks.

### Verification evidence

The coder's `verification.md` records `npx tsc --noEmit` (exit 0), `npx vitest --run` (11/11 pass), and `npm run build` (exit 0, all 35 routes incl. `/live-scores/match` and `/live-scores/teamlists`). The lockfile/workspace-root warning is noted as a pre-existing environment warning, not a code error. No browser test was claimed; correctness of the visual invariants is argued by markup analysis, which this review independently confirms against the diff and the reference commit. The evidence is sufficient; no re-run or spot-check was warranted.

</details>

<details>
<summary>File map</summary>

- `app/live-scores/match/page.tsx` — `Crest` locked-box badge + symmetric scoreboard-header grid; winner/margin line and wrapper preserved.
- `app/live-scores/teamlists/page.tsx` — same `Crest` + scoreboard-header changes, referencing `logos.*` instead of `teamLogos.*`.

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui diff`

</details>
