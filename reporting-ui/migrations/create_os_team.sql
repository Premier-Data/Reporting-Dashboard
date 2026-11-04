-- OS (offshore) team costs, synced from the "OS Team" sheet by sync-deputy.js.
-- One row per team member, plus a "Bank Fee" row per location where the sheet
-- lists one. Costs are fixed per person (not per game / per hour).
--
-- start_season / start_week: the cost only counts from that season + week
-- onward (set in sync-deputy.js → OS_START). NULL = no start limit.
--
-- Safe to re-run (idempotent).

create table if not exists public.os_team (
  name          text    not null,
  location      text    not null,
  kind          text    not null default 'member',  -- 'member' | 'fee'
  monthly_cost  numeric,
  weekly_cost   numeric,
  start_season  integer,
  start_week    integer,
  primary key (name, location)
);

create index if not exists os_team_location_idx on public.os_team (location);
