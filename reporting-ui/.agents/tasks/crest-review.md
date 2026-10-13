# Filled circular badge behind Live Scores crests

The change wraps each crest `<img>` in a fixed-size `rounded-full` `<span>` carrying a subtle `bg-white/10` background, so a non-square admin `logo_url` override — which `object-contain` letterboxes — still reads as a full-size circular badge instead of a small floating image. It is applied identically across the three Live Scores crest components (`ClubCrest` in the list, `Crest` in the match page, `Crest` in team lists). `object-contain`, `rounded-full`, and the fixed pixel box are all preserved; the inner `<img>` now fills the circle via `h-full w-full`. The initials-badge fallback is untouched in all three.

Watch for: nothing blocking. (confirmed) The treatment is consistent across all three surfaces, scope is clean, and no cropping or data-model behaviour changed.

**Verdict**: APPROVED

## High-level view

The wrapper carries the pixel dimensions (`style={dim}`) and the circular background; the image is sized to the full circle with `h-full w-full` and keeps `object-contain`. Because the box dimension lives on the span and the image fills it relatively, the fix scales to each surface's size (56 / 52 / 44) with no per-size tuning — the only per-file difference is the `size` prop passed at the call site. (confirmed)

The circle is only visible behind letterboxed non-square logos. A square bundled PNG fills the contain box edge-to-edge and sits opaque over the `bg-white/10`, so those crests are visually unchanged. (confirmed) The span clips to `rounded-full`, so no square-corner bleed and no background spilling past the circle.

The initials-badge fallback `<span>` was not modified in any of the three files, so the no-logo path does not regress. (confirmed)

Verification evidence exists and was read rather than re-run: build compiled with TypeScript passing (`tsc --noEmit` exit 0), 11 unit tests passed, and the author explicitly documented that a live DOM/screenshot capture was not possible because the fresh worktree lacks `.env` secrets (route 500 on `supabaseUrl is required`), falling back to reasoned markup analysis. That env failure is unrelated to this presentational change. (confirmed)

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings.

</details>

<details>
<summary>Details</summary>

### Consistent application across the three surfaces

All three logo paths now use the identical wrapper:

```jsx
<span className="flex shrink-0 items-center justify-center rounded-full bg-white/10" style={dim}>
  <img src={logo} alt="..." className="h-full w-full rounded-full object-contain" />
</span>
```

The only differences are the `alt` text (`""` in match/teamlists, `` `${name} logo` `` in the list, matching the pre-existing values) and the formatting of the `<img>` attributes. `shrink-0` moved from the image to the span, which is correct — the span is now the flex child that must not shrink. Tailwind classes are all valid; no typos. (confirmed)

### object-contain and the fixed box are preserved

`object-contain` is kept on the image, so non-square overrides are letterboxed rather than cropped — the full logo stays visible. The fixed pixel box moved from the image's inline `style` to the span's inline `style` (`dim` = `{ width: size, height: size }`), and the image fills it with `h-full w-full`. Net sizing is unchanged for square logos; non-square logos are now centered inside a visible circle via `items-center justify-center`. (confirmed)

### Background visibility and clipping

`bg-white/10` is a translucent fill that only shows where the image does not cover — i.e. the letterbox margins of a non-square override. For square bundled PNGs the opaque image covers the full box and the background is not visible, so no visual change there. The span's `rounded-full` clips the content to the circle, so neither the translucent fill nor a square image's corners bleed past the badge outline. (confirmed)

### Fallback and scope

The initials-badge fallback `<span>` (deterministic colour + initials) is byte-for-byte unchanged in all three files, so the no-logo case does not regress. Logo resolution (`clubLogoOverride` / `clubLogo` / `safeImageUrl`) and the data model are untouched. The diff touches only the three in-scope files; the only other change is the untracked `.agents/` task notes, which are not production code. (confirmed)

### Verification

The author's note at `.agents/tasks/crest-verification.md` records `npm run build` compiling with TypeScript clean, `npx tsc --noEmit` exit 0, and `npx vitest --run` passing 11 tests. It explicitly states no screenshot/DOM capture was possible (the fresh worktree has no `.env`, so `/live-scores` 500s on `supabaseUrl is required`) and falls back to reasoned markup analysis. That failure is an environment gap, not a code defect, and is unrelated to a presentational Tailwind change. Per instructions these suites were not re-run; the markup analysis above independently corroborates the author's reasoning. (confirmed)

</details>

<details>
<summary>File map</summary>

- `reporting-ui/app/live-scores/page.tsx` — `ClubCrest`: logo `<img>` wrapped in `bg-white/10` circular span.
- `reporting-ui/app/live-scores/match/page.tsx` — `Crest`: same wrapper applied.
- `reporting-ui/app/live-scores/teamlists/page.tsx` — `Crest`: same wrapper applied.

Full diff: `git -C c:\Users\AndyDin\reporting-dashboard\.worktrees\crest-logo-fit diff`

</details>
