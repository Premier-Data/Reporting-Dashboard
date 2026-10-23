# deputy-sync (Supabase Edge Function)

Syncs Deputy workforce data into the private `deputy` Postgres schema
(project `uizimmfujhpuiqhjofzf`). Read-only against Deputy — it never writes,
approves, or edits anything in Deputy.

## Status

| Area | State |
|---|---|
| DB schema (`deputy.*`, 11 tables) | ✅ applied (see `migrations/001_deputy_integration.sql`) |
| Pure logic (mapping, pagination, dedupe, retry) | ✅ unit-tested (`lib/deputy/deputySync.test.ts`, 18 tests) |
| Phase 1 handlers (Company, OperationalUnit, Employee) | ✅ **live-validated** — synced 2 companies + 124 employees, idempotent on re-run |
| Phase 2–4 handlers (Roster, Timesheet, Leave) | ✅ implemented (same engine + date window); not yet live-run |
| Deploy to Supabase | ❌ not deployed (needs approval + secrets) |
| Scheduling (pg_cron) | ❌ not set up (later phase) |

## Authentication: Deputy permanent token

For a single Deputy install, Deputy's recommended server-to-server method is a
**permanent token** — it does not expire, so there is no OAuth refresh flow.

- Generate it from the install's OAuth client page
  (`https://<install>/exec/devapp/oauth_clients` → open the client → **Get An
  Access Token**). The token is shown once; store it securely.
- Set it as `DEPUTY_API_TOKEN`. The function sends it as
  `Authorization: OAuth <token>`.
- **Caveat:** clicking "Get An Access Token" again generates a NEW permanent
  token and invalidates the previous one. Keep a single stable token for the
  sync; don't regenerate it unless you also update `DEPUTY_API_TOKEN`.

> Note: the global `once.deputy.com` authorization-code OAuth flow is for
> multi-tenant apps serving many installs. This install-specific client returns
> `invalid_client` there — which is expected; use the permanent token instead.

## What it does

- Single secured orchestration function. Request body:
  ```json
  { "resources": ["Company","OperationalUnit","Employee"],
    "mode": "manual", "startDate": "2025-10-23", "endDate": "2026-10-23",
    "dryRun": false }
  ```
- Auth: `x-sync-secret` header, constant-time compared to `DEPUTY_SYNC_SECRET`.
- Pages each resource's `QUERY` endpoint (max 500/page, Id-asc, bounded to 200
  pages), maps source fields to the real columns, dedupes by `deputy_id`, and
  batch-upserts on `onConflict: deputy_id`. Inactive employees are kept; rows
  are never hard-deleted.
- Tracks every run in `deputy.sync_runs` and advances `deputy.sync_checkpoints`
  **only** on full success.
- `dryRun: true` fetches + maps but writes nothing.

## Secrets (never commit real values)

See `.env.example`. Set with:
```
supabase secrets set DEPUTY_BASE_URL=... DEPUTY_API_TOKEN=... \
  DEPUTY_SYNC_SECRET=... SUPABASE_SERVICE_ROLE_KEY=...
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in the
deployed function; set them only for local testing.

## Test locally (pure logic, no secrets needed)

```
npm run test -- lib/deputy/deputySync.test.ts
```

## Deploy (requires approval)

```
supabase functions deploy deputy-sync --no-verify-jwt
```
`--no-verify-jwt` is used because the custom `x-sync-secret` guards every
request (enforced server-side in index.ts).

## Invoke a manual sync (PowerShell, no creds inline)

```powershell
$secret = $env:DEPUTY_SYNC_SECRET   # set in your shell, not in the command
curl.exe -s -X POST `
  "https://uizimmfujhpuiqhjofzf.functions.supabase.co/deputy-sync" `
  -H "x-sync-secret: $secret" -H "Content-Type: application/json" `
  -d '{"resources":["Company","OperationalUnit","Employee"],"mode":"manual","dryRun":true}'
```
Start with `"dryRun": true` to validate before writing.

## Rollback

- Disable: remove the function's schedule (if set) and/or
  `supabase functions delete deputy-sync`. Imported `deputy.*` data is left
  intact — rollback never deletes data.

## Known limitations / open questions

- Phase 1 is live-validated; Phase 2–4 (Roster/Timesheet/Leave) share the same
  engine but have not yet been run against live data.
- Employee `email` comes back null from `Employee/QUERY` (Deputy keeps contact
  details on a separate `Contact` object) — a Contact join can enrich it later.
- `TotalTime` / `Cost` units/semantics not yet confirmed against real data —
  stored verbatim, not treated as verified payroll values.
- Incremental sync uses a date window; a reliable `Modified` cursor is TBD
  pending live response inspection.
- The `deputy` schema + its tables must be exposed in the Data API ("Exposed
  schemas" + "Exposed tables") for the service role to reach them via
  supabase-js. (Already done for the live project.)
