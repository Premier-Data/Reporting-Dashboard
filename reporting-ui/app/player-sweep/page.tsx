"use client";

// Competition Player Sweep — admin tool.
//
// Step 1 (Preview): paste a PlayHQ season-page URL or a season short id, then
// load the season's grades (competition + organisation + grade list) from the
// public worker endpoint.
//
// Step 2 (Sweep): paste the BACKFILL_TOKEN and run a resumable, client-driven
// sweep that ingests every player appearance across all grades of the season.
// The worker processes ONE small grade slice per request (Cloudflare free-plan
// subrequest cap), returning a `next` cursor; this page loops client-side from
// { gradeIndex: 0, offset: 0 }, following `next` until done, with live progress
// and a cooperative Stop button. The token is passed per request and never
// stored in code or env.
//
// Static-export safe: a plain (non-dynamic) 'use client' page — no server
// routes/handlers/actions and no generateStaticParams.

import { useRef, useState } from "react";
import { Loader2, AlertTriangle, Search, Play, Square } from "lucide-react";

import {
  getSeasonGrades,
  sweepCompetitionBatch,
  parseSeasonId,
  type SeasonGradesResponse,
  type SweepBatchResult,
} from "@/lib/api/playerSweep";

// Shared input style — matches admin-config's inputCls exactly.
const inputCls =
  "w-full rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500";

// Per-request slice size. Hard-capped at 12 by the worker; 10 matches the
// worker default and keeps each invocation well under the subrequest cap.
const SWEEP_LIMIT = 10;

// Safety valve: if the same cursor keeps erroring, stop rather than loop
// forever. Counts consecutive failed batches.
const MAX_CONSECUTIVE_ERRORS = 3;

// Throttle valve: PlayHQ Discovery occasionally rate-limits (403/429). The
// worker now reports this as a resumable throttle rather than a hard error;
// we back off and retry the SAME slice, giving up only after this many
// consecutive throttles.
const MAX_CONSECUTIVE_THROTTLES = 5;

// Small async sleep used for backoff and inter-batch pacing.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SweepProgress = {
  running: boolean;
  gradeIndex: number;
  gradeName: string;
  // This-batch counts (most recent slice).
  batchProcessed: number;
  batchSkipped: number;
  // Cumulative across the whole run.
  totalProcessed: number;
  totalSkipped: number;
  batches: number;
  done: boolean;
};

const EMPTY_PROGRESS: SweepProgress = {
  running: false,
  gradeIndex: 0,
  gradeName: "",
  batchProcessed: 0,
  batchSkipped: 0,
  totalProcessed: 0,
  totalSkipped: 0,
  batches: 0,
  done: false,
};

