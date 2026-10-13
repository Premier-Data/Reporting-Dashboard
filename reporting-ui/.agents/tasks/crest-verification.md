# Crest logo-fit verification

Presentational fix (option A — filled circular badge) applied to the three Live
Scores crest components so non-square admin `logo_url` overrides no longer look
shrunk. First iteration (no `crest-review.json` present).

## What changed

For the `<img>` (logo) path only, in all three components, the bare
`<img ... className="shrink-0 rounded-full object-contain" />` was wrapped in a
fixed-size `rounded-full` `<span>` that carries a subtle filled circular
background (`bg-white/10`), `shrink-0`, and the pixel dimensions. The `<img>`
inside now fills that box (`h-full w-full`) and keeps `object-contain`.

- `app/live-scores/page.tsx` — `ClubCrest` (size 56 at call site)
- `app/live-scores/match/page.tsx` — `Crest` (size 52/44)
- `app/live-scores/teamlists/page.tsx` — `Crest` (size 44)

Resulting markup (sizes differ per surface):

```jsx
<span className="flex shrink-0 items-center justify-center rounded-full bg-white/10" style={dim}>
  <img src={logo} alt="..." className="h-full w-full rounded-full object-contain" />
</span>
```

Unchanged: `object-contain` is kept (no cropping — full logo stays visible), the
fixed width/height box, logo resolution (`clubLogoOverride`/`clubLogo`/
`safeImageUrl`), the data model, and the initials-badge `<span>` fallback (which
already draws a filled coloured circle).

## Build / type check

- `npm run build` — Turbopack **compiled successfully** and **TypeScript
  finished with no type errors** (all edited files type-checked). The build then
  failed only at the static-prerender step for `/fixtures` with
  `Error: supabaseUrl is required.` This is an ENVIRONMENT issue, not a code
  issue: the fresh worktree has no `.env`/`.env.local` (the main tree does), so
  `NEXT_PUBLIC_SUPABASE_URL` is empty during export. It is unrelated to this
  presentational change (no Supabase/`/fixtures` code touched).
- `npx tsc --noEmit` — exit code 0 (no type errors). This isolates the type-check
  gate from the env-dependent prerender step.

## Unit tests

- `npx vitest --run` — **2 files passed, 11 tests passed, 0 failures**
  (`lib/comparison/cross-exact.test.ts`, `lib/comparison/json-adapter.test.ts`).
  No crest logic is unit-tested; this confirms nothing regressed.

## Visual verification

A headless browser is NOT available in this environment, and a live DOM capture
of `/live-scores` was NOT possible: a dev server was started on port 3100
(`npm run dev -- -p 3100`, main-tree server on 3000 left untouched) and became
Ready, but `GET /live-scores` returned **500** with the same
`Error: supabaseUrl is required.` (module eval of `lib/supabase.ts` via
`lib/api/clubConfig.ts`). Without the `.env` secrets the route cannot render, so
no screenshot/DOM dump could be produced. The dev server on 3100 was stopped and
temp files removed; port 3000 was not disturbed.

**STATED EXPLICITLY: no screenshot/DOM capture was possible.** Verification is
therefore by reasoned markup analysis:

- The outer `<span>` is a fixed `width`/`height` box (56 / 52 / 44 px per
  surface) with `rounded-full` + `bg-white/10`, and `flex items-center
  justify-center`. It therefore always paints a full-size circular translucent
  badge regardless of the logo's aspect ratio.
- The inner `<img>` is `h-full w-full object-contain`, so it is sized to the full
  circle and scaled to fit WITHOUT cropping. A non-square override logo is
  letterboxed inside the circle, but the circle itself is now filled, so the
  crest reads as a full-size badge instead of a small floating image sitting in
  empty space. This is exactly the shrink symptom described.
- A square bundled PNG (e.g. NTFL clubs) fills the contain box edge-to-edge as
  before; the `bg-white/10` sits entirely behind the opaque square and is not
  visible, so those crests are visually unchanged.
- The three surfaces use the identical wrapper (only the pixel size differs), so
  the list card, match page, and team-lists page are consistent.
- The initials-badge fallback `<span>` was left as-is, so the no-logo case does
  not regress.

## Commands run (from reporting-ui in the worktree)

- `npm ci` (worktree had no node_modules; required to build/test)
- `npm run build`
- `npx tsc --noEmit` → 0
- `npx vitest --run` → 11 passed
- `npm run dev -- -p 3100` (background, then stopped) → route 500 due to missing env
