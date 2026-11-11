-- Premier Data x Deputy integration
-- Migration: 005_weekly_report_deputy_view.sql
--
-- >>> RUN THIS MANUALLY in the Supabase SQL Editor (project administrator). <<<
-- Nothing in the app or CI applies it. Until you run it the Weekly Report keeps
-- using deputy_shifts (Excel) exactly as before (the UI falls back safely).
--
-- WHAT THIS DOES
--   The Weekly Report reads shift hours / cost / area from ONE public view,
--   public.weekly_report_shifts:
--     * Season 2026 and earlier  -> the Excel-loaded table public.deputy_shifts
--                                   (unchanged, past weeks do not move).
--     * Season 2027 Week 1 onward -> the live Deputy API tables (deputy.timesheets
--                                   + deputy.operational_units), Wed 2026-09-30 on.
--
-- WHAT IS CREATED
--   * table    public.deputy_area_map      unit_name -> area_name (YOU edit this)
--   * function public.deputy_season_roll_date(int), deputy_season_of(date),
--              deputy_season_week_of(date)   (port of sync-deputy.js season rules)
--   * view     public.weekly_report_shifts
--
-- AREA NAMES
--   Each Deputy operational unit is its own area, with its exact Deputy name.
--   To rename or merge areas, edit public.deputy_area_map (Table Editor), e.g.
--   set area_name = 'Soccer' for several unit_name rows to merge them. The view
--   reads the map live, so changes show on the next page load.
--   Timesheets with no operational unit (blank id, '0' or unit not found) are
--   reported under the area 'Unassigned'.
--   When Deputy adds a NEW unit it shows up under its own name automatically
--   (the view falls back to the unit name when it has no map row). To make it
--   editable, re-seed (safe to re-run any time):
--       insert into public.deputy_area_map (unit_name, area_name)
--       select btrim(operational_unit_name), btrim(operational_unit_name)
--       from deputy.operational_units
--       where nullif(btrim(operational_unit_name), '') is not null
--       on conflict (unit_name) do nothing;
--
-- SECURITY / WHAT IS EXPOSED
--   The `deputy` schema is deliberately locked to service_role (migration 001).
--   This view is a normal view owned by the migration runner (postgres), so it
--   runs with its OWNER's rights and can read deputy.*. It must NOT be
--   security_invoker (anon cannot read the deputy schema). anon/authenticated
--   get SELECT on the view only. The view exposes ONLY: shift_key (an opaque
--   'api_<deputy id>'), shift_date, area_name, total_hours, total_cost, week,
--   season, source. NO employee names, ids or other personal data. Cost is
--   exposed to anon the same way public.deputy_shifts already exposes it.
--   deputy_area_map holds only unit/area labels, so anon may read it (select
--   policy); writes are not granted to anon (edit it with the dashboard role).
--
-- RULES
--   * Cost = Deputy timesheet `cost` (not cost + on_cost, not hours x rate).
--   * Only time_approved = true AND discarded not true (same as the Deputy API
--     tab). Unapproved timesheets are not counted until approved. Leave
--     timesheets are counted like any other approved timesheet.
--   * Cutover: season >= 2027 comes from the API; season < 2027 from Excel.
--
-- Idempotent: safe to re-run.

begin;

-- ── Area map ─────────────────────────────────────────────────────────────────
create table if not exists public.deputy_area_map (
  unit_name text primary key,   -- exact Deputy operational unit name
  area_name text not null       -- name shown as a row in the Weekly Report
);

comment on table public.deputy_area_map is
  'Weekly Report: Deputy operational unit name -> report area name. Edit area_name to rename/merge areas.';

alter table public.deputy_area_map enable row level security;

drop policy if exists "anon read deputy_area_map" on public.deputy_area_map;
create policy "anon read deputy_area_map"
  on public.deputy_area_map for select
  to anon, authenticated
  using (true);

-- Read for the app roles; writes only via the dashboard / service role.
grant select on public.deputy_area_map to anon, authenticated;

-- Identity seed: every Deputy unit maps to itself. Existing rows are never
-- overwritten, so your edits survive re-running this file.
insert into public.deputy_area_map (unit_name, area_name)
select btrim(operational_unit_name), btrim(operational_unit_name)
from deputy.operational_units
where nullif(btrim(operational_unit_name), '') is not null
on conflict (unit_name) do nothing;

-- ── Season / week helpers (exact port of sync-deputy.js) ─────────────────────
-- Weeks run Wed -> Tue. Season N starts on the Wednesday ON OR BEFORE 1 Oct of
-- calendar year N-1 (2027 season starts Wed 2026-09-30). Days before that
-- year's roll belong to the previous season. Week 1 starts on the roll date.

-- Wednesday on-or-before 1 Oct of `cal_year` (first day of season cal_year+1).
-- extract(dow): 0=Sun..6=Sat, same as JS getUTCDay(); Wednesday = 3.
create or replace function public.deputy_season_roll_date(cal_year integer)
returns date
language sql
immutable
as $$
  select (make_date(cal_year, 10, 1)
          - ((extract(dow from make_date(cal_year, 10, 1))::integer - 3 + 7) % 7))
