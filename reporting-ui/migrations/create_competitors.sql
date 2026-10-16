-- Competitor Intelligence: a register of market competitors + their sources,
-- and the posts auto-collected from the sources that expose a public feed.
--
-- Three tables:
--   competitors        — one row per company (name, website, sport, category…)
--   competitor_sources — per-competitor links (website / youtube / x / insta /
--                        facebook / linkedin / tiktok …). collection_method
--                        marks which are auto-pollable (rss/youtube) vs manual
--                        (social platforms with no free public feed).
--   competitor_posts   — items auto-collected by the worker from rss/youtube
--                        sources (title + canonical url + published date).
--
-- Social platforms (X, Instagram, Facebook, LinkedIn, TikTok) have no free,
-- ToS-compliant way to auto-detect new posts, so their sources are stored as
-- `manual`: the UI shows a one-click "open profile" link + last_reviewed. Only
-- rss/youtube sources are polled into competitor_posts.

-- ── competitors ──────────────────────────────────────────────────────────────
create table if not exists public.competitors (
    id            bigint generated always as identity primary key,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),

    name          text not null,
    website       text,
    -- Primary sport focus, free text ("Aussie Rules", "Soccer", "Multi-sport").
    sport         text,
    -- Competitive posture: direct | adjacent | emerging | technology | partner.
    category      text not null default 'direct',
    -- Monitoring priority: high | medium | low.
    priority      text not null default 'medium',
    country       text default 'Australia',
    description   text,
    notes         text,
    -- active | archived — archived competitors drop out of the default view.
    status        text not null default 'active'
);

create index if not exists idx_competitors_status on public.competitors (status);

-- ── competitor_sources ───────────────────────────────────────────────────────
create table if not exists public.competitor_sources (
    id             bigint generated always as identity primary key,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),

    competitor_id  bigint not null references public.competitors (id) on delete cascade,
    -- website | blog | youtube | x | instagram | facebook | linkedin | tiktok
    platform       text not null,
    -- The human-facing profile/page URL (always set — used for the manual link).
    profile_url    text not null,
    -- The machine feed URL to poll (RSS/Atom or a YouTube channel feed). Null
    -- for manual sources.
    feed_url       text,
    -- rss | youtube | manual. Only rss/youtube are polled by the worker.
    collection_method text not null default 'manual',
    -- Worker bookkeeping (polling only).
    last_checked_at   timestamptz,
    last_status       text,
    -- Manual-source bookkeeping: when a human last reviewed this profile.
    last_reviewed_at  timestamptz
);

create index if not exists idx_competitor_sources_competitor
    on public.competitor_sources (competitor_id);
create index if not exists idx_competitor_sources_method
    on public.competitor_sources (collection_method);

-- ── competitor_posts ─────────────────────────────────────────────────────────
create table if not exists public.competitor_posts (
    id             bigint generated always as identity primary key,
    created_at     timestamptz not null default now(), -- when WE collected it

    competitor_id  bigint not null references public.competitors (id) on delete cascade,
    source_id      bigint references public.competitor_sources (id) on delete set null,
    platform       text,
    -- Stable id from the feed (guid/videoId) for dedup; falls back to the url.
    external_id    text not null,
    title          text,
    url            text not null,
    summary        text,
    published_at   timestamptz
);

-- Dedup key: never store the same feed item twice per competitor.
create unique index if not exists idx_competitor_posts_dedupe
    on public.competitor_posts (competitor_id, external_id);
create index if not exists idx_competitor_posts_published
    on public.competitor_posts (published_at desc);

-- ── updated_at triggers ──────────────────────────────────────────────────────
create or replace function public.touch_competitors_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_competitors_updated_at on public.competitors;
create trigger trg_competitors_updated_at
    before update on public.competitors
    for each row execute function public.touch_competitors_updated_at();

drop trigger if exists trg_competitor_sources_updated_at on public.competitor_sources;
create trigger trg_competitor_sources_updated_at
    before update on public.competitor_sources
    for each row execute function public.touch_competitors_updated_at();

-- Same RLS posture as the other reporting tables (anon key read/write).
alter table public.competitors        disable row level security;
alter table public.competitor_sources disable row level security;
alter table public.competitor_posts   disable row level security;
