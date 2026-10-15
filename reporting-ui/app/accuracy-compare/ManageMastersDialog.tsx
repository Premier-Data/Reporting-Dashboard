"use client";

// Admin-only dialog to manage saved masters: rename the display filename,
// delete a one-off master (soft delete), or — when a master has graded checks
// attached — REPLACE its file to re-grade every attached check.
//
// This is a Client Component because it needs state, effects, and event
// handlers (onClick/onChange) per the Next.js "Server and Client Components"
// doc. All mutations are the existing client-side Supabase calls invoked from
// event handlers — NO Server Actions (matching the locked design decision and
// the rest of this data layer).

import { useEffect, useState } from "react";
import { X, Pencil, Trash2, Check, Upload, GitMerge } from "lucide-react";
import {
  renameMaster,
  deleteMaster,
  countActiveGroupSiblings,
  propagateMasterCorrection,
  mergeMasters,
  instancesFromRaw,
  type SavedMaster,
} from "@/lib/api/accuracyChecks";
import { parseInstances } from "@/lib/comparison/xml-compare";
import {
  masterAffordance,
  isValidMasterName,
  normalizeMasterName,
  sameMasterName,
  validMergeDestinations,
  canMergeInto,
} from "./master-manage-logic";

type RowState = {
  /** Advisory active-group count; mutations re-verify server-side. */
  count: number | null;
  editing: boolean;
  draftName: string;
  busy: boolean;
  message: string | null;
  /** Replace sub-UI is open for this row (count > 1 masters). */
  replacing: boolean;
  /** The merge destination-picker sub-UI is open for this row. */
  merging: boolean;
  /** Selected merge destination fileName (null until picked). */
  mergeDest: string | null;
  /** The merge confirm step is showing. */
  mergeConfirm: boolean;
};

const freshRow = (name: string): RowState => ({
  count: null,
  editing: false,
  draftName: name,
  busy: false,
  message: null,
  replacing: false,
  merging: false,
  mergeDest: null,
  mergeConfirm: false,
});

