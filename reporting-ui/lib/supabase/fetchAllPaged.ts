import { supabase } from "@/lib/supabase";

/** PostgREST returns at most 1000 rows per request. */
export const PAGE_SIZE = 1000;

export interface FetchAllPagedOptions {
  /** Column list for `.select()`. Defaults to "*". */
  select?: string;
  /** Business ordering applied first, in order (ascending). */
  order?: string[];
  /** UNIQUE key appended as the LAST order clause so offset paging is deterministic. */
  unique: string;
  /** Optional hook to add filters (`.eq`, `.is`, ...) to the query. */
  filters?: <Q>(query: Q) => Q;
}

/**
 * Reads every row of `table` in 1000-row pages with a deterministic order
 * (`order` columns, then `unique`). Offset paging is only correct when the
 * ORDER BY ends in a unique key, otherwise rows can be read twice or skipped.
 * Throws on any page error instead of returning a partial set.
 */
export async function fetchAllPaged<T>(table: string, opts: FetchAllPagedOptions): Promise<T[]> {
  const all: T[] = [];
  const orderCols = [...(opts.order ?? []).filter((c) => c !== opts.unique), opts.unique];
  for (let from = 0; ; from += PAGE_SIZE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from(table).select(opts.select ?? "*");
    if (opts.filters) q = opts.filters(q);
    for (const col of orderCols) q = q.order(col, { ascending: true });
    // paged-order-ok: orderCols always ends with opts.unique
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Error fetching ${table}: ${error.message}`);
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}
