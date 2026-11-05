-- Premier Data × Deputy integration
-- Migration: 002_deputy_cron.sql
-- Schedules a nightly Timesheet + Roster sync so approved shifts and the
-- rostered schedule are pulled into the `deputy` schema at the end of each day
-- (22:30 Australia/Sydney).
--
-- Apply through the Supabase SQL Editor as a project administrator.
--
-- DESIGN
-- - Uses pg_cron (scheduler) + pg_net (async HTTP) to POST to the deployed
--   `deputy-sync` Edge Function. No external scheduler required.
-- - DST-safe: the cron entry fires every 30 min; the SQL function
--   `deputy.run_daily_timesheet_sync()` only acts when the current
--   Australia/Sydney wall-clock time is 22:30. Because the gate is evaluated in
--   the 'Australia/Sydney' zone, it tracks AEST/AEDT automatically — no
--   hardcoded UTC offset that would drift an hour across daylight saving.
-- - Window: a trailing 14 days of Sydney local dates (today and the 13 prior),
--   so shifts approved up to ~2 weeks late are still captured (Deputy approvals
--   lag well past a few days). Upserts are idempotent on deputy_id, so
--   re-pulling the same days never duplicates.
-- - The x-sync-secret and the function URL are read from Supabase Vault, never
--   stored in this file or in git.
--
-- Every statement is idempotent; re-applying is safe.

begin;

-- ── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- Vault (supabase_vault) is enabled by default on Supabase projects; the
-- create below is a no-op guard in case it was disabled.
create extension if not exists supabase_vault;

-- ── Secrets (Vault) ───────────────────────────────────────────────────────────
-- Store the function URL and the x-sync-secret in Vault. These INSERTs are
-- commented out because they must run ONCE with real values and should not be
-- committed with secrets in them. Run them manually in the SQL Editor (see the
-- apply notes at the bottom), then leave them commented here.
--
--   select vault.create_secret(
--     'https://uizimmfujhpuiqhjofzf.functions.supabase.co/deputy-sync',
--     'deputy_sync_url',
--     'deputy-sync Edge Function URL');
--
--   select vault.create_secret(
--     '<DEPUTY_SYNC_SECRET>',
--     'deputy_sync_secret',
--     'x-sync-secret header for deputy-sync');

-- ── Worker function ──────────────────────────────────────────────────────────
-- Reads the Vault secrets and, when it is 22:30 in Sydney, POSTs a trailing
-- 3-day Timesheet sync to the Edge Function. Returns the pg_net request id when
-- it fires, or null when the time gate is not met.
create or replace function deputy.run_daily_timesheet_sync()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_now_syd   timestamptz := now();
  v_local     timestamp   := (now() at time zone 'Australia/Sydney');
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

  -- Trailing 14-day window in Sydney local dates (today + 13 prior days).
  -- Wider than one day because Deputy approvals lag — a shift worked today may
  -- not be approved for several days, and a 14-day trailing re-pull recaptures
  -- those late approvals (upserts on deputy_id, so re-syncing the same days is
  -- idempotent and never duplicates).
  v_end   := (v_local)::date;
  v_start := v_end - 13;

  -- Pull the secrets from Vault.
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'deputy_sync_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'deputy_sync_secret';

  if v_url is null or v_secret is null then
    raise exception 'deputy cron: missing Vault secret (deputy_sync_url / deputy_sync_secret)';
  end if;

  -- Sync both Timesheet (approved hours/pay) and Roster (planned shifts) so
  -- the Deputy API page's Rostered Schedule tab stays current too, not just
  -- Approved Timesheets. The Edge Function orders reference resources first,
  -- so passing both here is safe.
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

-- ── Schedule ─────────────────────────────────────────────────────────────────
-- Unschedule a prior copy of this job if present (makes re-apply idempotent),
-- then schedule it to run every 30 minutes. The function's internal time gate
-- restricts actual execution to 22:30 Sydney.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'deputy-daily-timesheet-sync') then
    perform cron.unschedule('deputy-daily-timesheet-sync');
  end if;
end;
$$;

select cron.schedule(
  'deputy-daily-timesheet-sync',
  '*/30 * * * *',
  $$ select deputy.run_daily_timesheet_sync(); $$
);

commit;

-- ── APPLY NOTES ──────────────────────────────────────────────────────────────
-- 1. Set the two Vault secrets ONCE (SQL Editor), with real values:
--      select vault.create_secret(
--        'https://uizimmfujhpuiqhjofzf.functions.supabase.co/deputy-sync',
--        'deputy_sync_url', 'deputy-sync Edge Function URL');
--      select vault.create_secret(
--        '<DEPUTY_SYNC_SECRET>', 'deputy_sync_secret', 'x-sync-secret for deputy-sync');
--    (If a secret with that name already exists, update it with
--     vault.update_secret(<uuid>, <new value>) instead.)
-- 2. Run this migration.
-- 3. Verify the job exists:        select jobname, schedule, active from cron.job;
-- 4. Watch recent runs:            select * from cron.job_run_details
--                                    order by start_time desc limit 10;
-- 5. Confirm the sync landed:      select * from deputy.sync_runs
--                                    where resource = 'Timesheet'
--                                    order by started_at desc limit 5;
--
-- To test immediately without waiting for 22:30, temporarily call the inner
-- POST directly (bypassing the time gate) or adjust the gate, then revert.
