"use client";

import { useMemo, useState } from "react";
import { X as XIcon, Trash2 } from "lucide-react";
import {
  formatTime,
  parseTime,
  buildCode,
  type Instance,
} from "@/lib/comparison/xml-compare";

// Admin-only editor for a single master instance. Handles both editing an
// existing instance and adding a new one the master missed. Shared by the
// Accuracy Comparison page and the Disputes review pop-up so the editing UI
// stays identical everywhere.
//
// Dropdowns (not free text) are used for team / player / stat so a value can
// only be set to something that already exists — no misspellings, and the
// category auto-fills from the chosen stat.
export default function MasterEditModal({
  instance,
  isNew,
  seedStart,
  seedEnd,
  teamOptions,
  statCatalog,
  playerCatalog,
  onSave,
  onDelete,
  onClose,
}: {
  instance: Instance | null;
  isNew: boolean;
  /** For a NEW instance: pre-fill Start (seconds), e.g. the current video time. */
  seedStart?: number;
  /** For a NEW instance: pre-fill End (seconds). */
  seedEnd?: number;
  teamOptions: string[];
  /** Valid { stat, category } pairs from the loaded files (for the dropdown). */
  statCatalog: { stat: string; category: string }[];
  /** All master instances, used to list existing players per team. */
  playerCatalog: Instance[];
  onSave: (inst: Instance) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [team, setTeam] = useState(instance?.team ?? teamOptions[0] ?? "");
  const [playerNumber, setPlayerNumber] = useState(
    instance?.playerNumber != null ? String(instance.playerNumber) : ""
  );
  const [playerName, setPlayerName] = useState(() => {
    const raw = instance?.playerRaw ?? "";
    return raw.replace(/^#?\d+\.?\s*/, "").trim();
  });
  // "" = not chosen. Selecting a stat also fixes its category.
  const [stat, setStat] = useState(instance?.stat ?? "");
  const [startStr, setStartStr] = useState(
    instance
      ? formatTime(instance.start)
      : seedStart != null
        ? formatTime(seedStart)
        : ""
  );
  const [endStr, setEndStr] = useState(
    instance
      ? formatTime(instance.end)
      : seedEnd != null
        ? formatTime(seedEnd)
        : ""
  );

  // Category is derived from the selected stat (no free text).
  const category =
    statCatalog.find((s) => s.stat === stat)?.category ??
    instance?.category ??
    "";

  // Existing players (number -> most-recent name) for the selected team, so
  // the number can be picked from a dropdown instead of typed.
  const playersForTeam = useMemo(() => {
    const teamLower = team.trim().toLowerCase();
    const map = new Map<number, string>();
    for (const i of playerCatalog) {
      if (i.team.trim().toLowerCase() !== teamLower) continue;
      if (i.playerNumber == null) continue;
      const name = i.playerRaw.replace(/^#?\d+\.?\s*/, "").trim();
      if (!map.has(i.playerNumber) || (name && !map.get(i.playerNumber)))
        map.set(i.playerNumber, name);
    }
    return Array.from(map.entries())
      .map(([number, name]) => ({ number, name }))
      .sort((a, b) => a.number - b.number);
  }, [playerCatalog, team]);

  // Whether the user is entering a number not already on the team.
  const [customNumber, setCustomNumber] = useState(false);

  const onPickNumber = (val: string) => {
    if (val === "__other__") {
      setCustomNumber(true);
      setPlayerNumber("");
      setPlayerName("");
      return;
    }
    setCustomNumber(false);
    setPlayerNumber(val);
    const found = playersForTeam.find((p) => String(p.number) === val);
    if (found) setPlayerName(found.name);
  };

  const save = () => {
    const num = playerNumber.trim() === "" ? null : parseInt(playerNumber, 10);
    const safeNum = Number.isNaN(num as number) ? null : num;
    const start = parseTime(startStr) ?? instance?.start ?? 0;
    const end = parseTime(endStr) ?? start;
    const playerRaw =
      safeNum != null
        ? `#${safeNum}${playerName ? `. ${playerName}` : ""}`
        : playerName;
    const code = buildCode(team.trim(), safeNum, playerName);
    const next: Instance = {
      id: instance?.id ?? (crypto.randomUUID?.() ?? `${Date.now()}`),
      start,
      end,
      mid: (start + end) / 2, // re-derived on re-parse; placeholder here
      team: team.trim(),
      playerNumber: safeNum,
      playerRaw,
      stat: stat.trim(),
      category: category.trim(),
      code,
    };
    onSave(next);
  };

  const canSave = team.trim() !== "" && stat.trim() !== "";

  const field =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none";
  const label = "mb-1 block text-xs font-medium text-slate-500";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-10 w-full max-w-md rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-800">
            {isNew ? "Add master instance" : "Edit master instance"}
          </h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Start (mm:ss)</label>
              <input
                className={field}
                value={startStr}
                onChange={(e) => setStartStr(e.target.value)}
                placeholder="76:29"
              />
            </div>
            <div>
              <label className={label}>End (mm:ss)</label>
              <input
                className={field}
                value={endStr}
                onChange={(e) => setEndStr(e.target.value)}
                placeholder="76:33"
              />
            </div>
          </div>

          <div>
            <label className={label}>Team</label>
            <select
              className={field}
              value={team}
              onChange={(e) => {
                setTeam(e.target.value);
                // Reset player selection when the team changes.
                setCustomNumber(false);
                setPlayerNumber("");
                setPlayerName("");
              }}
            >
              {!teamOptions.includes(team) && team && (
                <option value={team}>{team}</option>
              )}
              {teamOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-[110px_1fr] gap-3">
            <div>
              <label className={label}>Player #</label>
              {customNumber ? (
                <input
                  className={field}
                  value={playerNumber}
                  onChange={(e) => setPlayerNumber(e.target.value)}
                  inputMode="numeric"
                  placeholder="11"
                  autoFocus
                />
              ) : (
                <select
                  className={field}
                  value={playerNumber}
                  onChange={(e) => onPickNumber(e.target.value)}
                >
                  <option value="">—</option>
                  {playersForTeam.map((p) => (
                    <option key={p.number} value={String(p.number)}>
                      #{p.number}
                      {p.name ? ` ${p.name}` : ""}
                    </option>
                  ))}
                  <option value="__other__">+ Other…</option>
                </select>
              )}
            </div>
            <div>
              <label className={label}>Player name (optional)</label>
              <input
                className={field}
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={label}>Stat</label>
            <select
              className={field}
              value={stat}
              onChange={(e) => setStat(e.target.value)}
            >
              <option value="">Select a stat…</option>
              {!statCatalog.some((s) => s.stat === stat) && stat && (
                <option value={stat}>{stat}</option>
              )}
              {statCatalog.map((s) => (
                <option key={s.stat} value={s.stat}>
                  {s.stat}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label}>Category (stat group)</label>
            <input
              className={`${field} bg-slate-50 text-slate-500`}
              value={category}
              readOnly
              placeholder="Set automatically from the stat"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 p-4">
          {!isNew && instance ? (
            <button
              onClick={() => onDelete(instance.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-100"
            >
              <Trash2 size={13} /> Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!canSave}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            >
              {isNew ? "Add" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
