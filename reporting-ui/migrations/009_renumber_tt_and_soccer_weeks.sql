-- Premier Data x Deputy integration
-- Migration: 009_renumber_tt_and_soccer_weeks.sql
--
-- >>> RUN THIS MANUALLY in the Supabase SQL Editor (project administrator). <<<
-- Nothing in the app or CI applies it.
--
-- RUN ORDER: deploy the code first (the 6-hourly sync on main must already write
-- date-derived weeks, otherwise it would revert this), then 008, then this file.
-- Requires 005 (deputy_season_of / deputy_season_week_of).
--
-- WHAT THIS DOES
--   Renumbers stored season/week from each row's DATE using the unified rule
--   (Wed->Tue weeks, Week 1 = week containing 1 Oct, no Week 0):
--     * "TT_Games": season and "Week" (TEXT) from "Date".
--     * soccer_games: season/week from "Date", completed_* from completed_date
--       (expected to be 0 rows: already correct in the DB).
--     * os_team: adds start_date and converts the legacy sheet start weeks.
--
-- PREFLIGHT: aborts before changing anything if a column type differs.
-- Expected: TT_Games.Date=date, TT_Games.Week=text, TT_Games.season=integer,
--   soccer_games.Date=date, week=integer, season=integer, completed_date=date,
--   completed_season=integer, completed_week=integer,
--   os_team.start_season=integer, start_week=integer.
--
-- Idempotent: each UPDATE only selects rows that disagree, so a re-run changes 0 rows.
begin;

do $$
declare
  bad text := '';
  r record;
  found_type text;
begin
  for r in
    select * from (values
      ('TT_Games', 'Date', 'date'),
      ('TT_Games', 'Week', 'text'),
      ('TT_Games', 'season', 'integer'),
      ('soccer_games', 'Date', 'date'),
      ('soccer_games', 'week', 'integer'),
      ('soccer_games', 'season', 'integer'),
      ('soccer_games', 'completed_date', 'date'),
      ('soccer_games', 'completed_season', 'integer'),
      ('soccer_games', 'completed_week', 'integer'),
      ('os_team', 'start_season', 'integer'),
      ('os_team', 'start_week', 'integer')
    ) as e(tbl, col, typ)
  loop
    select coalesce(
             (select c.data_type from information_schema.columns c
               where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col),
             '<missing>')
      into found_type;
    if found_type <> r.typ then
      bad := bad || format(' %s.%s expected %s found %s;', r.tbl, r.col, r.typ, found_type);
    end if;
  end loop;
  if bad <> '' then
    raise exception '009 preflight failed, nothing changed:%', bad;
  end if;
end $$;

-- 1) TT_Games (names are case-sensitive): "Date" date, "Week" TEXT, season integer.
update public."TT_Games" t
set season = public.deputy_season_of(t."Date"),
    "Week" = public.deputy_season_week_of(t."Date")::text
where t."Date" is not null
  and (t.season is distinct from public.deputy_season_of(t."Date")
    or t."Week" is distinct from public.deputy_season_week_of(t."Date")::text);

-- 2) soccer_games: expected 0 rows today, kept for safety.
update public.soccer_games g
set season = public.deputy_season_of(g."Date"),
    week = public.deputy_season_week_of(g."Date")
where g."Date" is not null
  and (g.season is distinct from public.deputy_season_of(g."Date")
    or g.week is distinct from public.deputy_season_week_of(g."Date"));

update public.soccer_games g
set completed_season = public.deputy_season_of(g.completed_date),
    completed_week = public.deputy_season_week_of(g.completed_date)
where g.completed_date is not null
  and (g.completed_season is distinct from public.deputy_season_of(g.completed_date)
    or g.completed_week is distinct from public.deputy_season_week_of(g.completed_date));

-- 3) os_team: add the date the location starts counting, convert legacy sheet weeks.
alter table public.os_team add column if not exists start_date date;

-- Legacy 2026 sheet numbering: W1 = 2026-03-25 (2 -> 2026-04-01, 17 -> 2026-07-15).
update public.os_team
set start_date = date '2026-03-25' + (start_week - 1) * 7
where start_date is null and start_season = 2026 and start_week is not null;

update public.os_team
set start_season = public.deputy_season_of(start_date),
    start_week = public.deputy_season_week_of(start_date)
where start_date is not null
  and (start_season is distinct from public.deputy_season_of(start_date)
    or start_week is distinct from public.deputy_season_week_of(start_date));

commit;
notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATION (run each query separately)
-- ============================================================================

-- BEFORE running (optional, for comparison):
-- select season, count(*), min("Date"), max("Date"), min("Week"::int), max("Week"::int)
-- from public."TT_Games" group by 1 order by 1;

-- 1) TT_Games after. Expect 2026: 5303 rows, weeks 17..52; 2027: 48 rows, weeks 1..6 (as of audit).
-- select season, count(*), min("Date"), max("Date"), min("Week"::int), max("Week"::int)
-- from public."TT_Games" group by 1 order by 1;

-- 2) TT mismatches. Expect 0.
-- select count(*) from public."TT_Games"
-- where "Date" is not null
--   and ("Week" is distinct from public.deputy_season_week_of("Date")::text
--     or season is distinct from public.deputy_season_of("Date"));

-- 3) Soccer mismatches. Expect 0.
-- select count(*) from public.soccer_games
-- where ("Date" is not null
--        and (week is distinct from public.deputy_season_week_of("Date")
--          or season is distinct from public.deputy_season_of("Date")))
--    or (completed_date is not null
--        and (completed_week is distinct from public.deputy_season_week_of(completed_date)
--          or completed_season is distinct from public.deputy_season_of(completed_date)));

-- 4) os_team. Expect Philippines 2026 / 27 / 2026-04-01 and Vietnam 2026 / 42 / 2026-07-15.
-- select name, location, start_season, start_week, start_date from public.os_team
-- where start_date is not null order by location, name;
