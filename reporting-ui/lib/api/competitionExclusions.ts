import { supabase } from "@/lib/supabase";
import type { ExclusionKind, ExclusionRow } from "@/lib/analytics/exclusions";

const TABLE = "competition_exclusions";

export const EXCLUSIONS_NOT_SET_UP = "Exclusions not set up yet: run migration 010";

export class ExclusionsTableMissingError extends Error {
  constructor(message = EXCLUSIONS_NOT_SET_UP) {
    super(message);
    this.name = "ExclusionsTableMissingError";
  }
}

type ErrLike = { code?: string; status?: number; message?: string; details?: string } | null;

/** True when PostgREST reports the table does not exist (PGRST205 / 404). */
export function isMissingTableError(err: ErrLike): boolean {
  if (!err) return false;
  if (err.code === "PGRST205" || err.status === 404) return true;
  return /could not find the table|schema cache/i.test(`${err.message ?? ""} ${err.details ?? ""}`);
}

function fail(err: NonNullable<ErrLike>, fallback: string): never {
  console.error(`${TABLE}:`, err);
  if (isMissingTableError(err)) throw new ExclusionsTableMissingError();
  throw new Error(err.message || fallback);
}

export type NewExclusion = {
  kind: ExclusionKind;
  /** Canonical key (canonicalCompetition / canonicalTeam). */
  key: string;
  label: string;
  reason?: string | null;
  created_by?: string | null;
};

/** All exclusions, newest first. The table is tiny, so this is one request. */
export async function listExclusions(): Promise<ExclusionRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) fail(error, "Failed to load exclusions");
  return (data ?? []) as ExclusionRow[];
}

/** Bulk add. Already-excluded keys are left untouched (ON CONFLICT DO NOTHING). */
export async function addExclusions(items: NewExclusion[]): Promise<ExclusionRow[]> {
  if (items.length === 0) return [];
  const seen = new Set<string>();
  const rows = [];
  for (const it of items) {
    const id = `${it.kind}\u0000${it.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      kind: it.kind,
      key: it.key,
      label: it.label,
      reason: it.reason?.trim() ? it.reason.trim() : null,
      created_by: it.created_by ?? null,
    });
  }
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(rows, { onConflict: "kind,key", ignoreDuplicates: true })
    .select();
  if (error) fail(error, "Failed to save exclusions");
  return (data ?? []) as ExclusionRow[];
}

/** Restore: delete by row id, or by kind + canonical keys. Empty input is a no-op. */
export async function removeExclusions(
  target: { ids: number[] } | { kind: ExclusionKind; keys: string[] }
): Promise<void> {
  if ("ids" in target) {
    if (target.ids.length === 0) return;
    const { error } = await supabase.from(TABLE).delete().in("id", target.ids);
    if (error) fail(error, "Failed to restore exclusions");
    return;
  }
  if (target.keys.length === 0) return;
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("kind", target.kind)
    .in("key", target.keys);
  if (error) fail(error, "Failed to restore exclusions");
}
