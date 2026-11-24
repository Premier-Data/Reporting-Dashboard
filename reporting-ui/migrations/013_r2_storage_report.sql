-- 013_r2_storage_report.sql
--
-- Purpose: admin-only R2 storage report page (/r2-storage). The playhq-worker
-- scans the "video" R2 bucket and serves the folder totals through
-- POST /api/r2-report. The Worker only holds the anon key, so it verifies the
-- caller by calling r2_report_check_admin(username, password) through
-- Supabase REST. That function re-checks the admin password in SQL by calling
-- activity_assert_admin (migration 011) and returns true, or raises 42501
-- 'forbidden' when the user is not an admin / super_admin.
--
-- No tables are created. Same lock-down as 011: SECURITY DEFINER, fixed
-- search_path, revoked from public, executable by anon/authenticated.
-- Known limit, same as 011: anyone with the anon key can attempt password
-- guesses against this RPC.
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor of
-- project uizimmfujhpuiqhjofzf. Requires migration 011 to have been run.

create or replace function public.r2_report_check_admin(p_username text, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.activity_assert_admin(p_username, p_password);
  return true;
end;
$$;

revoke all on function public.r2_report_check_admin(text, text) from public;
grant execute on function public.r2_report_check_admin(text, text) to anon, authenticated;

-- Permission for the R2 Storage page (admin and super_admin only).
insert into public.role_permissions (role, page_key, can_access)
values
  ('super_admin', 'r2-storage', true),
  ('admin',       'r2-storage', true),
  ('analyst',     'r2-storage', false)
on conflict (role, page_key) do update set can_access = excluded.can_access;

notify pgrst, 'reload schema';

-- Verification queries (run manually):
--   select public.r2_report_check_admin('<admin username>', '<admin password>');  -- true
--   select public.r2_report_check_admin('<admin username>', 'wrong');            -- error 42501 forbidden
--   select role, can_access from public.role_permissions
--     where page_key = 'r2-storage';                                              -- 3 rows
