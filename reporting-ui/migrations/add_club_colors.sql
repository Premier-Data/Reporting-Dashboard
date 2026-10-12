-- Add primary + secondary team colours to club_config.
--
-- On the Players stats tab, the number square uses the PRIMARY colour as its
-- background and the SECONDARY colour for the number text. The older single
-- `team_color` is kept (back-compat) and treated as the primary when the new
-- columns are blank.

alter table public.club_config
    add column if not exists primary_color   text,
    add column if not exists secondary_color text;

-- Backfill: existing team_color becomes the primary colour.
update public.club_config
    set primary_color = team_color
    where primary_color is null and team_color is not null;
