"use client";

// Competitor Intelligence — a register of market competitors and the links we
// monitor for each. Auto-collected posts (YouTube / RSS blogs) appear in the
// activity feed once the worker collector is wired; social platforms with no
// free public feed are stored as one-click "open profile" links with a
// last-reviewed marker. Admin/supervisor only.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Radar,
  Loader2,
  AlertTriangle,
  Plus,
  Search,
  ExternalLink,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Check,
} from "lucide-react";

import { useAuth } from "@/components/auth/AuthContext";
import {
  listCompetitors,
  createCompetitor,
  updateCompetitor,
  deleteCompetitor,
  listSources,
  addSource,
  deleteSource,
  markSourceReviewed,
  listRecentPosts,
  seedCompetitors,
  syncCompetitorFeeds,
  type Competitor,
  type CompetitorSource,
  type CompetitorPost,
  type CompetitorCategory,
  type SourcePlatform,
  type CollectionMethod,
} from "@/lib/api/competitors";

const CATEGORIES: CompetitorCategory[] = [
  "direct",
  "adjacent",
  "emerging",
  "technology",
  "partner",
];

const CATEGORY_BADGE: Record<CompetitorCategory, string> = {
  direct: "bg-red-500/15 text-red-300 ring-1 ring-red-500/30",
  adjacent: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
  emerging: "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/30",
  technology: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30",
  partner: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
};

const PLATFORMS: SourcePlatform[] = [
  "website",
  "blog",
  "youtube",
  "x",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
];

