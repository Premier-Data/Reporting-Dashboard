-- Premier Data x Deputy integration
-- Migration: 012_deputy_cron_noon.sql
-- Adds a second daily Deputy sync at 12:00 (noon) Australia/Sydney, in addition
-- to the nightly 22:30 job from 002/004.
--
-- Why a new function: deputy.run_daily_timesheet_sync() has a hard 22:30 Sydney
-- time gate, so scheduling it again would never act at noon. This migration adds
-- deputy.run_noon_timesheet_sync(), identical to the 004 version of the nightly
-- function (same Vault lookups, same resources Timesheet + Roster, same mode,
-- same window today-13 .. today+28 in Sydney dates, same pg_net POST) except the
-- time gate (12:00-12:29 Sydney) and the name. The nightly function and job are
-- NOT touched.
--
-- DST-safe: pg_cron fires every 30 minutes (UTC); the function gates on the
-- Australia/Sydney wall clock, so AEST/AEDT is tracked automatically with no
-- hardcoded UTC offset. The 12:00 tick matches once per day.
--
-- Scope note: the sync pulls Deputy Timesheets (approved hours) and Roster, same
-- as the nightly job. Upserts are idempotent on deputy_id, so the extra run never
-- duplicates rows.
--
-- Requires the Vault secrets deputy_sync_url and deputy_sync_secret already set
-- up for 002. Contains no secrets. Apply through the Supabase SQL Editor
-- (project uizimmfujhpuiqhjofzf) as a project administrator.
-- Idempotent: create or replace + unschedule-if-exists, so re-applying is safe.
begin;

create or replace function deputy.run_noon_timesheet_sync()
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

  -- Time gate: only act at 12:00 Sydney local time. The cron entry runs every
  -- 30 minutes, so this matches exactly once per day.
  if not (v_hour = 12 and v_minute >= 0 and v_minute < 30) then
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
  -- deputy.sync_runs.
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

revoke all on function deputy.run_noon_timesheet_sync() from public, anon, authenticated;

-- Unschedule a prior copy if present, then schedule every 30 minutes. The
-- function's time gate restricts actual execution to 12:00 Sydney.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'deputy-noon-timesheet-sync') then
    perform cron.unschedule('deputy-noon-timesheet-sync');
  end if;
end;
$$;

select cron.schedule(
  'deputy-noon-timesheet-sync',
  '*/30 * * * *',
  $$ select deputy.run_noon_timesheet_sync(); $$
);

commit;

-- VERIFY (run separately):
--   select jobname, schedule, command, active from cron.job
--    where jobname in ('deputy-daily-timesheet-sync', 'deputy-noon-timesheet-sync');
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select * from deputy.sync_runs order by started_at desc limit 5;
--
-- ROLLBACK (run separately):
--   select cron.unschedule('deputy-noon-timesheet-sync');
--   drop function if exists deputy.run_noon_timesheet_sync();
