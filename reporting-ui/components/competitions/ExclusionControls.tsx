"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { SummaryRow } from "@/lib/analytics/competitionSummary";
import {
  exclusionImpact,
  type ExclusionKind,
} from "@/lib/analytics/exclusions";
import type { ExclusionsController } from "@/components/competitions/useCompetitionExclusions";

const nf = new Intl.NumberFormat("en-AU");

export type SelectableEntry = { key: string; label: string; games: number };

// ---------------------------------------------------------------------------
// Row selection
// ---------------------------------------------------------------------------

/**
 * Checkbox selection keyed by row key. `visibleKeys` are the rows currently
 * shown (after search/sort); the header checkbox acts on those only.
 * `allKeys` is every row that can be selected; keys that disappear from it
 * (for example after an exclude) are dropped automatically.
 */
export function useRowSelection(visibleKeys: readonly string[], allKeys: readonly string[]) {
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set());

  const selected = useMemo(() => {
    const present = new Set(allKeys);
    const out = new Set<string>();
    raw.forEach((k) => present.has(k) && out.add(k));
    return out;
  }, [raw, allKeys]);

  const toggle = useCallback((key: string) => {
    setRaw((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const visibleSelected = visibleKeys.filter((k) => selected.has(k)).length;
  const allSelected = visibleKeys.length > 0 && visibleSelected === visibleKeys.length;
  const someSelected = visibleSelected > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setRaw((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleKeys.forEach((k) => next.delete(k));
      else visibleKeys.forEach((k) => next.add(k));
      return next;
    });
  }, [allSelected, visibleKeys]);

  const clear = useCallback(() => setRaw(new Set()), []);

  return { selected, toggle, toggleAll, clear, allSelected, someSelected };
}

export type RowSelection = ReturnType<typeof useRowSelection>;

export function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  disabled,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all shown rows"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 accent-sky-500"
    />
  );
}

export function RowCheckbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 accent-sky-500"
    />
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Result = { type: "success" | "error"; text: string } | null;

export function ResultMessage({ result }: { result: Result }) {
  return (
    <>
      <div role="status" aria-live="polite" className={result?.type === "success" ? "text-sm text-emerald-400" : "sr-only"}>
        {result?.type === "success" ? result.text : ""}
      </div>
      {result?.type === "error" && (
        <div role="alert" className="text-sm text-red-400">
          {result.text}
        </div>
      )}
    </>
  );
}

