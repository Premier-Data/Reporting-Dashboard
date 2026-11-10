// Pure, framework-free decision logic for the Roster soft-delete reconcile.
//
// Deputy's QUERY endpoint has no way to expose a deleted roster, so a roster
// deleted/moved in Deputy simply stops being returned. deputy-sync never
// hard-deletes, so such rows would linger as phantom shifts. After a fully
// successful Roster sync of a window, rows inside that window that Deputy did
// NOT return are soft-deleted (is_deleted = true). This helper decides WHICH
// ids, and whether it is safe to do so at all. It performs no I/O.

export interface ReconcileInput {
  resource: string;
  status: "succeeded" | "partial" | "failed";
  dryRun: boolean;
  startDate?: string | null;
  endDate?: string | null;
  /** Records read from Deputy for the window. */
  readCount: number;
  /** Deputy ids returned by Deputy for the window (as text). */
  returnedIds: Iterable<string>;
  /** Non-deleted deputy_ids currently stored with roster_date in the window. */
  existingIds: string[];
  /** Refuse if more than this fraction of existing rows would be deleted. */
  maxFraction?: number;
  /** ...but always allow up to this many. */
  minAbsolute?: number;
}

export interface ReconcilePlan {
  action: "skip" | "apply";
  idsToDelete: string[];
  reason: string;
}

const skip = (reason: string): ReconcilePlan => ({
  action: "skip",
  idsToDelete: [],
  reason,
});

export function planRosterReconcile(input: ReconcileInput): ReconcilePlan {
  const {
    resource,
    status,
    dryRun,
    startDate,
    endDate,
    readCount,
    returnedIds,
    existingIds,
    maxFraction = 0.5,
    minAbsolute = 10,
  } = input;

  if (resource !== "Roster") return skip("not_roster");
  if (status !== "succeeded") return skip("sync_not_succeeded");
  if (dryRun) return skip("dry_run");
  if (!startDate || !endDate) return skip("no_window");

  const existing = Array.from(new Set(existingIds.map(String)));
  if (readCount === 0 && existing.length > 0) return skip("empty_read_guard");

  const returned = new Set(Array.from(returnedIds, String));
  const idsToDelete = existing.filter((id) => !returned.has(id)).sort();

  if (idsToDelete.length === 0) return skip("nothing_to_delete");

  const limit = Math.max(minAbsolute, maxFraction * existing.length);
  if (idsToDelete.length > limit) return skip("mass_delete_guard");

  return { action: "apply", idsToDelete, reason: "ok" };
}
