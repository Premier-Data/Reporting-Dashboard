# Verification — consistent scoreboard layout + fixed crest badges (match + teamlists)

Scope: ONLY the `Crest` component + scoreboard-header grid in the two target files.

- `app/live-scores/match/page.tsx`
- `app/live-scores/teamlists/page.tsx`

The reference list page (`app/live-scores/page.tsx`) was NOT touched. `lib/*`, tabs,
rosters, stat tables, and data fetching were NOT touched.

## Commands run (from `reporting-ui`)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Exit 0 — no type errors |
| `npx vitest --run` | Exit 0 — 2 test files, 11/11 tests passed, no regressions |
| `npm run build` | Exit 0 — compiled successfully; all 35 routes generated, incl. `/live-scores/match` and `/live-scores/teamlists` |

Notes on build:
- A multiple-lockfiles / inferred-workspace-root warning is emitted (Turbopack
  picked `C:\Users\AndyDin\package-lock.json`). This is a pre-existing
  environment warning, not a code error, and does not fail the build.
- No `/fixtures` missing-env prerender error occurred this run (env copy was intact).

No headless browser is installed, so no visual/browser test was run or claimed.
Correctness is argued below by precise markup analysis against the shipped
reference pattern (`ClubCrest` + scoreboard in `page.tsx` @ `d254cd4`).

## Markup-analysis reasoning

### 1. Crests are fixed, equal-size badges that never letterbox-shrink or overflow

Both target `Crest` components now use the reference's locked-box pattern:

- `box` sets `width/height/minWidth/minHeight/maxWidth/maxHeight = size` (all six
  axes). With every axis clamped, flex cannot grow or shrink the badge, so both
  home and away crests render at exactly `size` (52px in the headers) regardless
  of sibling content. This is what makes the two crests equal-size.
- The logo branch wraps the `<img>` in a `span` with
  `flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10`.
  `overflow-hidden` + `rounded-full` clips the image to the circle so it can
  never bleed into the adjacent score/name. `bg-white/10` fills the locked box
  so a non-square admin `logo_url` (object-contain, letterboxed) still reads as a
  full-size badge instead of a small floating image — uncropped.
- The `<img>` is `h-full w-full rounded-full object-contain`: it fills the locked
  box and preserves aspect ratio (no stretch, no crop).
- The initials fallback uses the same `box` with `fontSize: Math.round(size*0.4)`
  — identical to the reference (was 0.38 before), so all three surfaces match.

Logo resolution (`safeImageUrl(logoUrl) || clubLogo(name)`) is unchanged on both
pages, and the override still flows through `logoUrl` (`teamLogos`/`logos` state),
so data behaviour is identical.

### 2. Scores never overlap the FT pill / venue

Previous layout put `[homeScore][FT+venue][awayScore]` together in one centre
flex row, so a wide venue pushed the scores into it. New layout:

- Each team's score block is moved OUT beside that team's crest, in the outer
  `1fr` grid track (home block `items-start` pushed left; away block
  `flex-row-reverse` + `items-end` pushed right). Scores now sit on the card
  edges, away from the centre.
- The centre is a fixed-width clamped column
  (`w/min/max-[108px]`, `md:[128px]`) holding ONLY the FT pill + venue. Because
  min and max width are equal, the column can never widen; the venue line is
  `block w-full min-w-0 truncate`, so a long venue ellipsis-truncates inside the
  fixed track instead of expanding and colliding with the scores.
- The outer tracks are symmetric `1fr … 1fr`, so the two score blocks stay clear
  of the centre column at any name/venue length.

### 3. Team names render single-line, truncated with "…"

Each name span is now `block w-full truncate` (home `text-left`, away
`text-right`) with a `title={name}` tooltip carrying the full name. `truncate`
forces one line with an ellipsis, so a long club name can no longer wrap and push
one side taller than the other — home/away stay vertically aligned. Grid is
`items-start` so both blocks top-align.

### Home/away mirror

Home: `items-start`, inner row `flex` (crest then score), score col `items-start`.
Away: `items-end`, inner row `flex-row-reverse` (crest then score mirrored),
score col `items-end`. The two blocks are exact mirrors, matching the reference.

### Preserved / untouched

- Match page keeps the `{winner && margin != null && (<p>…won by…</p>)}` line
  immediately below the grid, and the `border-b … px-4 pb-4 pt-4` wrapper.
- Teamlists page keeps its wrapper and has no winner/margin line (as before).
- Tabs, rosters, home/away toggle, player/stat tables, and all data fetching are
  unchanged on both pages.