export default function PlayerSweepPage() {
  // ── Step 1: preview ──────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [season, setSeason] = useState<SeasonGradesResponse | null>(null);

  // ── Step 2: sweep ────────────────────────────────────────────────────
  const [token, setToken] = useState("");
  const [sweepError, setSweepError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SweepProgress>(EMPTY_PROGRESS);
  // Cooperative cancellation flag, toggled by Stop and read inside the loop.
  const cancelRef = useRef(false);

  async function onPreview() {
    const seasonId = parseSeasonId(input);
    if (!seasonId) {
      setPreviewError("Paste a PlayHQ season URL or a season id first.");
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    setSeason(null);
    // A fresh preview invalidates any prior sweep state.
    setSweepError(null);
    setProgress(EMPTY_PROGRESS);
    try {
      const data = await getSeasonGrades(seasonId);
      setSeason(data);
    } catch (e) {
      setPreviewError(
        e instanceof Error ? e.message : "Failed to load season grades."
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  function onStop() {
    cancelRef.current = true;
  }

  async function onStart() {
    if (!season) return;
    const tok = token.trim();
    if (!tok) {
      setSweepError("Paste the backfill token to start the sweep.");
      return;
    }

    const seasonId = season.season.id;
    const totalGrades = season.grades.length;
    if (totalGrades === 0) {
      setSweepError("This season has no grades to sweep.");
      return;
    }

    cancelRef.current = false;
    setSweepError(null);
    setProgress({ ...EMPTY_PROGRESS, running: true });

    let cursor: { gradeIndex: number; offset: number } = {
      gradeIndex: 0,
      offset: 0,
    };
    let totalProcessed = 0;
    let totalSkipped = 0;
    let batches = 0;
    let consecutiveErrors = 0;
    let throttleCount = 0;

    // Client-driven resumable loop: one slice per request, follow `next`.
    while (!cancelRef.current) {
      let result: SweepBatchResult;
      try {
        result = await sweepCompetitionBatch({
          season: seasonId,
          gradeIndex: cursor.gradeIndex,
          offset: cursor.offset,
          limit: SWEEP_LIMIT,
          token: tok,
        });
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors += 1;
        const msg =
          e instanceof Error ? e.message : "A sweep batch failed.";
        setSweepError(
          `${msg} (grade ${cursor.gradeIndex + 1} of ${totalGrades}, offset ${cursor.offset})`
        );
        // Bail out on repeated/fatal errors rather than looping forever.
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        // Otherwise skip past this (grade, offset): advance to the next grade
        // at offset 0 where it's safe to continue; stop if that was the last.
        const nextGrade = cursor.gradeIndex + 1;
        if (nextGrade >= totalGrades) break;
        cursor = { gradeIndex: nextGrade, offset: 0 };
        continue;
      }

      // Transient throttle: the worker returned a resumable slice (403/429
      // backoff upstream). Treat it as a pause-and-retry of the SAME cursor,
      // NOT a failure — don't count it as processed and don't advance.
      if (result.retryable || result.throttled) {
        throttleCount += 1;
        if (throttleCount >= MAX_CONSECUTIVE_THROTTLES) {
          setSweepError(
            `PlayHQ kept rate-limiting after ${MAX_CONSECUTIVE_THROTTLES} attempts — giving up (grade ${cursor.gradeIndex + 1} of ${totalGrades}, offset ${cursor.offset}). Try again later.`
          );
          break;
        }
        setSweepError(
          `Rate-limited by PlayHQ — backing off and retrying… (grade ${cursor.gradeIndex + 1} of ${totalGrades})`
        );
        await sleep(Math.min(2000 * 2 ** (throttleCount - 1), 15000));
        // Retry the same {gradeIndex, offset} without touching the cursor.
        continue;
      }

      // Normal slice: clear any transient throttle banner and reset the count.
      throttleCount = 0;
      setSweepError(null);

      batches += 1;
      totalProcessed += result.processed;
      totalSkipped += result.skipped;

      setProgress({
        running: true,
        gradeIndex: result.gradeIndex,
        gradeName: result.gradeName,
        batchProcessed: result.processed,
        batchSkipped: result.skipped,
        totalProcessed,
        totalSkipped,
        batches,
        done: false,
      });

      if (result.done || !result.next) break;
      // Gentle inter-batch pacing to avoid tripping the upstream rate limiter.
      await sleep(result.retryAfterMs ?? 800);
      cursor = result.next;
    }

    // Finalise: mark not-running; done=true only when we weren't cancelled.
    setProgress((prev) => ({
      ...prev,
      running: false,
      done: !cancelRef.current,
    }));
  }

  const running = progress.running;
  const totalGrades = season?.grades.length ?? 0;

  return (
    <div className="min-h-full bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          Competition Player Sweep
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm text-slate-400">
          Ingest every player appearance across a whole PlayHQ season. Preview a
          season&apos;s grades, then run a resumable sweep that processes one
          small slice at a time — it can be stopped and restarted safely
          (re-running upserts, so no duplicates).
        </p>

        {/* ── Step 1: preview ────────────────────────────────────────── */}
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-sky-300">
            1 · Season
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !previewLoading && onPreview()}
              placeholder="PlayHQ season URL or season id (e.g. ce93ea21)"
              className={`${inputCls} max-w-xl flex-1`}
            />
            <button
              type="button"
              onClick={onPreview}
              disabled={previewLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-40"
            >
              {previewLoading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Search size={15} />
              )}
              Preview grades
            </button>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            Tip: a game-centre URL contains a GAME id, not the season id. Paste
            the SEASON id or the season/competition page URL.
          </p>

          {previewError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              {previewError}
            </div>
          )}

          {season && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-semibold text-slate-100">
                  {season.competition.name}
                </span>
                <span className="text-sm text-slate-400">
                  {season.organisation.name}
                </span>
                <span className="text-sm text-slate-500">
                  {season.season.name}
                </span>
              </div>

              <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.03] text-left text-xs uppercase text-slate-400">
                      <th className="px-3 py-2 font-semibold">#</th>
                      <th className="px-3 py-2 font-semibold">Grade</th>
                      <th className="px-3 py-2 font-semibold">Gender</th>
                      <th className="px-3 py-2 font-semibold">Age</th>
                      <th className="px-3 py-2 font-semibold">Grade id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {season.grades.map((g, i) => (
                      <tr key={g.id} className="border-b border-white/5">
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2 font-medium text-slate-100">
                          {g.name}
                        </td>
                        <td className="px-3 py-2 text-slate-300">
                          {g.gender ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-slate-300">
                          {g.age ?? "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-400">
                          {g.id}
                        </td>
                      </tr>
                    ))}
                    {season.grades.length === 0 && (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-3 py-8 text-center text-slate-400"
                        >
                          This season has no grades.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {totalGrades} grade{totalGrades === 1 ? "" : "s"} found.
              </p>
            </div>
          )}
        </section>

        {/* ── Step 2: sweep ──────────────────────────────────────────── */}
        {season && totalGrades > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-sky-300">
              2 · Sweep
            </h2>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Backfill token"
                autoComplete="off"
                className={`${inputCls} max-w-md flex-1`}
              />
              <button
                type="button"
                onClick={onStart}
                disabled={running}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-40"
              >
                {running ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Play size={15} />
                )}
                {running ? "Sweeping…" : "Start sweep"}
              </button>
              <button
                type="button"
                onClick={onStop}
                disabled={!running}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:opacity-40"
              >
                <Square size={15} /> Stop
              </button>
            </div>

            <p className="mt-2 text-xs text-slate-500">
              The token is sent with each request and never stored. The sweep
              runs one small slice per request; use Stop to halt — progress is
              preserved and re-running is safe.
            </p>

            {sweepError && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                {sweepError}
              </div>
            )}

            {(running || progress.batches > 0 || progress.done) && (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    {running ? (
                      <>
                        <Loader2
                          size={16}
                          className="animate-spin text-emerald-300"
                        />
                        Sweeping grade {progress.gradeIndex + 1} of{" "}
                        {totalGrades}
                      </>
                    ) : progress.done ? (
                      <span className="text-emerald-300">Sweep complete</span>
                    ) : (
                      <span className="text-amber-300">Sweep stopped</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {progress.batches} batch
                    {progress.batches === 1 ? "" : "es"}
                  </span>
                </div>

                {progress.gradeName && (
                  <div className="mb-3 text-sm text-slate-300">
                    Current grade:{" "}
                    <span className="font-medium text-slate-100">
                      {progress.gradeName}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="This batch · processed" value={progress.batchProcessed} />
                  <Stat label="This batch · skipped" value={progress.batchSkipped} />
                  <Stat
                    label="Total processed"
                    value={progress.totalProcessed}
                    accent="emerald"
                  />
                  <Stat label="Total skipped" value={progress.totalSkipped} />
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// A single progress stat tile.
function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "emerald";
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`mt-0.5 text-xl font-bold ${
          accent === "emerald" ? "text-emerald-300" : "text-slate-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