$$;

-- Season label of a date: on/after this calendar year's roll -> year + 1.
create or replace function public.deputy_season_of(d date)
returns integer
language sql
immutable
as $$
  select case
    when d is null then null
    when d >= public.deputy_season_roll_date(extract(year from d)::integer)
      then extract(year from d)::integer + 1
    else extract(year from d)::integer
  end
$$;

-- Week number within the season (week 1 = first 7-day block from the roll).
create or replace function public.deputy_season_week_of(d date)
returns integer
language sql
immutable
as $$
  select case
    when d is null then null
    else floor(
      (d - public.deputy_season_roll_date(public.deputy_season_of(d) - 1))::numeric / 7
    )::integer + 1
  end
$$;

-- ── View ─────────────────────────────────────────────────────────────────────
-- Column names/types match what WeeklyReport.tsx reads from deputy_shifts.
create or replace view public.weekly_report_shifts as
-- (a) Excel rows: seasons before the 2027 cutover, untouched.
select
  s.shift_key::text            as shift_key,
  s.shift_date::date           as shift_date,
  s.area_name::text            as area_name,
  s.total_hours::numeric       as total_hours,
  s.total_cost::numeric        as total_cost,
  s.week::integer              as week,
  s.season::integer            as season,
  'excel'::text                as source
from public.deputy_shifts s
where s.season < 2027
union all
-- (b) Deputy API rows: season 2027 Week 1 onward (derived from the date).
select
  ('api_' || t.deputy_id)::text                                  as shift_key,
  t.timesheet_date                                               as shift_date,
  coalesce(
    nullif(btrim(m.area_name), ''),
    nullif(btrim(ou.operational_unit_name), ''),
    'Unassigned'
  )::text                                                        as area_name,
  coalesce(t.total_time, 0)::numeric                             as total_hours,
  coalesce(t.cost, 0)::numeric                                   as total_cost,
  public.deputy_season_week_of(t.timesheet_date)                 as week,
  public.deputy_season_of(t.timesheet_date)                      as season,
  'deputy-api'::text                                             as source
from deputy.timesheets t
-- Blank / '0' ids never match a unit, so they fall through to 'Unassigned'.
left join deputy.operational_units ou
  on ou.deputy_id = nullif(nullif(btrim(t.operational_unit_deputy_id), ''), '0')
left join public.deputy_area_map m
  on m.unit_name = btrim(ou.operational_unit_name)
where t.time_approved is true
  and coalesce(t.discarded, false) = false
  and t.timesheet_date is not null
  and public.deputy_season_of(t.timesheet_date) >= 2027;

comment on view public.weekly_report_shifts is
  'Weekly Report shifts: Excel deputy_shifts for season < 2027, Deputy API (approved, non-discarded, cost) from season 2027. No personal data.';

-- Owner-rights view (default). Do NOT set security_invoker: anon cannot read deputy.*
revoke all on public.weekly_report_shifts from public;
grant select on public.weekly_report_shifts to anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFY (run these separately in the SQL Editor after the migration)
-- ═════════════════════════════════════════════════════════════════════════════
-- 1) Rows / hours / cost per season and source (expect excel for 2026, deputy-api for 2027+):
--   select season, source, count(*) as rows, round(sum(total_hours),1) as hours, round(sum(total_cost)) as cost
--   from public.weekly_report_shifts group by 1,2 order by 1,2;
--
-- 2) Season/week helper spot-check (expect 2026-09-29 -> 2026 w52, 2026-09-30 -> 2027 w1,
--    2026-10-06 -> 2027 w1, 2026-10-07 -> 2027 w2, 2027-09-29 -> 2028 w1):
--   select d, public.deputy_season_of(d) as season, public.deputy_season_week_of(d) as week
--   from (values ('2026-09-29'::date),('2026-09-30'),('2026-10-06'),('2026-10-07'),('2027-09-29')) v(d);
--
-- 3) Weekly totals per area for the most recent weeks:
--   select season, week, area_name, round(sum(total_hours),1) as hours, round(sum(total_cost)) as cost
--   from public.weekly_report_shifts
--   where season = 2027 and week >= (select max(week) - 3 from public.weekly_report_shifts where season = 2027)
--   group by 1,2,3 order by 2 desc, 3;
--
-- 4) Deputy units and the area each maps to (edit public.deputy_area_map to change):
--   select ou.deputy_id, ou.operational_unit_name as unit,
--          coalesce(m.area_name, '(no map row: uses unit name)') as area
--   from deputy.operational_units ou
--   left join public.deputy_area_map m on m.unit_name = btrim(ou.operational_unit_name)
--   order by ou.operational_unit_name;
--
-- 5) Confirm the anon key can read it (from the app, or REST: GET /rest/v1/weekly_report_shifts?limit=1).
