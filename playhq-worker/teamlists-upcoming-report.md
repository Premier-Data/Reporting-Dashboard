# Team Lists for UPCOMING fixtures — findings report

Game under investigation: Tiwi Bombers Men Premier vs Darwin Buffaloes Men Premier,
2026-27 TIO NTFL Men Premier League, Round 3, status UPCOMING (Fri 16 Oct 2026).
PlayHQ slug `22c22bb1` → full fixture UUID `22c22bb1-471b-4ae3-8295-15568b69a829`.

## Summary answer (reads differently from the brief's hypothesis)

The platform's pipeline **already serves full pre-match line-ups for this UPCOMING
game**. I confirmed this against the live Worker: a GET to
`/api/fixtures/22c22bb1/teamlists` (and the full-UUID form) returns **both complete
rosters** — 26 named Tiwi Bombers players and 29 named Darwin Buffaloes players, with
jumper numbers — while the game status is still pre-match. There is **no status gate**
in the Worker. The REST game-summary feed PlayHQ exposes (`appearances[]`) carries the
selected squad before the match starts, and the Worker's `/teamlists` handler reads
exactly that.

So the brief's root-cause hypothesis — "the Worker sources team lists from a feed that
only has rosters once live/final, and/or gates on status" — is **refuted by live
evidence**. The Worker is working for this fixture today.

If the user is seeing an empty Team Lists view, it is **not** reproduced by the current
deployed Worker + current frontend code. The most likely explanations are
environmental/transient rather than a code defect in the data source (see Conclusions).

## Evidence

### 1. The Worker's `/teamlists` handler — data source and (absence of) a status gate

File: `playhq-worker/src/index.ts`, route match
`^\/api\/fixtures\/([^/]+)\/teamlists$`.

The handler tries two sources, in order, and never checks `status`:

1. **Primary — official REST game summary.** It calls `resolveFullGame(tid, env)` to
   get the full UUID, then `fetchGameSummary(fullId, env)` → `GET
   https://api.playhq.com/v1/games/{id}/summary` (function `fetchGameSummary`), then
   `summaryToTeamLists(tid, summary)`.
   - `summaryToTeamLists` builds each side's roster from `summary.appearances[]`
     (`rosterFor` groups by `appearance.teamID`, taking `firstName/lastName` +
     `playerNumber`). It returns `null` **only** when `appearances.length === 0`, not
     based on game status. The comment on the function notes appearances are "the full
     selected squad" and "matches the PlayHQ game-centre."
   - Crucially, the REST summary's `appearances[]` is populated **once the line-up is
     named**, which for NTFL happens pre-match — hence the live response below.

2. **Fallback — spectator GraphQL feed.** Only if the summary returned `null` (no
   appearances yet). It calls `fetchGame(tid, env)` (POST to
   `https://spectator.playhq.com/graphql`, `operationName: "game"`) and
   `teamListFrom(game, side)`, which reads `statistics.{home,away}.players[]`. The
   comment on `teamListFrom` correctly notes this spectator array "is empty pre-game."

So the only feed that is empty pre-game is the *fallback*; the *primary* feed
(REST summary `appearances`) is the one that carries pre-match line-ups, and it is tried
first. There is no `if (status === 'UPCOMING') return empty` anywhere in the handler.

### 2. Live Worker response for this game (observed, read-only GET)

`GET …/api/fixtures/22c22bb1/teamlists` and
`GET …/api/fixtures/22c22bb1-471b-4ae3-8295-15568b69a829/teamlists` both returned the
**same full payload**:

