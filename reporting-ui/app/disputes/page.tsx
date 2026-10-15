"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Flag,
    ChevronDown,
    ChevronRight,
    ChevronsUpDown,
    ArrowUp,
    ArrowDown,
    X as XIcon,
    Check,
    Clock,
    Pencil,
    Plus,
    Save,
    MessageSquare,
} from "lucide-react";
import {
    getAllDisputes,
    resolveDispute,
    DISPUTE_CATEGORIES,
    disputeCategoryLabel,
    type Dispute,
    type DisputeCategory,
} from "@/lib/api/disputes";
import {
    instancesFromRaw,
    getAccuracyChecksMeta,
    getAccuracyCheckById,
    propagateMasterCorrection,
    getMasterCheckSiblings,
    type AccuracyCheckMeta,
    type AccuracyCheck,
} from "@/lib/api/accuracyChecks";
import { serializeInstancesToJson } from "@/lib/comparison/json-adapter";
import {
    parseInstances,
    compareInstances,
    canonicaliseTeams,
    serializeInstances,
    formatTime,
    parseHomeAwayFromFileName,
    type Instance,
} from "@/lib/comparison/xml-compare";
import MasterEditModal from "@/components/MasterEditModal";
import { useAuth } from "@/components/auth/AuthContext";
import DisputesPanel from "@/components/DisputesPanel";
import SportToggle, { type SportFilter } from "@/components/SportToggle";
import {
    findUserByAnalystName,
    getOrCreateDirectConversation,
} from "@/lib/api/messages";

type Filter = "open" | "resolved" | "all";

type CheckGroup = {
    checkId: number;
    label: string;
    analyst: string;
    masterBy: string;
    date: string | null;
    disputes: Dispute[];
    openCount: number;
};

// Club suffixes that stay fully uppercase in a title-cased team name.
const ALWAYS_UPPER_TOKENS = new Set(["fc", "sc"]);

// Title-case a team name (each word capitalised) for a professional look.
// Club suffixes like FC/SC are always uppercased, and tokens with digits
// (U15, U15B) are left as-is. Kept identical to the Saved checks table.
function titleCaseTeam(name: string): string {
    return name
        .trim()
        .split(/\s+/)
        .map((w) => {
            if (ALWAYS_UPPER_TOKENS.has(w.toLowerCase())) return w.toUpperCase();
            if (/\d/.test(w)) return w;
            return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        })
        .join(" ");
}

