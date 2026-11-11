-- Premier Data x Deputy integration
-- Migration: 006_lock_excel_deputy_tables.sql
--
-- >>> RUN ONLY AFTER 007 + FRONTEND DEPLOY + VERIFICATION. <<<
-- >>> RUN THIS MANUALLY in the Supabase SQL Editor (project administrator). <<<
-- Nothing in the app or CI applies it.
--
-- ORDER: 1) run 007_deputy_api_shifts_all_seasons.sql  2) deploy the new frontend
--        3) verify the app + the 007 queries  4) run THIS file.
--
-- WHAT THIS DOES
--   Locks the two Excel-loaded Deputy tables so the browser (anon / authenticated
--   keys) can no longer read them. All Deputy data in the app comes from the Deputy
--   API (deputy schema) after this.
--     * public.deputy_shifts  (written by sync-deputy.js from the SharePoint workbook)
--     * public.deputy_roster  (written by syncDeputyRoster.js from DeputyRoster.csv.xlsx)
--   The sync scripts use the SERVICE key, which bypasses these revokes and RLS, so
--   they keep working unchanged. service_role grants are not touched.
--   The REVOKE is what satisfies the requirement. Enabling row level security (with
--   no policies = deny for non-bypass roles) is only defence in depth.
--
-- !! EXTERNAL CONSUMERS: confirm nothing else (Power BI, scripts, other apps) reads
--    these tables with the anon key. This lock cuts them off. Rollback is below.
--
-- NOT touched: public.deputy_area_map (labels only, must stay readable), the
-- deputy schema (already service_role only), public.weekly_report_shifts (API view).
--
-- Idempotent. Each table is skipped if it does not exist.

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEP 0: run these READ-ONLY queries BEFORE the lock and keep the output
-- (the rollback depends on (a)).
-- ═══════════════════════════════════════════════════════════════════════════════
-- (a) Is row level security already on? (record relrowsecurity per table)
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relname in ('deputy_shifts','deputy_roster');
--
-- (b) Hidden dependents (views) on the tables. Expect ZERO rows after 007. Each row found is a
--     view that would break and must be fixed first. (If only one table exists, run it for that one.)
--   select distinct c.relname as dependent, c.relkind
--   from pg_depend d
--   join pg_rewrite r on r.oid = d.objid
--   join pg_class c on c.oid = r.ev_class
--   where d.refobjid in ('public.deputy_shifts'::regclass, 'public.deputy_roster'::regclass)
--     and c.oid not in ('public.deputy_shifts'::regclass, 'public.deputy_roster'::regclass);
--
-- (c) Existing policies:
--   select schemaname, tablename, policyname from pg_policies
--   where tablename in ('deputy_shifts','deputy_roster');

-- ═══════════════════════════════════════════════════════════════════════════════
-- THE LOCK
-- ═══════════════════════════════════════════════════════════════════════════════
do $lock$
declare
  t text;
begin
  foreach t in array array['deputy_shifts', 'deputy_roster'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon, authenticated, public', t);
      -- Defence in depth: only switch RLS on if it is not already on.
      if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || t)) then
        execute format('alter table public.%I enable row level security', t);
      end if;
    end if;
  end loop;
end
$lock$;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFY (run separately)
-- ═══════════════════════════════════════════════════════════════════════════════
-- All four expect false (a table that does not exist raises an error: skip that line):
--   select has_table_privilege('anon',          'public.deputy_shifts', 'select') as anon_shifts,
--          has_table_privilege('authenticated', 'public.deputy_shifts', 'select') as auth_shifts,
--          has_table_privilege('anon',          'public.deputy_roster', 'select') as anon_roster,
--          has_table_privilege('authenticated', 'public.deputy_roster', 'select') as auth_roster;
-- REST with the anon key: GET /rest/v1/deputy_shifts?limit=1  -> 401 / permission denied
-- REST with the anon key: GET /rest/v1/weekly_report_shifts?limit=1 -> still 200
--
-- Find any other hand-made Excel Deputy table (give it the same revoke by copying the DO block):
--   select table_name from information_schema.tables
--   where table_schema = 'public' and table_name ilike '%deputy%';

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (restore browser access). Run only the parts you need.
-- ═══════════════════════════════════════════════════════════════════════════════
--   grant select on public.deputy_shifts, public.deputy_roster to anon, authenticated;
-- Then disable RLS ONLY on a table whose STEP 0 (a) showed relrowsecurity = false
-- (leave it enabled when step 0 said true):
--   -- if deputy_shifts had relrowsecurity = false:
--   alter table public.deputy_shifts disable row level security;
--   -- if deputy_roster had relrowsecurity = false:
--   alter table public.deputy_roster disable row level security;
--   notify pgrst, 'reload schema';
