"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  History,
  Trash2,
  X,
  Flag,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Download,
  RotateCcw,
  Film,
} from "lucide-react";

// Accuracy trend chart pulls in recharts — load lazily so recharts stays out
// of this page's initial bundle and only downloads when a trend is shown.
const AccuracyTrendChart = dynamic(() => import("./AccuracyTrendChart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">
      Loading chart…
    </div>
  ),
});
import type { TrendPoint } from "./AccuracyTrendChart";
import {
  getAccuracyChecksMeta,
  getAccuracyChecksXml,
  getSavedMasterXml,
  summariseByAnalyst,
  deleteAccuracyCheck,
  restoreAccuracyCheck,
  getDeletedAccuracyChecksMeta,
  backfillPlayerAccuracy,
  recomputeAllPlayerAccuracy,
  diagnoseMasterConsistency,
  fixStaleMasterTotals,
  instancesFromRaw,
  setAccuracyCheckCategory,
  CHECK_CATEGORY_OPTIONS,
  CHECK_CATEGORY_LABELS,
  type AccuracyCheckMeta,
  type CheckCategory,
  type MasterConsistencyReport,
  type MasterSiblingCheck,
} from "@/lib/api/accuracyChecks";
import {
  getOpenDisputeCounts,
  getDisputesForCheck,
  resolveDispute,
  type Dispute,
} from "@/lib/api/disputes";
import {
  parseInstances,
  canonicaliseTeams,
  compareInstances,
  parseHomeAwayFromFileName,
  serializeInstances,
  type Instance,
} from "@/lib/comparison/xml-compare";
import { serializeInstancesToJson } from "@/lib/comparison/json-adapter";
import {
  computePlayerAccuracy,
  type PlayerAccuracy,
  type AccuracyGroup,
  type StoredPlayerAccuracy,
} from "@/lib/comparison/player-accuracy";
import { type StoredAflPlayerAccuracy } from "@/lib/comparison/afl-player-accuracy";

// Narrow a stored player_accuracy (now a football | AFL union) to the
// football shape. The three football-only readers below keep today's behavior:
// a non-football (AFL) stored value reads as "no football data" exactly as the
// old `!stored.football` check did. AFL-shaped rendering is added separately.
function asFootballStored(
  pa: StoredPlayerAccuracy | StoredAflPlayerAccuracy | null | undefined
): StoredPlayerAccuracy | null {
  return pa && "football" in pa ? pa : null;
}
import {
  getAnalystLocationMap,
  ANALYST_LOCATIONS,
  type AnalystLocation,
} from "@/lib/api/analysts";
import { useAuth } from "@/components/auth/AuthContext";
import DisputesPanel from "@/components/DisputesPanel";
import SportToggle, { type SportFilter } from "@/components/SportToggle";

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

// Accuracy color bands: 90%+ green, 80–89.99% yellow, 70–79.99% orange,
// below 70% red.
function accColor(a: number) {
  if (a >= 0.9) return "text-emerald-600";
  if (a >= 0.8) return "text-yellow-500";
  if (a >= 0.7) return "text-orange-500";
  return "text-red-600";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ---- Friday→Thursday weeks ----------------------------------------
// Every week filter on this page (Saved checks, All analysts, By location)
// groups by a week that STARTS on Friday and ENDS the following Thursday. The
// key is the ISO date (YYYY-MM-DD, UTC) of that week's Friday, so keys sort
// chronologically as plain strings.
function fridayWeekStart(iso: string): Date {
  const d = new Date(iso);
  const date = new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  );
  // Days since the most recent Friday. getUTCDay: Sun=0..Sat=6, Fri=5.
  const back = (date.getUTCDay() - 5 + 7) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date;
}

function fridayWeekKey(iso: string): string {
  return fridayWeekStart(iso).toISOString().slice(0, 10);
}

// Label a Friday-week key as its "Fri dd Mon – Thu dd Mon" range.
function fridayWeekLabel(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return key;
  const fri = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const thu = new Date(fri);
  thu.setUTCDate(fri.getUTCDate() + 6);
  const fmt = (dt: Date) =>
    dt.toLocaleDateString("en-AU", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });
  return `${fmt(fri)} – ${fmt(thu)}`;
}

type TeamScope = "both" | "home" | "away";

// Player Accuracy groups (Overall / Passing / Offensive / Defensive /
// Goalkeeper) for a check, scoped to Both / Home / Away.
//
// FAST PATH: use the precomputed `player_accuracy` stored on the check — no
// XML fetch or parsing needed. FALLBACK: for older checks not yet backfilled,
// compute from the raw XML (fetched on demand) exactly as before.
function fixtureGroupAccuracy(
  check: AccuracyCheckMeta,
  scope: TeamScope,
  xml?: { xml_master: string | null; xml_analyst: string | null }
): PlayerAccuracy | null {
  // Fast path: stored precomputed values.
  const stored = check.player_accuracy;
  if (stored) {
    const football = asFootballStored(stored);
    if (!football || !football.football) return null;
    return football[scope] ?? null;
  }

  // Fallback: compute from the raw source (only until this check is
  // backfilled). Either side may be a JSON feed, so resolve format-aware.
  if (!xml?.xml_master || !xml?.xml_analyst) return null;
  const master = instancesFromRaw(xml.xml_master);
  const analyst = instancesFromRaw(xml.xml_analyst);
  const tol = check.tolerance ?? 3;
  const canon = canonicaliseTeams(master, analyst, tol, check.file_name_master);

  const inScope = (i: Instance) =>
    scope === "both" || i.team.trim().toLowerCase() === scope;

  const cmp = compareInstances(
    canon.master.filter(inScope),
    canon.analyst.filter(inScope),
    tol
  );
  const groups = computePlayerAccuracy(cmp.rows);
  return groups.overall.master > 0 ? groups : null;
}

// The Player Accuracy group columns shown in the fixture table, in order.
// These mirror the cards on the Accuracy Comparison page.
const PLAYER_ACCURACY_COLUMNS = [
  { key: "overall", label: "Overall", short: "OVR" },
  { key: "passing", label: "Passing", short: "PASS" },
  { key: "offensive", label: "Offensive", short: "OFF" },
  { key: "defensive", label: "Defensive", short: "DEF" },
  { key: "goalkeeper", label: "Goalkeeper", short: "GK" },
  { key: "other", label: "Other", short: "OTH" },
] as const;

type PlayerAccuracyGroupKey = (typeof PLAYER_ACCURACY_COLUMNS)[number]["key"];

// Club/suffix tokens that should always render fully uppercase.
const ALWAYS_UPPER_TOKENS = new Set(["fc", "sc"]);

