-- 010_competition_exclusions.sql
--
-- Purpose: persist the competitions and teams an admin has excluded from the
-- Competitions page (Dashboard, Teams and Competition details tabs).
-- Replaces the hard-coded exclusion list in the UI code. The "Practice" rule
-- stays automatic in code and is NOT stored here.
--
-- TT_Games is never read, modified or deleted by this migration or by the
-- feature. Exclusions are filters applied in the browser only.
--
-- Security model: the app talks to Supabase with the anon key and gates the
-- UI by role (admin / super_admin) in the client. RLS is enabled with
-- permissive anon/authenticated policies (same model as "Option B" in
-- fix_accuracy_checks_rls.sql). There is no UPDATE policy on purpose: bulk
-- "exclude" uses INSERT ... ON CONFLICT DO NOTHING and "restore" uses DELETE.
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.

create table if not exists public.competition_exclusions (
  id          bigint generated always as identity primary key,
  kind        text        not null check (kind in ('competition', 'team')),
  -- Canonical key: canonicalCompetition() / canonicalTeam() in the app
  -- (lowercase, whitespace collapsed, season/year stripped).
  key         text        not null,
  label       text        not null,
  reason      text        null,
  created_by  text        null,
  created_at  timestamptz not null default now(),
  constraint competition_exclusions_kind_key_uniq unique (kind, key)
);

alter table public.competition_exclusions enable row level security;

drop policy if exists "anon read competition_exclusions" on public.competition_exclusions;
create policy "anon read competition_exclusions"
  on public.competition_exclusions for select
  to anon, authenticated using (true);

drop policy if exists "anon insert competition_exclusions" on public.competition_exclusions;
create policy "anon insert competition_exclusions"
  on public.competition_exclusions for insert
  to anon, authenticated with check (true);

drop policy if exists "anon delete competition_exclusions" on public.competition_exclusions;
create policy "anon delete competition_exclusions"
  on public.competition_exclusions for delete
  to anon, authenticated using (true);

grant select, insert, delete on public.competition_exclusions to anon, authenticated;

-- Seed: the 8 competitions that were previously hard-coded in the app.
insert into public.competition_exclusions (kind, key, label, reason, created_by)
values
  ('competition', 'grand finals',                        'Grand Finals',                        'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'influencer games',                    'Influencer Games',                    'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'intra',                               'Intra',                               'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'nmfc academy',                        'NMFC Academy',                        'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'perth fl north vs south colts clash', 'Perth FL North vs South Colts Clash', 'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'sandringham dragons',                 'Sandringham Dragons',                 'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'sportvot test',                       'SportVot Test',                       'Seeded from the previous hard-coded list', 'migration 010'),
  ('competition', 'vafa c section',                      'Vafa C Section',                      'Seeded from the previous hard-coded list', 'migration 010')
on conflict (kind, key) do nothing;

notify pgrst, 'reload schema';

-- Verification queries (run manually):
--   select kind, count(*) from public.competition_exclusions group by kind;   -- expect competition = 8
--   select * from public.competition_exclusions order by kind, key;
--   select policyname, cmd, roles from pg_policies
--     where schemaname = 'public' and tablename = 'competition_exclusions';   -- expect select/insert/delete
