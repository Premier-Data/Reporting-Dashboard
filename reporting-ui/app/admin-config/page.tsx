"use client";

// Admin Configuration — Live Scores club & competition setup.
//
// Shows every PlayHQ competition wired into Live Scores (reference), and an
// editable table of clubs: the PlayHQ club id ↔ S3/JADE club uid mapping, a
// logo URL, and the team colour used on the Players stats + comparison bars.
// Everything persists to Supabase (club_config) and overrides the hardcoded
// defaults; a club with no row falls back to those defaults.

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Save,
  Trash2,
  Plus,
  Check,
  AlertTriangle,
  Download,
} from "lucide-react";

import { LIVE_SCORE_GRADES } from "@/lib/api/playhq";
import {
  CLUB_LOGO_FILES,
  clubLogo,
  clubBadgeColor,
  clubInitials,
  normaliseClub,
} from "@/lib/api/clubLogos";
import {
  listClubConfigs,
  upsertClubConfig,
  deleteClubConfig,
  discoverClubsFromFeeds,
  type ClubConfig,
} from "@/lib/api/clubConfig";

// A row in the editable table — merges a stored override (if any) with the
// bundled default for display. `id` is null for a default-only (unsaved) club.
type Row = {
  id: number | null;
  club_key: string;
  display_name: string;
  playhq_club_id: string;
  s3_club_uid: string; // kept as string for the input; parsed on save
  logo_url: string;
  primary_color: string;
  secondary_color: string;
  competitions: string;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
};

// Title-case a normalised key for a default display name ("st marys" → "St Marys").
function titleCase(key: string): string {
  return key
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function rowFromConfig(cfg: ClubConfig): Row {
  return {
    id: cfg.id,
    club_key: cfg.club_key,
    display_name: cfg.display_name || titleCase(cfg.club_key),
    playhq_club_id: cfg.playhq_club_id ?? "",
    s3_club_uid: cfg.s3_club_uid != null ? String(cfg.s3_club_uid) : "",
    logo_url: cfg.logo_url ?? "",
    primary_color: cfg.primary_color ?? cfg.team_color ?? "",
    secondary_color: cfg.secondary_color ?? "",
    competitions: cfg.competitions ?? "",
    dirty: false,
    saving: false,
    saved: false,
  };
}

function defaultRow(key: string): Row {
  return {
    id: null,
    club_key: key,
    display_name: titleCase(key),
    playhq_club_id: "",
    s3_club_uid: "",
    logo_url: "",
    primary_color: "",
    secondary_color: "",
    competitions: "",
    dirty: false,
    saving: false,
    saved: false,
  };
}

// Preview swatch background: the configured primary colour, else a generated one.
function colorFor(row: Row): string {
  return row.primary_color || clubBadgeColor(row.club_key);
}

// Logo preview: the override URL, else the bundled file, else initials badge.
function LogoPreview({ row }: { row: Row }) {
  const src = row.logo_url || clubLogo(row.club_key);
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full object-contain"
      />
    );
  }
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ background: colorFor(row) }}
    >
      {clubInitials(row.club_key)}
    </span>
  );
}