// Which platforms can auto-collect for free (worker polls these); everything
// else is a manual "open profile" link.
function defaultMethod(platform: SourcePlatform): CollectionMethod {
  if (platform === "youtube") return "youtube";
  if (platform === "blog") return "rss";
  return "manual";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export default function CompetitorsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";

  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [posts, setPosts] = useState<CompetitorPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sportFilter, setSportFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<Competitor | "new" | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        listCompetitors(false),
        listRecentPosts(60).catch(() => []),
      ]);
      setCompetitors(c);
      setPosts(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load competitors.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sports = useMemo(() => {
    const s = new Set<string>();
    for (const c of competitors) if (c.sport) s.add(c.sport);
    return Array.from(s).sort();
  }, [competitors]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return competitors.filter((c) => {
      if (sportFilter !== "all" && (c.sport ?? "") !== sportFilter) return false;
      if (catFilter !== "all" && c.category !== catFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q) ||
        (c.notes ?? "").toLowerCase().includes(q) ||
        (c.website ?? "").toLowerCase().includes(q)
      );
    });
  }, [competitors, query, sportFilter, catFilter]);

  const runSeed = async () => {
    if (!isAdmin) return;
    setSeeding(true);
    setNotice(null);
    try {
      const res = await seedCompetitors();
      setNotice(`Seeded ${res.added} competitor(s); ${res.skipped} already existed.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Seed failed.");
    } finally {
      setSeeding(false);
    }
  };

  const runSync = async () => {
    if (!isAdmin) return;
    setSyncing(true);
    setNotice(null);
    try {
      const res = await syncCompetitorFeeds();
      setNotice(
        res.sources === 0
          ? "Sync ran, but no auto (YouTube/RSS) sources are configured yet. Add a feed URL to a competitor's YouTube/blog source."
          : `Synced ${res.sources} feed source(s); up to ${res.inserted} item(s) collected.`
      );
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const removeCompetitor = async (c: Competitor) => {
    if (!isAdmin) return;
    if (!window.confirm(`Delete "${c.name}" and all its sources?`)) return;
    try {
      await deleteCompetitor(c.id);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Delete failed.");
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-full bg-gradient-to-b from-[#0B1220] to-[#0f172a] p-8 text-slate-200">
        <div className="mx-auto max-w-md rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-slate-400">
          Competitor Intelligence is available to admins and supervisors only.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-gradient-to-b from-[#0B1220] via-[#0d1526] to-[#0f172a] text-slate-100">
      <div className="mx-auto w-full max-w-6xl px-4 py-6">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <Radar size={20} className="text-sky-400" /> Competitor Intelligence
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Market monitoring — register competitors and the links we track.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {competitors.length === 0 && (
              <button
                onClick={runSeed}
                disabled={seeding}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50"
              >
                {seeding ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                Seed starter list
              </button>
            )}
            <button
              onClick={runSync}
              disabled={syncing}
              title="Collect new posts from YouTube/RSS sources now"
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              onClick={() => setEditing("new")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-700"
            >
              <Plus size={15} /> Add competitor
            </button>
          </div>
        </div>

        {/* Summary chips */}
        <div className="mb-4 flex flex-wrap gap-3 text-xs">
          <span className="rounded-lg bg-white/5 px-3 py-1.5 text-slate-300">
            {competitors.length} competitors
          </span>
          <span className="rounded-lg bg-white/5 px-3 py-1.5 text-slate-300">
            {sports.length} sports
          </span>
          <span className="rounded-lg bg-white/5 px-3 py-1.5 text-slate-300">
            {posts.length} auto-collected posts
          </span>
        </div>

        {notice && (
          <div className="mb-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
            {notice}
          </div>
        )}

        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] max-w-xs flex-1">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, notes, website…"
              className="w-full rounded-md border border-white/10 bg-[#0d1526] py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
          <select
            value={sportFilter}
            onChange={(e) => setSportFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-[#0d1526] px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="all">All sports</option>
            {sports.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-[#0d1526] px-2 py-1.5 text-xs text-slate-200 capitalize"
          >
            <option value="all">All types</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c} className="capitalize">{c}</option>
            ))}
          </select>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-400">
            {competitors.length === 0
              ? "No competitors yet. Click “Seed starter list” to add the researched set, or “Add competitor”."
              : "No competitors match the filter."}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10">
            {rows.map((c) => (
              <CompetitorRow
                key={c.id}
                competitor={c}
                expanded={expanded === c.id}
                onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
                onEdit={() => setEditing(c)}
                onDelete={() => removeCompetitor(c)}
              />
            ))}
          </div>
        )}

        {/* Activity feed */}
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-slate-200">Activity feed</h2>
          {posts.length === 0 ? (
            <p className="rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-xs text-slate-400">
              No auto-collected posts yet. Posts from YouTube/RSS sources will
              appear here once the collector runs. Social platforms are tracked
              as manual “open profile” links on each competitor.
            </p>
          ) : (
            <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
              {posts.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-20 shrink-0 text-[11px] text-slate-500">{fmtDate(p.published_at)}</span>
                  <a href={p.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-slate-200 hover:text-sky-300">
                    {p.title || p.url}
                  </a>
                  <span className="shrink-0 text-[10px] uppercase text-slate-500">{p.platform}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {editing && (
        <CompetitorEditModal
          competitor={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ── Competitor row (expandable, shows sources) ───────────────────────────────

function CompetitorRow({
  competitor: c,
  expanded,
  onToggle,
  onEdit,
  onDelete,
}: {
  competitor: Competitor;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [sources, setSources] = useState<CompetitorSource[] | null>(null);
  const [loadingSrc, setLoadingSrc] = useState(false);

  const loadSources = useCallback(async () => {
    setLoadingSrc(true);
    try {
      setSources(await listSources(c.id));
    } catch {
      setSources([]);
    } finally {
      setLoadingSrc(false);
    }
  }, [c.id]);

  useEffect(() => {
    if (expanded && sources === null) loadSources();
  }, [expanded, sources, loadSources]);

  return (
    <div className="border-b border-white/5 last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.03]">
        <button onClick={onToggle} className="text-slate-400 hover:text-slate-200">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-100">{c.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize ${CATEGORY_BADGE[c.category]}`}>
              {c.category}
            </span>
            {c.sport && <span className="text-[11px] text-slate-500">{c.sport}</span>}
          </div>
          {c.description && (
            <p className="mt-0.5 truncate text-[11px] text-slate-400">{c.description}</p>
          )}
        </div>
        {c.website && (
          <a href={c.website} target="_blank" rel="noreferrer" title="Open website"
             className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-sky-300">
            <ExternalLink size={14} />
          </a>
        )}
        <button onClick={onEdit} title="Edit" className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-200">
          <Pencil size={14} />
        </button>
        <button onClick={onDelete} title="Delete" className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-red-300">
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-white/5 bg-white/[0.02] px-10 py-3">
          <SourcesEditor
            competitorId={c.id}
            sources={sources}
            loading={loadingSrc}
            onChange={loadSources}
          />
        </div>
      )}
    </div>
  );
}

// ── Sources editor (per competitor) ──────────────────────────────────────────

