"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, HardDrive, Loader2, Lock, RefreshCw, Search } from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import {
    fetchR2Report,
    rescanR2Report,
    type R2ReportResponse,
} from "@/lib/api/r2Report";
import { buildVisibleRows, formatBytes } from "@/lib/r2/folderTree";
import { exportR2StorageCsv, exportR2StorageExcel } from "@/lib/exports/r2StorageExcel";
import {
    clearStoredPassword,
    getStoredPassword,
    isBadCredentials,
    setStoredPassword,
} from "@/lib/activity/storedPassword";

const POLL_MS = 30_000;

export default function R2StoragePage() {
    const { user } = useAuth();
    // The Worker re-checks the admin password on every call. It is remembered
    // in sessionStorage (this tab only), shared with the Activity Log gate.
    const [password, setPassword] = useState("");
    const [restored, setRestored] = useState(false);
    const [draft, setDraft] = useState("");
    const [checking, setChecking] = useState(false);
    const [gateError, setGateError] = useState("");

    useEffect(() => {
        if (!user) return;
        setPassword(getStoredPassword(user.username) ?? "");
        setRestored(true);
    }, [user]);

    const lock = useCallback(() => {
        clearStoredPassword();
        setPassword("");
    }, []);

    async function unlock() {
        if (!user || !draft) return;
        setChecking(true);
        setGateError("");
        try {
            await fetchR2Report(user.username, draft);
            setStoredPassword(user.username, draft);
            setPassword(draft);
            setDraft("");
        } catch (err) {
            setGateError(err instanceof Error ? err.message : "Couldn't verify password");
        } finally {
            setChecking(false);
        }
    }

    if (!user || !restored) return null;

    return (
        <div className="min-h-full bg-slate-100 text-slate-900">
            <div className="mx-auto max-w-7xl p-6 lg:p-8">
                {password && (
                    <div className="mb-4 flex justify-end">
                        <button
                            type="button"
                            onClick={lock}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                            title="Forget the password for this tab"
                        >
                            <Lock size={14} />
                            Lock
                        </button>
                    </div>
                )}
                <div className="mb-6">
                    <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
                        <HardDrive size={26} /> R2 Storage
                    </h1>
                    <p className="mt-2 text-sm text-slate-600">
                        Folder sizes in the &quot;video&quot; bucket. Parent folders include their nested folders, so do not add parent and child rows together.
                    </p>
                </div>
                {!password ? (
                    <div className="mx-auto mt-8 max-w-md rounded-2xl border border-slate-200 bg-white p-6">
                        <p className="flex items-center gap-2 font-semibold text-slate-900">
                            <Lock size={16} /> Confirm your password
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                            Storage figures are only released to an admin who confirms their password. It is remembered for this tab only, until you press Lock or close the tab.
                        </p>
                        <form
                            className="mt-4 flex gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                unlock();
                            }}
                        >
                            <input
                                type="password"
                                autoComplete="current-password"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder="Password"
                                className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                            />
                            <button
                                type="submit"
                                disabled={checking || !draft}
                                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                                {checking ? "Checking..." : "Unlock"}
                            </button>
                        </form>
                        {gateError && <p className="mt-3 text-sm text-red-600">{gateError}</p>}
                    </div>
                ) : (
                    <Report username={user.username} password={password} onAuthError={lock} />
                )}
            </div>
        </div>
    );
}

