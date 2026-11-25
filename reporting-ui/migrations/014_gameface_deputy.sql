-- 014_gameface_deputy.sql
--
-- Purpose: store a SECOND company's Deputy roster/schedule (read-only sync) in a
-- separate schema, gameface_deputy, with its own sync function, cron jobs and
-- an admin-only page (/gameface-deputy). The existing `deputy` schema, its
-- functions and cron jobs are not touched.
--
-- Security model:
--   * The schema is locked to service_role (same as 001). anon and
--     authenticated get NO privilege on the schema, tables or sequences, and
--     RLS is enabled on every table with no policies as a second lock.
--   * The page reads through the gameface-deputy-read Edge Function, which
--     calls public.gameface_deputy_check_admin(username, password) first. That
--     function re-checks the admin password in SQL via activity_assert_admin
--     (migration 011) and raises 42501 'forbidden' otherwise. Unlike 013 it is
--     executable by service_role ONLY (the Edge Function holds that key), so
--     the anon key cannot be used to guess passwords against it.
--   * The scheduled sync reads its URL and secret from Vault; nothing secret is
--     in this file. If the Vault secrets are not set yet, the cron jobs do
--     nothing (they raise a notice and return null).
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor of
-- project uizimmfujhpuiqhjofzf. Requires migrations 001 and 011.
-- After running: Project Settings > Data API > Exposed schemas: add gameface_deputy.
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

create schema if not exists gameface_deputy;
revoke all on schema gameface_deputy from public, anon, authenticated;
grant usage on schema gameface_deputy to service_role;

create table if not exists gameface_deputy.companies          (like deputy.companies          including all);
create table if not exists gameface_deputy.operational_units  (like deputy.operational_units  including all);
create table if not exists gameface_deputy.employees          (like deputy.employees          including all);
create table if not exists gameface_deputy.rosters            (like deputy.rosters            including all);
create table if not exists gameface_deputy.timesheets         (like deputy.timesheets         including all);
create table if not exists gameface_deputy.leave_records      (like deputy.leave_records      including all);
create table if not exists gameface_deputy.sync_runs          (like deputy.sync_runs          including all);
create table if not exists gameface_deputy.sync_checkpoints   (like deputy.sync_checkpoints   including all);

-- LIKE does not copy foreign keys.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gameface_deputy_checkpoints_run_fk'
       and conrelid = 'gameface_deputy.sync_checkpoints'::regclass
  ) then
    alter table gameface_deputy.sync_checkpoints
      add constraint gameface_deputy_checkpoints_run_fk
      foreign key (last_successful_run_id)
      references gameface_deputy.sync_runs(id) on delete set null;
  end if;
end;
$$;

alter table gameface_deputy.companies         enable row level security;
alter table gameface_deputy.operational_units enable row level security;
alter table gameface_deputy.employees         enable row level security;
alter table gameface_deputy.rosters           enable row level security;
alter table gameface_deputy.timesheets        enable row level security;
alter table gameface_deputy.leave_records     enable row level security;
alter table gameface_deputy.sync_runs         enable row level security;
alter table gameface_deputy.sync_checkpoints  enable row level security;

revoke all on all tables in schema gameface_deputy from public, anon, authenticated;
revoke all on all sequences in schema gameface_deputy from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema gameface_deputy to service_role;
grant usage, select on all sequences in schema gameface_deputy to service_role;
alter default privileges in schema gameface_deputy
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema gameface_deputy
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema gameface_deputy
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema gameface_deputy
  grant usage, select on sequences to service_role;