// Title-case a team name (each word capitalised) for a professional look.
// Club suffixes like FC/SC are always uppercased, and tokens with digits
// (U15, U15B) are left as-is.
function titleCaseTeam(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => {
      if (ALWAYS_UPPER_TOKENS.has(w.toLowerCase())) return w.toUpperCase();
      // Leave tokens containing digits (age groups like U15) as-is.
      if (/\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

// "Home v Away" for a check, from its master file name. Falls back to the
// saved match label, then a dash.
function matchTeamsLabel(check: AccuracyCheckMeta): string {
  const teams = parseHomeAwayFromFileName(check.file_name_master);
  if (teams) return `${titleCaseTeam(teams[0])} v ${titleCaseTeam(teams[1])}`;
  return check.match_label || "—";
}

// A group's % for display/averaging, or null when it has no data to compare.
// Guards on `master` (not just `pct`) so stale stored snapshots — written
// before the 0/0 fix, with pct=1 for empty sections — are treated as no-data
// instead of a bogus 100%. This is the single place that decision is made, so
// live data is correct even before an admin runs "Recompute all".
function groupPct(group: AccuracyGroup | null | undefined): number | null {
  if (!group || group.master === 0) return null;
  return group.pct;
}

// Read one Player Accuracy group's % from a check's STORED player_accuracy
// (both-teams scope). Returns null when not computed yet or non-football.
function storedGroupPct(
  check: AccuracyCheckMeta,
  key: PlayerAccuracyGroupKey
): number | null {
  const pa = asFootballStored(check.player_accuracy);
  if (!pa || !pa.football) return null;
  return groupPct(pa.both?.[key]);
}

// Average each Player Accuracy group across a set of checks (both-teams scope).
// Only checks with a value for a group count toward its average, so
// missing/non-football checks don't drag it down. Values are null when no
// check has a computed value for that group.
function averageGroups(
  checks: AccuracyCheckMeta[]
): Record<PlayerAccuracyGroupKey, number | null> {
  const sums = new Map<PlayerAccuracyGroupKey, { total: number; n: number }>();
  for (const col of PLAYER_ACCURACY_COLUMNS)
    sums.set(col.key, { total: 0, n: 0 });
  for (const c of checks) {
    for (const col of PLAYER_ACCURACY_COLUMNS) {
      const v = storedGroupPct(c, col.key);
      if (v == null) continue;
      const s = sums.get(col.key)!;
      s.total += v;
      s.n += 1;
    }
  }
  const out: Record<PlayerAccuracyGroupKey, number | null> = {
    overall: null,
    passing: null,
    offensive: null,
    defensive: null,
    goalkeeper: null,
    other: null,
  };
  for (const col of PLAYER_ACCURACY_COLUMNS) {
    const s = sums.get(col.key)!;
    if (s.n > 0) out[col.key] = s.total / s.n;
  }
  return out;
}

// One analyst's row within a master-fixture group. Holds the per-group
// Player Accuracy for the active scope (key -> group result, or null when the
// XML isn't available yet / the check has no football data).
type FixtureRow = {
  check: AccuracyCheckMeta;
  analyst: string;
  date: string;
  groups: PlayerAccuracy | null;
};

export default function AccuracyChecksPage() {
  const router = useRouter();
  const { user, ready } = useAuth();
  const canResolve =
    user?.role === "admin" || user?.role === "super_admin";

  // All loaded checks; `checks` below applies the sport filter.
  const [allChecks, setAllChecks] = useState<AccuracyCheckMeta[]>([]);
  // On-demand XML cache (check id -> raw XML), populated only when the user
  // switches the category columns to Home/Away, which needs per-team data
  // that only exists in the stored XML. Keeps the initial load light.
  const [xmlById, setXmlById] = useState<
    Map<number, { xml_master: string | null; xml_analyst: string | null }>
  >(new Map());
  const [loadingScopeXml, setLoadingScopeXml] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // One-time Player Accuracy backfill (admin) for older checks.
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [selectedAnalyst, setSelectedAnalyst] = useState<string>("");
  // Sport filter (all | afl | football), matching Accuracy Comparison.
  const [sportFilter, setSportFilter] = useState<SportFilter>("all");
  // Top-level view: per-analyst history, all-analyst comparison, or by-location.
  const [view, setView] = useState<"history" | "analysts" | "locations">(
    "history"
  );
  // Week filter for the comparison tables ("all" = whole season).
  const [weekFilter, setWeekFilter] = useState<string>("all");
  // Category filter SHARED across the "All analysts" and "By location"
  // comparison tabs ("all" = every category, NULL rows included). Separate
  // from the History tab's savedCategoryFilter.
  const [comparisonCategoryFilter, setComparisonCategoryFilter] = useState<
    CheckCategory | "all"
  >("all");
  // analyst name (lowercased) -> location, for the by-location comparison.
  const [locationByName, setLocationByName] = useState<
    Map<string, AnalystLocation>
  >(new Map());

  // Effective sport per check: stored value, else inferred from the master
  // XML (so older checks without a sport are classified correctly).
  const sportByCheck = useMemo(() => {
    const m = new Map<number, "afl" | "football">();
    for (const c of allChecks) {
      const stored =
        c.sport === "afl" || c.sport === "football" ? c.sport : null;
      m.set(c.id, stored ?? "afl");
    }
    return m;
  }, [allChecks]);

  const checks = useMemo(() => {
    if (sportFilter === "all") return allChecks;
    return allChecks.filter((c) => sportByCheck.get(c.id) === sportFilter);
  }, [allChecks, sportFilter, sportByCheck]);

  // Open-dispute counts per check id (for the badge), and the currently
  // expanded check's disputes panel.
  const [openCounts, setOpenCounts] = useState<Record<number, number>>({});
  const [expandedCheck, setExpandedCheck] = useState<number | null>(null);
  const [panelDisputes, setPanelDisputes] = useState<Dispute[]>([]);

  // Open a saved check fully in the Accuracy Comparison tab.
  function openCheck(id: number) {
    router.push(`/accuracy-compare?check=${id}`);
  }

  async function loadDisputePanel(checkId: number) {
    try {
      setPanelDisputes(await getDisputesForCheck(checkId));
    } catch (err) {
      console.error(err);
    }
  }

  function toggleDisputes(checkId: number) {
    if (expandedCheck === checkId) {
      setExpandedCheck(null);
      setPanelDisputes([]);
    } else {
      setExpandedCheck(checkId);
      loadDisputePanel(checkId);
    }
  }

  async function handleResolve(
    disputeId: number,
    status: "confirmed" | "denied",
    note: string | null
  ) {
    try {
      await resolveDispute(disputeId, status, user?.username ?? null, note);
      if (expandedCheck != null) await loadDisputePanel(expandedCheck);
      setOpenCounts(await getOpenDisputeCounts());
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to resolve dispute.");
    }
  }

  async function load() {
    try {
      setLoading(true);
      const [data, counts] = await Promise.all([
        getAccuracyChecksMeta(),
        getOpenDisputeCounts().catch(() => ({}) as Record<number, number>),
      ]);

      // Admins/super admins see everything. Any other role (analyst) sees
      // ONLY checks saved against their own allocated name — and nothing if
      // they have no allocated name (never fall back to showing all).
      const isAdmin =
        user?.role === "admin" || user?.role === "super_admin";
      const own = user?.analyst_name?.trim().toLowerCase() ?? "";
      const scoped = isAdmin
        ? data
        : data.filter(
            (c) => !!own && c.analyst_name.trim().toLowerCase() === own
          );

      setAllChecks(scoped);
      setOpenCounts(counts);
      setError(null);
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Failed to load accuracy checks."
      );
    } finally {
      setLoading(false);
    }
  }

  // Admin: compute + store Player Accuracy for older checks that lack it, so
  // the fixture columns render from the stored field (no per-view XML parsing).
  async function handleBackfill() {
    setBackfilling(true);
    setBackfillMsg("Starting…");
    try {
      const res = await backfillPlayerAccuracy((p) =>
        setBackfillMsg(`Processing ${p.done} / ${p.total}…`)
      );
      setBackfillMsg(
        `Done. Updated ${res.updated}, skipped ${res.skipped}.`
      );
      await load();
    } catch (err) {
      setBackfillMsg(
        err instanceof Error ? err.message : "Backfill failed."
      );
    } finally {
      setBackfilling(false);
    }
  }

  // Admin: recompute + overwrite Player Accuracy for EVERY check. Needed after
  // the Player Accuracy grouping changes (stats added/removed from a group) so
  // every stored value reflects the new grouping, not just null ones.
  async function handleRecomputeAll() {
    if (
      !window.confirm(
        "Recompute Player Accuracy for ALL checks? This overwrites every " +
          "check's stored accuracy from its XML and may take a while."
      )
    )
      return;
    setBackfilling(true);
    setBackfillMsg("Starting…");
    try {
      const res = await recomputeAllPlayerAccuracy((p) =>
        setBackfillMsg(`Processing ${p.done} / ${p.total}…`)
      );
      setBackfillMsg(
        `Done. Recomputed ${res.updated}, skipped ${res.skipped}.`
      );
      await load();
    } catch (err) {
      setBackfillMsg(
        err instanceof Error ? err.message : "Recompute failed."
      );
    } finally {
      setBackfilling(false);
    }
  }

  // Wait until auth is ready (session restored) before loading, so the
  // analyst-scoping filter runs against the real user, not a half-loaded one.
  useEffect(() => {
    if (!ready) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user?.role, user?.analyst_name]);

  // Load the analyst name -> location map once, for the by-location view.
  useEffect(() => {
    let cancelled = false;
    getAnalystLocationMap()
      .then((m) => {
        if (!cancelled) setLocationByName(m);
      })
      .catch((err) => console.error("Failed loading location map:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const analystSummaries = useMemo(
    () => summariseByAnalyst(checks),
    [checks]
  );

  // Empty selectedAnalyst = "All analysts" (the default view). Checks are
  // shown oldest-first per analyst, or all checks newest-first for "All".
  const analystChecks = useMemo(() => {
    if (!selectedAnalyst) {
      return [...checks].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
    return checks
      .filter(
        (c) =>
          c.analyst_name.trim().toLowerCase() ===
          selectedAnalyst.trim().toLowerCase()
      )
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
  }, [checks, selectedAnalyst]);

  // Which Player Accuracy group the trend chart plots.
  const [trendGroup, setTrendGroup] =
    useState<PlayerAccuracyGroupKey>("overall");

  const trendData = useMemo(
    () =>
      analystChecks
        .map((c, i) => {
          // Plot the selected Player Accuracy group (Overall/Passing/…). Skip
          // checks with no stored value for that group so the line is clean.
          const v = storedGroupPct(c, trendGroup);
          if (v == null) return null;
          return {
            idx: i + 1,
            label: matchTeamsLabel(c),
            accuracy: Number((v * 100).toFixed(1)),
          };
        })
        .filter((p): p is NonNullable<typeof p> => p != null)
        .map((p, i) => ({ ...p, idx: i + 1 })),
    [analystChecks, trendGroup]
  );

  // Sort state for the "Saved checks" table. Defaults to newest first.
  const [savedSort, setSavedSort] = useState<{
    key: string;
    dir: "asc" | "desc";
  }>({ key: "date", dir: "desc" });

  // Friday→Thursday week filter for the Saved checks table ("all" = every
  // week). Separate state from the comparison-tabs week filter, but both now
  // use the same Friday-start weeks.
  const [savedWeekFilter, setSavedWeekFilter] = useState<string>("all");

  // Category filter for the Saved checks table ("all" = every category,
  // including legacy NULL rows). A specific category excludes NULL rows.
  const [savedCategoryFilter, setSavedCategoryFilter] = useState<
    CheckCategory | "all"
  >("all");

  // Master-consistency diagnostic modal: which fixture filename to inspect.
  const [masterDiagFile, setMasterDiagFile] = useState<string | null>(null);

  // Deleted-checks review modal (admin only).
  const [showDeleted, setShowDeleted] = useState(false);

  function toggleSavedSort(key: string) {
    setSavedSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  }

  // Apply the active sort to the saved-checks rows. String columns sort
  // case-insensitively; numeric columns numerically; nulls sink to the bottom.
  const sortedSavedChecks = useMemo(() => {
    const { key, dir } = savedSort;
    const mult = dir === "asc" ? 1 : -1;
    const val = (c: AccuracyCheckMeta): number | string | null => {
      switch (key) {
        case "checkNo":
          return c.id;
        case "date":
          return new Date(c.created_at).getTime();
        case "match":
          return matchTeamsLabel(c).toLowerCase();
        case "analyst":
          return (c.analyst_name || "").toLowerCase();
        case "masterBy":
          return (c.master_analyst_name || "").toLowerCase();
        case "category":
          return (
            c.category ? CHECK_CATEGORY_LABELS[c.category] : ""
          ).toLowerCase();
        case "overall":
        case "passing":
        case "offensive":
        case "defensive":
        case "goalkeeper":
        case "other":
          return storedGroupPct(c, key as PlayerAccuracyGroupKey);
        case "exactMaster":
          return c.master_total > 0 ? c.exact / c.master_total : 0;
        case "disputes":
          return openCounts[c.id] ?? 0;
        default:
          return null;
      }
    };
    const weekScoped =
      savedWeekFilter === "all"
        ? analystChecks
        : analystChecks.filter(
            (c) => fridayWeekKey(c.created_at) === savedWeekFilter
          );
    // Category narrowing: "all" keeps everything (NULL included); a specific
    // category keeps only rows whose category matches (NULL excluded).
    const scoped =
      savedCategoryFilter === "all"
        ? weekScoped
        : weekScoped.filter((c) => c.category === savedCategoryFilter);
    return [...scoped].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * mult;
      }
      return ((av as number) - (bv as number)) * mult;
    });
  }, [
    analystChecks,
    savedSort,
    openCounts,
    savedWeekFilter,
    savedCategoryFilter,
  ]);

  // Distinct Friday→Thursday weeks present in the current (analyst/sport
  // scoped) checks, newest first, for the Saved-checks week selector.
  const savedWeeks = useMemo(() => {
    const set = new Set<string>();
    for (const c of analystChecks) set.add(fridayWeekKey(c.created_at));
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [analystChecks]);

  // Fixtures whose sibling checks (same master file) DON'T all share the same
  // stored master_total — the tell-tale of an edited/re-coded master. Detected
  // from data already in memory (no XML fetch): group by file_name_master and
  // compare the master_total values. Keyed by filename with the min/max spread.
  const masterTotalMismatches = useMemo(() => {
    const byFile = new Map<
      string,
      { label: string; totals: Set<number>; count: number }
    >();
    for (const c of checks) {
      const file = (c.file_name_master || "").trim();
      if (!file) continue;
      const e =
        byFile.get(file) ??
        { label: matchTeamsLabel(c), totals: new Set<number>(), count: 0 };
      e.totals.add(c.master_total);
      e.count += 1;
      byFile.set(file, e);
    }
    const out: {
      file: string;
      label: string;
      checks: number;
      min: number;
      max: number;
    }[] = [];
    for (const [file, e] of byFile.entries()) {
      if (e.totals.size <= 1) continue; // consistent — skip
      const nums = Array.from(e.totals);
      out.push({
        file,
        label: e.label,
        checks: e.count,
        min: Math.min(...nums),
        max: Math.max(...nums),
      });
    }
    return out.sort((a, b) => b.max - b.min - (a.max - a.min));
  }, [checks]);

  // Export the Saved-checks rows CURRENTLY SHOWING (respecting the week filter,
  // analyst scope and sort) to a CSV download. Percentages are written as plain
  // numbers (e.g. 92.3) so they open cleanly in Excel/Sheets.
  function exportSavedChecks() {
    const pctNum = (v: number | null) =>
      v == null ? "" : (v * 100).toFixed(1);
    const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

    const header = [
      "Check #",
      "Date",
      "Match",
      "Analyst",
      "Master by",
      ...PLAYER_ACCURACY_COLUMNS.map((c) => `${c.label} %`),
      "Exact",
      "Master total",
      "Open disputes",
    ];

    const lines = sortedSavedChecks.map((c) => {
      const cells = [
        String(c.id),
        formatDate(c.created_at),
        matchTeamsLabel(c),
        c.analyst_name || "",
        c.master_analyst_name || "",
        ...PLAYER_ACCURACY_COLUMNS.map((col) =>
          pctNum(storedGroupPct(c, col.key))
        ),
        String(c.exact),
        String(c.master_total),
        String(openCounts[c.id] ?? 0),
      ];
      return cells.map(csvCell).join(",");
    });

    const csv = [header.map(csvCell).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const scope =
      savedWeekFilter === "all"
        ? "all-weeks"
        : `week-${savedWeekFilter}`;
    const who = selectedAnalyst
      ? selectedAnalyst.replace(/\s+/g, "-").toLowerCase()
      : "all-analysts";
    a.href = url;
    a.download = `saved-checks_${who}_${scope}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Average Player Accuracy per group (Overall/Passing/Offensive/Defensive/
  // Goalkeeper) across the selected analyst's checks, from the stored
  // player_accuracy (both-teams scope). Only checks that HAVE a value for a
  // Problem-area analysis for the selected analyst: the 3–5 stats most in need
  // of improvement, each with the specific check they struggled with most.
  // Rule-based (no LLM), from the stored player_accuracy (both scope) — instant.
  const PROBLEM_THRESHOLD = 0.7; // below 70% = needs significant improvement
  const analystRecommendations = useMemo(() => {
    if (!selectedAnalyst) return null;

    // stat label -> aggregate + which group it belongs to + worst check.
    type Agg = {
      label: string;
      group: string;
      master: number;
      exact: number;
      // Worst single check for this stat (lowest %, needs enough volume).
      worst: {
        checkId: number;
        label: string;
        date: string;
        pct: number;
        exact: number;
        master: number;
      } | null;
    };
    const byStat = new Map<string, Agg>();

    for (const c of analystChecks) {
      const pa = asFootballStored(c.player_accuracy);
      if (!pa || !pa.football) continue;
      for (const col of PLAYER_ACCURACY_COLUMNS) {
        if (col.key === "overall") continue;
        const grp = pa.both?.[col.key];
        if (!grp) continue;
        for (const part of grp.parts) {
          if (part.master <= 0) continue;
          let e = byStat.get(part.label);
          if (!e) {
            e = {
              label: part.label,
              group: col.label,
              master: 0,
              exact: 0,
              worst: null,
            };
            byStat.set(part.label, e);
          }
          e.master += part.master;
          e.exact += part.exact;
          // Track the worst check for this stat — needs a little volume
          // (>=3 master events) so a single 0/1 doesn't dominate.
          const checkPct = part.exact / part.master;
          if (
            part.master >= 3 &&
            (e.worst == null || checkPct < e.worst.pct)
          ) {
            e.worst = {
              checkId: c.id,
              label: matchTeamsLabel(c),
              date: c.created_at,
              pct: checkPct,
              exact: part.exact,
              master: part.master,
            };
          }
        }
      }
    }

    const stats = Array.from(byStat.values())
      .map((e) => ({ ...e, pct: e.exact / e.master }))
      .filter((s) => s.pct < PROBLEM_THRESHOLD)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 5);

    if (stats.length === 0) return { stats: [] as typeof stats };
    return { stats };
  }, [selectedAnalyst, analystChecks]);

  // Distinct Friday→Thursday weeks present in the (sport-filtered) checks,
  // newest first, for the comparison-table week selector. Consistent with the
  // Saved-checks week filter (Friday start, Thursday end).
  const availableWeeks = useMemo(() => {
    const set = new Set<string>();
    for (const c of checks) set.add(fridayWeekKey(c.created_at));
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [checks]);

  // All-analyst comparison: for each analyst, the average of each Player
  // Accuracy group across their checks (optionally filtered to one week).
  // Also carries the check count so the table can show sample size.
  const analystComparison = useMemo(() => {
    const weekScoped =
      weekFilter === "all"
        ? checks
        : checks.filter((c) => fridayWeekKey(c.created_at) === weekFilter);
    // Narrow by category after the week scope. "all" keeps everything
    // (NULL/uncategorised included); a specific category keeps only matching
    // rows (NULL excluded). Mirrors the Saved checks table semantics.
    const scoped =
      comparisonCategoryFilter === "all"
        ? weekScoped
        : weekScoped.filter((c) => c.category === comparisonCategoryFilter);

    const byAnalyst = new Map<
      string,
      {
        analyst: string;
        checks: number;
        sums: Map<PlayerAccuracyGroupKey, { total: number; n: number }>;
      }
    >();

    for (const c of scoped) {
      const name = c.analyst_name || "—";
      let e = byAnalyst.get(name);
      if (!e) {
        const sums = new Map<
          PlayerAccuracyGroupKey,
          { total: number; n: number }
        >();
        for (const col of PLAYER_ACCURACY_COLUMNS)
          sums.set(col.key, { total: 0, n: 0 });
        e = { analyst: name, checks: 0, sums };
        byAnalyst.set(name, e);
      }
      e.checks += 1;
      for (const col of PLAYER_ACCURACY_COLUMNS) {
        const v = storedGroupPct(c, col.key);
        if (v == null) continue;
        const s = e.sums.get(col.key)!;
        s.total += v;
        s.n += 1;
      }
    }

    return Array.from(byAnalyst.values())
      .map((e) => {
        const groups: Record<PlayerAccuracyGroupKey, number | null> = {
          overall: null,
          passing: null,
          offensive: null,
          defensive: null,
          goalkeeper: null,
          other: null,
        };
        for (const col of PLAYER_ACCURACY_COLUMNS) {
          const s = e.sums.get(col.key)!;
          groups[col.key] = s.n > 0 ? s.total / s.n : null;
        }
        const location =
          locationByName.get(e.analyst.trim().toLowerCase()) ?? "Unknown";
        return { analyst: e.analyst, location, checks: e.checks, groups };
      })
      .sort((a, b) => (b.groups.overall ?? -1) - (a.groups.overall ?? -1));
  }, [checks, weekFilter, comparisonCategoryFilter, locationByName]);

  // Sort state for the comparison table.
  const [comparisonSort, setComparisonSort] = useState<{
    key: string;
    dir: "asc" | "desc";
  }>({ key: "overall", dir: "desc" });

  function toggleComparisonSort(key: string) {
    setComparisonSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" }
    );
  }

  const sortedComparison = useMemo(() => {
    const { key, dir } = comparisonSort;
    const mult = dir === "asc" ? 1 : -1;
    const val = (r: (typeof analystComparison)[number]): number | string | null => {
      if (key === "analyst") return r.analyst.toLowerCase();
      if (key === "location") return r.location.toLowerCase();
      if (key === "checks") return r.checks;
      return r.groups[key as PlayerAccuracyGroupKey];
    };
    return [...analystComparison].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string")
        return av.localeCompare(bv) * mult;
      return ((av as number) - (bv as number)) * mult;
    });
  }, [analystComparison, comparisonSort]);

  // By-location comparison: group checks by the analyst's country (via the
  // name->location map), averaging each Player Accuracy group. Names without a
  // location fall into "Unknown". Respects the week filter.
  const locationComparison = useMemo(() => {
    const weekScoped =
      weekFilter === "all"
        ? checks
        : checks.filter((c) => fridayWeekKey(c.created_at) === weekFilter);
    // Narrow by category after the week scope (same rule as the analysts tab).
    const scoped =
      comparisonCategoryFilter === "all"
        ? weekScoped
        : weekScoped.filter((c) => c.category === comparisonCategoryFilter);

    // Per-analyst accumulator, grouped under each location, so a location row
    // can expand to show every analyst that belongs to it.
    type Sums = Map<PlayerAccuracyGroupKey, { total: number; n: number }>;
    const newSums = (): Sums => {
      const s: Sums = new Map();
      for (const col of PLAYER_ACCURACY_COLUMNS)
        s.set(col.key, { total: 0, n: 0 });
      return s;
    };
    const finalizeGroups = (
      sums: Sums
    ): Record<PlayerAccuracyGroupKey, number | null> => {
      const groups: Record<PlayerAccuracyGroupKey, number | null> = {
        overall: null,
        passing: null,
        offensive: null,
        defensive: null,
        goalkeeper: null,
        other: null,
      };
      for (const col of PLAYER_ACCURACY_COLUMNS) {
        const s = sums.get(col.key)!;
        groups[col.key] = s.n > 0 ? s.total / s.n : null;
      }
      return groups;
    };

    const byLoc = new Map<
      string,
      {
        location: string;
        checks: number;
        sums: Sums;
        analysts: Map<string, { analyst: string; checks: number; sums: Sums }>;
      }
    >();

    for (const c of scoped) {
      const name = (c.analyst_name || "").trim();
      const loc = locationByName.get(name.toLowerCase()) ?? "Unknown";
      let e = byLoc.get(loc);
      if (!e) {
        e = {
          location: loc,
          checks: 0,
          sums: newSums(),
          analysts: new Map(),
        };
        byLoc.set(loc, e);
      }
      e.checks += 1;

      // Per-analyst bucket within this location.
      const analystKey = name || "—";
      let a = e.analysts.get(analystKey);
      if (!a) {
        a = { analyst: analystKey, checks: 0, sums: newSums() };
        e.analysts.set(analystKey, a);
      }
      a.checks += 1;

      for (const col of PLAYER_ACCURACY_COLUMNS) {
        const v = storedGroupPct(c, col.key);
        if (v == null) continue;
        const s = e.sums.get(col.key)!;
        s.total += v;
        s.n += 1;
        const as = a.sums.get(col.key)!;
        as.total += v;
        as.n += 1;
      }
    }

    const order = [...ANALYST_LOCATIONS, "Unknown"];
    return Array.from(byLoc.values())
      .map((e) => {
        const analystRows = Array.from(e.analysts.values())
          .map((a) => ({
            analyst: a.analyst,
            checks: a.checks,
            groups: finalizeGroups(a.sums),
          }))
          .sort((a, b) => (b.groups.overall ?? -1) - (a.groups.overall ?? -1));
        return {
          location: e.location,
          checks: e.checks,
          analysts: e.analysts.size,
          groups: finalizeGroups(e.sums),
          analystRows,
        };
      })
      .sort(
        (a, b) => order.indexOf(a.location) - order.indexOf(b.location)
      );
  }, [checks, weekFilter, comparisonCategoryFilter, locationByName]);

  // Overall averages across ALL (sport-filtered) checks, for the History
  // summary cards.
  const overallAverages = useMemo(() => averageGroups(checks), [checks]);

  const [expandedFixture, setExpandedFixture] = useState<string | null>(null);
  const [fixtureSearch, setFixtureSearch] = useState("");
  // Both / Home / Away scope for the category accuracy columns.
  const [fixtureScope, setFixtureScope] = useState<TeamScope>("both");

  // The Player Accuracy columns (Overall / Passing / Offensive / Defensive /
  // Goalkeeper) are computed from the raw instance counts for every scope, so
  // we lazily pull XML for the visible checks (batched) and cache it. The
  // light list load doesn't include XML, so fetch it here for all scopes.
  useEffect(() => {
    // Only fetch XML for checks WITHOUT precomputed player_accuracy (older,
    // not-yet-backfilled checks). Backfilled/new checks render from the stored
    // field with no XML fetch at all.
    const missing = checks
      .filter((c) => !c.player_accuracy)
      .map((c) => c.id)
      .filter((id) => !xmlById.has(id));
    if (missing.length === 0) return;

    let cancelled = false;
    setLoadingScopeXml(true);
    getAccuracyChecksXml(missing)
      .then((fetched) => {
        if (cancelled) return;
        setXmlById((prev) => {
          const next = new Map(prev);
          for (const [id, row] of fetched) next.set(id, row);
          return next;
        });
      })
      .catch((err) => console.error("Failed loading Home/Away XML:", err))
      .finally(() => {
        if (!cancelled) setLoadingScopeXml(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fixtureScope, checks, xmlById]);

  // Sort: "analyst" | "date" | a category name.
  const [fixtureSort, setFixtureSort] = useState<{
    key: string;
    dir: "asc" | "desc";
  }>({ key: "date", dir: "asc" });

  function toggleFixtureSort(key: string) {
    setFixtureSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  }

  // Group checks by master fixture, computing the Player Accuracy groups
  // (Overall / Passing / Offensive / Defensive / Goalkeeper) for the active
  // scope from the stored XML — same method as the Accuracy Comparison cards.
  const masterFixtureGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        masterBy: string | null;
        rows: FixtureRow[];
      }
    >();

    for (const c of checks) {
      const key = (c.file_name_master || c.match_label || `check-${c.id}`)
        .trim();
      if (!key) continue;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          label: c.file_name_master || c.match_label || key,
          masterBy: c.master_analyst_name ?? null,
          rows: [],
        };
        map.set(key, g);
      }
      g.rows.push({
        check: c,
        analyst: c.analyst_name,
        date: c.created_at,
        groups: fixtureGroupAccuracy(c, fixtureScope, xmlById.get(c.id)),
      });
    }

    return Array.from(map.values()).sort(
      (a, b) =>
        b.rows.length - a.rows.length || a.label.localeCompare(b.label)
    );
  }, [checks, fixtureScope, xmlById]);

  function sortFixtureRows(rows: FixtureRow[]): FixtureRow[] {
    const { key, dir } = fixtureSort;
    const mult = dir === "asc" ? 1 : -1;
    const val = (r: FixtureRow): number | string | null => {
      if (key === "analyst") return r.analyst.toLowerCase();
      if (key === "date") return new Date(r.date).getTime();
      // Otherwise it's one of the Player Accuracy group keys.
      const g = r.groups?.[key as keyof PlayerAccuracy];
      return groupPct(g);
    };
    return [...rows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * mult;
      }
      return ((av as number) - (bv as number)) * mult;
    });
  }

  const filteredFixtureGroups = useMemo(() => {
    const q = fixtureSearch.trim().toLowerCase();
    if (!q) return masterFixtureGroups;
    return masterFixtureGroups.filter(
      (g) =>
        g.label.toLowerCase().includes(q) ||
        (g.masterBy ?? "").toLowerCase().includes(q)
    );
  }, [masterFixtureGroups, fixtureSearch]);

  // Per-master timeline download (XML or native-schema JSON). The latest
  // master timeline is the `xml_master` stored on any check of this master
  // (propagateMasterCorrection keeps every sibling identical). We grab one
  // check, use its cached XML if present else fetch it, parse to instances
  // and re-serialise in the requested format. Keyed by group key so a single
  // button can show a per-row "…" busy state.
  const [downloadingMaster, setDownloadingMaster] = useState<string | null>(
    null
  );
  async function downloadMasterTimeline(
    group: { key: string; label: string; rows: FixtureRow[] },
    format: "xml" | "json"
  ) {
    const first = group.rows[0]?.check;
    if (!first) return;
    setDownloadingMaster(`${group.key}:${format}`);
    try {
      let raw = xmlById.get(first.id)?.xml_master ?? null;
      if (!raw) {
        // Master-only fetch: the download never uses xml_analyst, so pull just
        // xml_master (halves egress vs getAccuracyChecksXml, which also selects
        // the large analyst blob). Same xml_master string → byte-identical file.
        raw = await getSavedMasterXml(first.id);
      }
      const instances = instancesFromRaw(raw);
      if (instances.length === 0) {
        window.alert(
          "No master timeline is stored for this fixture, so there is nothing to export."
        );
        return;
      }
      const content =
        format === "json"
          ? serializeInstancesToJson(instances)
          : serializeInstances(instances);
      const blob = new Blob([content], {
        type: format === "json" ? "application/json" : "application/xml",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const base =
        (group.label || "master").replace(/\.(xml|json)$/i, "").trim() ||
        "master";
      a.download = `${base}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Master timeline export failed:", e);
      window.alert("Could not export the master timeline. Please try again.");
    } finally {
      setDownloadingMaster(null);
    }
  }

  // The "Saved checks" card — the full list of every saved check, sorted +
  // week-filterable, in a ~10-row scroll region. Rendered in the History tab
  // (all checks) AND, when an analyst is selected, in their detail section.
  // The table columns adapt: the Analyst column is shown only when no single
  // analyst is selected.
  const savedChecksCard = (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
        <h2 className="text-sm font-semibold text-slate-700">Saved checks</h2>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Week</label>
          <select
            value={savedWeekFilter}
            onChange={(e) => setSavedWeekFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
            aria-label="Filter saved checks by week (Friday to Thursday)"
          >
            <option value="all">All weeks</option>
            {savedWeeks.map((w) => (
              <option key={w} value={w}>
                {fridayWeekLabel(w)}
              </option>
            ))}
          </select>
          <label className="text-xs font-medium text-slate-500">Category</label>
          <select
            value={savedCategoryFilter}
            onChange={(e) =>
              setSavedCategoryFilter(e.target.value as CheckCategory | "all")
            }
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
            aria-label="Filter saved checks by category"
          >
            <option value="all">All categories</option>
            {CHECK_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {CHECK_CATEGORY_LABELS[opt]}
              </option>
            ))}
          </select>
          <button
            onClick={exportSavedChecks}
            disabled={sortedSavedChecks.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Export the checks currently shown to CSV"
          >
            <Download size={13} /> Export
            {sortedSavedChecks.length > 0
              ? ` (${sortedSavedChecks.length})`
              : ""}
          </button>
        </div>
      </div>
      {/* Scroll region sized to ~10 rows; header stays pinned.
          Vertical-only scroll — columns are sized to fit width. */}
      <div className="max-h-[460px] overflow-y-auto">
        <table className="w-full table-fixed text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-20 px-2.5 py-2">
                <SortHead
                  label="Check #"
                  col="checkNo"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                  align="left"
                />
              </th>
              <th className="w-24 px-2.5 py-2">
                <SortHead
                  label="Date"
                  col="date"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                  align="left"
                />
              </th>
              <th className="w-40 px-2.5 py-2">
                <SortHead
                  label="Match"
                  col="match"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                  align="left"
                />
              </th>
              {!selectedAnalyst && (
                <th className="w-28 px-2.5 py-2">
                  <SortHead
                    label="Analyst"
                    col="analyst"
                    sort={savedSort}
                    onSort={toggleSavedSort}
                    align="left"
                  />
                </th>
              )}
              <th className="w-28 px-2.5 py-2">
                <SortHead
                  label="Master by"
                  col="masterBy"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                  align="left"
                />
              </th>
              <th className="w-32 px-2.5 py-2">
                <SortHead
                  label="Category"
                  col="category"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                  align="left"
                />
              </th>
              {PLAYER_ACCURACY_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  title={col.label}
                  className="w-14 px-2 py-2 text-right"
                >
                  <SortHead
                    label={col.short}
                    col={col.key}
                    sort={savedSort}
                    onSort={toggleSavedSort}
                  />
                </th>
              ))}
              <th className="w-20 px-2 py-2 text-right">
                <SortHead
                  label="Ex/Mas"
                  col="exactMaster"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                />
              </th>
              <th className="w-16 px-2 py-2 text-center">
                <SortHead
                  label="Disp"
                  col="disputes"
                  sort={savedSort}
                  onSort={toggleSavedSort}
                  align="center"
                />
              </th>
              <th className="w-8 px-1 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {sortedSavedChecks.map((c) => {
              return (
                <React.Fragment key={c.id}>
                  <tr
                    onClick={() => openCheck(c.id)}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                    title="Open full accuracy check in Accuracy Comparison"
                  >
                    <td className="whitespace-nowrap px-2.5 py-2 font-medium tabular-nums text-slate-600">
                      #{c.id}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2 text-slate-600">
                      {formatDate(c.created_at)}
                    </td>
                    <td className="px-2.5 py-2 text-slate-700">
                      <span
                        className="block truncate"
                        title={matchTeamsLabel(c)}
                      >
                        {matchTeamsLabel(c)}
                      </span>
                    </td>
                    {!selectedAnalyst && (
                      <td className="truncate px-2.5 py-2 font-medium text-slate-700">
                        {c.analyst_name || "—"}
                      </td>
                    )}
                    <td className="truncate px-2.5 py-2 text-slate-600">
                      {c.master_analyst_name || "—"}
                    </td>
                    <td
                      className="px-2.5 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <select
                        value={c.category ?? ""}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => handleCategoryChange(c.id, e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-slate-500 focus:outline-none"
                        title="Change this check's category"
                        aria-label="Check category"
                      >
                        <option value="">— Uncategorised</option>
                        {CHECK_CATEGORY_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {CHECK_CATEGORY_LABELS[opt]}
                          </option>
                        ))}
                      </select>
                    </td>
                    {PLAYER_ACCURACY_COLUMNS.map((col) => {
                      const v = storedGroupPct(c, col.key);
                      return (
                        <td
                          key={col.key}
                          className={`px-2 py-2 text-right font-medium tabular-nums ${
                            v != null ? accColor(v) : "text-slate-300"
                          }`}
                        >
                          {v != null ? pct(v) : "—"}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap px-2 py-2 text-right text-slate-600">
                      {c.exact}/{c.master_total}
                    </td>
                    <td className="px-2 py-2 text-center">
                      {(openCounts[c.id] ?? 0) > 0 ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDisputes(c.id);
                          }}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 hover:bg-amber-200"
                          title="Review disputes"
                        >
                          <Flag size={11} /> {openCounts[c.id]}
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDisputes(c.id);
                          }}
                          className="text-xs text-slate-400 hover:text-slate-600"
                          title="View disputes"
                        >
                          —
                        </button>
                      )}
                    </td>
                    <td className="px-1 py-2 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(c.id);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        title="Delete check"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                  {expandedCheck === c.id && (
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td
                        colSpan={selectedAnalyst ? 13 : 14}
                        className="px-4 py-3"
                      >
                        <DisputesPanel
                          disputes={panelDisputes}
                          canResolve={canResolve}
                          onResolve={handleResolve}
                          onOpen={(d) => {
                            const params = new URLSearchParams({
                              check: String(d.check_id),
                            });
                            if (d.code_time != null)
                              params.set("seek", String(d.code_time));
                            if (d.stat) params.set("stat", d.stat);
                            router.push(
                              `/accuracy-compare?${params.toString()}`
                            );
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  async function handleDelete(id: number) {
    if (
      !confirm(
        "Delete this saved accuracy check?\n\nIt will be moved to Deleted checks, where an admin can review or restore it."
      )
    )
      return;
    try {
      await deleteAccuracyCheck(id, user?.username ?? null);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete.");
    }
  }

  // Inline category edit on the Saved checks table. Persists only the category
  // column, then reflects the new value in local state so the row updates
  // without a full reload. "" maps back to NULL (Uncategorised).
  async function handleCategoryChange(id: number, value: string) {
    const next: CheckCategory | null =
      value === "" ? null : (value as CheckCategory);
    try {
      await setAccuracyCheckCategory(id, next);
      setAllChecks((prev) =>
        prev.map((x) => (x.id === id ? { ...x, category: next } : x))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to set category.");
    }
  }

  if (loading) {
    return (
      <div className="min-h-full bg-slate-100 p-8 text-slate-600">
        Loading accuracy checks...
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-[1600px] p-6 lg:p-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
              <History size={26} /> Accuracy History
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Accuracy checks accumulated over the season. Track each analyst&apos;s
              trend and see who has completed the most master checks.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* View tabs */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              <button
                onClick={() => setView("history")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  view === "history"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                History
              </button>
              <button
                onClick={() => setView("analysts")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  view === "analysts"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                All analysts
              </button>
              <button
                onClick={() => setView("locations")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  view === "locations"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                By location
              </button>
            </div>
            <SportToggle value={sportFilter} onChange={setSportFilter} />
            {canResolve && (
              <button
                onClick={() => setShowDeleted(true)}
                title="Review and restore deleted checks"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
              >
                <Trash2 size={14} /> Deleted checks
              </button>
            )}
            <Link
              href="/accuracy-compare"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
            >
              New comparison
            </Link>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {allChecks.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500">
            No accuracy checks saved yet. Run a comparison and save it to build
            history here.
          </div>
        ) : checks.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500">
            No {sportFilter === "afl" ? "Aussie Rules" : "Football"} checks
            saved yet.
          </div>
        ) : view === "analysts" ? (
          <AnalystComparisonTable
            rows={sortedComparison}
            sort={comparisonSort}
            onSort={toggleComparisonSort}
            weeks={availableWeeks}
            weekFilter={weekFilter}
            onWeekChange={setWeekFilter}
            categoryFilter={comparisonCategoryFilter}
            onCategoryChange={setComparisonCategoryFilter}
            analystOptions={analystSummaries.map((s) => ({
              name: s.analystName,
              checks: s.checks,
            }))}
            totalChecks={checks.length}
            selectedAnalyst={selectedAnalyst}
            onAnalystChange={setSelectedAnalyst}
            trendData={trendData}
            trendGroup={trendGroup}
            onTrendGroupChange={setTrendGroup}
          />
        ) : view === "locations" ? (
          <LocationComparisonTable
            rows={locationComparison}
            weeks={availableWeeks}
            weekFilter={weekFilter}
            onWeekChange={setWeekFilter}
            categoryFilter={comparisonCategoryFilter}
            onCategoryChange={setComparisonCategoryFilter}
          />
        ) : (
          <div className="space-y-6">
            {/* Overall averages across all checks */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Overall averages{" "}
                <span className="font-normal normal-case text-slate-400">
                  (across {checks.length} check
                  {checks.length === 1 ? "" : "s"})
                </span>
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {PLAYER_ACCURACY_COLUMNS.map((col) => {
                  const v = overallAverages[col.key];
                  return (
                    <Stat
                      key={col.key}
                      label={col.label}
                      value={v != null ? pct(v) : "—"}
                      color={v != null ? accColor(v) : undefined}
                    />
                  );
                })}
              </div>
            </div>

            {/* Master-consistency warning (admins): fixtures whose sibling
                checks were graded against different master versions, so their
                master totals differ. Click a fixture to inspect. */}
            {canResolve && masterTotalMismatches.length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                  <Flag size={15} /> Master totals differ for{" "}
                  {masterTotalMismatches.length} fixture
                  {masterTotalMismatches.length === 1 ? "" : "s"}
                </p>
                <p className="mt-0.5 text-xs text-amber-700">
                  These fixtures were graded against slightly different master
                  files, so the master total isn&apos;t identical across
                  analysts. Click one to inspect each check&apos;s master.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {masterTotalMismatches.map((m) => (
                    <button
                      key={m.file}
                      onClick={() => setMasterDiagFile(m.file)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                      title={m.file}
                    >
                      {m.label}
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold">
                        {m.min}–{m.max} · {m.checks} checks
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Full list of every saved check. Shown here in the History tab
                whenever no single analyst is selected; when one IS selected the
                selected-analyst detail below renders it instead (so it's not
                duplicated). */}
            {!selectedAnalyst && savedChecksCard}
          </div>
        )}

        {/* Selected-analyst detail (recommendations + their saved checks).
            Rendered outside the view switch so it appears in whichever tab is
            active when an analyst is picked — the picker lives in the "All
            analysts" tab, so this shows there. */}
        {selectedAnalyst && (
          <div className="mt-6 space-y-6">
            {analystRecommendations && (
              <RecommendationsPanel
                data={analystRecommendations}
                threshold={PROBLEM_THRESHOLD}
                analyst={selectedAnalyst}
                onOpenCheck={openCheck}
              />
            )}

            {/* Saved checks — full width */}
            <div>{savedChecksCard}</div>
          </div>
        )}

        {/* BY MASTER FIXTURE — every check grouped by the master file, with
            each analyst's overall / home / away accuracy. */}
        {checks.length > 0 && masterFixtureGroups.length > 0 && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
              <h2 className="text-sm font-semibold text-slate-700">
                Checks by master fixture
              </h2>
              <div className="flex items-center gap-3">
                {/* Both / Home / Away scope for the category % columns */}
                <div className="flex items-center gap-1">
                  {(
                    [
                      ["both", "Both teams"],
                      ["home", "Home"],
                      ["away", "Away"],
                    ] as [TeamScope, string][]
                  ).map(([s, label]) => (
                    <button
                      key={s}
                      onClick={() => setFixtureScope(s)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        fixtureScope === s
                          ? "bg-slate-900 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {loadingScopeXml && (
                    <span className="ml-1 text-xs text-slate-400">
                      Loading…
                    </span>
                  )}
                </div>
                <input
                  value={fixtureSearch}
                  onChange={(e) => setFixtureSearch(e.target.value)}
                  placeholder="Search fixture or master…"
                  className="w-56 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-500"
                />
                {canResolve && (
                  <>
                    <button
                      onClick={handleBackfill}
                      disabled={backfilling}
                      title="Precompute & store Player Accuracy for older checks so this table loads instantly"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                    >
                      {backfilling ? "Backfilling…" : "Backfill accuracy"}
                    </button>
                    <button
                      onClick={handleRecomputeAll}
                      disabled={backfilling}
                      title="Recompute Player Accuracy for ALL checks (use after the accuracy grouping changes)"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                    >
                      {backfilling ? "Working…" : "Recompute all"}
                    </button>
                  </>
                )}
              </div>
              {backfillMsg && (
                <span className="w-full text-xs text-slate-500">
                  {backfillMsg}
                </span>
              )}
            </div>

            {/* Scrollable list — ~5 fixture rows visible, the rest scroll. */}
            <div className="max-h-[340px] divide-y divide-slate-100 overflow-y-auto">
              {filteredFixtureGroups.map((g) => {
                const isOpen = expandedFixture === g.key;
                // The game video for this master fixture — siblings share it,
                // so take the first check that has one.
                const videoUrl =
                  g.rows
                    .map((r) => (r.check.video_url ?? "").trim())
                    .find((u) => u.length > 0) ?? "";
                return (
                  <div key={g.key}>
                    <div className="flex w-full items-center gap-3 px-5 py-3 hover:bg-slate-50">
                      <button
                        onClick={() =>
                          setExpandedFixture(isOpen ? null : g.key)
                        }
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span className="shrink-0 text-slate-400">
                          {isOpen ? "▾" : "▸"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-800">
                            {g.label}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {g.masterBy ? `Master by ${g.masterBy} · ` : ""}
                            {g.rows.length} check
                            {g.rows.length === 1 ? "" : "s"}
                          </p>
                        </div>
                      </button>
                      {/* View video + export the latest master timeline. */}
                      <div className="flex shrink-0 items-center gap-1.5">
                        {videoUrl ? (
                          <a
                            href={videoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open the game video in a new tab"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <Film size={13} /> Video
                          </a>
                        ) : (
                          <span
                            title="No game video saved for this fixture"
                            className="inline-flex cursor-default items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-300"
                          >
                            <Film size={13} /> Video
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadMasterTimeline(g, "xml");
                          }}
                          disabled={downloadingMaster === `${g.key}:xml`}
                          title="Download the latest master timeline as XML"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Download size={13} />
                          {downloadingMaster === `${g.key}:xml`
                            ? "…"
                            : "XML"}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadMasterTimeline(g, "json");
                          }}
                          disabled={downloadingMaster === `${g.key}:json`}
                          title="Download the latest master timeline as JSON"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Download size={13} />
                          {downloadingMaster === `${g.key}:json`
                            ? "…"
                            : "JSON"}
                        </button>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="overflow-x-auto bg-slate-50/60 px-5 pb-4">
                        <table className="min-w-full text-sm">
                          <thead className="text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="py-2 pr-4 text-left">
                                <SortHead
                                  label="Analyst"
                                  col="analyst"
                                  sort={fixtureSort}
                                  onSort={toggleFixtureSort}
                                  align="left"
                                />
                              </th>
                              <th className="py-2 pr-4 text-left">
                                <SortHead
                                  label="Date"
                                  col="date"
                                  sort={fixtureSort}
                                  onSort={toggleFixtureSort}
                                  align="left"
                                />
                              </th>
                              {PLAYER_ACCURACY_COLUMNS.map((col, idx) => (
                                <th
                                  key={col.key}
                                  className={`py-2 px-3 text-center ${
                                    idx === 0
                                      ? "border-l border-slate-200"
                                      : ""
                                  }`}
                                >
                                  <SortHead
                                    label={col.label}
                                    col={col.key}
                                    sort={fixtureSort}
                                    onSort={toggleFixtureSort}
                                    align="center"
                                  />
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sortFixtureRows(g.rows).map((r) => (
                              <tr
                                key={r.check.id}
                                onClick={() => openCheck(r.check.id)}
                                className="cursor-pointer border-t border-slate-200 hover:bg-white"
                                title="Open full accuracy check"
                              >
                                <td className="py-2 pr-4 font-medium text-slate-800">
                                  {r.analyst}
                                </td>
                                <td className="whitespace-nowrap py-2 pr-4 text-slate-600">
                                  {formatDate(r.date)}
                                </td>
                                {PLAYER_ACCURACY_COLUMNS.map((col, idx) => {
                                  const grp =
                                    r.groups?.[col.key as keyof PlayerAccuracy];
                                  const v = groupPct(grp);
                                  return (
                                    <td
                                      key={col.key}
                                      title={
                                        grp
                                          ? `${grp.exact}/${grp.master} exact`
                                          : undefined
                                      }
                                      className={`py-2 px-3 text-center tabular-nums ${
                                        idx === 0
                                          ? "border-l border-slate-200 font-semibold"
                                          : "font-medium"
                                      } ${
                                        v != null
                                          ? accColor(v)
                                          : "text-slate-300"
                                      }`}
                                    >
                                      {v != null ? pct(v) : "—"}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-800">
                              <td className="py-2 pr-4" colSpan={2}>
                                Average ({g.rows.length} check
                                {g.rows.length === 1 ? "" : "s"})
                              </td>
                              {PLAYER_ACCURACY_COLUMNS.map((col, idx) => {
                                // Average the visible per-row group %s (honours
                                // the active Both/Home/Away scope).
                                let total = 0;
                                let n = 0;
                                for (const r of g.rows) {
                                  const grp =
                                    r.groups?.[col.key as keyof PlayerAccuracy];
                                  // Exclude 0/0 groups (no data) from the avg.
                                  const v = groupPct(grp);
                                  if (v != null) {
                                    total += v;
                                    n += 1;
                                  }
                                }
                                const v = n > 0 ? total / n : null;
                                return (
                                  <td
                                    key={col.key}
                                    className={`py-2 px-3 text-center tabular-nums ${
                                      idx === 0
                                        ? "border-l border-slate-200"
                                        : ""
                                    } ${
                                      v != null
                                        ? accColor(v)
                                        : "text-slate-300"
                                    }`}
                                  >
                                    {v != null ? pct(v) : "—"}
                                  </td>
                                );
                              })}
                            </tr>
                          </tfoot>
                        </table>
                        {g.rows.every((r) => r.groups == null) && (
                          <p className="pt-2 text-xs text-slate-400">
                            {loadingScopeXml
                              ? "Loading player accuracy…"
                              : "Player accuracy needs the saved XML; older checks may not have it."}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {filteredFixtureGroups.length === 0 && (
                <p className="p-6 text-center text-sm text-slate-400">
                  No fixtures match your search.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {masterDiagFile && (
        <MasterConsistencyModal
          fileNameMaster={masterDiagFile}
          onClose={() => setMasterDiagFile(null)}
          onOpenCheck={(id) => {
            setMasterDiagFile(null);
            openCheck(id);
          }}
          onFixed={() => load()}
        />
      )}

      {showDeleted && (
        <DeletedChecksModal
          onClose={() => setShowDeleted(false)}
          onOpenCheck={(id) => {
            setShowDeleted(false);
            openCheck(id);
          }}
          onRestored={() => load()}
        />
      )}
    </div>
  );
}

// Modal listing soft-deleted checks (admin only) so they can be reviewed,
// re-opened, or restored. Each row can expand to show the check's disputes.
function DeletedChecksModal({
  onClose,
  onOpenCheck,
  onRestored,
}: {
  onClose: () => void;
  onOpenCheck: (checkId: number) => void;
  /** Called after a check is restored, so the main page reloads. */
  onRestored: () => void;
}) {
  const [rows, setRows] = useState<AccuracyCheckMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [disputesByCheck, setDisputesByCheck] = useState<
    Record<number, Dispute[]>
  >({});

  async function reload() {
    try {
      setRows(await getDeletedAccuracyChecksMeta());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
      setRows([]);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function toggleExpand(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!disputesByCheck[id]) {
      try {
        const d = await getDisputesForCheck(id);
        setDisputesByCheck((cur) => ({ ...cur, [id]: d }));
      } catch {
        setDisputesByCheck((cur) => ({ ...cur, [id]: [] }));
      }
    }
  }

  async function handleRestore(id: number) {
    setBusyId(id);
    try {
      await restoreAccuracyCheck(id);
      await reload();
      onRestored();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to restore.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-800">
            <Trash2 size={18} /> Deleted checks
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {rows == null ? (
          <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            No deleted checks. Anything deleted from the history will appear
            here for review or restore.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Match</th>
                  <th className="px-3 py-2">Analyst</th>
                  <th className="px-3 py-2">Deleted</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const disputes = disputesByCheck[c.id];
                  const isOpen = expanded === c.id;
                  return (
                    <React.Fragment key={c.id}>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium text-slate-700">
                          {matchTeamsLabel(c)}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {c.analyst_name || "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                          {c.deleted_at ? formatDate(c.deleted_at) : "—"}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {c.deleted_by || "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => toggleExpand(c.id)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"
                            >
                              {isOpen ? (
                                <ChevronDown size={13} />
                              ) : (
                                <ChevronRight size={13} />
                              )}
                              Disputes
                            </button>
                            <button
                              onClick={() => onOpenCheck(c.id)}
                              className="text-xs font-medium text-sky-600 hover:text-sky-800"
                            >
                              Open
                            </button>
                            <button
                              onClick={() => handleRestore(c.id)}
                              disabled={busyId === c.id}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                            >
                              <RotateCcw size={12} />
                              {busyId === c.id ? "Restoring…" : "Restore"}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={5} className="px-4 py-3">
                            {disputes == null ? (
                              <p className="text-xs text-slate-400">
                                Loading disputes…
                              </p>
                            ) : disputes.length === 0 ? (
                              <p className="text-xs text-slate-400">
                                No disputes were raised on this check.
                              </p>
                            ) : (
                              <ul className="space-y-1">
                                {disputes.map((d) => (
                                  <li
                                    key={d.id}
                                    className="flex flex-wrap items-center gap-2 text-xs text-slate-600"
                                  >
                                    <span
                                      className={`rounded px-1.5 py-0.5 font-semibold ${
                                        d.status === "open"
                                          ? "bg-amber-100 text-amber-700"
                                          : d.status === "confirmed"
                                            ? "bg-emerald-100 text-emerald-700"
                                            : "bg-slate-200 text-slate-600"
                                      }`}
                                    >
                                      {d.status}
                                    </span>
                                    <span className="font-medium text-slate-700">
                                      {d.stat || "—"}
                                    </span>
                                    <span className="text-slate-500">
                                      {d.side} · {d.player || "—"}
                                      {d.team ? ` · ${d.team}` : ""}
                                    </span>
                                    {d.reason && (
                                      <span className="italic text-slate-400">
                                        “{d.reason}”
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          Deleted checks are hidden from all history, leaderboards and dispute
          views but kept here so they can be restored. Restoring brings the
          check (and its disputes) back into the active data.
        </p>
      </div>
    </div>
  );
}

// Modal that inspects every check sharing a master file, showing each one's
// stored vs parsed master total and whether the raw master files are
// byte-identical — so an admin can see which check diverged and by how much.
function MasterConsistencyModal({
  fileNameMaster,
  onClose,
  onOpenCheck,
  onFixed,
}: {
  fileNameMaster: string;
  onClose: () => void;
  onOpenCheck: (checkId: number) => void;
  /** Called after stale stored totals are corrected, so the page can reload. */
  onFixed: () => void;
}) {
  const [report, setReport] = useState<MasterConsistencyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixMsg, setFixMsg] = useState<string | null>(null);

  async function handleFixStale() {
    if (!report || report.staleTotalCheckIds.length === 0) return;
    setFixing(true);
    setFixMsg(null);
    try {
      const res = await fixStaleMasterTotals(report.staleTotalCheckIds);
      setFixMsg(`Corrected ${res.fixed} stored total(s).`);
      onFixed();
      // Re-run the diagnostic so the modal reflects the fix.
      const fresh = await diagnoseMasterConsistency(fileNameMaster);
      setReport(fresh);
    } catch (e) {
      setFixMsg(e instanceof Error ? e.message : "Fix failed.");
    } finally {
      setFixing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // State is reset via the async callbacks below (not synchronously here) so
    // the effect only kicks off external work.
    diagnoseMasterConsistency(fileNameMaster)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileNameMaster]);

  // Assign each distinct xml hash a short letter (A, B, C…) so identical vs
  // different master files are easy to compare at a glance.
  const hashLabels = useMemo(() => {
    const map = new Map<string, string>();
    let n = 0;
    for (const c of report?.checks ?? []) {
      if (c.xmlHash && !map.has(c.xmlHash)) {
        map.set(c.xmlHash, String.fromCharCode(65 + n));
        n += 1;
      }
    }
    return map;
  }, [report]);

  // Letter of the reference (majority) master version.
  const referenceLetter = useMemo(() => {
    const ref = report?.checks.find((c) => c.isReference);
    return ref?.xmlHash ? hashLabels.get(ref.xmlHash) ?? "A" : "A";
  }, [report, hashLabels]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800">
              <Flag size={16} className="text-amber-600" /> Master consistency
            </h2>
            <p className="mt-0.5 break-all text-xs text-slate-400">
              {fileNameMaster}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Inspecting each check&apos;s master…
          </p>
        ) : error ? (
          <p className="py-8 text-center text-sm text-red-500">{error}</p>
        ) : report ? (
          <>
            <div
              className={`mb-3 rounded-lg px-3 py-2 text-xs font-medium ${
                report.consistent
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-800"
              }`}
            >
              {report.consistent
                ? report.staleTotalCheckIds.length > 0
                  ? "The master files are identical — but some stored totals are out of date. The history difference is stale data, not a real master difference."
                  : "All checks parse to the same master total."
                : `Master totals differ: ${report.distinctCounts.join(
                    ", "
                  )} across ${report.checks.length} checks. ` +
                  `${report.distinctHashes} distinct master file version${
                    report.distinctHashes === 1 ? "" : "s"
                  } found.`}
            </div>

            {report.staleTotalCheckIds.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-xs text-slate-600">
                  {report.staleTotalCheckIds.length} check
                  {report.staleTotalCheckIds.length === 1 ? "" : "s"} have a
                  stored total that doesn&apos;t match their master file.
                </span>
                <button
                  onClick={handleFixStale}
                  disabled={fixing}
                  className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
                >
                  {fixing ? "Fixing…" : "Fix stored totals"}
                </button>
                {fixMsg && (
                  <span className="text-xs text-slate-500">{fixMsg}</span>
                )}
              </div>
            )}

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-2">Analyst</th>
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2 text-right">Master</th>
                  <th className="py-2 pr-2 text-center">File</th>
                  <th className="py-2 pr-2 text-right">Diff</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {report.checks.map((c) => (
                  <MasterDiffRow
                    key={c.checkId}
                    check={c}
                    hashLabel={c.xmlHash ? hashLabels.get(c.xmlHash) : "—"}
                    onOpenCheck={onOpenCheck}
                  />
                ))}
              </tbody>
            </table>

            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              The most common master version is the{" "}
              <span className="font-semibold text-slate-500">reference</span>{" "}
              (File {referenceLetter}). Expand a row to see, per stat, how many
              this master has vs the reference. The{" "}
              <span className="font-semibold text-slate-500">Diff</span> column
              sums to the total difference. A re-graded outcome shows as a pair
              (e.g. −1 &quot;Short Passes Successful&quot;, +1 &quot;… Unsuccessful&quot;)
              that nets to zero on the total but explains accuracy differences.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

// One row in the master-consistency table. Expands to reveal the exact
// instances this check's master adds/removes vs the reference version.
function MasterDiffRow({
  check: c,
  hashLabel,
  onOpenCheck,
}: {
  check: MasterSiblingCheck;
  hashLabel: string | undefined;
  onOpenCheck: (checkId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const diffs = c.statDiffs;

  return (
    <>
      <tr className="border-b border-slate-100 last:border-0">
        <td className="py-2 pr-2 font-medium text-slate-700">
          {c.analystName || "—"}
          {c.isReference && (
            <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">
              REF
            </span>
          )}
        </td>
        <td className="whitespace-nowrap py-2 pr-2 text-slate-500">
          {formatDate(c.createdAt)}
        </td>
        <td className="py-2 pr-2 text-right tabular-nums text-slate-600">
          {c.parsedMasterTotal ?? c.storedMasterTotal}
          {c.parsedMasterTotal != null &&
            c.parsedMasterTotal !== c.storedMasterTotal && (
              <span
                className="ml-1 text-[10px] font-semibold text-amber-600"
                title={`Stored total is ${c.storedMasterTotal}; the master file actually has ${c.parsedMasterTotal}. Stored value is stale.`}
              >
                (stored {c.storedMasterTotal})
              </span>
            )}
        </td>
        <td className="py-2 pr-2 text-center">
          <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">
            {hashLabel ?? "—"}
          </span>
        </td>
        <td className="py-2 pr-2 text-right">
          {c.isReference ? (
            <span className="text-xs text-slate-400">reference</span>
          ) : diffs.length === 0 ? (
            <span className="text-xs font-medium text-emerald-600">
              identical
            </span>
          ) : (
            <button
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold hover:opacity-80"
              title="Show which stats differ vs the reference master"
            >
              <span
                className={
                  c.totalDelta > 0
                    ? "text-emerald-600"
                    : c.totalDelta < 0
                      ? "text-red-600"
                      : "text-slate-500"
                }
              >
                {c.totalDelta > 0 ? `+${c.totalDelta}` : c.totalDelta} total
              </span>
              <span className="text-slate-400">
                · {diffs.length} stat{diffs.length === 1 ? "" : "s"}
              </span>
              {open ? (
                <ChevronDown size={12} className="text-slate-400" />
              ) : (
                <ChevronRight size={12} className="text-slate-400" />
              )}
            </button>
          )}
        </td>
        <td className="py-2 text-right">
          <button
            onClick={() => onOpenCheck(c.checkId)}
            className="text-xs font-medium text-sky-600 hover:text-sky-800"
          >
            Open
          </button>
        </td>
      </tr>
      {open && diffs.length > 0 && (
        <tr className="border-b border-slate-100 bg-slate-50/70">
          <td colSpan={6} className="px-3 py-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Stat counts vs reference — this master&apos;s count, the
              reference&apos;s, and the difference
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 pr-2 font-medium">Stat</th>
                  <th className="py-1 px-2 text-right font-medium">This</th>
                  <th className="py-1 px-2 text-right font-medium">Ref</th>
                  <th className="py-1 pl-2 text-right font-medium">Diff</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d) => (
                  <tr key={d.stat} className="border-t border-slate-100">
                    <td className="py-1 pr-2 text-slate-700">{d.stat}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-slate-600">
                      {d.thisCount}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums text-slate-500">
                      {d.referenceCount}
                    </td>
                    <td
                      className={`py-1 pl-2 text-right font-semibold tabular-nums ${
                        d.delta > 0 ? "text-emerald-600" : "text-red-600"
                      }`}
                    >
                      {d.delta > 0 ? `+${d.delta}` : d.delta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

// Full detail of a saved accuracy check: summary cards + category and
// team breakdowns (everything that was stored at save time).
function CheckDetailModal({
  check,
  onClose,
}: {
  check: AccuracyCheckMeta;
  onClose: () => void;
}) {
  const cards: { label: string; value: string; color?: string }[] = [
    { label: "Accuracy", value: pct(check.accuracy), color: accColor(check.accuracy) },
    { label: "Exact", value: `${check.exact}`, color: "text-emerald-600" },
    { label: "Wrong stat", value: `${check.wrong_stat}`, color: "text-amber-600" },
    { label: "Wrong player", value: `${check.wrong_player}`, color: "text-orange-600" },
    { label: "Wrong team", value: `${check.wrong_team}`, color: "text-red-600" },
    { label: "Missed", value: `${check.missed}`, color: "text-slate-600" },
    { label: "Extra", value: `${check.extra}`, color: "text-purple-600" },
    { label: "Master total", value: `${check.master_total}` },
    { label: "Analyst total", value: `${check.analyst_total}` },
    { label: "Avg time drift", value: `${(check.avg_time_drift ?? 0).toFixed(1)}s` },
  ];

  const barColor = (a: number) =>
    a >= 0.9
      ? "bg-emerald-500"
      : a >= 0.8
        ? "bg-yellow-500"
        : a >= 0.7
          ? "bg-orange-500"
          : "bg-red-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-6 w-full max-w-4xl rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {check.match_label || "Accuracy check"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {check.analyst_name}
              {check.master_analyst_name
                ? ` · master by ${check.master_analyst_name}`
                : ""}
              {" · "}
              {formatDate(check.created_at)}
              {check.tolerance != null ? ` · ±${check.tolerance}s tolerance` : ""}
            </p>
            {(check.file_name_master || check.file_name_analyst) && (
              <p className="mt-1 text-xs text-slate-400">
                {check.file_name_master ?? "?"} vs{" "}
                {check.file_name_analyst ?? "?"}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-5">
          {cards.map((c) => (
            <Stat key={c.label} label={c.label} value={c.value} color={c.color} />
          ))}
        </div>

        {/* Category breakdown */}
        {check.category_breakdown && check.category_breakdown.length > 0 && (
          <div className="border-t border-slate-100 p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">
              Accuracy by stat category
            </h3>
            <div className="space-y-1">
              {check.category_breakdown.map((c) => (
                <div
                  key={c.category}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5"
                >
                  <span className="w-40 shrink-0 truncate text-sm text-slate-600">
                    {c.category}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${barColor(c.accuracy)}`}
                      style={{ width: `${c.accuracy * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs text-slate-500">
                    {(c.accuracy * 100).toFixed(0)}% ({c.exact}/{c.total})
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Team breakdown */}
        {check.team_breakdown && check.team_breakdown.length > 0 && (
          <div className="border-t border-slate-100 p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">
              Accuracy by team
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {check.team_breakdown
                .filter((t) => t.masterTotal > 0)
                .map((t) => (
                  <div
                    key={t.team}
                    className="rounded-xl border border-slate-200 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-bold text-slate-900">
                        {t.team}
                      </span>
                      <span className={`text-sm font-bold ${accColor(t.accuracy)}`}>
                        {(t.accuracy * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${barColor(t.accuracy)}`}
                        style={{ width: `${t.accuracy * 100}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                      <span>Exact {t.exact}</span>
                      <span>Wrong stat {t.wrongStat}</span>
                      <span>Wrong player {t.wrongPlayer}</span>
                      <span>Wrong team {t.wrongTeam}</span>
                      <span>Missed {t.missed}</span>
                      <span>Extra {t.extra}</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Clickable sort header for the by-master-fixture table.
function SortHead({
  label,
  col,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  col: string;
  sort: { key: string; dir: "asc" | "desc" };
  onSort: (key: string) => void;
  align?: "left" | "right" | "center";
}) {
  const active = sort.key === col;
  const justify =
    align === "right"
      ? "justify-end"
      : align === "center"
        ? "justify-center"
        : "justify-start";
  return (
    <button
      onClick={() => onSort(col)}
      className={`inline-flex w-full items-center gap-0.5 whitespace-nowrap font-semibold uppercase transition hover:text-slate-800 ${
        active ? "text-slate-800" : "text-slate-500"
      } ${justify}`}
    >
      {label}
      <span className="text-[9px]">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </button>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-bold ${color ?? "text-slate-800"}`}>
        {value}
      </div>
    </div>
  );
}

// ---- Recommendations (rule-based problem-area analysis) ----------------
type RecStat = {
  label: string;
  group: string;
  master: number;
  exact: number;
  pct: number;
  worst: {
    checkId: number;
    label: string;
    date: string;
    pct: number;
    exact: number;
    master: number;
  } | null;
};
type RecData = { stats: RecStat[] };

// Panel under the trend chart: the analyst's top 3–5 stats to work on, each
// with its overall accuracy and the specific check they struggled with most.
function RecommendationsPanel({
  data,
  threshold,
  analyst,
  onOpenCheck,
}: {
  data: RecData;
  threshold: number;
  analyst: string;
  onOpenCheck: (id: number) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Sparkles size={16} className="text-violet-500" /> Recommendations
      </h2>
      <p className="mb-4 text-xs text-slate-400">
        Top stats {analyst} should focus on (below{" "}
        {(threshold * 100).toFixed(0)}%), averaged across their checks.
      </p>

      {data.stats.length === 0 ? (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-xs font-medium text-emerald-700">
          No problem areas below {(threshold * 100).toFixed(0)}%. Solid across
          the board.
        </div>
      ) : (
        <ol className="space-y-3">
          {data.stats.map((s, i) => (
            <li
              key={s.label}
              className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3"
            >
              {/* Stat + group */}
              <span className="shrink-0 text-sm font-semibold text-slate-800">
                {i + 1}. {s.label}
                <span className="ml-1.5 text-xs font-normal text-slate-400">
                  {s.group}
                </span>
              </span>

              {/* Worst check — same line */}
              {s.worst && (
                <button
                  onClick={() => onOpenCheck(s.worst!.checkId)}
                  className="min-w-0 flex-1 truncate text-left text-xs text-slate-500 hover:text-slate-700"
                  title="Open this check"
                >
                  Struggled most in{" "}
                  <span className="font-medium text-slate-700 underline decoration-dotted">
                    {s.worst.label}
                  </span>{" "}
                  <span className="text-slate-400">
                    ({formatDate(s.worst.date)})
                  </span>{" "}
                  —{" "}
                  <span className={`font-semibold ${accColor(s.worst.pct)}`}>
                    {(s.worst.pct * 100).toFixed(0)}%
                  </span>{" "}
                  ({s.worst.exact}/{s.worst.master})
                </button>
              )}

              {/* Overall accuracy — right aligned */}
              <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Total
                </span>
                <span
                  className={`text-sm font-bold tabular-nums ${accColor(
                    s.pct
                  )}`}
                >
                  {(s.pct * 100).toFixed(1)}%
                  <span className="ml-1 text-xs font-normal text-slate-400">
                    ({s.exact}/{s.master})
                  </span>
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// All-analyst comparison table: every analyst's average Player Accuracy per
// group, sortable, with a calendar-week selector (default = whole season).
type ComparisonRowData = {
  analyst: string;
  location: string;
  checks: number;
  groups: Record<PlayerAccuracyGroupKey, number | null>;
};

function AnalystComparisonTable({
  rows,
  sort,
  onSort,
  weeks,
  weekFilter,
  onWeekChange,
  categoryFilter,
  onCategoryChange,
  analystOptions,
  totalChecks,
  selectedAnalyst,
  onAnalystChange,
  trendData,
  trendGroup,
  onTrendGroupChange,
}: {
  rows: ComparisonRowData[];
  sort: { key: string; dir: "asc" | "desc" };
  onSort: (key: string) => void;
  weeks: string[];
  weekFilter: string;
  onWeekChange: (w: string) => void;
  /** Shared comparison category filter ("all" = every category). */
  categoryFilter: CheckCategory | "all";
  onCategoryChange: (v: CheckCategory | "all") => void;
  /** Analyst names + check counts for the picker. */
  analystOptions: { name: string; checks: number }[];
  /** Total checks across all analysts (for the "All analysts" option). */
  totalChecks: number;
  /** Currently selected analyst ("" = all). */
  selectedAnalyst: string;
  onAnalystChange: (name: string) => void;
  /** Accuracy-trend points for the selected analyst + group. */
  trendData: TrendPoint[];
  /** Which Player Accuracy group the trend plots. */
  trendGroup: PlayerAccuracyGroupKey;
  onTrendGroupChange: (key: PlayerAccuracyGroupKey) => void;
}) {
  // When an analyst is picked, narrow the table to just their row.
  const visibleRows = selectedAnalyst
    ? rows.filter(
        (r) =>
          r.analyst.trim().toLowerCase() ===
          selectedAnalyst.trim().toLowerCase()
      )
    : rows;

  // Export the rows CURRENTLY SHOWING (respecting the analyst + week filters
  // and the active sort) to a CSV download. Percentages are plain numbers
  // (e.g. 92.3) so they open cleanly in Excel/Sheets.
  function exportComparison() {
    const pctNum = (v: number | null) =>
      v == null ? "" : (v * 100).toFixed(1);
    const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

    const header = [
      "Analyst",
      "Location",
      "Checks",
      ...PLAYER_ACCURACY_COLUMNS.map((c) => `${c.label} %`),
    ];
    const lines = visibleRows.map((r) =>
      [
        r.analyst,
        r.location,
        String(r.checks),
        ...PLAYER_ACCURACY_COLUMNS.map((col) => pctNum(r.groups[col.key])),
      ]
        .map(csvCell)
        .join(",")
    );

    const csv = [header.map(csvCell).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const scope = weekFilter === "all" ? "all-weeks" : `week-${weekFilter}`;
    const who = selectedAnalyst
      ? selectedAnalyst.replace(/\s+/g, "-").toLowerCase()
      : "all-analysts";
    a.href = url;
    a.download = `analyst-accuracy_${who}_${scope}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            All analysts — average player accuracy
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Averaged across each analyst&apos;s checks
            {weekFilter === "all" ? " (whole season)" : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Analyst</label>
          <select
            value={selectedAnalyst}
            onChange={(e) => onAnalystChange(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
          >
            <option value="">All analysts ({totalChecks} check{totalChecks === 1 ? "" : "s"})</option>
            {analystOptions.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name} ({o.checks} check{o.checks === 1 ? "" : "s"})
              </option>
            ))}
          </select>
          <label className="text-xs font-medium text-slate-500">Week</label>
          <select
            value={weekFilter}
            onChange={(e) => onWeekChange(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
          >
            <option value="all">All weeks</option>
            {weeks.map((w) => (
              <option key={w} value={w}>
                {fridayWeekLabel(w)}
              </option>
            ))}
          </select>
          <label className="text-xs font-medium text-slate-500">Category</label>
          <select
            value={categoryFilter}
            onChange={(e) =>
              onCategoryChange(e.target.value as CheckCategory | "all")
            }
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
            aria-label="Filter comparison by category"
          >
            <option value="all">All categories</option>
            {CHECK_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {CHECK_CATEGORY_LABELS[opt]}
              </option>
            ))}
          </select>
          <button
            onClick={exportComparison}
            disabled={visibleRows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Export the analysts currently shown to CSV"
          >
            <Download size={13} /> Export
            {visibleRows.length > 0 ? ` (${visibleRows.length})` : ""}
          </button>
        </div>
      </div>

      <div className="max-h-[600px] overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-2.5 py-2">
                <SortHead
                  label="Analyst"
                  col="analyst"
                  sort={sort}
                  onSort={onSort}
                  align="left"
                />
              </th>
              <th className="px-2.5 py-2">
                <SortHead
                  label="Location"
                  col="location"
                  sort={sort}
                  onSort={onSort}
                  align="left"
                />
              </th>
              <th className="px-2.5 py-2 text-right">
                <SortHead
                  label="Checks"
                  col="checks"
                  sort={sort}
                  onSort={onSort}
                />
              </th>
              {PLAYER_ACCURACY_COLUMNS.map((col) => (
                <th key={col.key} className="px-2.5 py-2 text-right">
                  <SortHead
                    label={col.label}
                    col={col.key}
                    sort={sort}
                    onSort={onSort}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr
                key={r.analyst}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="whitespace-nowrap px-2.5 py-2 font-medium text-slate-800">
                  <button
                    type="button"
                    onClick={() => onAnalystChange(r.analyst)}
                    className="text-left font-medium text-sky-700 hover:text-sky-900 hover:underline"
                    title={`View all of ${r.analyst}'s checks`}
                  >
                    {r.analyst}
                  </button>
                </td>
                <td className="whitespace-nowrap px-2.5 py-2 text-slate-600">
                  {r.location}
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums text-slate-600">
                  {r.checks}
                </td>
                {PLAYER_ACCURACY_COLUMNS.map((col) => {
                  const v = r.groups[col.key];
                  return (
                    <td
                      key={col.key}
                      className={`px-2.5 py-2 text-right font-medium tabular-nums ${
                        v != null ? accColor(v) : "text-slate-300"
                      }`}
                    >
                      {v != null ? pct(v) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={3 + PLAYER_ACCURACY_COLUMNS.length}
                  className="p-6 text-center text-sm text-slate-400"
                >
                  {selectedAnalyst
                    ? "No checks for this analyst in the selected week."
                    : "No checks for this week."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>

    {/* Accuracy trend — for the selected analyst. */}
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">Accuracy trend</h2>
        {selectedAnalyst && (
          <div className="flex flex-wrap items-center gap-1">
            {PLAYER_ACCURACY_COLUMNS.map((col) => (
              <button
                key={col.key}
                onClick={() => onTrendGroupChange(col.key)}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                  trendGroup === col.key
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {col.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {!selectedAnalyst ? (
        <p className="text-sm text-slate-400">
          Select an analyst above to see their accuracy trend.
        </p>
      ) : trendData.length < 2 ? (
        <p className="text-sm text-slate-400">
          Need at least 2 saved checks to show a trend.
        </p>
      ) : (
        <div className="h-64">
          <AccuracyTrendChart data={trendData} />
        </div>
      )}
    </div>
    </div>
  );
}

// By-location comparison: each country's average Player Accuracy per group,
// with the same week selector. Read-only (few rows, no sorting needed).
type LocationAnalystRow = {
  analyst: string;
  checks: number;
  groups: Record<PlayerAccuracyGroupKey, number | null>;
};
type LocationRowData = {
  location: string;
  checks: number;
  analysts: number;
  groups: Record<PlayerAccuracyGroupKey, number | null>;
  analystRows: LocationAnalystRow[];
};

function LocationComparisonTable({
  rows,
  weeks,
  weekFilter,
  onWeekChange,
  categoryFilter,
  onCategoryChange,
}: {
  rows: LocationRowData[];
  weeks: string[];
  weekFilter: string;
  onWeekChange: (w: string) => void;
  /** Shared comparison category filter ("all" = every category). */
  categoryFilter: CheckCategory | "all";
  onCategoryChange: (v: CheckCategory | "all") => void;
}) {
  // Which location rows are expanded to show their analysts.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (loc: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(loc)) next.delete(loc);
      else next.add(loc);
      return next;
    });

  // Sort state. `key === null` keeps the incoming (natural location) order.
  const [sort, setSort] = useState<{
    key: string | null;
    dir: "asc" | "desc";
  }>({ key: null, dir: "desc" });

  const toggleSort = (key: string) =>
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" }
    );

  // Sorting reorders the ANALYSTS WITHIN each location (the location rows keep
  // their natural order). Clicking a header sorts every location's expanded
  // analyst list by that column.
  const sortedRows = useMemo(() => {
    if (!sort.key) return rows;
    const { key, dir } = sort;
    const mult = dir === "asc" ? 1 : -1;
    const val = (a: LocationAnalystRow): number | string | null => {
      if (key === "location") return a.analyst.toLowerCase();
      if (key === "analysts") return a.analyst.toLowerCase();
      if (key === "checks") return a.checks;
      return a.groups[key as PlayerAccuracyGroupKey];
    };
    const cmp = (a: LocationAnalystRow, b: LocationAnalystRow) => {
      const av = val(a);
      const bv = val(b);
      // Nulls (no data) always sort last, regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * mult;
      }
      return (av - bv) * mult;
    };
    return rows.map((r) => ({
      ...r,
      analystRows: [...r.analystRows].sort(cmp),
    }));
  }, [rows, sort]);

  // Sort state and toggle for the SortHead component, which expects a
  // non-null key. When no explicit sort is chosen it points at a sentinel so
  // no header shows as active.
  const headSort = { key: sort.key ?? "", dir: sort.dir };

  // Export the by-location table to CSV: one row per location, then an
  // indented row per analyst within it. Respects the current sort + week
  // filter (the rows already reflect them). Percentages are plain numbers.
  function exportLocations() {
    const pctNum = (v: number | null) =>
      v == null ? "" : (v * 100).toFixed(1);
    const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const groupCols = PLAYER_ACCURACY_COLUMNS;

    const header = [
      "Location",
      "Analyst",
      "Checks",
      ...groupCols.map((c) => `${c.label} %`),
    ];
    const lines: string[] = [];
    for (const r of sortedRows) {
      lines.push(
        [
          r.location,
          "", // location-level row: no analyst
          String(r.checks),
          ...groupCols.map((col) => pctNum(r.groups[col.key])),
        ]
          .map(csvCell)
          .join(",")
      );
      for (const a of r.analystRows) {
        lines.push(
          [
            r.location,
            a.analyst,
            String(a.checks),
            ...groupCols.map((col) => pctNum(a.groups[col.key])),
          ]
            .map(csvCell)
            .join(",")
        );
      }
    }

    const csv = [header.map(csvCell).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const scope = weekFilter === "all" ? "all-weeks" : `week-${weekFilter}`;
    a.href = url;
    a.download = `location-accuracy_${scope}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            By location — average player accuracy
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Averaged across all analysts in each country
            {weekFilter === "all" ? " (whole season)" : ""}. Click a location to
            see its analysts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Week</label>
          <select
            value={weekFilter}
            onChange={(e) => onWeekChange(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
          >
            <option value="all">All weeks</option>
            {weeks.map((w) => (
              <option key={w} value={w}>
                {fridayWeekLabel(w)}
              </option>
            ))}
          </select>
          <label className="text-xs font-medium text-slate-500">Category</label>
          <select
            value={categoryFilter}
            onChange={(e) =>
              onCategoryChange(e.target.value as CheckCategory | "all")
            }
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-slate-500 focus:outline-none"
            aria-label="Filter comparison by category"
          >
            <option value="all">All categories</option>
            {CHECK_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {CHECK_CATEGORY_LABELS[opt]}
              </option>
            ))}
          </select>
          <button
            onClick={exportLocations}
            disabled={rows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Export the locations currently shown to CSV"
          >
            <Download size={13} /> Export
            {rows.length > 0 ? ` (${rows.length})` : ""}
          </button>
        </div>
      </div>

      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-6 px-2.5 py-2" />
              <th className="px-2.5 py-2">
                <SortHead
                  label="Location"
                  col="location"
                  sort={headSort}
                  onSort={toggleSort}
                  align="left"
                />
              </th>
              <th className="px-2.5 py-2 text-right">
                <SortHead
                  label="Analysts"
                  col="analysts"
                  sort={headSort}
                  onSort={toggleSort}
                />
              </th>
              <th className="px-2.5 py-2 text-right">
                <SortHead
                  label="Checks"
                  col="checks"
                  sort={headSort}
                  onSort={toggleSort}
                />
              </th>
              {PLAYER_ACCURACY_COLUMNS.map((col) => (
                <th key={col.key} className="px-2.5 py-2 text-right">
                  <SortHead
                    label={col.label}
                    col={col.key}
                    sort={headSort}
                    onSort={toggleSort}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const isOpen = expanded.has(r.location);
              return (
                <React.Fragment key={r.location}>
                  <tr
                    onClick={() => toggle(r.location)}
                    className="cursor-pointer border-t border-slate-100 transition hover:bg-slate-50"
                  >
                    <td className="px-2.5 py-2 align-middle text-slate-400">
                      {isOpen ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2 font-semibold text-slate-800">
                      {r.location}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-slate-600">
                      {r.analysts}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums text-slate-600">
                      {r.checks}
                    </td>
                    {PLAYER_ACCURACY_COLUMNS.map((col) => {
                      const v = r.groups[col.key];
                      return (
                        <td
                          key={col.key}
                          className={`px-2.5 py-2 text-right font-medium tabular-nums ${
                            v != null ? accColor(v) : "text-slate-300"
                          }`}
                        >
                          {v != null ? pct(v) : "—"}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Expanded: one row per analyst in this location. */}
                  {isOpen &&
                    (r.analystRows.length === 0 ? (
                      <tr className="bg-slate-50/60">
                        <td />
                        <td
                          colSpan={3 + PLAYER_ACCURACY_COLUMNS.length}
                          className="px-2.5 py-2 text-xs text-slate-400"
                        >
                          No analysts for this location.
                        </td>
                      </tr>
                    ) : (
                      r.analystRows.map((a) => (
                        <tr
                          key={`${r.location}-${a.analyst}`}
                          className="border-t border-slate-50 bg-slate-50/60"
                        >
                          <td />
                          <td className="whitespace-nowrap px-2.5 py-2 pl-6 text-slate-600">
                            {a.analyst}
                          </td>
                          <td className="px-2.5 py-2 text-right tabular-nums text-slate-400">
                            —
                          </td>
                          <td className="px-2.5 py-2 text-right tabular-nums text-slate-500">
                            {a.checks}
                          </td>
                          {PLAYER_ACCURACY_COLUMNS.map((col) => {
                            const v = a.groups[col.key];
                            return (
                              <td
                                key={col.key}
                                className={`px-2.5 py-2 text-right tabular-nums ${
                                  v != null ? accColor(v) : "text-slate-300"
                                }`}
                              >
                                {v != null ? pct(v) : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    ))}
                </React.Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={4 + PLAYER_ACCURACY_COLUMNS.length}
                  className="p-6 text-center text-sm text-slate-400"
                >
                  No checks for this week.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