export function FallbackNotice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return (
    <p className="rounded-lg border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
      {notice}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Action bar and dialog
// ---------------------------------------------------------------------------

export function ExclusionActionBar({
  selectedCount,
  canPersist,
  busy,
  onExclude,
  onClear,
}: {
  selectedCount: number;
  canPersist: boolean;
  busy?: boolean;
  onExclude: () => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-slate-700 bg-slate-900 px-5 py-3"
      data-testid="exclusion-action-bar"
    >
      <span aria-live="polite" className="text-sm font-semibold text-white">
        {selectedCount} selected
      </span>
      <button
        type="button"
        onClick={onExclude}
        disabled={!canPersist || busy}
        className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Exclude selected
      </button>
      <button
        type="button"
        onClick={onClear}
        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        Clear selection
      </button>
    </div>
  );
}

export function ConfirmExcludeDialog({
  kind,
  entries,
  busy,
  onConfirm,
  onCancel,
}: {
  kind: ExclusionKind;
  entries: readonly SelectableEntry[];
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => reasonRef.current?.focus(), []);
  const noun = kind === "competition" ? "competition" : "team";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="w-full max-w-lg rounded-2xl border border-slate-700 bg-[#0f1b2d] p-5 text-slate-200 shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-white">
          Exclude {entries.length} {noun}
          {entries.length === 1 ? "" : "s"}?
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          {kind === "competition"
            ? "All games in these competitions are removed from every Competitions tab. Teams that also play elsewhere stay."
            : "These teams are removed from team counts and the Teams list. Their games still count for competitions and opponents."}{" "}
          TT_Games data is not changed, and you can restore them later.
        </p>
        <ul className="mt-3 max-h-48 divide-y divide-slate-800 overflow-auto rounded-lg border border-slate-700 text-sm">
          {entries.map((e) => (
            <li key={e.key} className="flex justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate">{e.label}</span>
              <span className="flex-shrink-0 text-slate-400">
                {nf.format(e.games)} game{e.games === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
        <label htmlFor={reasonId} className="mt-3 block text-xs text-slate-400">
          Reason (optional)
        </label>
        <textarea
          id={reasonId}
          ref={reasonRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-lg border border-slate-700 bg-[#0b1524] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={busy}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50"
          >
            Exclude
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exclude flow shared by the competition and team lists
// ---------------------------------------------------------------------------

/**
 * Wires selection -> confirm dialog -> exclusions.add -> result message.
 * `entries` are the rows that can be selected (keys are canonical keys).
 */
export function useExcludeFlow(
  kind: ExclusionKind,
  exclusions: ExclusionsController | undefined,
  entries: readonly SelectableEntry[],
  selection: RowSelection
) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selection.selected.has(e.key)),
    [entries, selection.selected]
  );

  const open = () => {
    setResult(null);
    setDialogOpen(true);
  };
  const cancel = () => setDialogOpen(false);

  const confirm = async (reason: string) => {
    if (!exclusions) return;
    setBusy(true);
    try {
      await exclusions.add(
        selectedEntries.map((e) => ({
          kind,
          key: e.key,
          label: e.label,
          reason,
          created_by: exclusions.actor ?? null,
        }))
      );
      const n = selectedEntries.length;
      const noun = kind === "competition" ? "competition" : "team";
      selection.clear();
      setDialogOpen(false);
      setResult({ type: "success", text: `Excluded ${n} ${noun}${n === 1 ? "" : "s"}.` });
    } catch (e) {
      setDialogOpen(false);
      setResult({
        type: "error",
        text: `Could not exclude: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return { dialogOpen, busy, result, setResult, selectedEntries, open, cancel, confirm };
}

// ---------------------------------------------------------------------------
// Excluded list
// ---------------------------------------------------------------------------

export function ExcludedPanel({
  kind,
  exclusions,
  allGames,
  canManage,
}: {
  kind: ExclusionKind;
  exclusions: ExclusionsController;
  allGames: readonly SummaryRow[];
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const panelId = useId();

  const rows = useMemo(() => exclusions.rows.filter((r) => r.kind === kind), [exclusions.rows, kind]);
  const selectableKeys = useMemo(
    () => rows.filter((r) => r.id != null).map((r) => String(r.id)),
    [rows]
  );
  const selection = useRowSelection(selectableKeys, selectableKeys);
  const manage = canManage && exclusions.canPersist;

  const impacts = useMemo(
    () =>
      open
        ? new Map(rows.map((r) => [r.key, exclusionImpact(allGames, kind, r.key)]))
        : new Map<string, { games: number; teams: number }>(),
    [open, rows, allGames, kind]
  );

  const restore = async () => {
    const ids = [...selection.selected].map(Number);
    setBusy(true);
    try {
      await exclusions.restore(ids);
      selection.clear();
      setResult({ type: "success", text: `Restored ${ids.length} ${kind}${ids.length === 1 ? "" : "s"}.` });
    } catch (e) {
      setResult({
        type: "error",
        text: `Could not restore: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-[#0f1b2d]">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="rounded text-sm font-semibold text-sky-300 hover:text-sky-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Excluded ({rows.length})
        </button>
        <ResultMessage result={result} />
      </div>
      {open && (
        <div id={panelId} className="border-t border-slate-700">
          {rows.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">
              No {kind === "competition" ? "competitions" : "teams"} excluded.
            </p>
          ) : (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Excluded {kind === "competition" ? "competitions" : "teams"}</caption>
                <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    {manage && (
                      <th scope="col" className="w-10 px-4 py-2">
                        <SelectAllCheckbox
                          checked={selection.allSelected}
                          indeterminate={selection.someSelected}
                          onChange={selection.toggleAll}
                        />
                      </th>
                    )}
                    <th scope="col" className="px-4 py-2 font-semibold">Name</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Reason</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Excluded by</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Date</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Affects</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {rows.map((r) => {
                    const imp = impacts.get(r.key);
                    return (
                      <tr key={`${r.id ?? "b"}-${r.key}`}>
                        {manage && (
                          <td className="px-4 py-2">
                            {r.id != null && (
                              <RowCheckbox
                                label={r.label}
                                checked={selection.selected.has(String(r.id))}
                                onChange={() => selection.toggle(String(r.id))}
                              />
                            )}
                          </td>
                        )}
                        <th scope="row" className="px-4 py-2 font-medium text-slate-200">{r.label}</th>
                        <td className="px-4 py-2 text-slate-400">{r.reason ?? "-"}</td>
                        <td className="px-4 py-2 text-slate-400">{r.created_by ?? (r.id == null ? "Built-in" : "-")}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-slate-400">{r.created_at ? r.created_at.slice(0, 10) : "-"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-slate-300">
                          {imp
                            ? kind === "competition"
                              ? `${nf.format(imp.teams)} teams, ${nf.format(imp.games)} games`
                              : `${nf.format(imp.games)} games`
                            : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-5 py-3 text-xs text-slate-500">
            Practice competitions are always excluded automatically and are not listed here.
          </p>
          {manage && selection.selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-700 bg-slate-900 px-5 py-3">
              <span aria-live="polite" className="text-sm font-semibold text-white">
                {selection.selected.size} selected
              </span>
              <button
                type="button"
                onClick={restore}
                disabled={busy}
                className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50"
              >
                Restore selected
              </button>
              <button
                type="button"
                onClick={selection.clear}
                className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
