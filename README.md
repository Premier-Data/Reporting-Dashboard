# Premier Data — Operations Platform

Internal platform for managing match video downloads, analyst allocation, and workforce reporting.

## Architecture

Two independently deployed pieces:

| Component | Location | Deploys to | URL |
|---|---|---|---|
| **Frontend** (`reporting-ui/`) | this repo | GitHub Pages (via Actions on push to `main`) | https://dashboard.premierdata-technology.com |
| **API** (`PDAutoDownload.Api`) | separate repo/folder | Windows Service on EC2 (`pdlive.leagueadmin.com.au`) | https://downloads.premierdata-technology.com |

Data sources:

- **Supabase** — `TT_Games` (fixture master list), `teams`, `analyst_team_affiliations`
- **Deputy API** — shifts and rosters come only from the Deputy API tables (via `lib/api/deputyShifts.ts`), never from the Excel-loaded Deputy tables
- **PDAutoDownload API** (PostgreSQL) — live download status, fixture assignments, computers, analysts
- **SignalR** (`/operationsHub`) — real-time allocation/progress broadcasts to all open pages

## Pages

| Route | Purpose |
|---|---|
| `/` and `/dashboard` | Landing page with links to all sections |
| `/operations` | Live Board — analyst allocations and computer status |
| `/fixtures` | Match Video Auto Download Dashboard |
| `/schedule` | Analyst roster grid with fixture allocation |
| `/recommendations` | Fixture Allocation Engine (AI recommendations) |
| `/analyst-management` | Analyst records and computer assignments |
| `/analyst-profile` | Individual analyst metrics, ratings, games coded |
| `/analyst-compare` | Side-by-side analyst comparison |
| `/affiliated-teams` | Team performance and analyst affiliations |
| `/reporting` | Workforce hours, cost, and performance analytics |
| `/computers`, `/downloads`, `/notifications`, `/settings` | Supporting admin views |

## Local development

```bash
cd reporting-ui
npm install
npm run dev
```

Runs on http://localhost:3000. In development the API clients point at `http://localhost:5165`, so run the API locally too:

```bash
cd <PDAutoDownload path>/PDAutoDownload.Api
dotnet run
```

### Required environment variables

Create `reporting-ui/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

The Excel → Supabase sync script (`sync-deputy.js`) additionally needs:

```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
SITE_ID=...
DRIVE_ID=...
FILE_ID=...
```

These are stored as GitHub Actions secrets for the scheduled sync workflow.

## Deploying

### Frontend

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds `reporting-ui` as a static export and publishes to GitHub Pages.

```bash
git add -A
git commit -m "your change"
git push origin platform-ui
git checkout main
git merge platform-ui --no-edit
git push origin main
git checkout platform-ui
```

Notes:

- `next.config.js` uses `output: "export"` — everything must be statically renderable. Client components using `useSearchParams()` need a `<Suspense>` boundary.
- `public/CNAME` pins the custom domain. Do not delete it or GitHub Pages will drop the domain on the next deploy.
- No `basePath` is set because the site is served from the root of a custom domain.

### API

See the deploy script in the PDAutoDownload project:

```powershell
.\deploy-api.ps1        # builds and packages
```

Then copy the zip to the EC2 and run the update script there. The API runs as the `PDAutoDownloadApi` Windows Service (Automatic start, auto-restart on failure).

CORS on the API must include the frontend origin (`dashboard.premierdata-technology.com`) or every request will fail silently in the browser.

## Scheduled jobs

| Workflow | Schedule | Purpose |
|---|---|---|
| `.github/workflows/sync.yml` | every 6 hours | Pulls the Deputy/fixtures Excel from SharePoint into Supabase |
| `.github/workflows/deploy.yml` | on push to `main` | Builds and publishes the frontend |

## Repository layout

```
reporting-ui/          The application (this is the only deployed frontend)
  app/                 Next.js App Router pages
  components/          Shared UI
  lib/api/             API clients for the PDAutoDownload API
  lib/analytics/       Analyst metric and rating calculations
  lib/recommendations/ Allocation scoring engine
  types/               Shared TypeScript types
  sync-deputy.js       Excel → Supabase sync (run by GitHub Actions)
docs/reference/        Source spreadsheets and reference material
.github/workflows/     CI: deploy + scheduled sync
```

## Known gotchas

- **`game_key` does not match between Supabase and the API.** `TT_Games.game_key` and the API's `gameKey`/`fixtureId` are different identifier systems. Fixtures are matched on `home_team` + `away_team` instead.
- **File sizes** are resolved by the API's `FileMetadataService`, which issues HEAD requests against the Cloudflare video URLs and caches `FileSizeBytes`. Fixtures not yet imported into the API show "Checking...".
- **Assignment writes to two places.** `assignFixture` creates the `FixtureAssignment` (drives Schedule/Live Board/Fixtures) and `createDownloadJob` queues the actual download for the desktop agent. Allocation flows call both.
