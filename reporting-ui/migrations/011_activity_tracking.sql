-- 011_activity_tracking.sql
--
-- Purpose: user activity tracker for the dashboard (mirrors lms-platform's
-- activity tracking). The browser reports "stretches" of activity (ended by
-- 5 minutes of inactivity or a change of section) plus online presence every
-- 30s. An admin viewer (/activity) reads them back.
--
-- Stores only: user id, username snapshot, timestamps, section (page key) and
-- pathname (<= 300 chars, no query string). No IP, no user agent.
--
-- Security model: the dashboard has no Supabase Auth (auth.uid() is always
-- null), so the tables are locked down with RLS enabled and NO policies, and
-- all anon table privileges are revoked. Access is only through
-- SECURITY DEFINER functions:
--   * activity_heartbeat(...)            write; checks user id + username exist
--   * activity_admin_summary(...)        read; re-checks admin password in SQL
--   * activity_admin_user(...)           read; re-checks admin password in SQL
-- Known limit: anyone holding the anon key and a valid user id/username can
-- still write heartbeats for that user (no DB-level identity).
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor of
-- project uizimmfujhpuiqhjofzf.

create table if not exists public.activity_segments (
  id          uuid        primary key,
  user_id     bigint      not null,
  username    text        not null,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  section     text        null,
  path        text        null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_activity_segments_user_started
  on public.activity_segments (user_id, started_at);
create index if not exists idx_activity_segments_started
  on public.activity_segments (started_at);

create table if not exists public.user_presence (
  user_id        bigint      primary key,
  username       text        null,
  last_seen_at   timestamptz not null,
  last_active_at timestamptz null,
  section        text        null,
  path           text        null
);

alter table public.activity_segments enable row level security;
alter table public.user_presence     enable row level security;
-- No policies on purpose: only the SECURITY DEFINER functions below can touch them.
drop policy if exists "anon read activity_segments" on public.activity_segments;
drop policy if exists "anon read user_presence" on public.user_presence;
revoke all on public.activity_segments from anon, authenticated;
revoke all on public.user_presence     from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Write: heartbeat from the signed-in user's browser.
-- p_closing = tab closing: backdate last_seen_at so the user shows offline.
-- ---------------------------------------------------------------------------
create or replace function public.activity_heartbeat(
  p_user_id    bigint,
  p_username   text,
  p_segment_id uuid        default null,
  p_started_at timestamptz default null,
  p_ended_at   timestamptz default null,
  p_section    text        default null,
  p_path       text        default null,
  p_closing    boolean     default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now         timestamptz := now();
  v_name        text;
  v_start       timestamptz;
  v_end         timestamptz;
  v_section     text := left(p_section, 100);
  v_path        text := left(p_path, 300);
  v_last_active timestamptz := null;
  v_rows        int;
begin
  select username into v_name
    from public.user_accounts
   where id = p_user_id and lower(username) = lower(coalesce(p_username, ''));
  if v_name is null then
    return; -- unknown user: ignore silently
  end if;

  if p_segment_id is not null and p_started_at is not null and p_ended_at is not null
     and v_now - p_started_at < interval '7 days' then
    v_end   := least(p_ended_at, v_now + interval '2 minutes');
    v_start := least(p_started_at, v_end);

    update public.activity_segments
       set ended_at = v_end
     where id = p_segment_id and user_id = p_user_id;
    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      insert into public.activity_segments (id, user_id, username, started_at, ended_at, section, path)
      values (p_segment_id, p_user_id, v_name, v_start, v_end, v_section, v_path)
      on conflict (id) do nothing;
    end if;
    v_last_active := v_end;
  end if;

  insert into public.user_presence as up (user_id, username, last_seen_at, last_active_at, section, path)
  values (
    p_user_id, v_name,
    case when coalesce(p_closing, false) then v_now - interval '151 seconds' else v_now end,
    v_last_active, v_section, v_path
  )
  on conflict (user_id) do update
    set username       = excluded.username,
        last_seen_at   = excluded.last_seen_at,
        last_active_at = coalesce(excluded.last_active_at, up.last_active_at),
        section        = excluded.section,
        path           = excluded.path;
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal: admin credential check (not callable by anon).
-- ---------------------------------------------------------------------------
create or replace function public.activity_assert_admin(p_username text, p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  select (encode(sha256(convert_to(salt || coalesce(p_password, ''), 'utf8')), 'hex') = password_hash)
         and role in ('admin', 'super_admin')
    into v_ok
    from public.user_accounts
   where lower(username) = lower(coalesce(p_username, ''))
   limit 1;
  if v_ok is distinct from true then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read: everyone's segments overlapping [p_from, p_to) plus presence.
-- Returns { segments: [...], presence: [...] }.
-- ---------------------------------------------------------------------------
create or replace function public.activity_admin_summary(
  p_username text,
  p_password text,
  p_from     timestamptz,
  p_to       timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.activity_assert_admin(p_username, p_password);
  return jsonb_build_object(
    'segments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'user_id', s.user_id, 'username', s.username,
               'started_at', s.started_at, 'ended_at', s.ended_at,
               'section', s.section, 'path', s.path)
             order by s.started_at)
        from public.activity_segments s
       where s.started_at < p_to and s.ended_at >= p_from
    ), '[]'::jsonb),
    'presence', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', p.user_id, 'username', p.username,
               'last_seen_at', p.last_seen_at, 'last_active_at', p.last_active_at,
               'section', p.section, 'path', p.path))
        from public.user_presence p
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Read: one user's segments overlapping [p_from, p_to) plus presence.
-- Returns { segments: [...], presence: {...} | null }.
-- ---------------------------------------------------------------------------
create or replace function public.activity_admin_user(
  p_username text,
  p_password text,
  p_user_id  bigint,
  p_from     timestamptz,
  p_to       timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.activity_assert_admin(p_username, p_password);
  return jsonb_build_object(
    'segments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'user_id', s.user_id, 'username', s.username,
               'started_at', s.started_at, 'ended_at', s.ended_at,
               'section', s.section, 'path', s.path)
             order by s.started_at)
        from public.activity_segments s
       where s.user_id = p_user_id and s.started_at < p_to and s.ended_at >= p_from
    ), '[]'::jsonb),
    'presence', (
      select jsonb_build_object(
               'user_id', p.user_id, 'username', p.username,
               'last_seen_at', p.last_seen_at, 'last_active_at', p.last_active_at,
               'section', p.section, 'path', p.path)
        from public.user_presence p
       where p.user_id = p_user_id
    )
  );
