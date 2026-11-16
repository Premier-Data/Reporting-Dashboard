"use client";

import { useEffect, useMemo, useState } from "react";
import type { ComparisonResult, ComparisonRow } from "@/lib/comparison/xml-compare";
import {
  buildTrainingPlan,
  type HistoryInput,
  type PlanContext,
  type PlanOptions,
  type TrainingPlan,
} from "@/lib/comparison/trainingPlan";
import { loadTrainingHistory } from "@/lib/api/trainingPlanHistory";

export interface UseTrainingPlanProps {
  open: boolean;
  result: ComparisonResult;
  scopeRows: ComparisonRow[];
  context: Omit<PlanContext, "reviewBaseUrl">;
}

export interface UseTrainingPlanReturn {
  plan: TrainingPlan;
  status: "idle" | "loading" | "ready" | "error";
  progress: { done: number; total: number } | null;
  error: string | null;
  warnings: string[];
}

export function useTrainingPlan(
  props: UseTrainingPlanProps,
  options: PlanOptions & { includeStats: boolean }
): UseTrainingPlanReturn {
  const { open, result, scopeRows, context } = props;
  const { includeStats, scope, window: win } = options;

  const [history, setHistory] = useState<HistoryInput | null>(null);
  const [status, setStatus] = useState<UseTrainingPlanReturn["status"]>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // window.location is read only inside an effect (static prerender safe).
  const [reviewBaseUrl, setReviewBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReviewBaseUrl(`${window.location.origin}${window.location.pathname}`);
  }, [open]);

  const analystName = context.analystName?.trim() || null;
  const { sport, checkId, checkCreatedAt, checkCategory } = context;
  const winMode = win.mode;
  const winValue = win.mode === "checks" ? win.n : win.days;

  useEffect(() => {
    if (!open || !analystName) {
      setHistory(null);
      setStatus("idle");
      setProgress(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setStatus("loading");
    setError(null);
    setProgress(null);
    const referenceDate = checkCreatedAt ? new Date(checkCreatedAt) : new Date();
    loadTrainingHistory({
      analystName,
      sport,
      category: checkCategory,
      excludeCheckId: checkId,
      referenceDate,
      window: winMode === "checks" ? { mode: "checks", n: winValue } : { mode: "days", days: winValue },
      includeStats,
      signal: ctrl.signal,
      onProgress: (done, total) => {
        if (!ctrl.signal.aborted) setProgress({ done, total });
      },
    })
      .then((h) => {
        if (ctrl.signal.aborted) return;
        setHistory(h);
        setStatus("ready");
      })
      .catch((err) => {
        if (ctrl.signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
        console.error("Training plan history failed", err);
        setHistory(null);
        setError(err instanceof Error ? err.message : "Failed to load history");
        setStatus("error");
      });
    return () => ctrl.abort();
  }, [open, analystName, sport, checkId, checkCreatedAt, checkCategory, winMode, winValue, includeStats]);

  const plan = useMemo(
    () =>
      buildTrainingPlan(
        { result, scopeRows },
        history,
        { ...context, reviewBaseUrl },
        { scope, window: win }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, scopeRows, history, context, reviewBaseUrl, scope, winMode, winValue]
  );

  return { plan, status, progress, error, warnings: history?.warnings ?? [] };
}
