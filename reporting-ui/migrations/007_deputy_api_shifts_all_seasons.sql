-- Premier Data x Deputy integration
-- Migration: 007_deputy_api_shifts_all_seasons.sql
--
-- >>> RUN THIS MANUALLY in the Supabase SQL Editor (project administrator). <<<
-- Nothing in the app or CI applies it.
--
-- RUN ORDER (see also 006_lock_excel_deputy_tables.sql):
--   1) run THIS file (007)
--   2) deploy the new frontend
--   3) verify (queries at the bottom of this file + spot-check the app)
--   4) only then run 006 (locks the Excel tables)
--
-- WHAT THIS DOES
--   Replaces public.weekly_report_shifts (created by 005) so it reads ONLY the live
--   Deputy API tables (deputy.timesheets + deputy.operational_units) for EVERY
--   season from 2026. The Excel table public.deputy_shifts is no longer touched by
--   this view (no UNION). Verify with query 4 below.
--
-- RULES
--   * Cost = Deputy timesheet `cost` (not cost + on_cost, not hours x rate).
--   * Only time_approved = true AND discarded not true (same as deputy-read / the
--     Deputy API tab). Leave timesheets count like any other approved timesheet.
--   * is_deleted is deliberately NOT filtered, to mirror deputy-read exactly so the
--     view and the employee-level pages cannot disagree. See verification query 6.
--   * Area = Deputy operational unit name through public.deputy_area_map. No unit
--     (blank id, '0', unit not found) -> 'Unassigned'.
--   * Report cutoff: timesheets dated BEFORE deputy_report_start_date() (2026-01-01)
--     are never reported, so 2025 history does not appear as an extra season.
--   * Season 2026 is SHEET-DEFINED: week 0 = everything before 2026-03-25 (the
--     report starts at 2026-01-01), week 1 starts Wed 2026-03-25, then Wed->Tue
--     weeks until 2026-09-29. Season 2027+ follow the formula helper from 005
--     (Week 1 = Wednesday on or before 1 Oct; 2027 Week 1 = Wed 2026-09-30).
--     The formula helper deputy_season_week_of() is NOT correct for 2026 dates, so
--     the new deputy_report_week_of() special-cases season 2026.
--
-- SECURITY / WHAT IS EXPOSED
--   Same as 005: owner-rights view (NOT security_invoker; anon cannot read the
--   deputy schema). Exposes ONLY: shift_key (opaque 'api_<deputy id>'), shift_date,
--   area_name, total_hours, total_cost, week, season, source, day_name, month_name.
--   NO employee names or ids. anon/authenticated get SELECT on the view only.
--
-- COLUMNS: the first eight keep the exact name/order/type of 005 (required by
-- CREATE OR REPLACE VIEW); day_name and month_name are appended (English names
-- derived from the date, not used by the app).
--
-- Idempotent: safe to re-run. Does not edit 005.
begin;

-- ── Named constants (immutable zero-argument functions) ──────────────────────────
-- Cutoff: API timesheets before this date are never reported.
create or replace function public.deputy_report_start_date()
returns date
language sql
immutable
as $$ select date '2026-01-01' $$;

-- Season 2026 is sheet-defined: week 0 = everything before this date, week 1 starts here.
create or replace function public.deputy_season2026_week1_start()
returns date
language sql
immutable
as $$ select date '2026-03-25' $$;

-- ── Week of a date for the report (season 2026 special-cased) ────────────────────
-- Needs deputy_season_of() / deputy_season_week_of() from migration 005.
create or replace function public.deputy_report_week_of(d date)
returns integer
language sql
immutable
as $$
  select case
    when d is null then null
    when public.deputy_season_of(d) = 2026 then
      case
        when d < public.deputy_season2026_week1_start() then 0
        else ((d - public.deputy_season2026_week1_start()) / 7) + 1   -- integer days / 7
      end
    else public.deputy_season_week_of(d)
  end
$$;

comment on function public.deputy_report_start_date() is
  'Weekly Report cutoff: Deputy API timesheets before this date are never reported (TS twin: DEPUTY_REPORT_START_DATE in lib/deputy/reportWeeks.ts).';
comment on function public.deputy_season2026_week1_start() is
  'Season 2026 is sheet-defined: week 0 before this date, week 1 starts here (TS twin: SEASON_2026_WEEK1_START).';