export default function DisputesPage() {
    const { user, ready } = useAuth();
    const router = useRouter();
    const canResolve = user?.role === "admin" || user?.role === "super_admin";
    // Which fixture group is currently starting a message (checkId), for a
    // per-button loading state.
    const [messaging, setMessaging] = useState<number | null>(null);

    // Start (or open) a direct conversation with the analyst whose fixture
    // this is, linked to the check, then jump to the Messages page. Admins use
    // this to give an analyst feedback about their flagged instances.
    async function messageAnalyst(analystName: string, checkId: number) {
        if (!user) return;
        if (!analystName.trim()) {
            alert("This fixture has no analyst name to message.");
            return;
        }
        setMessaging(checkId);
        try {
            const target = await findUserByAnalystName(analystName);
            if (!target) {
                alert(
                    `No user account found for "${analystName}". They need a login account to receive messages.`
                );
                return;
            }
            if (target.id === user.id) {
                alert("That's you — pick a different person to message.");
                return;
            }
            const convId = await getOrCreateDirectConversation(
                user.id,
                target.id,
                { checkId }
            );
            router.push(`/messages?c=${convId}`);
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to open messages.");
        } finally {
            setMessaging(null);
        }
    }

    const [disputes, setDisputes] = useState<Dispute[]>([]);
    const [checks, setChecks] = useState<AccuracyCheckMeta[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<Filter>("open");
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const [search, setSearch] = useState("");
    const [sportFilter, setSportFilter] = useState<SportFilter>("all");
    // Analyst filter for the table ("all" = every analyst).
    const [analystFilter, setAnalystFilter] = useState<string>("all");
    // Flag-category filter ("all" | one of the DisputeCategory codes |
    // "uncategorised" for legacy disputes without a category).
    const [categoryFilter, setCategoryFilter] = useState<
        "all" | DisputeCategory | "uncategorised"
    >("all");
    // Sortable columns for the fixture table.
    const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
        key: "open",
        dir: "desc",
    });
    function toggleSort(key: string) {
        setSort((cur) =>
            cur.key === key
                ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
                : { key, dir: key === "date" || key === "match" || key === "analyst" ? "asc" : "desc" }
        );
    }

    // Self-contained review pop-up (Option B): the disputed instance's video
    // clip + inline resolve, without leaving the Disputes page.
    const [reviewing, setReviewing] = useState<{
        dispute: Dispute;
        videoUrl: string | null;
    } | null>(null);

    // Open the disputed instance in a review pop-up on this page.
    function openInReview(d: Dispute) {
        const check = checks.find((c) => c.id === d.check_id);
        setReviewing({ dispute: d, videoUrl: check?.video_url ?? null });
    }

    async function load() {
        try {
            setLoading(true);
            const [d, c] = await Promise.all([
                getAllDisputes(),
                getAccuracyChecksMeta().catch(() => [] as AccuracyCheckMeta[]),
            ]);

            // Admins/super admins see everything. Analysts see ONLY disputes
            // on checks saved against their own name (nothing if unallocated).
            const isAdmin =
                user?.role === "admin" || user?.role === "super_admin";
            const own = user?.analyst_name?.trim().toLowerCase() ?? "";

            if (isAdmin) {
                setChecks(c);
                setDisputes(d);
            } else {
                const ownChecks = c.filter(
                    (chk) => !!own && chk.analyst_name.trim().toLowerCase() === own
                );
                const ownIds = new Set(ownChecks.map((chk) => chk.id));
                setChecks(ownChecks);
                setDisputes(d.filter((dis) => ownIds.has(dis.check_id)));
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!ready) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, user?.role, user?.analyst_name]);

    const checkById = useMemo(() => {
        const m = new Map<number, AccuracyCheckMeta>();
        for (const c of checks) m.set(c.id, c);
        return m;
    }, [checks]);

    // Effective sport per check: use the stored value; legacy checks without
    // one default to "afl". (The check list no longer carries raw XML, so we
    // rely on the stored sport column rather than parsing it.)
    const sportByCheck = useMemo(() => {
        const m = new Map<number, "afl" | "football">();
        for (const c of checks) {
            const stored =
                c.sport === "afl" || c.sport === "football" ? c.sport : null;
            m.set(c.id, stored ?? "afl");
        }
        return m;
    }, [checks]);

    // Match title, identical to the Saved checks table (Accuracy History):
    // "Home v Away" title-cased from the master file name, falling back to the
    // saved match label, then the analyst file, then the check id.
    function labelFor(checkId: number): string {
        const c = checkById.get(checkId);
        if (!c) return `Check #${checkId}`;
        const teams = parseHomeAwayFromFileName(c.file_name_master);
        if (teams)
            return `${titleCaseTeam(teams[0])} v ${titleCaseTeam(teams[1])}`;
        return (
            c.match_label ||
            `${c.analyst_name}${
                c.file_name_analyst ? ` · ${c.file_name_analyst}` : ""
            }`
        );
    }

    // Filtered disputes, then grouped by check.
    const groups = useMemo(() => {
        const matchesFilter = (d: Dispute) =>
            filter === "all"
                ? true
                : filter === "open"
                  ? d.status === "open"
                  : d.status !== "open";

        const matchesSport = (checkId: number) => {
            if (sportFilter === "all") return true;
            return sportByCheck.get(checkId) === sportFilter;
        };

        const matchesCategory = (d: Dispute) => {
            if (categoryFilter === "all") return true;
            if (categoryFilter === "uncategorised") return !d.category;
            return d.category === categoryFilter;
        };

        const byCheck = new Map<number, Dispute[]>();
        for (const d of disputes) {
            if (!matchesFilter(d)) continue;
            if (!matchesSport(d.check_id)) continue;
            if (!matchesCategory(d)) continue;
            const arr = byCheck.get(d.check_id) ?? [];
            arr.push(d);
            byCheck.set(d.check_id, arr);
        }

        // Match search only targets the match label now that analyst has its
        // own dropdown.
        const q = search.trim().toLowerCase();
        const result: CheckGroup[] = [];
        for (const [checkId, ds] of byCheck.entries()) {
            const c = checkById.get(checkId);
            const label = labelFor(checkId);
            const analyst = c?.analyst_name ?? "";
            const masterBy = c?.master_analyst_name ?? "";
            if (q && !label.toLowerCase().includes(q)) continue;
            if (
                analystFilter !== "all" &&
                analyst.trim().toLowerCase() !== analystFilter.trim().toLowerCase()
            )
                continue;
            result.push({
                checkId,
                label,
                analyst,
                masterBy,
                date: c?.created_at ?? null,
                disputes: ds.sort(
                    (a, b) =>
                        (a.code_time ?? 0) - (b.code_time ?? 0)
                ),
                openCount: ds.filter((d) => d.status === "open").length,
            });
        }

        // Apply the selected column sort. Secondary/tertiary keys keep the
        // ordering stable and useful (open first, then volume, then date).
        const dir = sort.dir === "asc" ? 1 : -1;
        const cmpStr = (a: string, b: string) =>
            a.localeCompare(b, undefined, { sensitivity: "base" });
        return result.sort((a, b) => {
            switch (sort.key) {
                case "date":
                    return dir * (a.date ?? "").localeCompare(b.date ?? "");
                case "match":
                    return dir * cmpStr(a.label, b.label);
                case "analyst":
                    return dir * cmpStr(a.analyst, b.analyst);
                case "masterBy":
                    return dir * cmpStr(a.masterBy, b.masterBy);
                case "total":
                    return dir * (a.disputes.length - b.disputes.length);
                case "open":
                default:
                    if (a.openCount !== b.openCount)
                        return dir * (a.openCount - b.openCount);
                    if (a.disputes.length !== b.disputes.length)
                        return dir * (a.disputes.length - b.disputes.length);
                    return dir * (a.date ?? "").localeCompare(b.date ?? "");
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        disputes,
        checkById,
        sportByCheck,
        filter,
        search,
        sportFilter,
        analystFilter,
        categoryFilter,
        sort,
    ]);

    // Distinct analysts present in the (sport/status-filtered) disputes, for
    // the Analyst dropdown. Built independent of the analyst filter itself.
    const analystOptions = useMemo(() => {
        const set = new Set<string>();
        for (const d of disputes) {
            const c = checkById.get(d.check_id);
            const name = c?.analyst_name?.trim();
            if (name) set.add(name);
        }
        return Array.from(set).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" })
        );
    }, [disputes, checkById]);

    function toggle(checkId: number) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(checkId)) next.delete(checkId);
            else next.add(checkId);
            return next;
        });
    }

    async function handleResolve(
        disputeId: number,
        status: "confirmed" | "denied",
        note: string | null
    ) {
        try {
            await resolveDispute(disputeId, status, user?.username ?? null, note);
            // If we resolved the one being reviewed, close the pop-up.
            setReviewing((cur) =>
                cur && cur.dispute.id === disputeId ? null : cur
            );
            await load();
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to resolve.");
        }
    }

    const counts = useMemo(() => {
        const open = disputes.filter((d) => d.status === "open").length;
        return { open, total: disputes.length };
    }, [disputes]);

    // Per-category counts for the breakdown chips. Respects sport / status /
    // analyst filters (so the breakdown matches the visible table) but NOT the
    // category filter itself — every category chip stays visible so you can
    // switch between them. Clicking a chip toggles the category filter.
    const categoryBreakdown = useMemo(() => {
        const matchesFilter = (d: Dispute) =>
            filter === "all"
                ? true
                : filter === "open"
                  ? d.status === "open"
                  : d.status !== "open";
        const matchesSport = (checkId: number) =>
            sportFilter === "all" || sportByCheck.get(checkId) === sportFilter;
        const matchesAnalyst = (checkId: number) => {
            if (analystFilter === "all") return true;
            const a = checkById.get(checkId)?.analyst_name ?? "";
            return (
                a.trim().toLowerCase() === analystFilter.trim().toLowerCase()
            );
        };

        const counts = new Map<string, number>();
        let total = 0;
        for (const d of disputes) {
            if (!matchesFilter(d)) continue;
            if (!matchesSport(d.check_id)) continue;
            if (!matchesAnalyst(d.check_id)) continue;
            const key = d.category ?? "uncategorised";
            counts.set(key, (counts.get(key) ?? 0) + 1);
            total += 1;
        }

        const rows: {
            key: "all" | DisputeCategory | "uncategorised";
            label: string;
            count: number;
        }[] = [{ key: "all", label: "All", count: total }];
        for (const c of DISPUTE_CATEGORIES) {
            rows.push({
                key: c.value,
                label: c.label,
                count: counts.get(c.value) ?? 0,
            });
        }
        const uncat = counts.get("uncategorised") ?? 0;
        if (uncat > 0) {
            rows.push({
                key: "uncategorised",
                label: disputeCategoryLabel(null),
                count: uncat,
            });
        }
        return rows;
    }, [
        disputes,
        filter,
        sportFilter,
        analystFilter,
        sportByCheck,
        checkById,
    ]);

    function fmtDate(iso: string | null) {
        if (!iso) return "";
        return new Date(iso).toLocaleDateString("en-AU", {
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
    }

    if (loading) {
        return (
            <div className="min-h-full bg-slate-100 p-8 text-slate-600">
                Loading disputes...
            </div>
        );
    }

    return (
        <div className="min-h-full bg-slate-100 text-slate-900">
            <div className="mx-auto max-w-6xl p-6 lg:p-8">
                <div className="mb-6">
                    <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
                        <Flag size={26} /> Disputes
                    </h1>
                    <p className="mt-2 text-sm text-slate-600">
                        One row per fixture — click to expand its disputes.{" "}
                        <span className="font-semibold text-amber-600">
                            {counts.open} open
                        </span>{" "}
                        · {counts.total} total across {groups.length} fixture
                        {groups.length === 1 ? "" : "s"}.
                    </p>
                </div>

                {/* Filters: sport · status · analyst · match search */}
                <div className="mb-4 flex flex-wrap items-center gap-2">
                    <SportToggle value={sportFilter} onChange={setSportFilter} />
                    <div className="flex items-center gap-1.5">
                        {(["open", "resolved", "all"] as Filter[]).map((f) => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition ${
                                    filter === f
                                        ? "bg-slate-900 text-white"
                                        : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                                }`}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                    <select
                        value={analystFilter}
                        onChange={(e) => setAnalystFilter(e.target.value)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-slate-500"
                        aria-label="Filter by analyst"
                    >
                        <option value="all">All analysts</option>
                        {analystOptions.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                    <select
                        value={categoryFilter}
                        onChange={(e) =>
                            setCategoryFilter(
                                e.target.value as
                                    | "all"
                                    | DisputeCategory
                                    | "uncategorised"
                            )
                        }
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-slate-500"
                        aria-label="Filter by flag category"
                    >
                        <option value="all">All categories</option>
                        {DISPUTE_CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>
                                {c.label}
                            </option>
                        ))}
                        <option value="uncategorised">Uncategorised</option>
                    </select>
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search match…"
                        className="ml-auto w-56 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-500"
                    />
                </div>

                {/* By-category breakdown: click a chip to filter the table to
                    that flag category. */}
                <div className="mb-4 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        By category
                    </span>
                    {categoryBreakdown.map((c) => {
                        const active = categoryFilter === c.key;
                        return (
                            <button
                                key={c.key}
                                onClick={() => setCategoryFilter(c.key)}
                                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
                                    active
                                        ? "bg-indigo-600 text-white"
                                        : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                }`}
                            >
                                {c.label}
                                <span
                                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                                        active
                                            ? "bg-white/25 text-white"
                                            : "bg-slate-100 text-slate-500"
                                    }`}
                                >
                                    {c.count}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {groups.length === 0 ? (
                    <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-500">
                        No {filter === "all" ? "" : filter} disputes.
                    </div>
                ) : (
                    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                                    <th className="w-8 px-3 py-2.5" />
                                    <SortHeader
                                        label="Date"
                                        col="date"
                                        sort={sort}
                                        onSort={toggleSort}
                                        className="w-28"
                                    />
                                    <SortHeader
                                        label="Match"
                                        col="match"
                                        sort={sort}
                                        onSort={toggleSort}
                                    />
                                    <SortHeader
                                        label="Analyst"
                                        col="analyst"
                                        sort={sort}
                                        onSort={toggleSort}
                                        className="w-40"
                                    />
                                    <SortHeader
                                        label="Master by"
                                        col="masterBy"
                                        sort={sort}
                                        onSort={toggleSort}
                                        className="w-40"
                                    />
                                    <SortHeader
                                        label="Open"
                                        col="open"
                                        sort={sort}
                                        onSort={toggleSort}
                                        className="w-20 text-right"
                                        align="right"
                                    />
                                    <SortHeader
                                        label="Total"
                                        col="total"
                                        sort={sort}
                                        onSort={toggleSort}
                                        className="w-20 text-right"
                                        align="right"
                                    />
                                </tr>
                            </thead>
                            <tbody>
                                {groups.map((g) => {
                                    const isOpen = expanded.has(g.checkId);
                                    return (
                                        <Fragment key={g.checkId}>
                                            <tr
                                                onClick={() => toggle(g.checkId)}
                                                className={`cursor-pointer border-b border-slate-100 transition hover:bg-slate-50 ${
                                                    isOpen ? "bg-slate-50" : ""
                                                }`}
                                            >
                                                <td className="px-3 py-2.5 align-middle text-slate-400">
                                                    {isOpen ? (
                                                        <ChevronDown size={16} />
                                                    ) : (
                                                        <ChevronRight size={16} />
                                                    )}
                                                </td>
                                                <td className="whitespace-nowrap px-3 py-2.5 align-middle text-slate-600">
                                                    {g.date ? fmtDate(g.date) : "—"}
                                                </td>
                                                <td className="px-3 py-2.5 align-middle">
                                                    <span className="block max-w-[22rem] truncate font-semibold text-slate-800">
                                                        {g.label}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2.5 align-middle text-slate-700">
                                                    <span className="block truncate">
                                                        {g.analyst || "—"}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2.5 align-middle text-slate-600">
                                                    <span className="block truncate">
                                                        {g.masterBy || "—"}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2.5 text-right align-middle">
                                                    {g.openCount > 0 ? (
                                                        <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700">
                                                            {g.openCount}
                                                        </span>
                                                    ) : (
                                                        <span className="text-slate-400">
                                                            0
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-3 py-2.5 text-right align-middle font-semibold text-slate-700">
                                                    {g.disputes.length}
                                                </td>
                                            </tr>
                                            {isOpen && (
                                                <tr className="border-b border-slate-100">
                                                    <td
                                                        colSpan={7}
                                                        className="bg-slate-50/60 p-3"
                                                    >
                                                        {canResolve && g.analyst && (
                                                            <div className="mb-3 flex items-center justify-end">
                                                                <button
                                                                    onClick={() =>
                                                                        messageAnalyst(
                                                                            g.analyst,
                                                                            g.checkId
                                                                        )
                                                                    }
                                                                    disabled={
                                                                        messaging ===
                                                                        g.checkId
                                                                    }
                                                                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                                                                    title={`Message ${g.analyst} about this fixture's flags`}
                                                                >
                                                                    <MessageSquare
                                                                        size={13}
                                                                    />
                                                                    {messaging ===
                                                                    g.checkId
                                                                        ? "Opening…"
                                                                        : `Message ${g.analyst}`}
                                                                </button>
                                                            </div>
                                                        )}
                                                        <DisputesPanel
                                                            disputes={g.disputes}
                                                            canResolve={canResolve}
                                                            onResolve={handleResolve}
                                                            onOpen={openInReview}
                                                        />
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {reviewing && (
                <DisputeReviewModal
                    dispute={reviewing.dispute}
                    videoUrl={reviewing.videoUrl}
                    canResolve={canResolve}
                    onResolve={handleResolve}
                    onSaved={load}
                    onClose={() => setReviewing(null)}
                />
            )}
        </div>
    );
}

