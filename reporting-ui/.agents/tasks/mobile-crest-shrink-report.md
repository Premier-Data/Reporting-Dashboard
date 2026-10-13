# Mobile crest "shrink" — findings report

## Summary answer

The crest **box is NOT being shrunk by flex layout, and the team-name wrap is a red
herring.** The size difference is **theory (B): `object-contain` letterboxing of
non-square source images.**

Every crest renders inside a fixed `56×56` box (inline `width/height` on the `<img>`).
The clubs that look "full size" are drawn from the **bundled** `public/clubs/*.png`
files, which are all **perfectly square (96×96)** — so with `object-contain` they fill
the 56×56 box edge-to-edge. The clubs that look "shrunk" (Mooroopna, Echuca, Rochester,
etc.) have **no bundled logo** and fall through to an admin-configured `logo_url`
override. When that override image is **non-square** (a landscape/padded S3 or Cloudinary
asset), `object-contain` scales it to fit the longer side, leaving the box visually
underfilled — the crest looks smaller even though its box is identical.

The reason the shrunk crests *correlate* with longer, two-line team names is **spurious**:
the Goulburn Valley clubs in the screenshot (Benalla, Shepparton, Mooroopna, Echuca,
Rochester) happen to both (a) have longer names and (b) rely on admin override logos
rather than square bundled PNGs. The wrapping name does **not** compress the crest (see
"Why theory (A) is ruled out" below).

## Evidence

### 1. The crest box has a fixed, non-shrinkable size

`app/live-scores/page.tsx`, `ClubCrest` (~line 240):

```tsx
const dim = { width: size, height: size };     // size = 56 at the call site
if (logo) {
  return (
    <img
      src={logo}
      style={dim}                                // inline width:56; height:56
      className="shrink-0 rounded-full object-contain"
    />
  );
}
```

The box dimensions come from inline `style={{width:56,height:56}}`, which Tailwind/flex
cannot override. `object-contain` then fits the (possibly non-square) source *inside*
that 56×56 box, preserving aspect ratio and leaving empty space on the short axis.

### 2. The layout is a COLUMN flex, so a wrapping name cannot compress the crest

`app/live-scores/page.tsx`, `teamCol` (~line 334) + the card grid (~line 391):

```tsx
const teamCol = (name, side) => (
  <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
    <ClubCrest name={name} size={56} />
    <span className="line-clamp-2 text-xs leading-tight md:text-sm ...">
      {name ?? "TBC"}
    </span>
  </div>
);
// ...
<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-4 md:gap-3 md:px-4">
  {teamCol(home?.name, "home")}
  <div className="flex items-center gap-3 md:gap-4"> ...scores... </div>
  {teamCol(away?.name, "away")}
</div>
```

- The team column is `flex-col` → **main axis is vertical, cross axis is horizontal.**
- The crest and the name are stacked on the **vertical** axis; `items-center`
  (`align-items:center`) sizes each item by its own intrinsic width on the **horizontal**
  axis. Flex does not stretch or shrink items on the cross axis here, so a two-line name
  never steals horizontal width from the crest.
- On the vertical (main) axis, `shrink-0` on the `<img>` already prevents the crest from
  being compressed to make room for a taller (two-line) name; the column has no fixed
  height, so it simply grows.
- The outer cells are grid tracks `[1fr_auto_1fr]`; each team cell is an equal `1fr`, and
  `min-w-0` lets the name wrap/clamp inside the cell. None of this touches the crest's
  fixed box.

Net: the 56×56 box is identical for every team. Theory (A) does not occur in this layout.

### 3. Full-size crests are square bundled PNGs; shrunk crests are non-bundled override logos

Measured bundled logos — all square:

```
banks.png 96x96   darwin-buffaloes.png 96x96   nightcliff.png 96x96
palmerston-magpies.png 96x96   pint.png 96x96   southern-districts.png 96x96
st-marys.png 96x96   tiwi-bombers.png 96x96   wanderers.png 96x96   waratah.png 96x96
```

`lib/api/clubLogos.ts` `CLUB_LOGO_FILES` only maps NTFL clubs (Palmerston, Waratah,
Nightcliff, Tiwi, Wanderers, Pint, St Marys, Southern Districts, Banks, Darwin
Buffaloes). **None of the screenshot clubs (Benalla / Shepparton / Mooroopna / Echuca /
Rochester — Goulburn Valley) are bundled**, so `clubLogo(name)` returns `null` for them.

Resolution order in `ClubCrest` (line 246):

```tsx
const logo = clubLogoOverride(name) || clubLogo(name);
```

So those clubs render whatever the admin `logo_url` override provides
(`lib/api/clubConfig.ts` → `clubLogoOverride` → `clubConfigSnapshot(name)?.logo_url`,
passed through `safeImageUrl`). Those override URLs come from:

