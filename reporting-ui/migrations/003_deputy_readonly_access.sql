-- Premier Data x Deputy integration
-- Migration: 003_deputy_readonly_access.sql
--
-- Read-only database access to APPROVED SHIFTS for an external developer.
--
-- WHAT THIS CREATES
--   * schema  deputy_export                   (not in the Data API's exposed schemas)
--   * view    deputy_export.approved_shifts   (approved, non-discarded timesheets
--                                              with names resolved)
--   * role    deputy_reader                   (SELECT on that one view, nothing else)
--
-- DESIGN / SECURITY
--   * The developer gets a login that can read ONE view. It has no access to the
--     `deputy` tables, to `public` app tables, or to any other schema, and it
--     cannot write: the role is read-only by default, with a statement timeout
--     and a small connection limit.
--   * The view runs with its OWNER's rights (the Postgres default, i.e. NOT
--     security_invoker), so the reader needs no grant on deputy.* at all.
--   * PAY IS DELIBERATELY NOT EXPOSED (no cost / on_cost columns). Add them to
--     the view only if the developer genuinely needs wages.
--   * NO PASSWORD IS STORED IN THIS FILE. The role is created NOLOGIN. Enable it
--     with a password in a separate step that is never committed (see bottom).
--
-- Idempotent: safe to re-run. Apply in the Supabase SQL Editor.
-- To revoke access later:  alter role deputy_reader nologin;  (or drop it).

begin;

-- ── Schema ───────────────────────────────────────────────────────────────────
create schema if not exists deputy_export;
revoke all on schema deputy_export from public, anon, authenticated;

-- ── View ─────────────────────────────────────────────────────────────────────
-- Same definition of "approved" as the site: time_approved and not discarded
-- (Deputy's "Auto-approved" shifts also have time_approved = true).
-- Names: the employee's actual first + last name, falling back to Deputy's
-- display name, then the raw id. Dates: shift_date is the Australia/Sydney
-- calendar date of the shift; start_at / end_at are exact instants (timestamptz).
-- modified_at is Deputy's last-modified time, useful for incremental pulls.
create or replace view deputy_export.approved_shifts as
select
  t.deputy_id                                         as shift_id,
  t.timesheet_date                                    as shift_date,
  t.start_at                                          as start_at,
  t.end_at                                            as end_at,
  t.total_time                                        as hours,
  t.employee_deputy_id                                as employee_id,
  coalesce(
    nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''),
    nullif(btrim(e.display_name), ''),
    t.employee_deputy_id
  )                                                   as employee_name,
  t.operational_unit_deputy_id                        as area_id,
  coalesce(
    nullif(btrim(ou.operational_unit_name), ''),
    t.operational_unit_deputy_id
  )                                                   as area_name,
  coalesce(t.is_leave, false)                         as is_leave,
  t.source_modified_at                                as modified_at
from deputy.timesheets t
left join deputy.employees e
  on e.deputy_id = t.employee_deputy_id
left join deputy.operational_units ou
  on ou.deputy_id = t.operational_unit_deputy_id
where t.time_approved is true
  and coalesce(t.discarded, false) = false
  and t.is_deleted = false;

revoke all on deputy_export.approved_shifts from public, anon, authenticated;

-- ── Role ─────────────────────────────────────────────────────────────────────
-- Created NOLOGIN: cannot connect until you enable it with a password (below).
-- New roles default to no superuser / createdb / createrole / bypassrls.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'deputy_reader') then
    create role deputy_reader nologin;
  end if;
end
$$;

alter role deputy_reader connection limit 5;
alter role deputy_reader set default_transaction_read_only = on;
alter role deputy_reader set statement_timeout = '30s';
alter role deputy_reader set idle_in_transaction_session_timeout = '30s';

grant usage on schema deputy_export to deputy_reader;
grant select on deputy_export.approved_shifts to deputy_reader;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 2 (run manually, NEVER commit the password): enable login
-- ═════════════════════════════════════════════════════════════════════════════
--   alter role deputy_reader with login password '<LONG_RANDOM_PASSWORD>';
--
-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 3: verify (SQL Editor). Impersonate the role and check it is boxed in.
-- ═════════════════════════════════════════════════════════════════════════════
--   grant deputy_reader to postgres;   -- lets you SET ROLE in the editor
--   set role deputy_reader;
--   select count(*) from deputy_export.approved_shifts;   -- works
--   select * from deputy.timesheets limit 1;              -- must FAIL: permission denied
--   select * from public.user_accounts limit 1;           -- must FAIL: permission denied
--   insert into deputy_export.approved_shifts (shift_id) values ('x');  -- must FAIL
--   reset role;
--
-- CONNECTING (developer, server-side only, SSL on):
--   host     aws-1-ap-southeast-2.pooler.supabase.com
--   port     5432
--   database postgres
--   user     deputy_reader.uizimmfujhpuiqhjofzf   (pooler format: role.project-ref)
--   password <the password from step 2>
--   e.g.  postgresql://deputy_reader.uizimmfujhpuiqhjofzf:<password>@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