// Sortable column header for the fixtures table.
function SortHeader({
    label,
    col,
    sort,
    onSort,
    className = "",
    align = "left",
}: {
    label: string;
    col: string;
    sort: { key: string; dir: "asc" | "desc" };
    onSort: (key: string) => void;
    className?: string;
    align?: "left" | "right";
}) {
    const active = sort.key === col;
    return (
        <th className={`px-3 py-2.5 ${className}`}>
            <button
                type="button"
                onClick={() => onSort(col)}
                className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition hover:text-slate-700 ${
                    active ? "text-slate-700" : "text-slate-500"
                } ${align === "right" ? "flex-row-reverse" : ""}`}
            >
                {label}
                {active ? (
                    sort.dir === "asc" ? (
                        <ArrowUp size={12} />
                    ) : (
                        <ArrowDown size={12} />
                    )
                ) : (
                    <ChevronsUpDown size={12} className="text-slate-300" />
                )}
            </button>
        </th>
    );
}

// -----------------------------------------------------------------------
// Self-contained review pop-up: plays the disputed instance's video clip
// and lets an admin resolve it (Analyst correct / Master correct) inline.
// -----------------------------------------------------------------------
function fmtClock(t: number | null): string {
    if (t == null) return "—";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// Colour-coded status badges, matching the Accuracy Comparison timeline.
const STATUS_BADGE: Record<string, { label: string; badge: string }> = {
    exact: { label: "Exact", badge: "bg-emerald-100 text-emerald-700" },
    wrong_stat: { label: "Wrong stat", badge: "bg-amber-100 text-amber-700" },
    wrong_player: {
        label: "Wrong player",
        badge: "bg-orange-100 text-orange-700",
    },
    wrong_team: { label: "Wrong team", badge: "bg-red-100 text-red-700" },
    missed: { label: "Missed", badge: "bg-slate-200 text-slate-700" },
    extra: { label: "Extra", badge: "bg-purple-100 text-purple-700" },
};

function DisputeReviewModal({
    dispute: d,
    videoUrl,
    canResolve,
    onResolve,
    onSaved,
    onClose,
}: {
    dispute: Dispute;
    videoUrl: string | null;
    canResolve: boolean;
    onResolve: (
        disputeId: number,
        status: "confirmed" | "denied",
        note: string | null
    ) => void | Promise<void>;
    /** Called after a corrected master is saved, so the page can refresh. */
    onSaved?: () => void | Promise<void>;
    onClose: () => void;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const activeRowRef = useRef<HTMLDivElement | null>(null);
    const [note, setNote] = useState("");
    const [videoTime, setVideoTime] = useState(0);
    const [loadingRows, setLoadingRows] = useState(true);

    // The loaded check + its instances. Master is EDITABLE (admins can correct
    // a wrong master to resolve a dispute); analyst is read-only. Editing the
    // master recomputes the timeline live and can be saved back in place.
    const [check, setCheck] = useState<AccuracyCheck | null>(null);
    const [masterInstances, setMasterInstances] = useState<Instance[]>([]);
    const [analystInstances, setAnalystInstances] = useState<Instance[]>([]);
    const [fileNameMaster, setFileNameMaster] = useState<string | null>(null);
    // A JSON-sourced master is viewable but NOT editable in place: the edit /
    // save flow serializes to SportsCode XML, which a JSON feed can't round-
    // trip through. Mirrors the accuracy-compare gate (masterIsJson).
    const [masterIsJson, setMasterIsJson] = useState(false);
    const tol = check?.tolerance ?? 3;

    // Editing state.
    const [editing, setEditing] = useState<Instance | "new" | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState<string | null>(null);

    // Load + parse the check's stored XML.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoadingRows(true);
            try {
                const c = await getAccuracyCheckById(d.check_id);
                if (!c || cancelled) return;
                setCheck(c);
                setFileNameMaster(c.file_name_master);
                // Use the JSON-aware adapter (not parseInstances directly):
                // a check's master/analyst source can be SportsCode XML OR a
                // JSON event feed (e.g. Touch/soccer). parseInstances is XML-
                // only and silently returns [] for JSON, which blanked the
                // timeline and the master-edit panel for JSON-sourced checks.
                setMasterInstances(instancesFromRaw(c.xml_master));
                setAnalystInstances(instancesFromRaw(c.xml_analyst));
                setMasterIsJson(
                    !!c.xml_master && c.xml_master.trimStart().startsWith("{")
                );
                setDirty(false);
                setSaveMsg(null);
            } catch (err) {
                console.error("Failed building dispute timeline:", err);
            } finally {
                if (!cancelled) setLoadingRows(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [d.check_id]);

    // Seek to the disputed moment once the video is ready.
    useEffect(() => {
        const v = videoRef.current;
        if (!v || d.code_time == null) return;
        const seek = () => {
            try {
                v.currentTime = Math.max(0, d.code_time as number);
                v.play().catch(() => {});
            } catch {
                // ignore
            }
        };
        if (v.readyState >= 1) seek();
        else v.addEventListener("loadedmetadata", seek, { once: true });
    }, [d.code_time, videoUrl]);

    // Canonicalise + compare the (possibly edited) master against the analyst.
    // Recomputes whenever the master instances change, so an edit updates the
    // timeline and the disputed-row highlighting live.
    const canon = useMemo(
        () =>
            canonicaliseTeams(
                masterInstances,
                analystInstances,
                tol,
                fileNameMaster
            ),
        [masterInstances, analystInstances, tol, fileNameMaster]
    );
    const result = useMemo(
        () => compareInstances(canon.master, canon.analyst, tol),
        [canon, tol]
    );
    const rows = result.rows;
    const teamNames = canon.displayNames;

    // Keep the disputed / active row in view.
    useEffect(() => {
        activeRowRef.current?.scrollIntoView({
            block: "nearest",
            behavior: "smooth",
        });
    }, [videoTime, rows]);

    // Canonical team -> real club name (from the master file) for display.
    const teamDisplay = (canonTeam: string): string => {
        const key = canonTeam.trim().toLowerCase();
        if (key === "home" && teamNames.home) return teamNames.home;
        if (key === "away" && teamNames.away) return teamNames.away;
        return canonTeam;
    };

    // ---- Master editing (admin only) ------------------------------------
    // Open the editor for a master row. Rows carry the CANONICAL instance
    // (Home/Away); resolve back to the ORIGINAL by id so the modal shows the
    // real club name and edits keep the real naming.
    const openEdit = (canonical: Instance) => {
        const original =
            masterInstances.find((i) => i.id === canonical.id) ?? canonical;
        setEditing(original);
    };

    // Round-trip edited instances through the SAME format the master is stored
    // in, so they normalise exactly like a fresh load (mid, playerNumber from
    // code, etc.). JSON masters re-import via instancesFromRaw(JSON); XML via
    // parseInstances(XML). Using the wrong format here would silently drop
    // fields the other serializer doesn't carry.
    const renormalise = (list: Instance[]): Instance[] =>
        masterIsJson
            ? instancesFromRaw(serializeInstancesToJson(list))
            : parseInstances(serializeInstances(list));

    const upsertMaster = (inst: Instance) => {
        setMasterInstances((cur) => {
            const exists = cur.some((i) => i.id === inst.id);
            const next = exists
                ? cur.map((i) => (i.id === inst.id ? inst : i))
                : [...cur, inst];
            return renormalise(next);
        });
        setDirty(true);
        setSaveMsg(null);
        setEditing(null);
    };

    const deleteMaster = (id: string) => {
        setMasterInstances((cur) => renormalise(cur.filter((i) => i.id !== id)));
        setDirty(true);
        setSaveMsg(null);
        setEditing(null);
    };

    // Save the corrected master back to the check in place (Option A): rewrite
    // xml_master and the recomputed summary/breakdowns so the analyst's stored
    // accuracy reflects the corrected master.
    const saveCorrectedMaster = async () => {
        if (!check) return;
        const fileName = check.file_name_master;
        if (!fileName) {
            setSaveMsg("This check has no master file name to propagate to.");
            return;
        }

        // The master is shared: this correction re-grades EVERY check of this
        // master. Confirm the blast radius before writing.
        let siblings = { count: 1, analysts: [check.analyst_name] };
        try {
            siblings = await getMasterCheckSiblings(fileName);
        } catch {
            // fall back to just this check
        }
        const others = Math.max(0, siblings.count - 1);
        const confirmed = window.confirm(
            `Correcting this master updates all ${siblings.count} check` +
                `${siblings.count === 1 ? "" : "s"} of "${fileName}"` +
                (others > 0
                    ? ` and re-grades ${others} other analyst check${
                          others === 1 ? "" : "s"
                      } (${siblings.analysts.join(", ")}).`
                    : ".") +
                `\n\nContinue?`
        );
        if (!confirmed) return;

        setSaving(true);
        setSaveMsg(null);
        try {
            // Serialize back to the SAME format the master was stored in: a
            // JSON-feed master round-trips via serializeInstancesToJson (re-
            // imports cleanly through instancesFromRaw), an XML master via
            // serializeInstances. propagateMasterCorrection writes this to
            // xml_master on every sibling and re-grades each with the JSON-
            // aware grader, so corrections apply across the whole master group.
            const correctedMaster = masterIsJson
                ? serializeInstancesToJson(masterInstances)
                : serializeInstances(masterInstances);
            // Propagate to every check of this master; each is recomputed
            // against its own analyst source (the master is the shared source).
            const res = await propagateMasterCorrection(fileName, correctedMaster);
            setDirty(false);
            setSaveMsg(
                `Saved. Master corrected across ${res.updated} check` +
                    `${res.updated === 1 ? "" : "s"}` +
                    (res.analysts.length
                        ? ` (${res.analysts.join(", ")}).`
                        : ".")
            );
            // Refresh the disputes page so its list/meta reflect the new master.
            await onSaved?.();
        } catch (err) {
            setSaveMsg(
                err instanceof Error ? err.message : "Failed to save."
            );
        } finally {
            setSaving(false);
        }
    };

    // Dropdown catalogs for the edit modal (from the loaded instances).
    const statCatalog = useMemo(() => {
        const map = new Map<string, { stat: string; category: string }>();
        const add = (i: Instance) => {
            const stat = i.stat.trim();
            if (!stat) return;
            const key = stat.toLowerCase();
            if (!map.has(key))
                map.set(key, { stat, category: i.category.trim() });
        };
        for (const i of masterInstances) add(i);
        for (const i of analystInstances) add(i);
        return Array.from(map.values()).sort((a, b) =>
            a.stat.localeCompare(b.stat)
        );
    }, [masterInstances, analystInstances]);

    const teamOptions = useMemo(
        () =>
            Array.from(
                new Set(masterInstances.map((i) => i.team).filter(Boolean))
            ),
        [masterInstances]
    );

    const seekTo = (seconds: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = Math.max(0, seconds);
        v.play().catch(() => {});
    };

    const open = d.status === "open";

    return (
        <div
            className="fixed inset-0 z-50 flex flex-col bg-slate-900/80 p-2 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="mx-auto flex h-full w-full max-w-[1800px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between gap-2 border-b border-slate-700 px-4 py-2.5">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                        <Flag size={15} className="text-amber-400" /> Review
                        dispute
                        <span className="text-xs font-normal text-slate-400">
                            {d.stat || "—"} ·{" "}
                            {d.side === "master" ? "Master" : "Analyst"}
                            {d.player ? ` · ${d.player}` : ""}
                            <span className="ml-1 inline-flex items-center gap-1">
                                <Clock size={11} /> {fmtClock(d.code_time)}
                            </span>
                        </span>
                    </span>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                        title="Close"
                    >
                        <XIcon size={18} />
                    </button>
                </div>

                {/* Body: video (left, larger) + both timelines (right) */}
                <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[2fr_1fr]">
                    {/* Video */}
                    <div className="flex min-h-0 items-center justify-center bg-black p-2">
                        {videoUrl ? (
                            <video
                                ref={videoRef}
                                src={videoUrl}
                                controls
                                onTimeUpdate={(e) =>
                                    setVideoTime(e.currentTarget.currentTime)
                                }
                                className="max-h-full max-w-full"
                            />
                        ) : (
                            <p className="text-sm text-slate-400">
                                No video URL saved for this check.
                            </p>
                        )}
                    </div>

                    {/* Timelines */}
                    <div className="flex min-h-0 flex-col border-t border-slate-700 lg:border-l lg:border-t-0">
                        {canResolve && (
                            <div className="flex flex-wrap items-center gap-2 border-b border-slate-700 bg-slate-800/60 px-3 py-2">
                                <span className="text-[11px] font-semibold text-amber-300">
                                    Master editing
                                </span>
                                <span className="text-[11px] text-slate-400">
                                    Correct a mis-coded master to resolve this
                                    dispute.
                                </span>
                                <div className="ml-auto flex items-center gap-2">
                                    <button
                                        onClick={() => setEditing("new")}
                                        className="inline-flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
                                    >
                                        <Plus size={12} /> Add
                                    </button>
                                    <button
                                        onClick={saveCorrectedMaster}
                                        disabled={!dirty || saving}
                                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                                    >
                                        <Save size={12} />{" "}
                                        {saving ? "Saving…" : "Save corrected"}
                                    </button>
                                </div>
                                {saveMsg && (
                                    <span className="w-full text-[11px] text-slate-400">
                                        {saveMsg}
                                    </span>
                                )}
                            </div>
                        )}
                        <div className="grid grid-cols-[124px_1fr_1fr] border-b border-slate-700 bg-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            <div className="p-2.5">Status</div>
                            <div className="border-l border-slate-700 p-2.5">
                                Master
                            </div>
                            <div className="border-l border-slate-700 p-2.5">
                                Analyst
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto bg-white">
                            {loadingRows ? (
                                <p className="p-6 text-center text-sm text-slate-400">
                                    Loading timeline…
                                </p>
                            ) : (
                                rows.map((row, i) => {
                                    const isDisputed =
                                        (d.side === "master" &&
                                            row.master?.id === d.instance_id) ||
                                        (d.side === "analyst" &&
                                            row.analyst?.id === d.instance_id);
                                    const mActive =
                                        !!row.master &&
                                        videoTime >= row.master.start &&
                                        videoTime <= row.master.end;
                                    const aActive =
                                        !!row.analyst &&
                                        videoTime >= row.analyst.start &&
                                        videoTime <= row.analyst.end;
                                    const active = mActive || aActive;
                                    return (
                                        <div
                                            key={i}
                                            ref={
                                                isDisputed || active
                                                    ? activeRowRef
                                                    : undefined
                                            }
                                            className={`grid grid-cols-[124px_1fr_1fr] border-b text-sm last:border-b-0 ${
                                                isDisputed
                                                    ? "border-amber-300 bg-amber-50"
                                                    : active
                                                      ? "border-sky-400 bg-sky-50 shadow-[inset_4px_0_0_0_#0ea5e9]"
                                                      : "border-slate-100"
                                            }`}
                                        >
                                            <div className="flex items-center px-2 py-1">
                                                <span
                                                    className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                                                        STATUS_BADGE[row.status]
                                                            ?.badge ??
                                                        "bg-slate-200 text-slate-700"
                                                    }`}
                                                >
                                                    {STATUS_BADGE[row.status]
                                                        ?.label ??
                                                        row.status.replace(
                                                            "_",
                                                            " "
                                                        )}
                                                </span>
                                            </div>
                                            <MiniCell
                                                inst={row.master}
                                                onSeek={seekTo}
                                                active={mActive}
                                                onEdit={
                                                    canResolve && row.master
                                                        ? () =>
                                                              openEdit(
                                                                  row.master!
                                                              )
                                                        : undefined
                                                }
                                                teamLabel={
                                                    row.master
                                                        ? teamDisplay(
                                                              row.master.team
                                                          )
                                                        : undefined
                                                }
                                            />
                                            <MiniCell
                                                inst={row.analyst}
                                                onSeek={seekTo}
                                                active={aActive}
                                                teamLabel={
                                                    row.analyst
                                                        ? teamDisplay(
                                                              row.analyst.team
                                                          )
                                                        : undefined
                                                }
                                            />
                                        </div>
                                    );
                                })
                            )}
                            {!loadingRows && rows.length === 0 && (
                                <p className="p-6 text-center text-sm text-slate-400">
                                    No timeline data for this check.
                                </p>
                            )}
                        </div>
                    </div>
                </div>

                {/* Raised reason + resolve */}
                <div className="border-t border-slate-700 p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                d.category
                                    ? "bg-indigo-500/20 text-indigo-200"
                                    : "border border-dashed border-slate-600 text-slate-400"
                            }`}
                        >
                            {disputeCategoryLabel(d.category)}
                        </span>
                        <p className="text-xs text-slate-400">
                            {d.raised_by ? `Raised by ${d.raised_by}` : "Raised"}
                            {d.reason
                                ? ` — “${d.reason}”`
                                : " — no reason given"}
                        </p>
                    </div>

                    {!open && (
                        <p className="text-sm font-semibold text-slate-200">
                            {d.status === "confirmed"
                                ? "Analyst correct"
                                : "Master correct"}
                            {d.resolved_by ? ` · by ${d.resolved_by}` : ""}
                            {d.resolution_note
                                ? ` · ${d.resolution_note}`
                                : ""}
                        </p>
                    )}

                    {open && canResolve && (
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="Resolution note (optional)"
                                className="min-w-[200px] flex-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
                            />
                            <button
                                onClick={() =>
                                    onResolve(
                                        d.id,
                                        "confirmed",
                                        note.trim() || null
                                    )
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                            >
                                <Check size={15} /> Analyst correct
                            </button>
                            <button
                                onClick={() =>
                                    onResolve(
                                        d.id,
                                        "denied",
                                        note.trim() || null
                                    )
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-700"
                            >
                                <Check size={15} /> Master correct
                            </button>
                        </div>
                    )}

                    {open && !canResolve && (
                        <p className="text-xs text-slate-500">
                            Awaiting admin review.
                        </p>
                    )}
                </div>
            </div>

            {/* Admin master instance editor (layers above the review pop-up) */}
            {editing && (
                <div onClick={(e) => e.stopPropagation()}>
                    <MasterEditModal
                        instance={editing === "new" ? null : editing}
                        isNew={editing === "new"}
                        teamOptions={teamOptions}
                        statCatalog={statCatalog}
                        playerCatalog={masterInstances}
                        onSave={upsertMaster}
                        onDelete={deleteMaster}
                        onClose={() => setEditing(null)}
                    />
                </div>
            )}
        </div>
    );
}

// Compact timeline cell for the dispute review modal. Clickable to seek.
function MiniCell({
    inst,
    onSeek,
    active,
    onEdit,
    teamLabel,
}: {
    inst: Instance | null;
    onSeek: (seconds: number) => void;
    active?: boolean;
    /** Admin-only: edit this (master) instance. Renders a pencil button. */
    onEdit?: () => void;
    /** Real club name to show instead of the canonical "Home"/"Away". */
    teamLabel?: string;
}) {
    if (!inst) {
        return (
            <div className="border-l border-slate-200 px-2 py-1">
                <span className="text-[11px] italic text-slate-300">
                    — no entry —
                </span>
            </div>
        );
    }
    const teamKey = inst.team.trim().toLowerCase();
    const bg =
        teamKey === "home"
            ? "bg-emerald-50"
            : teamKey === "away"
              ? "bg-orange-50"
              : "";
    return (
        <div
            onClick={() => onSeek(inst.start)}
            title={`${formatTime(inst.mid)} · ${
                inst.stat || inst.category || "—"
            } · ${teamLabel ?? inst.team}${
                inst.playerNumber != null ? ` #${inst.playerNumber}` : ""
            } — jump to this moment`}
            className={`cursor-pointer border-l border-slate-200 px-2 py-1 hover:brightness-95 ${
                active ? "bg-sky-100 ring-2 ring-inset ring-sky-500" : bg
            }`}
        >
            {/* Single compact line: time · stat (truncates) · team/#player */}
            <div className="flex items-center gap-x-1.5 overflow-hidden whitespace-nowrap">
                <span className="shrink-0 font-mono text-[11px] font-semibold text-slate-500">
                    {formatTime(inst.mid)}
                </span>
                <span className="truncate text-xs font-semibold text-slate-900">
                    {inst.stat || inst.category || "—"}
                </span>
                <span className="ml-auto shrink-0 text-[11px] font-medium text-slate-500">
                    {teamLabel ?? inst.team}
                    {inst.playerNumber != null ? ` #${inst.playerNumber}` : ""}
                </span>
                {onEdit && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit();
                        }}
                        title="Edit master instance"
                        className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                    >
                        <Pencil size={11} />
                    </button>
                )}
            </div>
        </div>
    );
}