function SourcesEditor({
  competitorId,
  sources,
  loading,
  onChange,
}: {
  competitorId: number;
  sources: CompetitorSource[] | null;
  loading: boolean;
  onChange: () => void | Promise<void>;
}) {
  const [platform, setPlatform] = useState<SourcePlatform>("website");
  const [url, setUrl] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const method = defaultMethod(platform);
  const isAuto = method !== "manual";

  const add = async () => {
    if (!url.trim()) return;
    setAdding(true);
    try {
      // For auto sources, use the explicit feed URL when given; otherwise fall
      // back to the profile URL (works when the profile URL IS a feed, e.g. a
      // pasted youtube.com/feeds/videos.xml?... link or a blog's /feed URL).
      const feed = isAuto ? feedUrl.trim() || url.trim() : null;
      await addSource({
        competitor_id: competitorId,
        platform,
        profile_url: url.trim(),
        feed_url: feed,
        collection_method: method,
        last_checked_at: null,
        last_status: null,
        last_reviewed_at: null,
      });
      setUrl("");
      setFeedUrl("");
      await onChange();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Sources &amp; social links
      </div>
      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {(sources ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 capitalize text-slate-400">{s.platform}</span>
              <a href={s.profile_url} target="_blank" rel="noreferrer" className="flex-1 truncate text-slate-300 hover:text-sky-300">
                {s.profile_url}
              </a>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                s.collection_method === "manual" ? "bg-white/5 text-slate-500" : "bg-emerald-500/15 text-emerald-300"
              }`}>
                {s.collection_method === "manual" ? "manual" : "auto"}
              </span>
              {s.collection_method === "manual" && (
                <button
                  onClick={async () => { await markSourceReviewed(s.id); await onChange(); }}
                  title={`Mark reviewed (last: ${fmtDate(s.last_reviewed_at)})`}
                  className="shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-emerald-300"
                >
                  <Check size={12} />
                </button>
              )}
              <button
                onClick={async () => { await deleteSource(s.id); await onChange(); }}
                className="shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-red-300"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
          {(sources ?? []).length === 0 && (
            <li className="text-xs text-slate-500">No sources yet.</li>
          )}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as SourcePlatform)}
          className="rounded-md border border-white/10 bg-[#0d1526] px-2 py-1 text-xs capitalize text-slate-200"
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p} className="capitalize">{p}</option>
          ))}
        </select>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Profile / page URL"
          className="min-w-[160px] flex-1 rounded-md border border-white/10 bg-[#0d1526] px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        {isAuto && (
          <input
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            placeholder={
              platform === "youtube"
                ? "Feed URL (youtube.com/feeds/videos.xml?channel_id=…)"
                : "RSS/Atom feed URL (optional — defaults to the page URL)"
            }
            className="min-w-[200px] flex-1 rounded-md border border-emerald-500/30 bg-[#0d1526] px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        )}
        <button
          onClick={add}
          disabled={adding || !url.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-40"
        >
          <Plus size={12} /> Add link
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-slate-500">
        YouTube and blog links auto-collect (every ~30 min); X / Instagram /
        Facebook / LinkedIn / TikTok are tracked as manual “open profile” links
        (no free live feed). For YouTube, paste the channel’s feed URL
        <span className="text-slate-400"> youtube.com/feeds/videos.xml?channel_id=…</span>
        — find the channel_id in the channel’s page source.
      </p>
    </div>
  );
}

// ── Add / edit competitor modal ──────────────────────────────────────────────

function CompetitorEditModal({
  competitor,
  onClose,
  onSaved,
}: {
  competitor: Competitor | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const isNew = competitor === null;
  const [name, setName] = useState(competitor?.name ?? "");
  const [website, setWebsite] = useState(competitor?.website ?? "");
  const [sport, setSport] = useState(competitor?.sport ?? "Aussie Rules");
  const [category, setCategory] = useState<CompetitorCategory>(competitor?.category ?? "direct");
  const [priority, setPriority] = useState<"high" | "medium" | "low">(competitor?.priority ?? "medium");
  const [description, setDescription] = useState(competitor?.description ?? "");
  const [notes, setNotes] = useState(competitor?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) { setErr("Name is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        name: name.trim(),
        website: website.trim() || null,
        sport: sport.trim() || null,
        category,
        priority,
        country: "Australia",
        description: description.trim() || null,
        notes: notes.trim() || null,
        status: "active" as const,
      };
      if (isNew) await createCompetitor(payload);
      else await updateCompetitor(competitor!.id, payload);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg border border-white/10 bg-[#0d1526] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-500";
  const label = "mb-1 block text-xs font-medium text-slate-400";

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="my-10 w-full max-w-lg rounded-2xl border border-white/10 bg-[#0d1526] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <h3 className="text-sm font-semibold text-slate-100">
            {isNew ? "Add competitor" : "Edit competitor"}
          </h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200">✕</button>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className={label}>Name *</label>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className={label}>Website</label>
            <input className={field} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label}>Sport</label>
              <input className={field} value={sport} onChange={(e) => setSport(e.target.value)} placeholder="Aussie Rules" />
            </div>
            <div>
              <label className={label}>Type</label>
              <select className={`${field} capitalize`} value={category} onChange={(e) => setCategory(e.target.value as CompetitorCategory)}>
                {CATEGORIES.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Priority</label>
              <select className={field} value={priority} onChange={(e) => setPriority(e.target.value as "high" | "medium" | "low")}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label}>Description</label>
            <textarea className={`${field} h-16 resize-none`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <label className={label}>Notes (internal)</label>
            <textarea className={`${field} h-16 resize-none`} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {err && <p className="text-xs text-red-300">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/10 p-4">
          <button onClick={onClose} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5">Cancel</button>
          <button onClick={save} disabled={saving} className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-40">
            {saving ? "Saving…" : isNew ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