- Admin-pasted URLs — e.g. the Shepparton Cloudinary URL in the task history carries
  `h_96,w_96` transforms and measures **96×96 (square)** → fills the box, looks full.
- Auto-harvested S3 assets — `discoverClubsFromFeeds` in `lib/api/clubConfig.ts` stores
  `myHomeTeamImage.imageFilename` / `myAwayTeamImage.imageFilename` verbatim as
  `logo_url`. These are arbitrary aspect ratios (often landscape/padded) → `object-contain`
  letterboxes them → the crest looks small.

That is the exact split between "full-size" and "shrunk" crests.

### 4. No global CSS overrides the crest img

`app/globals.css` has no global `img`/`object-*` rule affecting crests (the only
`max-width` is inside an unrelated scoped fullscreen block). The behaviour is entirely
driven by the inline box + `object-contain` + the source image's aspect ratio.

### 5. Same bug on sibling surfaces

`app/live-scores/match/page.tsx` `Crest` (~line 53) and
`app/live-scores/teamlists/page.tsx` `Crest` (~line 34) are the same component shape:

```tsx
<img src={logo} style={{width:size,height:size}} className="shrink-0 rounded-full object-contain" />
```

Both resolve `safeImageUrl(logoUrl) || clubLogo(name)` and use `object-contain`, so a
non-square override logo letterboxes there too (sizes 52/44 instead of 56). The fix must
cover all three crest definitions.

### Execution note

No headless browser (puppeteer/playwright) is installed in `reporting-ui`, and
`web_fetch` forces HTTPS while the dev server is plain HTTP (plus the page resolves
overrides client-side via Supabase), so I could not script live computed-style
measurements. The conclusion rests on (a) a precise CSS/flex read showing the box is
fixed and the column axis cannot compress it, and (b) measured source-image aspect ratios
showing bundled = square (fills box) vs override = often non-square (letterboxed). A
temp probe file in `%TEMP%` was used only to measure the Cloudinary sample and is
disposable. No code was changed.

## Conclusions

1. **Definitive cause: (B) `object-contain` letterboxing of non-square source images.**
   The crest box is always 56×56; square sources fill it, non-square override logos sit
   smaller inside it. The box itself never shrinks.
2. **Responsible elements/classes:**
   - `app/live-scores/page.tsx` `ClubCrest` ~line 253 — `<img style={{width,height}}
     className="shrink-0 rounded-full object-contain">`.
   - `app/live-scores/match/page.tsx` `Crest` ~line 68 — same.
   - `app/live-scores/teamlists/page.tsx` `Crest` ~line 49 — same.
   - The `object-contain` + the stored non-square `logo_url` are the actual trigger; the
     `flex-col items-center` column (`teamCol`, ~line 334) is NOT at fault.
3. **Not a breakpoint-specific bug.** It is present at every width (the box is fixed px,
   not responsive). It is simply more noticeable on narrow screens where crests sit closer
   together and the eye compares them directly. There is no Tailwind breakpoint gate on
   the crest size (the only `md:` on the column is the name font size).

## Recommended fix (not implemented)

Make the rendered crest fill its box consistently regardless of source aspect ratio.
Options, in order of preference:

1. **Switch `object-contain` → `object-cover` on the crest `<img>`** (all three crest
   components). This fills the 56/52/44 box edge-to-edge for any aspect ratio, matching
   the square bundled PNGs. Trade-off: a non-square logo gets its edges cropped. Combined
   with `rounded-full` the crop is usually acceptable for a circular badge, but a wide
   banner-style logo would lose its sides.

2. **Normalise logos to square before/while rendering** (keeps `object-contain`, no
   cropping): wrap the `<img>` in a fixed-size element and letterbox *intentionally* on a
   neutral background, OR centre-pad non-square sources. For Cloudinary-hosted overrides
   this can be done in the URL (e.g. `c_pad`/`c_fill`,`w_96,h_96`); for arbitrary S3
   assets, server-side normalisation or a background-filled wrapper is needed. More work,
   but preserves the full logo.

3. **Pragmatic hybrid:** keep `object-contain` but give the `<img>` a subtle filled
   circular background (`bg-white/10` + `rounded-full`) so letterboxed logos still read as
   a full-size badge even when the artwork doesn't fill it. Smallest change, hides the
   "shrunk" perception without cropping.

Whichever is chosen, apply it to **all three** crest surfaces (list / match / teamlists)
since they share the component shape. The `teamCol` flex column needs **no** change — it
is not causing the problem. If you want belt-and-braces layout safety you could add an
explicit fixed wrapper (`h-[56px] w-[56px] shrink-0`) around the crest, but that only
guards the box, which is already fixed; it will not change the letterboxing symptom on
its own.
