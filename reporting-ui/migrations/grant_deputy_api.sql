-- Grant the Deputy API page to super_admin only.
-- The page exposes pay/cost data (wages, derived hourly rates), so navigation
-- access is restricted to super admins. Without a can_access=true row, the nav
-- item stays hidden and the route guard redirects other roles away.
--
-- Idempotent: upserts on the (role, page_key) unique key. Safe to re-apply.
-- Apply through the Supabase SQL Editor.

insert into public.role_permissions (role, page_key, can_access)
values ('super_admin', 'deputy-api', true)
on conflict (role, page_key) do update set can_access = true;
