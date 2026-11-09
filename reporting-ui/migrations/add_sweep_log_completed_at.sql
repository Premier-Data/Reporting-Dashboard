-- Player Sweep resume support: record when a grade FINISHED sweeping.
--
-- Adds playhq_sweep_log.completed_at. A log row alone only means "touched"
-- (it is written after every batch, including partial/throttled ones); the
-- worker now sets completed_at only when a grade's final slice was reached with
-- no per-game failures and no throttle, and clears it when a grade is re-swept
-- from offset 0.
--
-- No new table, so no new RLS/grants: the new column follows the table's
-- existing privileges (the worker reads/writes it with its existing key).
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR *BEFORE* deploying the worker:
-- the worker selects/upserts completed_at and would fail without the column.
-- Idempotent: safe to run more than once.

alter table public.playhq_sweep_log
  add column if not exists completed_at timestamptz;

-- Best-effort backfill: sweeps run in grade order, so in each season every
-- grade swept before the most recently swept grade is assumed complete. The
-- latest-touched grade per season stays incomplete and is simply redone
-- (a log row alone cannot prove it finished). Set completed_at manually for
-- it if you know it finished.
--
-- Caveats: the old client advanced past a grade after repeated errors, so an
-- earlier skipped/partial grade with an older timestamp may be backfilled as
-- complete. If you suspect that, use "Re-sweep all grades" in the UI.
--
-- Re-run safety: the backfill only touches seasons that have no completed_at
-- yet, so once the new worker has recorded real completions (and left other
-- grades deliberately null) a re-run changes nothing for those seasons.
update public.playhq_sweep_log l
set completed_at = l.last_swept_at
where l.completed_at is null
  and l.last_swept_at < (
    select max(x.last_swept_at)
    from public.playhq_sweep_log x
    where x.season_id = l.season_id
  )
  and not exists (
    select 1
    from public.playhq_sweep_log y
    where y.season_id = l.season_id
      and y.completed_at is not null
  );
