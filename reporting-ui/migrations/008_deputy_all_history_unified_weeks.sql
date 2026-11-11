-- Premier Data x Deputy integration
-- Migration: 008_deputy_all_history_unified_weeks.sql
--
-- >>> RUN THIS MANUALLY in the Supabase SQL Editor (project administrator). <<<
-- Nothing in the app or CI applies it.
--
-- RUN ORDER: deploy the code first, then run 008, then 009, then verify.
-- Requires 005 (deputy_season_* functions) and 007 (weekly_report_shifts view).
--
-- WHAT THIS DOES
--   * public.weekly_report_shifts now returns ALL Deputy API history (from
--     2025-03-11), not just 2026-01-01 onward.
--   * One unified week rule for every season: weeks run Wed->Tue, season N starts
--     on the Wednesday on or before 1 Oct of year N-1, and that day is Week 1.
--     No season-2026 special case and no Week 0. Season 2025 has 53 weeks.
--
-- HOW: the view body from 007 calls deputy_report_start_date(),
--   deputy_report_week_of() and deputy_season_of() by name, so replacing the two
--   functions below changes the view output without recreating the view (column
--   list, grants and owner-rights semantics are unchanged).
--
-- Idempotent: safe to re-run. Does not edit 005/006/007.
begin;

-- Lower bound only. Deputy history starts 2025-03-11, so this is "no cutoff" in
-- practice (TS twin: DEPUTY_HISTORY_START in lib/deputy/reportWeeks.ts).
create or replace function public.deputy_report_start_date()
returns date
language sql
immutable
as $$ select date '2025-01-01' $$;

-- Plain unified formula from 005 for any season (TS twin: deputyWeekOf).
create or replace function public.deputy_report_week_of(d date)
returns integer
language sql
immutable
as $$ select public.deputy_season_week_of(d) $$;

comment on function public.deputy_report_start_date() is
  'Lower bound of reported Deputy API history (008). TS twin: DEPUTY_HISTORY_START in lib/deputy/reportWeeks.ts.';
comment on function public.deputy_report_week_of(date) is
  'Unified report week (008): delegates to deputy_season_week_of. TS twin: deputyWeekOf.';
comment on function public.deputy_season2026_week1_start() is
  'DEPRECATED (008): no longer referenced.';
comment on view public.weekly_report_shifts is
  'Deputy API shifts (approved, non-discarded, Deputy cost) for all history from 2025 with unified Wed-Tue weeks (008). No personal data.';

commit;
notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATION (run each query separately after the migration)
-- ============================================================================

-- 1) Seasons present. Expect 2025, 2026, 2027 and source only 'deputy-api'.
--    Row counts at audit time: 2375 / 6028 / 226 (later syncs add rows: "at least").
-- select season, source, count(*) as rows, min(shift_date), max(shift_date)
-- from public.weekly_report_shifts group by 1, 2 order by 1;

-- 2) Earliest shift. Expect 2025-03-11.
-- select min(shift_date) from public.weekly_report_shifts;

-- 3) Spot dates (same fixtures as lib/deputy/reportWeeks.test.ts). Expect ok = true on every row.
-- select d, public.deputy_season_of(d) as season, public.deputy_report_week_of(d) as week,
--        (public.deputy_season_of(d) = e_season and public.deputy_report_week_of(d) = e_week) as ok
-- from (values
--   ('2025-03-11'::date, 2025, 24),
--   ('2025-09-23'::date, 2025, 52),
--   ('2025-09-24'::date, 2025, 53),
--   ('2025-09-30'::date, 2025, 53),
--   ('2025-10-01'::date, 2026, 1),
--   ('2026-03-25'::date, 2026, 26),
--   ('2026-09-29'::date, 2026, 52),
--   ('2026-09-30'::date, 2027, 1),
--   ('2026-10-06'::date, 2027, 1),
--   ('2026-10-07'::date, 2027, 2)
-- ) as v(d, e_season, e_week);

-- 4) Row count must equal the approved, non-discarded API timesheets (audit: 8629).
-- select (select count(*) from public.weekly_report_shifts) as view_rows,
--        (select count(*) from deputy.timesheets
--          where time_approved is true and coalesce(discarded, false) = false
--            and timesheet_date is not null) as api_rows;

-- 5) View is still free of the Excel table. Expect 0 rows.
-- select d.refobjid::regclass
-- from pg_depend d
-- join pg_rewrite r on r.oid = d.objid
-- where r.ev_class = 'public.weekly_report_shifts'::regclass
--   and d.refobjid = 'public.deputy_shifts'::regclass;
