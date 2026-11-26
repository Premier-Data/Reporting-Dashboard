-- 015_gameface_fixture_allocations.sql
--
-- Purpose: let an admin allocate a synced Comp Fixture (public.comp_fixtures,
-- AFL only) to a published GameFace roster shift on the GameFace Schedule view.
-- Allocation only. Nothing here is linked to the Premier Data assignments.
--
-- Rules enforced in the database:
--   * One ACTIVE allocation per fixture (partial unique index on
--     comp_fixture_id where unallocated_at is null). A second allocate raises
--     'already_allocated' (23505). Unallocating is a soft cancel, so history is
--     kept and the fixture can be allocated again afterwards.
--   * The fixture must exist with sport 'Australian Rules Football'.
--   * The shift must be a gameface_deputy.rosters row that is published, not
--     deleted and not an open shift. shift_date and the employee link come
--     from that row and allocated_by from the verified username, never from
--     the client.
--
-- Security model (same as 014):
--   * The table lives in the gameface_deputy schema, which is locked to
--     service_role. RLS is on with no policies as a second lock.
--   * The Edge Function gameface-fixture-allocations calls the three public
--     SECURITY DEFINER functions below with the service-role key. Each one
--     starts with public.activity_assert_admin(username, password) (migration
--     011), which raises 42501 'forbidden' for a non-admin or wrong password.
--     Execute is limited to service_role, so the anon key cannot reach them.
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor of
-- project uizimmfujhpuiqhjofzf. Requires migrations 001, 011 and 014.
begin;

create table if not exists gameface_deputy.fixture_allocations (
  id               bigint generated always as identity primary key,
  comp_fixture_id  text        not null,
  roster_deputy_id text        not null,
  employee_name    text        not null,
  shift_date       date        not null,
  allocated_by     text        not null,
  allocated_at     timestamptz not null default now(),
  unallocated_by   text,
  unallocated_at   timestamptz,
  constraint fixture_allocations_unalloc_pair
    check ((unallocated_by is null) = (unallocated_at is null))
);

alter table gameface_deputy.fixture_allocations enable row level security;
revoke all on gameface_deputy.fixture_allocations from public, anon, authenticated;
grant all on gameface_deputy.fixture_allocations to service_role;

-- One active allocation per fixture.
create unique index if not exists fixture_allocations_one_active_idx
  on gameface_deputy.fixture_allocations (comp_fixture_id)
  where unallocated_at is null;

create index if not exists fixture_allocations_shift_date_idx
  on gameface_deputy.fixture_allocations (shift_date);

-- List ACTIVE allocations whose shift_date is in [p_from, p_to].
create or replace function public.gameface_fixture_allocations_list(
  p_username text,
  p_password text,
  p_from     date,
  p_to       date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.activity_assert_admin(p_username, p_password);
  select coalesce(jsonb_agg(to_jsonb(a) order by a.shift_date, a.id), '[]'::jsonb)
    into v_rows
    from (
      select id, comp_fixture_id, roster_deputy_id, employee_name,
             shift_date, allocated_by, allocated_at
        from gameface_deputy.fixture_allocations
       where unallocated_at is null
         and (p_from is null or shift_date >= p_from)
         and (p_to is null or shift_date <= p_to)
    ) a;
  return v_rows;
end;
$$;

-- Allocate a fixture to a published roster shift.
create or replace function public.gameface_fixture_allocate(
  p_username        text,
  p_password        text,
  p_comp_fixture_id text,
  p_roster_id       text,
  p_employee_name   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_roster_date date;
  v_row         gameface_deputy.fixture_allocations;
begin
  perform public.activity_assert_admin(p_username, p_password);

  if not exists (
    select 1 from public.comp_fixtures f
     where f.id = p_comp_fixture_id
       and f.sport = 'Australian Rules Football'
  ) then
    raise exception 'fixture_not_allocatable' using errcode = '22023';
  end if;

  select r.roster_date into v_roster_date
    from gameface_deputy.rosters r
   where r.deputy_id = p_roster_id
     and r.is_deleted = false
     and r.published = true
     and coalesce(r.open_shift, false) = false;
  if v_roster_date is null then
    raise exception 'shift_not_allocatable' using errcode = '22023';
  end if;

  begin
    insert into gameface_deputy.fixture_allocations
      (comp_fixture_id, roster_deputy_id, employee_name, shift_date, allocated_by)
    values
      (p_comp_fixture_id, p_roster_id, coalesce(nullif(btrim(p_employee_name), ''), 'Unknown'),
       v_roster_date, p_username)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'already_allocated' using errcode = '23505';
  end;

  return jsonb_build_object(
    'id', v_row.id,
    'comp_fixture_id', v_row.comp_fixture_id,
    'roster_deputy_id', v_row.roster_deputy_id,
    'employee_name', v_row.employee_name,
    'shift_date', v_row.shift_date,
    'allocated_by', v_row.allocated_by,
    'allocated_at', v_row.allocated_at
  );
end;
$$;

-- Soft-cancel an active allocation.
create or replace function public.gameface_fixture_unallocate(
  p_username      text,
  p_password      text,
  p_allocation_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row gameface_deputy.fixture_allocations;
begin
  perform public.activity_assert_admin(p_username, p_password);

  update gameface_deputy.fixture_allocations
     set unallocated_by = p_username,
         unallocated_at = now()
   where id = p_allocation_id
     and unallocated_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'comp_fixture_id', v_row.comp_fixture_id,
    'roster_deputy_id', v_row.roster_deputy_id,
    'employee_name', v_row.employee_name,
    'shift_date', v_row.shift_date,
    'allocated_by', v_row.allocated_by,
    'allocated_at', v_row.allocated_at
  );
end;
$$;

revoke all on function public.gameface_fixture_allocations_list(text, text, date, date) from public, anon, authenticated;
revoke all on function public.gameface_fixture_allocate(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.gameface_fixture_unallocate(text, text, bigint) from public, anon, authenticated;
grant execute on function public.gameface_fixture_allocations_list(text, text, date, date) to service_role;
grant execute on function public.gameface_fixture_allocate(text, text, text, text, text) to service_role;
grant execute on function public.gameface_fixture_unallocate(text, text, bigint) to service_role;

notify pgrst, 'reload schema';
commit;

-- VERIFY (run separately):
--   select indexname, indexdef from pg_indexes
--    where schemaname = 'gameface_deputy' and tablename = 'fixture_allocations';       -- partial unique index present
--   select relrowsecurity from pg_class
--    where oid = 'gameface_deputy.fixture_allocations'::regclass;                       -- true
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'gameface_deputy' and table_name = 'fixture_allocations'
--      and grantee in ('anon', 'authenticated');                                         -- 0 rows
--   select p.proname, p.prosecdef from pg_proc p
--    where p.pronamespace = 'public'::regnamespace and p.proname like 'gameface_fixture_%'; -- 3 rows, prosecdef true
--
-- ROLLBACK (run separately):
--   drop function if exists public.gameface_fixture_allocations_list(text, text, date, date);
--   drop function if exists public.gameface_fixture_allocate(text, text, text, text, text);
--   drop function if exists public.gameface_fixture_unallocate(text, text, bigint);
--   drop table if exists gameface_deputy.fixture_allocations;
