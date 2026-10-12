-- Admin-editable configuration for Live Scores clubs.
--
-- The Live Scores feature ships hardcoded defaults for club logos + initials-
-- badge colours (lib/api/clubLogos.ts) and resolves PlayHQ games to S3/JADE
-- reports by name matching (lib/api/matchReport.ts). This table lets a
-- super-admin OVERRIDE/augment those per club without a code change:
--   - map a club to its PlayHQ club id and its S3/JADE club uid,
--   - set a logo URL (overrides the bundled public/clubs/*.png),
--   - set the team colour used on the Players stats + comparison bars.
--
-- Rows are keyed by the normalised club name (see normaliseClub()), the same
-- stable key the UI already uses to look clubs up. Everything is optional:
-- a missing row / null field falls back to the hardcoded default, so the UI
-- works unchanged until an admin fills these in.

create table if not exists public.club_config (
    id            bigint generated always as identity primary key,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),

    -- Normalised club key, e.g. "st marys". Unique — one config row per club.
    club_key      text not null,
    -- Human display name as the admin wants it shown, e.g. "St Mary's".
    display_name  text not null default '',

    -- External id mappings.
    playhq_club_id text,            -- PlayHQ club/organisation id (UUID or slug)
    s3_club_uid    integer,         -- Premier Data / JADE club uid (e.g. 1834)

    -- Presentation overrides.
    logo_url      text,             -- absolute/relative URL; overrides bundled png
    team_color    text,             -- hex "#rrggbb" used on player stats + bars

    -- Which competitions this club plays in (free-text labels, informational).
    competitions  text
);

create unique index if not exists idx_club_config_key
    on public.club_config (club_key);

-- Keep updated_at current on write.
create or replace function public.touch_club_config_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_club_config_updated_at on public.club_config;
create trigger trg_club_config_updated_at
    before update on public.club_config
    for each row execute function public.touch_club_config_updated_at();

-- Same RLS posture as the other reporting tables (anon key read/write).
alter table public.club_config disable row level security;
