# gameface-deputy-sync / gameface-deputy-read

Read-only sync of the second company's Deputy install into the `gameface_deputy` schema, plus the admin-only read function behind the `/gameface-deputy` page. The existing `deputy-sync` and `deputy-read` functions are not touched.

Only Deputy `resource/<Name>/QUERY` calls are made (see `deputyHttp.ts`). Personal and pay-rate fields are dropped by name before storage (`sanitize.ts`).

## Operator steps (values are never pasted in chat or committed)

1. Run `migrations/014_gameface_deputy.sql` in the SQL editor (needs 001 and 011).
2. Project Settings > Data API > Exposed schemas: add `gameface_deputy`.
3. Set Edge Function secrets `GAMEFACE_DEPUTY_BASE_URL`, `GAMEFACE_DEPUTY_API_TOKEN`, `GAMEFACE_DEPUTY_SYNC_SECRET` (see `.env.example`). Use a temporary env file outside the repo, then delete it.
4. Vault (SQL editor, once): `gameface_deputy_sync_url` and `gameface_deputy_sync_secret` (examples at the bottom of the migration). Until set, the cron jobs do nothing.
5. Deploy: `supabase functions deploy gameface-deputy-sync --no-verify-jwt` and `supabase functions deploy gameface-deputy-read`.
6. Dry run first (writes nothing):
   ```
   $secret = $env:GAMEFACE_DEPUTY_SYNC_SECRET
   $body = '{"resources":["Company","OperationalUnit","Employee","Roster","Timesheet","Leave"],"mode":"manual","startDate":"<today-13>","endDate":"<today+28>","dryRun":true}'
   Invoke-RestMethod -Method Post -Uri "https://uizimmfujhpuiqhjofzf.functions.supabase.co/gameface-deputy-sync" -Headers @{ "x-sync-secret" = $secret } -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 6
   ```
   Check `dateMismatches` is 0 and read `keptFieldNames`: if anything personal or pay-rate related is listed, extend `isSensitiveKey` in `sanitize.ts`. A `deputy_403` on Leave is acceptable.
7. Real run: same call with `"dryRun":false`, then `select resource, status, records_read from gameface_deputy.sync_runs order by started_at desc limit 10;`.