function Report({
    username,
    password,
    onAuthError,
}: {
    username: string;
    password: string;
    onAuthError: () => void;
}) {
    const [data, setData] = useState<R2ReportResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [rescanning, setRescanning] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(async () => {
        try {
            const res = await fetchR2Report(username, password);
            setData(res);
            setError("");
        } catch (err) {
            if (isBadCredentials(err)) {
                onAuthError();
                return;
            }
            setError(err instanceof Error ? err.message : "Couldn't load the report");
        } finally {
            setLoading(false);
        }
    }, [username, password, onAuthError]);

    useEffect(() => {
        load();
    }, [load]);

    const running = data?.scan.status === "running";

    useEffect(() => {
        if (!running) return;
        const id = setInterval(load, POLL_MS);
        return () => clearInterval(id);
    }, [running, load]);

    // Tick once a second only while a cooldown is counting down.
    const cooldownEnd = data?.nextRescanAt ? new Date(data.nextRescanAt).getTime() : 0;
    const cooldownMs = Math.max(0, cooldownEnd - now);
    useEffect(() => {
        if (cooldownEnd <= Date.now()) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [cooldownEnd]);

    async function rescan() {
        setRescanning(true);
        setNotice("");
        try {
            const res = await rescanR2Report(username, password);
            if (!res.ok && res.reason === "cooldown") {
                setNow(Date.now());
                setNotice(`Rescan is on cooldown. Try again in ${Math.ceil(res.retryAfterSeconds / 60)} min.`);
            } else if (!res.ok) {
                setNotice("A scan is already running.");
            } else {
                setNotice("Rescan requested. Listing starts within 2 minutes.");
            }
            await load();
        } catch (err) {
            if (isBadCredentials(err)) {
                onAuthError();
                return;
            }
            setError(err instanceof Error ? err.message : "Couldn't start a rescan");
        } finally {
            setRescanning(false);
        }
    }

    const snapshot = data?.snapshot ?? null;
    const rows = useMemo(
        () => (snapshot ? buildVisibleRows(snapshot.folders, expanded, search) : []),
        [snapshot, expanded, search]
    );

    function toggle(prefix: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(prefix)) next.delete(prefix);
            else next.add(prefix);
            return next;
        });
    }

    const searching = search.trim() !== "";
    const rescanDisabled = rescanning || running || cooldownMs > 0;
    const cooldownLabel = cooldownMs > 0 ? ` (${Math.ceil(cooldownMs / 60000)} min)` : "";

    if (loading) {
        return (
            <p className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 size={16} className="animate-spin" /> Loading...
            </p>
        );
    }

    return (
        <div className="space-y-4">
            {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
            )}
            {notice && (
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">{notice}</div>
            )}
            {running && data && (
                <div className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                    <Loader2 size={16} className="animate-spin" />
                    Scan in progress: {data.scan.objectsScanned.toLocaleString()} objects scanned so far.
                    {snapshot ? " The figures below are from the previous scan." : ""}
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Bucket total</p>
                    <p className="mt-1 text-2xl font-bold">{snapshot ? formatBytes(snapshot.totalBytes) : "-"}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Files</p>
                    <p className="mt-1 text-2xl font-bold">{snapshot ? snapshot.totalFiles.toLocaleString() : "-"}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Last scanned</p>
                    <p className="mt-1 text-lg font-semibold">
                        {snapshot
                            ? new Date(snapshot.scannedAt).toLocaleString("en-AU", {
                                  timeZone: "Australia/Melbourne",
                                  dateStyle: "medium",
                                  timeStyle: "short",
                              })
                            : "No scan yet"}
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[16rem] flex-1">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search folders"
                        className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:border-blue-500"
                    />
                </div>
                <button
                    type="button"
                    disabled={!snapshot}
                    onClick={() => snapshot && exportR2StorageExcel(snapshot)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                    <Download size={14} /> Excel
                </button>
                <button
                    type="button"
                    disabled={!snapshot}
                    onClick={() => snapshot && exportR2StorageCsv(snapshot)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                    <Download size={14} /> CSV
                </button>
                <button
                    type="button"
                    disabled={rescanDisabled}
                    onClick={rescan}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    title={running ? "A scan is running" : cooldownMs > 0 ? "Rescan is on cooldown" : "Scan the bucket again"}
                >
                    <RefreshCw size={14} className={rescanning || running ? "animate-spin" : ""} />
                    Rescan{cooldownLabel}
                </button>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
                <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Folder</th>
                            <th className="px-4 py-3 text-right">Files</th>
                            <th className="px-4 py-3 text-right">Size</th>
                            <th className="px-4 py-3 text-right">% of parent</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => {
                            const open = searching || expanded.has(r.prefix);
                            return (
                                <tr key={r.prefix} className="border-t border-slate-100">
                                    <td className="px-4 py-2" style={{ paddingLeft: 16 + r.depth * 20 }}>
                                        {r.hasChildren ? (
                                            <button
                                                type="button"
                                                onClick={() => toggle(r.prefix)}
                                                className="inline-flex items-center gap-1 font-medium text-slate-900"
                                                aria-expanded={open}
                                            >
                                                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                {r.name}/
                                            </button>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 pl-[18px] text-slate-800">{r.name}/</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2 text-right tabular-nums">{r.files.toLocaleString()}</td>
                                    <td className="px-4 py-2 text-right tabular-nums">{formatBytes(r.bytes)}</td>
                                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                                        {r.pctOfParent === null ? "" : `${r.pctOfParent.toFixed(1)}%`}
                                    </td>
                                </tr>
                            );
                        })}
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                                    {snapshot
                                        ? searching
                                            ? "No folders match your search."
                                            : "The bucket has no folders."
                                        : running
                                          ? "The first scan is running. Check back soon."
                                          : "No scan has finished yet. Press Rescan to start one."}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
