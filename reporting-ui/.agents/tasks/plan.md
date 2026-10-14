# Implementation Plan — Consistent scoreboard layout + fixed crest badges on the two other Live Scores surfaces

Apply the SAME consistent-layout + fixed-crest-badge treatment already shipped on the Live Scores LIST page (`app/live-scores/page.tsx`, branch `feature/empty-slot-dispute-permission` @ `d254cd4`) to the two other Live Scores surfaces so all three match.

Scope is STRICTLY two files, and within them ONLY the `Crest` component + the scoreboard-header JSX:

1. `c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui\app\live-scores\match\page.tsx`
2. `c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui\app\live-scores\teamlists\page.tsx`

Do NOT touch `app/live-scores/page.tsx`, `lib/*`, the tabs, rosters, stat tables, data fetching, or any other content. This is a presentational tweak.

## Design decisions (grounded in the reference + the two targets' real structure)

- **Reference pattern (confirmed by reading the shipped list page).** `ClubCrest` locks its box on all six axes (`width/height/minWidth/minHeight/maxWidth/maxHeight = size`), wraps the `<img>` in a `span` with `flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10`, and renders the img as `h-full w-full rounded-full object-contain`. The initials fallback uses the same locked box with `background: clubBadgeColor(name)` and `fontSize: Math.round(size * 0.4)`. The list scoreboard is a `grid grid-cols-[1fr_auto_1fr] items-start` with mirrored outer-pushed team blocks (crest+score on one `flex-row` / `flex-row-reverse` row, name on a single `block w-full truncate` line below) and a fixed-width clamped centre column whose venue line uses `min-w-0 truncate`.

- **Keep each target's existing data wiring.** Both target `Crest` components already resolve the logo as `safeImageUrl(logoUrl) || clubLogo(name)`, where `logoUrl` comes from the page's own `teamLogos`/`logos` state. Preserve that exact resolution; only the returned markup changes. Do NOT switch to `clubLogoOverride` (the targets pass the override through `logoUrl`). Rationale: minimal change, no new imports, identical data behaviour.