end;
$$;

revoke all on function public.activity_heartbeat(bigint, text, uuid, timestamptz, timestamptz, text, text, boolean) from public;
revoke all on function public.activity_assert_admin(text, text) from public, anon, authenticated;
revoke all on function public.activity_admin_summary(text, text, timestamptz, timestamptz) from public;
revoke all on function public.activity_admin_user(text, text, bigint, timestamptz, timestamptz) from public;
grant execute on function public.activity_heartbeat(bigint, text, uuid, timestamptz, timestamptz, text, text, boolean) to anon, authenticated;
grant execute on function public.activity_admin_summary(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.activity_admin_user(text, text, bigint, timestamptz, timestamptz) to anon, authenticated;

-- Permission for the Activity Log page (admin and super_admin only).
insert into public.role_permissions (role, page_key, can_access)
values
  ('super_admin', 'activity-log', true),
  ('admin',       'activity-log', true),
  ('analyst',     'activity-log', false)
on conflict (role, page_key) do update set can_access = excluded.can_access;

notify pgrst, 'reload schema';

-- Verification queries (run manually):
--   select relname, relrowsecurity from pg_class
--     where relname in ('activity_segments', 'user_presence');          -- both true
--   select count(*) from pg_policies
--     where tablename in ('activity_segments', 'user_presence');        -- 0
--   select role, can_access from public.role_permissions
--     where page_key = 'activity-log';                                  -- 3 rows