-- Admin check used by the gameface-deputy-read Edge Function.
create or replace function public.gameface_deputy_check_admin(p_username text, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.activity_assert_admin(p_username, p_password);
  return true;
end;
$$;

revoke all on function public.gameface_deputy_check_admin(text, text) from public, anon, authenticated;
grant execute on function public.gameface_deputy_check_admin(text, text) to service_role;

-- Scheduled sync. Acts only when the Sydney wall clock is p_hour and the minute
-- is in [p_minute_from, p_minute_from + 30). DST-safe (gate is in Sydney time).
create or replace function gameface_deputy.run_scheduled_sync(p_hour int, p_minute_from int)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_local   timestamp := (now() at time zone 'Australia/Sydney');
  v_hour    int;
  v_minute  int;
  v_today   date;
  v_url     text;
  v_secret  text;
  v_body    jsonb;
  v_request bigint;
begin
  v_hour   := extract(hour   from v_local)::int;
  v_minute := extract(minute from v_local)::int;
  if not (v_hour = p_hour and v_minute >= p_minute_from and v_minute < p_minute_from + 30) then
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'gameface_deputy_sync_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'gameface_deputy_sync_secret';
  if v_url is null or v_secret is null then
    raise notice 'gameface deputy cron: Vault secrets gameface_deputy_sync_url / gameface_deputy_sync_secret not set yet';
    return null;
  end if;

  v_today := v_local::date;
  v_body := jsonb_build_object(
    'resources', jsonb_build_array('Company', 'OperationalUnit', 'Employee', 'Roster', 'Timesheet', 'Leave'),
    'mode', 'incremental',
    'startDate', to_char(v_today - 13, 'YYYY-MM-DD'),
    'endDate',   to_char(v_today + 28, 'YYYY-MM-DD'),
    'dryRun', false
  );

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

revoke all on function gameface_deputy.run_scheduled_sync(int, int) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'gameface-deputy-noon-sync') then
    perform cron.unschedule('gameface-deputy-noon-sync');
  end if;
  if exists (select 1 from cron.job where jobname = 'gameface-deputy-nightly-sync') then
    perform cron.unschedule('gameface-deputy-nightly-sync');
  end if;
end;
$$;

select cron.schedule(
  'gameface-deputy-noon-sync',
  '*/30 * * * *',
  $$ select gameface_deputy.run_scheduled_sync(12, 0); $$
);
select cron.schedule(
  'gameface-deputy-nightly-sync',
  '*/30 * * * *',
  $$ select gameface_deputy.run_scheduled_sync(22, 30); $$
);

-- Permission for the GameFace Deputy page (admin and super_admin only).
insert into public.role_permissions (role, page_key, can_access)
values
  ('super_admin', 'gameface-deputy', true),
  ('admin',       'gameface-deputy', true),
  ('analyst',     'gameface-deputy', false)
on conflict (role, page_key) do update set can_access = excluded.can_access;

notify pgrst, 'reload schema';

commit;

-- VAULT (run once, with real values, never commit them):
--   select vault.create_secret(
--     'https://uizimmfujhpuiqhjofzf.functions.supabase.co/gameface-deputy-sync',
--     'gameface_deputy_sync_url', 'gameface-deputy-sync URL');
--   select vault.create_secret(
--     '<PLACEHOLDER: same value as GAMEFACE_DEPUTY_SYNC_SECRET>',
--     'gameface_deputy_sync_secret', 'x-sync-secret for gameface-deputy-sync');
--
-- VERIFY (run separately):
--   select table_name, privilege_type, grantee from information_schema.role_table_grants
--    where table_schema = 'gameface_deputy' and grantee in ('anon', 'authenticated');   -- 0 rows
--   select relname, relrowsecurity from pg_class
--    where relnamespace = 'gameface_deputy'::regnamespace and relkind = 'r';            -- all true
--   select jobname, schedule, active from cron.job
--    where jobname like 'gameface-deputy-%' or jobname like 'deputy-%';
--   select role, can_access from public.role_permissions where page_key = 'gameface-deputy';  -- 3 rows
--
-- ROLLBACK (run separately):
--   select cron.unschedule('gameface-deputy-noon-sync');
--   select cron.unschedule('gameface-deputy-nightly-sync');
--   drop function if exists gameface_deputy.run_scheduled_sync(int, int);
--   drop function if exists public.gameface_deputy_check_admin(text, text);
--   drop schema gameface_deputy cascade;
--   delete from public.role_permissions where page_key = 'gameface-deputy';
