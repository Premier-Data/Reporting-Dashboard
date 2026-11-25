// Pure pull engine for gameface-deputy-sync (no Deno/Supabase imports).
//
// Pages one Deputy resource through an injected `fetchPage`, maps each record
// with the existing deputy-sync mapper, scrubs personal fields, and dedupes by
// deputy_id. Nothing here touches the network or the database.
import {
  buildQuery,
  dedupeByDeputyId,
  hasMorePages,
  nextDay,
  type DeputyQuery,
} from "../deputy-sync/query.ts";
import { RESOURCE_MAP, type Json } from "../deputy-sync/mappers.ts";
import { prepareRow, summariseDryRun, type DryRunSummary } from "./sanitize.ts";

export type PullOptions = {
  /** Reads one QUERY page for a Deputy resource name. Injected by the caller. */
  fetchPage: (resource: string, query: DeputyQuery) => Promise<Json[]>;
  pageSize: number;
  maxPages: number;
};

export type PullWindow = { startDate?: string; endDate?: string };

export type PullResult = {
  rows: Json[];
  returnedIds: Set<string>;
  read: number;
  skipped: number;
  droppedFieldNames: string[];
  summary: DryRunSummary;
};

export async function pullResource(
  opts: PullOptions,
  resourceName: string,
  window: PullWindow
): Promise<PullResult> {
  const cfg = RESOURCE_MAP[resourceName];
  if (!cfg) throw new Error("unknown_resource");
  const returnedIds = new Set<string>();
  const sources: Json[] = [];
  const mapped: Json[] = [];
  const prepared: Json[] = [];
  const dropped = new Set<string>();
  for (let page = 0; page < opts.maxPages; page++) {
    const q = buildQuery({
      start: page * opts.pageSize,
      max: opts.pageSize,
      dateField: cfg.dateField,
      from: cfg.dateField ? window.startDate : undefined,
      // endDate is inclusive for callers; Deputy's filter is `Date < to`.
      to:
        cfg.dateField && window.endDate
          ? nextDay(window.endDate) ?? undefined
          : undefined,
    });
    const raw = await opts.fetchPage(cfg.deputyResource, q);
    for (const r of raw) {
      if (r.Id != null) returnedIds.add(String(r.Id));
      const m = cfg.mapper(r);
      const p = prepareRow(resourceName, m, r);
      for (const d of p.dropped) dropped.add(d);
      sources.push(r);
      mapped.push(m);
      prepared.push(p.row);
    }
    if (!hasMorePages(raw.length, opts.pageSize)) break;
  }
  const { unique, duplicates } = dedupeByDeputyId(prepared);
  const skipped = duplicates + (prepared.length - unique.length - duplicates);
  const droppedFieldNames = [...dropped].sort();
  return {
    rows: unique,
    returnedIds,
    read: sources.length,
    skipped,
    droppedFieldNames,
    summary: summariseDryRun(resourceName, sources, mapped, droppedFieldNames),
  };
}