- **Fallback font scale 0.4 (not the targets' current 0.38).** Match the reference exactly so all three surfaces render identical badges. Rationale: the task's invariant is "all three match"; 0.4 is what shipped.

- **Centre column adaptation.** The two targets' headers differ from the list card: they have NO fixture-row/venue-under-schedule layout — instead their centre block holds `[homeScore + G.B] [FT pill + venue] [awayScore + G.B]` all bunched together, which is exactly why scores overlap the venue/location. The fix moves each team's score OUT to its own side block (next to that side's crest, pushed to the outer edge) and leaves ONLY the FT pill + venue in a fixed-width clamped centre column with a truncating venue. This mirrors the reference's "scores against the outer edge, centre column fixed-width" shape while respecting that these pages show FT/venue (not date/time/vs) in the centre. Rationale: directly removes the score↔venue overlap the user reported while keeping both pages' real centre content (FT + venue).

- **Crest size stays 52.** Both target headers already call `<Crest ... size={52} />`. Keep 52 (the badge is now a locked filled box at that size). Rationale: no visual size regression; task says "scaled to its size".

- **Names truncate to one line.** Replace each side's `leading-tight` wrapping name span with a single-line `block w-full truncate` + `title` tooltip so a long club name can never wrap and knock the two sides out of alignment. Rationale: the "names on a single line truncated with …" invariant.

## Invariants to achieve (verify these by eye after the coder step on all three surfaces)

- Fixed, equal-size circular crest badges that never letterbox-shrink and never grow/overflow into neighbouring score/name (locked box + `overflow-hidden` + `bg-white/10` fill + `object-contain`).
- Non-square admin `logo_url` overrides read as a full-size badge, uncropped.
- Scores never overlap the FT pill / venue / location text.
- Team names render on a single line, truncated with `…`, with a `title` tooltip carrying the full name.
- Home and away blocks are exact mirrors so they always line up regardless of name length.
- Each page's existing data, tabs, toggles, rosters, stat tables, and non-header content are unchanged.

---

## Steps

- [ ] 1. Replace the `Crest` component in `app/live-scores/match/page.tsx` (~line 53) with the locked-box filled-badge pattern.
      Keep the exact props `{ name, size = 44, logoUrl }` and the exact logo resolution `const logo = safeImageUrl(logoUrl) || clubLogo(name);`. Replace the body with the reference markup below (same imports already present: `safeImageUrl`, `clubLogo`, `clubInitials`, `clubBadgeColor`).

      Exact replacement for the component body (everything after the destructured props / type):
      ```tsx
      const logo = safeImageUrl(logoUrl) || clubLogo(name);
      // Lock the badge box on every axis so flex can neither grow nor shrink it,
      // and clip overflow so a logo can never bleed into the score/name beside it.
      const box = {
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        maxWidth: size,
        maxHeight: size,
      };
      if (logo) {
        // eslint-disable-next-line @next/next/no-img-element
        return (
          <span
            className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10"
            style={box}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logo}
              alt={`${name ?? ""} logo`}
              className="h-full w-full rounded-full object-contain"
            />
          </span>
        );
      }
      return (
        <span
          className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
          style={{ ...box, background: clubBadgeColor(name), fontSize: Math.round(size * 0.4) }}
          aria-hidden="true"
        >
          {clubInitials(name)}
        </span>
      );
      ```
      (Keep the single `// eslint-disable-next-line` that sits immediately above the `<img>`; remove the now-stale `const dim = { width: size, height: size };`.)
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui\app\live-scores\match\page.tsx`
      Verify: `npm run build` (from `reporting-ui`) compiles with no type/lint errors for this file. Then load `/live-scores/match?grade=<key>&id=<gameId>` in the dev app and confirm both crests are equal-size filled circles.

- [ ] 2. Rework the match-page scoreboard header JSX so each team's score sits beside that team's crest on the outer edge, the name truncates on one line, and only the FT pill + venue remain in a fixed-width centre column.
      This is the `{game && ( <div className="border-b border-white/10 px-4 pb-4 pt-4"> ... </div> )}` block in `MatchStatsInner` (the `grid grid-cols-[1fr_auto_1fr] items-center gap-3` and its three children). Preserve the surrounding `border-b … px-4 pb-4 pt-4` wrapper and the `{winner && margin != null && ( <p …> )}` line underneath (unchanged). Replace ONLY the inner grid.

      Replace the current grid (home crest+name column / centre `[score][FT+venue][score]` group / away crest+name column) with a symmetric outer-pushed layout. Target markup:
      ```tsx
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 md:gap-3">
        {/* Home block: crest + score on one row pushed LEFT, name truncated below */}
        <div className="flex min-w-0 flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <Crest name={home?.name} size={52} logoUrl={teamLogos.home} />
            <div className="flex flex-col items-start">
              <span className="text-3xl font-extrabold leading-none tabular-nums">
                {homeScore ?? "-"}
              </span>
              <span className="mt-1 text-[11px] tabular-nums text-slate-400">
                {goalsBehinds(home)}
              </span>
            </div>
          </div>
          <span
            className="block w-full truncate text-left text-xs font-medium text-slate-300"
            title={home?.name ?? "Home"}
          >
            {home?.name ?? "Home"}
          </span>
        </div>

        {/* Centre: fixed-width clamped column — FT pill + venue (venue truncates) */}
        <div className="flex w-[108px] min-w-[108px] max-w-[108px] flex-col items-center px-1 text-center md:w-[128px] md:min-w-[128px] md:max-w-[128px]">
          <span className="rounded-full bg-sky-600 px-3 py-0.5 text-xs font-bold">
            FT
          </span>
          <span className="mt-1 block w-full min-w-0 truncate text-[11px] text-slate-400" title={game.venue?.name ?? ""}>
            {game.venue?.name ?? ""}
          </span>
        </div>

        {/* Away block: mirror of home (crest + score pushed RIGHT via flex-row-reverse) */}
        <div className="flex min-w-0 flex-col items-end gap-2">
          <div className="flex flex-row-reverse items-center gap-2">
            <Crest name={away?.name} size={52} logoUrl={teamLogos.away} />
            <div className="flex flex-col items-end">
              <span className="text-3xl font-extrabold leading-none tabular-nums">
                {awayScore ?? "-"}
              </span>
              <span className="mt-1 text-[11px] tabular-nums text-slate-400">
                {goalsBehinds(away)}
              </span>
            </div>
          </div>
          <span
            className="block w-full truncate text-right text-xs font-medium text-slate-300"
            title={away?.name ?? "Away"}
          >
            {away?.name ?? "Away"}
          </span>
        </div>
      </div>
      ```
      Notes: the "FT" literal and `game.venue?.name`, `homeScore`/`awayScore`, `goalsBehinds(home/away)`, `teamLogos.home/away`, and `home?.name`/`away?.name` are all the page's EXISTING values — do not rename or re-fetch. Keep the `{winner && margin != null && ...}` paragraph exactly as-is after this grid.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui\app\live-scores\match\page.tsx`
      Verify: `npm run build` compiles clean. In the dev app, open a match with a long club name and a long venue: confirm names show on one line with `…`, scores sit beside their crest on the outer edges and do NOT overlap the FT pill/venue, and home/away mirror each other.

- [ ] 3. Replace the `Crest` component in `app/live-scores/teamlists/page.tsx` (~line 34) with the SAME locked-box filled-badge pattern from step 1.
      The component is byte-identical to the match page's old `Crest` (same props, same `const dim`, same old `<img className="shrink-0 rounded-full object-contain">`). Apply the exact same replacement body as step 1 (same imports are already present on this page: `safeImageUrl`, `clubLogo`, `clubInitials`, `clubBadgeColor`). Remove the stale `const dim`.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui\app\live-scores\teamlists\page.tsx`
      Verify: `npm run build` compiles clean. Load `/live-scores/teamlists?grade=<key>&id=<gameId>` and confirm both crests are equal-size filled circles.

- [ ] 4. Rework the teamlists-page scoreboard header JSX to the same outer-pushed symmetric layout as step 2.
      This is the `{game && ( <div className="border-b border-white/10 px-4 pb-4 pt-4"> ... </div> )}` block in `TeamListsInner`. Its inner grid is identical in shape to the match page's (centre `[score][FT+venue][score]` group), but it has NO winner/margin paragraph underneath. Replace ONLY the inner grid with the SAME markup block given in step 2, using THIS page's variable names: crests use `logoUrl={logos.home}` / `logoUrl={logos.away}` (this page's state is `logos`, not `teamLogos`); everything else (`home?.name`, `away?.name`, `homeScore`, `awayScore`, `goalsBehinds(home/away)`, `game.venue?.name`, the "FT" literal) is identical and already present. Keep the `border-b … px-4 pb-4 pt-4` wrapper.
      Files: `c:\Users\AndyDin\reporting-dashboard\.worktrees\scoreboard-match-teamlists\reporting-ui\app\live-scores\teamlists\page.tsx`
      Verify: `npm run build` compiles clean. In the dev app open a team-lists page with a long name/venue: confirm the invariants (equal fixed crests, names one-line truncated with `…`, scores not overlapping FT/venue, home/away mirrored) and that the Home/Away roster toggle + roster list below are unchanged.

- [ ] 5. Final cross-surface consistency check.
      With both files changed, visually compare all three surfaces — the Live Scores LIST (`/live-scores`, unchanged reference), the match page, and the team-lists page — and confirm the crest badges and scoreboard alignment read identically across them.
      Files: none (verification only).
      Verify: `npm run build` from `reporting-ui` succeeds with zero errors. If the repo exposes a lint/typecheck script in `package.json` (e.g. `npm run lint`), run it and confirm no new warnings in the two changed files. (Per `AGENTS.md`, if any Next.js build/config issue arises, consult `node_modules/next/dist/docs/` before changing config — but this change is JSX/Tailwind only and should not require it.)

## Notes / assumptions

- The build/verify command is `npm run build` run from the `reporting-ui` directory. The coder step should confirm the exact script names in `reporting-ui/package.json` (e.g. `build`, `lint`, `dev`) during execution and use the project's real scripts; grep is not a substitute for building.
- `safeImageUrl`, `clubLogo`, `clubInitials`, `clubBadgeColor` are already imported on BOTH target pages, so no import changes are needed. `goalsBehinds` is also already imported on both.
- If a target's header already differs slightly from what's described here (e.g. extra classes on the wrapper), preserve those outer-wrapper classes and only swap the inner grid as specified.