export default function AdminConfigPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  // Which competition's clubs to show (dropdown). "" = all.
  const [compFilter, setCompFilter] = useState<string>("");
  // Auto-populate from the PlayHQ/S3 feeds.
  const [populating, setPopulating] = useState(false);
  const [populateMsg, setPopulateMsg] = useState<string | null>(null);

  // Load stored overrides and merge with the bundled default club list so every
  // known club shows (even before it has a saved row).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      // Always seed the bundled default clubs so the table is usable even if
      // the overrides table isn't reachable yet (e.g. migration not applied).
      const byKey = new Map<string, Row>();
      for (const key of Object.keys(CLUB_LOGO_FILES)) {
        byKey.set(key, defaultRow(key));
      }
      try {
        const configs = await listClubConfigs();
        if (cancelled) return;
        // Overlay stored overrides (and add any club that only exists in DB).
        for (const cfg of configs) byKey.set(cfg.club_key, rowFromConfig(cfg));
      } catch (e) {
        if (!cancelled)
          setError(
            (e instanceof Error ? e.message : "Failed to load saved config.") +
              " Showing defaults — run the club_config migration to enable saving."
          );
      } finally {
        if (!cancelled) {
          const list = Array.from(byKey.values()).sort((a, b) =>
            a.display_name.localeCompare(b.display_name)
          );
          setRows(list);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((prev) =>
      prev.map((r) =>
        r.club_key === key ? { ...r, ...patch, dirty: true, saved: false } : r
      )
    );

  async function save(key: string) {
    const row = rows.find((r) => r.club_key === key);
    if (!row) return;
    setRows((prev) =>
      prev.map((r) => (r.club_key === key ? { ...r, saving: true } : r))
    );
    try {
      await upsertClubConfig({
        club_key: row.club_key,
        display_name: row.display_name,
        playhq_club_id: row.playhq_club_id,
        s3_club_uid: row.s3_club_uid ? Number(row.s3_club_uid) : null,
        logo_url: row.logo_url,
        primary_color: row.primary_color,
        secondary_color: row.secondary_color,
        competitions: row.competitions,
      });
      setRows((prev) =>
        prev.map((r) =>
          r.club_key === key
            ? { ...r, saving: false, dirty: false, saved: true }
            : r
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
      setRows((prev) =>
        prev.map((r) => (r.club_key === key ? { ...r, saving: false } : r))
      );
    }
  }

  async function removeOverride(key: string) {
    const row = rows.find((r) => r.club_key === key);
    if (!row || row.id == null) return;
    if (!confirm(`Clear saved config for "${row.display_name}"? It reverts to defaults.`))
      return;
    try {
      await deleteClubConfig(row.id);
      // Reset to the bundled default (keep it in the list).
      setRows((prev) =>
        prev.map((r) => (r.club_key === key ? defaultRow(key) : r))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete.");
    }
  }

  // Pull PlayHQ club ids, S3/JADE uids and logo URLs from the live feeds and
  // fill ONLY blank fields on each club (never overwrite an admin edit). New
  // clubs are added. Rows become "dirty" so the admin reviews, then saves.
  async function populate() {
    setPopulating(true);
    setPopulateMsg(null);
    setError(null);
    try {
      const found = await discoverClubsFromFeeds((done, total) =>
        setPopulateMsg(`Scanning fixtures… ${done}/${total}`)
      );
      const foundByKey = new Map(found.map((f) => [f.club_key, f]));
      let filled = 0;
      let added = 0;

      setRows((prev) => {
        const byKey = new Map(prev.map((r) => [r.club_key, r]));
        for (const f of found) {
          const existing = byKey.get(f.club_key);
          if (existing) {
            const patch: Partial<Row> = {};
            if (!existing.playhq_club_id && f.playhq_club_id)
              patch.playhq_club_id = f.playhq_club_id;
            if (!existing.s3_club_uid && f.s3_club_uid != null)
              patch.s3_club_uid = String(f.s3_club_uid);
            if (!existing.logo_url && f.logo_url) patch.logo_url = f.logo_url;
            // Competitions are derived from the feeds — always refresh them so
            // the competition filter stays accurate.
            if (f.competitions && f.competitions !== existing.competitions)
              patch.competitions = f.competitions;
            if (Object.keys(patch).length > 0) {
              byKey.set(f.club_key, {
                ...existing,
                ...patch,
                dirty: true,
                saved: false,
              });
              filled += 1;
            }
          } else {
            byKey.set(f.club_key, {
              ...defaultRow(f.club_key),
              display_name: f.display_name,
              playhq_club_id: f.playhq_club_id ?? "",
              s3_club_uid: f.s3_club_uid != null ? String(f.s3_club_uid) : "",
              logo_url: f.logo_url ?? "",
              competitions: f.competitions ?? "",
              dirty: true,
            });
            added += 1;
          }
        }
        return Array.from(byKey.values()).sort((a, b) =>
          a.display_name.localeCompare(b.display_name)
        );
      });

      setPopulateMsg(
        `Found ${foundByKey.size} club(s): filled ${filled}, added ${added}. Review and Save all.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to populate from feeds.");
      setPopulateMsg(null);
    } finally {
      setPopulating(false);
    }
  }

  // Save every dirty row (used after a populate so the admin doesn't click each).
  async function saveAll() {
    const dirty = rows.filter((r) => r.dirty);
    for (const r of dirty) {
      await save(r.club_key);
    }
  }

  function addClub() {
    const key = normaliseClub(newKey);
    if (!key) return;
    if (rows.some((r) => r.club_key === key)) {
      setError(`"${key}" is already in the list.`);
      return;
    }
    setRows((prev) =>
      [
        ...prev,
        {
          ...defaultRow(key),
          display_name: newKey.trim(),
          competitions: compFilter, // tag with the current competition filter
          dirty: true,
        },
      ].sort((a, b) => a.display_name.localeCompare(b.display_name))
    );
    setNewKey("");
    setError(null);
  }

  const inputCls =
    "w-full rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500";

  const grades = useMemo(() => LIVE_SCORE_GRADES, []);

  // Competition options for the Clubs dropdown — the grade labels.
  const compOptions = useMemo(
    () => LIVE_SCORE_GRADES.map((g) => g.label),
    []
  );

  // Default the Clubs filter to the first competition once rows load.
  useEffect(() => {
    if (!compFilter && compOptions.length > 0) setCompFilter(compOptions[0]);
  }, [compOptions, compFilter]);

  // Clubs shown: those whose `competitions` field includes the selected comp
  // (substring, case-insensitive). "" shows all. A club with no competitions
  // recorded shows under every filter so it's never hidden/orphaned.
  const visibleRows = useMemo(() => {
    if (!compFilter) return rows;
    const needle = compFilter.toLowerCase();
    return rows.filter(
      (r) =>
        !r.competitions.trim() ||
        r.competitions.toLowerCase().includes(needle)
    );
  }, [rows, compFilter]);

  return (
    <div className="min-h-full bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          Admin Configuration
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm text-slate-400">
          Live Scores competition &amp; club setup. Map each club to its PlayHQ
          club id and S3/JADE club uid, set a logo, and choose the team colour
          used on the Players stats tab. Blank fields fall back to the built-in
          defaults.
        </p>

        {/* Competitions reference */}
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-sky-300">
            Competitions (PlayHQ grades)
          </h2>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.03] text-left text-xs uppercase text-slate-400">
                  <th className="px-3 py-2 font-semibold">Key</th>
                  <th className="px-3 py-2 font-semibold">Competition</th>
                  <th className="px-3 py-2 font-semibold">PlayHQ grade id</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((g) => (
                  <tr key={g.key} className="border-b border-white/5">
                    <td className="px-3 py-2 font-mono text-xs text-slate-400">
                      {g.key}
                    </td>
                    <td className="px-3 py-2 font-medium">{g.label}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">
                      {g.gradeId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Grades are configured in code (lib/api/playhq.ts). This table is for
            reference when mapping clubs below.
          </p>
        </section>

        {/* Clubs editor */}
        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-sky-300">
                Clubs
              </h2>
              <select
                value={compFilter}
                onChange={(e) => setCompFilter(e.target.value)}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm font-medium text-slate-100 outline-none focus:border-sky-500 [&>option]:bg-slate-800"
              >
                <option value="">All competitions</option>
                {compOptions.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={populate}
                disabled={populating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {populating ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Download size={15} />
                )}
                Populate from feeds
              </button>
              <button
                type="button"
                onClick={saveAll}
                disabled={populating || !rows.some((r) => r.dirty)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-40"
              >
                <Save size={15} /> Save all
              </button>
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addClub()}
                placeholder="Add a club by name…"
                className={`${inputCls} w-48`}
              />
              <button
                type="button"
                onClick={addClub}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
              >
                <Plus size={15} /> Add
              </button>
            </div>
          </div>

          {populateMsg && (
            <div className="mb-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-200">
              {populateMsg}
            </div>
          )}

          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 py-16 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" /> Loading clubs…
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[920px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/[0.03] text-left text-xs uppercase text-slate-400">
                    <th className="px-3 py-2 font-semibold">Club</th>
                    <th className="px-3 py-2 font-semibold">PlayHQ club id</th>
                    <th className="px-3 py-2 font-semibold">S3 / JADE uid</th>
                    <th className="px-3 py-2 font-semibold">Logo URL</th>
                    <th className="px-3 py-2 font-semibold">Colours</th>
                    <th className="px-3 py-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                        No clubs for this competition yet. Use &quot;Populate
                        from feeds&quot; or add one.
                      </td>
                    </tr>
                  )}
                  {visibleRows.map((row) => (
                    <tr key={row.club_key} className="border-b border-white/5 align-top">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <LogoPreview row={row} />
                          <div className="min-w-0">
                            <input
                              value={row.display_name}
                              onChange={(e) =>
                                update(row.club_key, { display_name: e.target.value })
                              }
                              className={`${inputCls} w-40`}
                            />
                            <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                              {row.club_key}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={row.playhq_club_id}
                          onChange={(e) =>
                            update(row.club_key, { playhq_club_id: e.target.value })
                          }
                          placeholder="UUID / slug"
                          className={`${inputCls} w-44`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={row.s3_club_uid}
                          onChange={(e) =>
                            update(row.club_key, {
                              s3_club_uid: e.target.value.replace(/[^0-9]/g, ""),
                            })
                          }
                          placeholder="e.g. 1834"
                          inputMode="numeric"
                          className={`${inputCls} w-24`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={row.logo_url}
                          onChange={(e) =>
                            update(row.club_key, { logo_url: e.target.value })
                          }
                          placeholder="https://…"
                          className={`${inputCls} w-48`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-3">
                          {/* Live preview of the player number badge. */}
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs font-bold"
                            style={{
                              backgroundColor:
                                row.primary_color || clubBadgeColor(row.club_key),
                              color: row.secondary_color || "#ffffff",
                            }}
                            title="Player number preview"
                          >
                            9
                          </span>
                          <label className="flex flex-col items-center gap-0.5">
                            <input
                              type="color"
                              aria-label="Primary (square) colour"
                              value={row.primary_color || clubBadgeColor(row.club_key)}
                              onChange={(e) =>
                                update(row.club_key, { primary_color: e.target.value })
                              }
                              className="h-7 w-9 cursor-pointer rounded border border-white/15 bg-transparent"
                            />
                            <span className="text-[9px] uppercase text-slate-500">
                              Primary
                            </span>
                          </label>
                          <label className="flex flex-col items-center gap-0.5">
                            <input
                              type="color"
                              aria-label="Secondary (number) colour"
                              value={row.secondary_color || "#ffffff"}
                              onChange={(e) =>
                                update(row.club_key, {
                                  secondary_color: e.target.value,
                                })
                              }
                              className="h-7 w-9 cursor-pointer rounded border border-white/15 bg-transparent"
                            />
                            <span className="text-[9px] uppercase text-slate-500">
                              Number
                            </span>
                          </label>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => save(row.club_key)}
                            disabled={row.saving || (!row.dirty && !row.saved)}
                            className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-40"
                          >
                            {row.saving ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : row.saved ? (
                              <Check size={13} />
                            ) : (
                              <Save size={13} />
                            )}
                            {row.saved ? "Saved" : "Save"}
                          </button>
                          {row.id != null && (
                            <button
                              type="button"
                              onClick={() => removeOverride(row.club_key)}
                              aria-label="Clear override"
                              className="rounded-lg border border-white/10 p-1.5 text-slate-400 transition hover:bg-red-500/15 hover:text-red-300"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Changes take effect on the Live Scores tab. On the Players stats
            tab, the Primary colour is the player number square&apos;s
            background and the Secondary colour is the number text. Pick a
            competition above to edit just that league&apos;s clubs.
          </p>
        </section>
      </div>
    </div>
  );
}
