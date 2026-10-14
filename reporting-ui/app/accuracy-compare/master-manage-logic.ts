// Pure logic for the "Manage saved masters" feature (rename / delete /
// replace). Extracted so the risky bits — the deletable predicate, filename
// validation/normalization, and the group-equality rule — are unit-tested
// without a DB or React. Mirrors the `dispute-permissions.ts` pattern.
//
// These same one-liners (sameMasterName / normalizeMasterName /
// isValidMasterName) are the single contract the data layer in
// `lib/api/accuracyChecks.ts` relies on; keep the definitions here authoritative.

/**
 * DELETABLE predicate: a saved master is safe to delete iff exactly one active
 * check is in its (normalized) group. Every row that produces a saved-master
 * dropdown entry is already a graded accuracy check, so a count > 1 means other
 * analysts' graded results depend on this master and deleting would orphan or
 * destroy them — that case must be routed to Replace instead. A count of 0 is
 * treated as not-deletable (there is nothing to delete; the caller no-ops).
 */
export function isMasterDeletable(activeGroupCount: number): boolean {
  return activeGroupCount === 1;
}

/** Non-empty-after-trim validation for a master display name. */
export function isValidMasterName(name: string): boolean {
  return name.trim().length > 0;
}

/**
 * Normalized display name actually stored (trimmed, NO case-fold). The display
 * name preserves the user's casing; case-insensitivity is only ever a
 * comparison key (see sameMasterName), never what gets persisted.
 */
export function normalizeMasterName(name: string): string {
  return name.trim();
}

/**
 * The ONE grouping rule: case-insensitive + trim equality. Used for dropdown
 * de-dup (mirrors getSavedMasters' key), group resolution, and the rename
 * collision check, so the dropdown's grouping and the mutations' targeting
 * always agree.
 */
export function sameMasterName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * What the manage UI should offer for a master, given its (normalized) active
 * count and whether the current user may manage. Pure — drives button
 * enablement and the delete-vs-replace fork.
 */
export interface ManageAffordance {
  /** Admin / super_admin. */
  canManage: boolean;
  /** canManage. */
  canRename: boolean;
  /** canManage && isMasterDeletable(count). */
  canDelete: boolean;
  /** canManage && count > 1 — delete is blocked, Replace is the only removal. */
  mustReplaceToRemove: boolean;
}

export function masterAffordance(
  activeGroupCount: number,
  isAdmin: boolean
): ManageAffordance {
  const canManage = isAdmin;
  return {
    canManage,
    canRename: canManage,
    canDelete: canManage && isMasterDeletable(activeGroupCount),
    mustReplaceToRemove: canManage && activeGroupCount > 1,
  };
}
