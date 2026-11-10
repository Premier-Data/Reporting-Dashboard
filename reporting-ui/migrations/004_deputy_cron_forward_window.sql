-- Premier Data x Deputy integration
-- Migration: 004_deputy_cron_forward_window.sql
-- Extends the nightly sync window FORWARD so upcoming rosters are pulled in.
--
-- Before: startDate = today - 13, endDate = today (so future rosters were never
-- fetched and the Schedule page could not show next week's shifts).
-- After:  startDate = today - 13, endDate = today + 28 (Sydney local dates,
-- inclusive), i.e. 14 days back and 28 days forward.
--
-- Future dates return no Timesheet rows from Deputy (nothing worked yet), which
-- is harmless. For Roster the deputy-sync function also soft-deletes rows in the
-- window that Deputy no longer returns (is_deleted = true), guarded so an empty
-- or failed read never wipes the window.
--
-- Only the window changes versus 002_deputy_cron.sql: same signature, same
-- 22:30 Australia/Sydney time gate, same Vault lookups (deputy_sync_url,
-- deputy_sync_secret), same resources (Timesheet + Roster), same mode. The
-- existing pg_cron job calls this function by name, so it is NOT re-scheduled.
--
-- Apply through the Supabase SQL Editor as a project administrator. Contains no
-- secrets. Idempotent: create or replace; re-applying is safe.
begin;

create or replace function deputy.run_daily_timesheet_sync()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_local     timestamp   := (now() at time zone 'Australia/Sydney');
  v_today     date;
  v_hour      int;
  v_minute    int;
  v_start     date;
  v_end       date;
  v_url       text;
  v_secret    text;
  v_body      jsonb;
  v_request   bigint;
begin
  v_hour   := extract(hour   from v_local)::int;
  v_minute := extract(minute from v_local)::int;

  -- Time gate: only act at 22:30 Sydney local time. The cron entry runs every
  -- 30 minutes, so this matches exactly once per day.
  if not (v_hour = 22 and v_minute >= 30 and v_minute < 60) then
    return null;
  end if;

  -- Window in Sydney local dates: today - 13 .. today + 28 (inclusive).
  v_today := (v_local)::date;
  v_start := v_today - 13;
  v_end   := v_today + 28;

  -- Pull the secrets from Vault.
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'deputy_sync_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'deputy_sync_secret';

  if v_url is null or v_secret is null then
    raise exception 'deputy cron: missing Vault secret (deputy_sync_url / deputy_sync_secret)';
  end if;

  v_body := jsonb_build_object(
    'resources', jsonb_build_array('Timesheet', 'Roster'),
    'mode', 'incremental',
    'startDate', to_char(v_start, 'YYYY-MM-DD'),
    'endDate',   to_char(v_end,   'YYYY-MM-DD'),
    'dryRun', false
  );

  -- Fire-and-forget async POST (pg_net). The Edge Function records the run in
  -- deputy.sync_runs, so results are observable there regardless of this call.
  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', v_secret
    ),
    body    := v_body
  ) into v_request;

  return v_request;
end;
$$;

revoke all on function deputy.run_daily_timesheet_sync() from public, anon, authenticated;

commit;