- `status: "PENDING"` (the summary's own status value for a not-yet-started game).
- `home`: `Tiwi Bombers Men Premier` (`c1d46460-…`), 26 players (15 numbered, 11
  without a number).
- `away`: `Darwin Buffaloes Men Premier` (`42f3dae3-…`), 29 players (19 numbered, 10
  without a number).

This is the authoritative proof: pre-match line-ups are present and served **now**.

(Note: `…/22c22bb1/status` returns `{"error":"graphql_errors"}` because the `/status`
route hits the spectator GraphQL `game` op, which has no data for an UPCOMING game. That
endpoint is unrelated to team lists and is not used by the Team Lists page.)

### 3. gameId mapping (frontend → PlayHQ fixture)

- `getGradeGames(gradeId)` in `reporting-ui/lib/api/playhq.ts` returns games whose `.id`
  is the **full UUID** (`PlayHqGame.id`), not the short URL slug.
- Live grade feed confirms: for the Men's grade `be950883-…/games`, the game appears as
  `id: "22c22bb1-471b-4ae3-8295-15568b69a829"`, `status: "UPCOMING"`, `round: "Round 3"`.
- The Live Scores list builds the Team Lists link with that same id —
  `app/live-scores/page.tsx`, `openPage()`:
  `new URLSearchParams({ grade: gradeKey, id: game.id })` →
  `/live-scores/teamlists?grade=<key>&id=<uuid>`.
- The Team Lists page (`app/live-scores/teamlists/page.tsx`) reads `id` from the query
  and calls `getTeamLists(gameId)` with that full UUID — the exact id I tested, which
  returns full rosters. It also does `games.find((x) => x.id === gameId)` for the
  scoreboard header; that match succeeds because both are the same UUID.

So the id plumbing is consistent end-to-end (full UUID throughout). The URL slug
`22c22bb1` is only the leading segment of the UUID; the Worker's `resolveFullGame`
accepts either form (`full === gameId || full.split("-")[0] === gameId`), which is why
both GET forms returned identical data.

### 4. Frontend does no status filtering

`TeamRoster` in `teamlists/page.tsx` renders whatever `team.players` the Worker returns,
and only shows the empty-state copy — "No team list available yet. Lists appear once a
match is live or final." — when `roster.length === 0`. Since the Worker returns 26/29
players, the empty state will **not** show for this game. The frontend is not filtering
by `UPCOMING`.

## Conclusions

1. **Root cause is NOT what the brief hypothesised.** The Worker neither gates on status
   nor relies solely on a live/final-only feed. Its `/teamlists` handler sources from the
   REST game-summary `appearances[]` (which has pre-match line-ups) first, and that feed
   is returning full rosters for this UPCOMING game right now.

2. **The deployed pipeline works for this fixture today.** Verified by live GET against
   the user's own Worker and grade feed. No code change is required to make UPCOMING
   line-ups appear — they already do at the data layer.

3. Because the data source is confirmed good, an empty Team Lists view in the UI (if the
   user still sees one) is most plausibly one of the following — none of which is a
   defect in the Worker's data sourcing:
   - **Stale deploy / browser or edge cache.** The report (`getTeamLists` uses
     `cache: no-store`, Worker caches 15s) suggests the live state is fresh, but a
     previously-deployed Worker build (before the REST-summary primary path was added)
     could have returned empty, and a cached frontend bundle or an older worker version
     could linger. Confirm the deployed Worker is this source revision.
   - **A different fixture/grade with no line-ups named yet.** For a game where PlayHQ has
     not yet published the squad, `appearances[]` is empty and the spectator fallback is
     also empty pre-game, so the empty-state copy shows legitimately. This specific R3
     game is not that case.
   - **Transient upstream error.** If `fetchGameSummary` 404s/times out AND the spectator
     fallback also has nothing, the user sees empty. Not observed in testing.

## Recommendations (nothing implemented)

- **Owner of any further work: the Cloudflare Worker (`playhq-worker`), not
  `reporting-ui`.** But note no data-sourcing fix is actually needed — the behaviour the
  brief wanted (UPCOMING line-ups shown) is already live.
- **First action is operational, not code:** confirm the deployed Worker is running this
  revision of `src/index.ts` (the one with the REST-summary-first `/teamlists` path). If
  the user reproduced "empty" against an older deploy, a `wrangler deploy` of the current
  source resolves it. This is the single most likely gap between "code works" and "user
  saw empty."
- **No frontend change is required.** `reporting-ui` already renders whatever rosters the
  Worker returns and does no status filtering.
- **Copy nit (optional):** the empty-state text "Lists appear once a match is live or
  final" (in `teamlists/page.tsx`, and the matching doc comment in `lib/api/playhq.ts`:
  "Populated once a game is live/final; empty pre-game") is now **inaccurate** — lists
  appear as soon as PlayHQ names the squad, which is pre-match. Consider softening to
  something like "No team list published yet." so it doesn't imply lists are
  live/final-only. This is cosmetic, not functional.
- **If the user can still reproduce an empty view on this exact R3 game**, capture the
  Network tab response for `…/api/fixtures/<uuid>/teamlists` from their browser and the
  deployed Worker version; the discrepancy will be a cache/deploy issue, since the source
  + live endpoint are confirmed correct here.

## PlayHQ API considerations

- The Worker already holds the PlayHQ REST API key as a secret (`PHQ_API_KEY`) and uses
  the official `GET /v1/games/{id}/summary` endpoint with `x-api-key` + `x-phq-tenant`
  headers — the correct, authorised way to read line-ups. No new auth, new GraphQL op, or
  scraping of PlayHQ's private game-centre endpoint is needed; the public REST summary
  already exposes pre-match `appearances[]`.
- Rate limits are already handled (429 → `Retry-After`, short edge cache). No change.

---
Investigation was read-only: no code edits, commits, or deploys. Live reads were GETs to
the user's own Worker and the public grade feed only.
