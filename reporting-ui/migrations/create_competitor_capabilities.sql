-- Ready-reckoner feature matrix: how each competitor compares to Premier Data
-- across a fixed list of service/product capabilities.
--
-- The capability ROWS are defined in code (lib/api/competitors.ts
-- CAPABILITIES) so they stay versioned and consistent. This table stores one
-- CELL per (competitor_id, capability_key): the competitor's rating for that
-- capability plus an optional note. Premier Data's own column is rendered from
-- code (always "yes"), so it has no rows here.
--
-- rating values: 'yes' | 'partial' | 'no' | 'unknown' (default 'unknown').

create table if not exists public.competitor_capabilities (
    id              bigint generated always as identity primary key,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    competitor_id   bigint not null references public.competitors (id) on delete cascade,
    -- Stable capability key from code (e.g. 'remote_analysts', 'video_analysis').
    capability_key  text not null,
    -- yes | partial | no | unknown
    rating          text not null default 'unknown',
    note            text
);

-- One cell per competitor+capability.
create unique index if not exists idx_competitor_capabilities_cell
    on public.competitor_capabilities (competitor_id, capability_key);
create index if not exists idx_competitor_capabilities_competitor
    on public.competitor_capabilities (competitor_id);

create or replace function public.touch_competitor_capabilities_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_competitor_capabilities_updated_at on public.competitor_capabilities;
create trigger trg_competitor_capabilities_updated_at
    before update on public.competitor_capabilities
    for each row execute function public.touch_competitor_capabilities_updated_at();

-- Same RLS posture as the other reporting tables (anon key read/write).
alter table public.competitor_capabilities disable row level security;