comment on function public.deputy_report_week_of(date) is
  'Report week number of a date: season 2026 sheet-defined (week 0 before 2026-03-25), other seasons use deputy_season_week_of (TS twin: deputyWeekOf).';

-- ── View ─────────────────────────────────────────────────────────────────────────
create or replace view public.weekly_report_shifts as
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
  public.deputy_report_week_of(t.timesheet_date)                 as week,
  public.deputy_season_of(t.timesheet_date)                      as season,
  'deputy-api'::text                                             as source,
  btrim(to_char(t.timesheet_date, 'FMDay'))::text                as day_name,
  btrim(to_char(t.timesheet_date, 'FMMonth'))::text              as month_name
from deputy.timesheets t
-- Blank / '0' ids never match a unit, so they fall through to 'Unassigned'.
left join deputy.operational_units ou
  on ou.deputy_id = nullif(nullif(btrim(t.operational_unit_deputy_id), ''), '0')
left join public.deputy_area_map m
  on m.unit_name = btrim(ou.operational_unit_name)
where t.time_approved is true
  and coalesce(t.discarded, false) = false
  and t.timesheet_date is not null
  and t.timesheet_date >= public.deputy_report_start_date();

comment on view public.weekly_report_shifts is
  'Deputy API shifts (approved, non-discarded, Deputy cost) for every season from 2026. No personal data. Replaced the Excel union of migration 005.';

-- Owner-rights view (default). Do NOT set security_invoker: anon cannot read deputy.*
revoke all on public.weekly_report_shifts from public;
grant select on public.weekly_report_shifts to anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFY (run these separately in the SQL Editor after the migration)
-- ═══════════════════════════════════════════════════════════════════════════════
-- 1) Rows / hours / cost per season and source (expect ONLY seasons 2026 and 2027, ONLY deputy-api):
--   select season, source, count(*) as rows, round(sum(total_hours),1) as hours, round(sum(total_cost)) as cost
--   from public.weekly_report_shifts group by 1,2 order by 1,2;
--
-- 2) Fixture dates (expect 2026-01-01 -> 2026 w0, 2026-03-24 -> 2026 w0, 2026-03-25 -> 2026 w1,
--    2026-03-31 -> 2026 w1, 2026-04-01 -> 2026 w2, 2026-09-29 -> 2026 w27,
--    2026-09-30 -> 2027 w1, 2026-10-06 -> 2027 w1, 2026-10-07 -> 2027 w2):
--   select d, public.deputy_season_of(d) as season, public.deputy_report_week_of(d) as week
--   from (values ('2026-01-01'::date),('2026-03-24'),('2026-03-25'),('2026-03-31'),('2026-04-01'),
--                ('2026-09-29'),('2026-09-30'),('2026-10-06'),('2026-10-07')) v(d);
--
-- 3) Cutoff (expect min_date >= 2026-01-01):
--   select min(shift_date) as min_date, max(shift_date) as max_date from public.weekly_report_shifts;
--
-- 4) No dependency on the Excel table (expect ZERO rows):
--   select distinct c.relname as dependent
--   from pg_depend d
--   join pg_rewrite r on r.oid = d.objid
--   join pg_class c on c.oid = r.ev_class
--   where d.refobjid = to_regclass('public.deputy_shifts')
--     and c.oid = 'public.weekly_report_shifts'::regclass;
--
-- 5) Week 0 / week 1 boundary of season 2026 (week 0 ends 2026-03-24, week 1 starts 2026-03-25):
--   select season, week, min(shift_date) as first_day, max(shift_date) as last_day, round(sum(total_hours),1) as hours
--   from public.weekly_report_shifts where season = 2026 and week <= 2 group by 1,2 order by 2;
--
-- 6) Informational: approved rows flagged is_deleted since the cutoff (view and deputy-read both include them;
--    if non-zero, add the filter to BOTH together):
--   select count(*) from deputy.timesheets
--   where time_approved is true and coalesce(discarded,false) = false and is_deleted is true
--     and timesheet_date >= public.deputy_report_start_date();
--
-- 7) Confirm the anon key can read it (REST): GET /rest/v1/weekly_report_shifts?limit=1
