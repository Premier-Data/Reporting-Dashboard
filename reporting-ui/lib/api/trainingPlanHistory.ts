// History loader for the training plan. READ-ONLY: it only calls existing
// select functions and re-grades earlier checks in the browser.
//
// Order matters: disputes are loaded BEFORE any grading. The cache holds only
// the graded ComparisonRow[] per check (never dispute-filtered counts), and
// countStats is applied with an explicit excludeFn on every build, so a dispute
// resolved after a check was cached is still honoured.

import {
  getAccuracyChecksMeta,
  getAccuracyChecksXml,
  gradeOverlapScoped,
  type AccuracyCheckMeta,
} from "@/lib/api/accuracyChecks";
import { getAllDisputes, type Dispute } from "@/lib/api/disputes";
import type { ComparisonRow } from "@/lib/comparison/xml-compare";
import {
  TRAINING_TREND_CONSTANTS as C,
  countStats,
  makeDisputeExclude,
  selectHistoryChecks,
  type HistoryCheck,
  type HistoryInput,
  type HistoryWindow,
} from "@/lib/comparison/trainingPlan";

const CHUNK = 4;

// Session-only cache of graded rows, keyed by a signature of the stored figures.
const rowCache = new Map<string, ComparisonRow[]>();

export function clearTrainingHistoryCache(): void {
  rowCache.clear();
}

function signature(m: AccuracyCheckMeta): string {
  return [
    m.id,
    m.accuracy,
    m.master_total,
    m.analyst_total,
    m.exact,
    m.missed,
    m.extra,
    m.wrong_stat,
    m.wrong_player,
    m.wrong_team,
    m.avg_time_drift,
    m.tolerance,
  ].join("|");
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export interface LoadTrainingHistoryArgs {
  analystName: string;
  sport: "afl" | "football" | null;
  category: string | null;
  excludeCheckId: number | null;
  referenceDate: Date;
  window: HistoryWindow;
  includeStats: boolean;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export async function loadTrainingHistory(
  args: LoadTrainingHistoryArgs
): Promise<HistoryInput> {
  const { signal, onProgress } = args;
  const warnings: string[] = [];
  if (signal?.aborted) throw abortError();

  // 1. Disputes first (confirmed ones, grouped by check).
  const confirmedByCheck = new Map<number, Dispute[]>();
  try {
    const all = await getAllDisputes();
    for (const d of all) {
      if (d.status !== "confirmed" || d.deleted_at != null) continue;
      const list = confirmedByCheck.get(d.check_id) ?? [];
      list.push(d);
      confirmedByCheck.set(d.check_id, list);
    }
  } catch (err) {
    console.warn("Training plan: disputes unavailable", err);
    warnings.push(
      "Dispute data unavailable for history; counts include disputed rows"
    );
  }
  if (signal?.aborted) throw abortError();

  // 2. Meta list (paged, ordered by a unique key); filter the analyst in JS.
  const metas = await getAccuracyChecksMeta();
  if (signal?.aborted) throw abortError();
  const name = args.analystName.trim().toLowerCase();
  const analystMetas = metas.filter(
    (m) => (m.analyst_name ?? "").trim().toLowerCase() === name
  );
  const { selected, matchedInWindow } = selectHistoryChecks(
    analystMetas,
    args.window,
    {
      date: args.referenceDate,
      sport: args.sport,
      category: args.category,
      excludeCheckId: args.excludeCheckId,
      analystName: args.analystName,
    }
  );

  // 3. Re-grade (cached per check).
  const gradedRows = new Map<number, ComparisonRow[] | null>();
  if (args.includeStats) {
    const total = selected.length;
    let done = 0;
    const toFetch: AccuracyCheckMeta[] = [];
    for (const m of selected) {
      const hit = rowCache.get(signature(m));
      if (hit) {
        gradedRows.set(m.id, hit);
        onProgress?.(++done, total);
      } else {
        toFetch.push(m);
      }
    }
    for (let i = 0; i < toFetch.length; i += CHUNK) {
      if (signal?.aborted) throw abortError();
      const chunk = toFetch.slice(i, i + CHUNK);
      const blobs = await getAccuracyChecksXml(chunk.map((m) => m.id));
      if (signal?.aborted) throw abortError();
      for (const m of chunk) {
        const blob = blobs.get(m.id);
        let rows: ComparisonRow[] | null = null;
        if (blob) {
          try {
            const graded = gradeOverlapScoped(
              blob.xml_master,
              blob.xml_analyst,
              m.tolerance,
              m.file_name_master,
              m.sport
            );
            rows = graded ? graded.result.rows : null;
          } catch (err) {
            console.warn(`Training plan: check ${m.id} failed to grade`, err);
          }
        }
        if (rows) {
          rowCache.set(signature(m), rows);
        } else {
          warnings.push(
            `Check #${m.id} could not be re-graded; using category totals for it`
          );
        }
        gradedRows.set(m.id, rows);
        onProgress?.(++done, total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // 4. Apply countStats with an explicit excludeFn on every build.
  const checks: HistoryCheck[] = selected.map((m) => {
    const rows = gradedRows.get(m.id) ?? null;
    const exclude = makeDisputeExclude(confirmedByCheck.get(m.id) ?? []);
    return {
      id: m.id,
      createdAt: m.created_at,
      matchLabel: m.match_label,
      accuracy: m.accuracy,
      summary: {
        masterTotal: m.master_total,
        exact: m.exact,
        missed: m.missed,
        extra: m.extra,
        wrongPlayer: m.wrong_player,
        wrongStat: m.wrong_stat,
        wrongTeam: m.wrong_team,
      },
      categories: (m.category_breakdown ?? []).map((c) => ({
        category: c.category,
        total: c.total,
        exact: c.exact,
      })),
      stats: rows ? countStats(rows, exclude) : null,
      category: m.category,
    };
  });

  // 5. All-analyst average (same sport, last N days), from the same meta list.
  let allAnalystAverage: HistoryInput["allAnalystAverage"] = null;
  try {
    const cutoff = args.referenceDate.getTime() - C.ALL_ANALYST_DAYS * 86_400_000;
    const pool = metas.filter((m) => {
      if (m.accuracy == null) return false;
      const t = new Date(m.created_at).getTime();
      if (!Number.isFinite(t) || t < cutoff || t > args.referenceDate.getTime())
        return false;
      return args.sport == null || m.sport == null || m.sport === args.sport;
    });
    const accs = pool.map((m) => m.accuracy);
    const byCat = new Map<string, { total: number; exact: number }>();
    for (const m of pool)
      for (const c of m.category_breakdown ?? []) {
        const cur = byCat.get(c.category) ?? { total: 0, exact: 0 };
        cur.total += c.total;
        cur.exact += c.exact;
        byCat.set(c.category, cur);
      }
    const byCategory: Record<string, number> = {};
    for (const [k, v] of byCat) if (v.total > 0) byCategory[k] = v.exact / v.total;
    allAnalystAverage = {
      accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
      byCategory,
    };
  } catch (err) {
    console.warn("Training plan: all-analyst average unavailable", err);
    warnings.push("All-analyst average unavailable");
  }

  return { checks, allAnalystAverage, warnings, matchedInWindow };
}