export default function ManageMastersDialog({
  masters,
  isAdmin,
  username,
  onClose,
  onChanged,
}: {
  masters: SavedMaster[];
  isAdmin: boolean;
  username: string | null;
  /** Close the dialog. */
  onClose: () => void;
  /**
   * Called after any successful mutation so the page can re-fetch
   * getSavedMasters() and reflect the change in the dropdown + in-view master.
   * Receives the operation and the affected name(s) so the page can keep the
   * loaded master consistent.
   */
  onChanged: (
    change:
      | { type: "rename"; oldName: string; newName: string }
      | { type: "delete"; name: string }
      | { type: "replace"; name: string; raw: string }
      | { type: "merge"; source: string; dest: string }
  ) => void | Promise<void>;
}) {
  // Per-master UI state, keyed by the master's exact fileName.
  const [rows, setRows] = useState<Record<string, RowState>>({});

  // Fetch advisory counts whenever the master list changes. Row state is
  // created lazily on read (via the `rows[name] ?? freshRow(name)` fallback),
  // so the effect only performs the async count fetch and writes results from
  // its async callback — it does NOT call setState synchronously in its body.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const m of masters) {
        try {
          const count = await countActiveGroupSiblings(m.fileName);
          if (cancelled) return;
          setRows((prev) => ({
            ...prev,
            [m.fileName]: { ...(prev[m.fileName] ?? freshRow(m.fileName)), count },
          }));
        } catch {
          // Leave count null; the mutation guards remain authoritative.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [masters]);

  const patchRow = (name: string, patch: Partial<RowState>) =>
    setRows((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? freshRow(name)), ...patch },
    }));

  const startEdit = (m: SavedMaster) =>
    patchRow(m.fileName, { editing: true, draftName: m.fileName, message: null });

  const cancelEdit = (m: SavedMaster) =>
    patchRow(m.fileName, { editing: false, draftName: m.fileName, message: null });

  const saveRename = async (m: SavedMaster) => {
    const row = rows[m.fileName];
    if (!row) return;
    const next = normalizeMasterName(row.draftName);
    if (!isValidMasterName(next)) {
      patchRow(m.fileName, { message: "Master name cannot be empty." });
      return;
    }
    if (sameMasterName(next, m.fileName) && next === m.fileName) {
      // No actual change.
      patchRow(m.fileName, { editing: false });
      return;
    }
    patchRow(m.fileName, { busy: true, message: null });
    try {
      const res = await renameMaster(m.fileName, next);
      patchRow(m.fileName, {
        busy: false,
        editing: false,
        message: `Renamed across ${res.updated} check${
          res.updated === 1 ? "" : "s"
        }.`,
      });
      await onChanged({ type: "rename", oldName: m.fileName, newName: next });
    } catch (err) {
      patchRow(m.fileName, {
        busy: false,
        message:
          err instanceof Error ? err.message : "Failed to rename master.",
      });
    }
  };

  const confirmDelete = async (m: SavedMaster) => {
    const ok = window.confirm(
      "Delete this saved master? This removes the one check that uses it; " +
        "it can be restored from Deleted checks."
    );
    if (!ok) return;
    patchRow(m.fileName, { busy: true, message: null });
    try {
      const res = await deleteMaster(m.fileName, username ?? null);
      if (res.deleted === 0) {
        patchRow(m.fileName, {
          busy: false,
          message: "This master was already removed.",
        });
      } else {
        patchRow(m.fileName, { busy: false });
      }
      await onChanged({ type: "delete", name: m.fileName });
    } catch (err) {
      // Stale-count handling: a >1 guard throw means the row actually has
      // attached checks now. Surface the message, re-fetch the real count, and
      // flip the row to offering Replace.
      let count: number | null = null;
      try {
        count = await countActiveGroupSiblings(m.fileName);
      } catch {
        /* keep null */
      }
      patchRow(m.fileName, {
        busy: false,
        count,
        message:
          err instanceof Error ? err.message : "Failed to delete master.",
      });
    }
  };

  const handleReplaceFile = async (m: SavedMaster, fileList: FileList | null) => {
    const f = fileList?.[0];
    if (!f) return;
    patchRow(m.fileName, { busy: true, message: null });
    let text: string;
    try {
      text = await f.text();
    } catch {
      patchRow(m.fileName, { busy: false, message: "Could not read that file." });
      return;
    }
    // Guard an empty/unparsable master here (propagateMasterCorrection has no
    // empty guard of its own, and would otherwise overwrite xml_master with an
    // empty master across every attached check and collapse their accuracy).
    // Both branches must be covered: a JSON feed is resolved by instancesFromRaw
    // (the same adapter propagateMasterCorrection uses), while XML is checked
    // with parseInstances to mirror the existing override handler's message.
    const looksJson = /\.json$/i.test(f.name) || text.trimStart().startsWith("{");
    if (looksJson) {
      if (instancesFromRaw(text).length === 0) {
        patchRow(m.fileName, {
          busy: false,
          message: "That file has no master stats.",
        });
        return;
      }
    } else if (parseInstances(text).length === 0) {
      patchRow(m.fileName, {
        busy: false,
        message: "That file has no <instance> entries.",
      });
      return;
    }
    try {
      // Keep file_name_master unchanged (the design's deliberate decision):
      // propagateMasterCorrection keys on it, so every attached check is found
      // and re-graded while the single dropdown entry persists.
      const res = await propagateMasterCorrection(m.fileName, text);
      patchRow(m.fileName, {
        busy: false,
        replacing: false,
        message: `Replaced. Re-graded ${res.updated} check${
          res.updated === 1 ? "" : "s"
        }${res.analysts.length ? ` (${res.analysts.join(", ")}).` : "."}`,
      });
      await onChanged({ type: "replace", name: m.fileName, raw: text });
    } catch (err) {
      patchRow(m.fileName, {
        busy: false,
        message:
          err instanceof Error ? err.message : "Failed to replace master.",
      });
    }
  };

  const confirmMerge = async (m: SavedMaster) => {
    const row = rows[m.fileName];
    const destName = row?.mergeDest;
    if (!destName || !canMergeInto(m.fileName, destName)) return;
    const dest = masters.find((x) => sameMasterName(x.fileName, destName));
    if (!dest) return;
    patchRow(m.fileName, { busy: true, message: null });
    try {
      const res = await mergeMasters(m.fileName, dest.fileName, dest.checkId);
      let message: string;
      if (res.moved === 0) {
        message = "Nothing to move — source was already empty.";
      } else {
        const regradedTotal = res.regraded + res.failed;
        message =
          `Moved ${res.moved} check${res.moved === 1 ? "" : "s"} into ` +
          `"${dest.fileName}"; re-graded ${res.regraded}` +
          `${res.analysts.length ? ` (${res.analysts.join(", ")})` : ""}. ` +
          `Source removed.` +
          (res.regraded < regradedTotal
            ? " Some checks could not be re-graded and will reconcile on the next backfill."
            : "");
      }
      patchRow(m.fileName, {
        busy: false,
        merging: false,
        mergeConfirm: false,
        mergeDest: null,
        message,
      });
      await onChanged({ type: "merge", source: m.fileName, dest: dest.fileName });
    } catch (err) {
      patchRow(m.fileName, {
        busy: false,
        message:
          err instanceof Error ? err.message : "Failed to merge masters.",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">
            Manage saved masters
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {masters.length === 0 ? (
            <p className="text-sm text-slate-500">No saved masters yet.</p>
          ) : (
            <ul className="space-y-2">
              {masters.map((m) => {
                const row = rows[m.fileName] ?? freshRow(m.fileName);
                const aff = masterAffordance(row.count ?? 0, isAdmin);
                const canSaveRename =
                  isValidMasterName(row.draftName) &&
                  normalizeMasterName(row.draftName) !== m.fileName;
                return (
                  <li
                    key={m.fileName}
                    className="rounded-lg border border-slate-200 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        {row.editing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={row.draftName}
                              disabled={row.busy}
                              onChange={(e) =>
                                patchRow(m.fileName, { draftName: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && canSaveRename)
                                  saveRename(m);
                                if (e.key === "Escape") cancelEdit(m);
                              }}
                              autoFocus
                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
                            />
                            <button
                              onClick={() => saveRename(m)}
                              disabled={!canSaveRename || row.busy}
                              className="rounded p-1 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                              aria-label="Save new name"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => cancelEdit(m)}
                              disabled={row.busy}
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40"
                              aria-label="Cancel rename"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <p className="truncate text-sm font-medium text-slate-700">
                            {m.fileName}
                          </p>
                        )}
                        <p className="mt-0.5 text-xs text-slate-400">
                          {row.count == null
                            ? "Counting attached checks…"
                            : row.count === 1
                            ? "1 attached check — deletable"
                            : `${row.count} attached checks — replace to update`}
                        </p>
                      </div>

                      {!row.editing && (
                        <div className="flex shrink-0 items-center gap-1">
                          {aff.canRename && (
                            <button
                              onClick={() => startEdit(m)}
                              disabled={row.busy}
                              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
                              aria-label="Rename master"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                          {aff.canManage &&
                            (aff.canDelete ? (
                              <button
                                onClick={() => confirmDelete(m)}
                                disabled={row.busy}
                                className="rounded p-1.5 text-red-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                                aria-label="Delete master"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            ) : aff.mustReplaceToRemove ? (
                              <button
                                onClick={() =>
                                  patchRow(m.fileName, {
                                    replacing: !row.replacing,
                                    message: null,
                                  })
                                }
                                disabled={row.busy}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                              >
                                <Upload className="h-3.5 w-3.5" />
                                Replace
                              </button>
                            ) : null)}
                          {aff.canManage && (
                            <button
                              onClick={() =>
                                patchRow(m.fileName, {
                                  merging: !row.merging,
                                  message: null,
                                  mergeConfirm: false,
                                  mergeDest: null,
                                })
                              }
                              disabled={row.busy}
                              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
                              aria-label="Move checks into another master"
                              title="Move checks into another master"
                            >
                              <GitMerge className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {row.merging && aff.canManage && (() => {
                      const dests = validMergeDestinations(masters, m.fileName);
                      if (dests.length === 0) {
                        return (
                          <div className="mt-3 rounded-md bg-slate-50 p-3">
                            <p className="text-xs text-slate-600">
                              No other master to move into.
                            </p>
                          </div>
                        );
                      }
                      return (
                        <div className="mt-3 rounded-md bg-slate-50 p-3">
                          <label className="block text-xs font-medium text-slate-600">
                            Move all checks for &quot;{m.fileName}&quot; into
                          </label>
                          <select
                            value={row.mergeDest ?? ""}
                            disabled={row.busy}
                            onChange={(e) =>
                              patchRow(m.fileName, {
                                mergeDest: e.target.value || null,
                                mergeConfirm: false,
                              })
                            }
                            className="mt-1.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-slate-500 focus:outline-none disabled:opacity-40"
                          >
                            <option value="">Select a destination master…</option>
                            {dests.map((d) => (
                              <option key={d.fileName} value={d.fileName}>
                                {d.fileName}
                              </option>
                            ))}
                          </select>

                          {row.mergeConfirm && row.mergeDest ? (
                            <div className="mt-3">
                              <p className="text-xs font-medium text-slate-700">
                                Move all checks for &quot;{m.fileName}&quot; into
                                &quot;{row.mergeDest}&quot;
                              </p>
                              <p className="mt-1 text-xs text-slate-600">
                                {row.count == null
                                  ? `Move all checks for "${m.fileName}" into "${row.mergeDest}". "${m.fileName}" will be removed, and all checks under "${row.mergeDest}" will be re-graded against the "${row.mergeDest}" master. This can't be undone from here.`
                                  : `Move ${row.count} check${
                                      row.count === 1 ? "" : "s"
                                    } for "${m.fileName}" into "${row.mergeDest}". "${m.fileName}" will be removed, and all checks under "${row.mergeDest}" will be re-graded against the "${row.mergeDest}" master. This can't be undone from here.`}
                              </p>
                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  onClick={() => confirmMerge(m)}
                                  disabled={
                                    row.busy ||
                                    !row.mergeDest ||
                                    !canMergeInto(m.fileName, row.mergeDest)
                                  }
                                  className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
                                >
                                  <GitMerge className="h-3.5 w-3.5" />
                                  Move
                                </button>
                                <button
                                  onClick={() =>
                                    patchRow(m.fileName, { mergeConfirm: false })
                                  }
                                  disabled={row.busy}
                                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-2">
                              <button
                                onClick={() =>
                                  patchRow(m.fileName, { mergeConfirm: true })
                                }
                                disabled={
                                  row.busy ||
                                  !row.mergeDest ||
                                  !canMergeInto(m.fileName, row.mergeDest ?? "")
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                              >
                                <GitMerge className="h-3.5 w-3.5" />
                                Move checks…
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {row.replacing && aff.mustReplaceToRemove && (
                      <div className="mt-3 rounded-md bg-slate-50 p-3">
                        <p className="text-xs text-slate-600">
                          This master can&apos;t be deleted because{" "}
                          {row.count ?? "several"} accuracy checks are graded
                          against it. Upload a new master file to replace it —
                          every attached check will be re-graded.
                        </p>
                        <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                          <Upload className="h-3.5 w-3.5" />
                          Choose .xml or .json
                          <input
                            type="file"
                            accept=".xml,.json,text/xml,application/xml,application/json"
                            disabled={row.busy}
                            onChange={(e) => handleReplaceFile(m, e.target.files)}
                            className="hidden"
                          />
                        </label>
                      </div>
                    )}

                    {row.message && (
                      <p className="mt-2 text-xs font-medium text-slate-600">
                        {row.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
