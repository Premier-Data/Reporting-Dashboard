-- PlayHQ fixture → JADE (S3) fixture uid mapping.
--
-- The Live Scores stats/team-list features resolve a PlayHQ game to its JADE
-- report (Reports{uid}.json) by matching team names + round + season against
-- comp_fixtures (lib/api/matchReport.resolveJadeUidForGame). That auto-match
-- works for most home-and-away games but can't disambiguate some finals / rare
-- cases, and recomputes on every open. This table stores the resolved mapping
-- so:
--   - the resolver can look it up directly (fast, stable), and
--   - an admin can OVERRIDE a game the auto-matcher gets wrong / can't match.
--
-- Keyed by the PlayHQ game id (the "78454e3d"-style id on each fixture). A row
-- with jade_fixture_uid NULL explicitly means "no JADE report / do not try",
-- which lets an admin suppress a bad auto-match.

create table if not exists public.fixture_map (
    id               bigint generated always as identity primary key,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),

    -- PlayHQ game id (unique — one mapping per fixture).
    playhq_game_id   text not null,
    -- The JADE / S3 fixture uid (Reports{uid}.json). NULL = intentionally none.
    jade_fixture_uid integer,

    -- Cached display context (so the admin table reads without re-fetching).
    grade_key        text,     -- LIVE_SCORE_GRADES key, e.g. "ntfl-mens"
    label            text,     -- "Round 2 — St Mary's vs Wanderers"
    -- How the mapping was set: 'auto' (resolver) or 'manual' (admin override).
    source           text not null default 'auto'
);

create unique index if not exists idx_fixture_map_game
    on public.fixture_map (playhq_game_id);

create or replace function public.touch_fixture_map_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_fixture_map_updated_at on public.fixture_map;
create trigger trg_fixture_map_updated_at
    before update on public.fixture_map
    for each row execute function public.touch_fixture_map_updated_at();

alter table public.fixture_map disable row level security;
