"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/UI/tabs";
import { THEME } from "@/lib/theme";
import DeputyApiView from "@/components/deputy/DeputyApiView";
import DeputyInsightsView from "@/components/deputy/DeputyInsightsView";
import { makeGamefaceDeputySource } from "@/lib/api/gamefaceDeputy";
import {
    clearStoredPassword,
    getStoredPassword,
    setStoredPassword,
} from "@/lib/activity/storedPassword";

type TabValue = "deputy-api" | "deputy-insights";

export default function GamefaceDeputyPage() {
    const { user } = useAuth();
    // The read function re-checks the admin password on every call. It is
    // remembered in sessionStorage (this tab only), shared with the other
    // admin gates.
    const [password, setPassword] = useState("");
    const [restored, setRestored] = useState(false);
    const [draft, setDraft] = useState("");
    const [checking, setChecking] = useState(false);
    const [gateError, setGateError] = useState("");
    const [tab, setTab] = useState<TabValue>("deputy-api");

    useEffect(() => {
        document.title = "GameFace Deputy | Premier Data";
        if (!user) return;
        setPassword(getStoredPassword(user.username) ?? "");
        setRestored(true);
    }, [user]);

    const username = user?.username ?? "";
    const source = useMemo(
        () => makeGamefaceDeputySource(username, password),
        [username, password]
    );

    const lock = useCallback(() => {
        clearStoredPassword();
        setPassword("");
    }, []);

    async function unlock() {
        if (!user || !draft) return;
        setChecking(true);
        setGateError("");
        try {
            await makeGamefaceDeputySource(user.username, draft).getRosters();
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

    if (!password) {
        return (
            <div className="min-h-full bg-slate-100 text-slate-900">
                <div className="mx-auto max-w-7xl p-6 lg:p-8">
                    <h1 className="text-3xl font-bold tracking-tight text-slate-900">GameFace Deputy</h1>
                    <div className="mx-auto mt-8 max-w-md rounded-2xl border border-slate-200 bg-white p-6">
                        <p className="flex items-center gap-2 font-semibold text-slate-900">
                            <Lock size={16} /> Confirm your password
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                            This roster is only released to an admin who confirms their password. It is remembered for this tab only, until you press Lock or close the tab.
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
                </div>
            </div>
        );
    }

    return (
        <div style={{ background: THEME.bg }}>
            <div className="flex items-center justify-between px-6 pt-6">
                <h1 className="text-2xl font-bold text-white">GameFace Deputy</h1>
                <button
                    type="button"
                    onClick={lock}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0f1b2d] px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                    title="Forget the password for this tab"
                >
                    <Lock size={14} />
                    Lock
                </button>
            </div>
            <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
                <TabsList className="mx-6 mt-4 flex gap-2 border-b border-slate-700">
                    <TabsTrigger value="deputy-api">Deputy API</TabsTrigger>
                    <TabsTrigger value="deputy-insights">Deputy Insights</TabsTrigger>
                </TabsList>
                <TabsContent value="deputy-api">
                    <DeputyApiView
                        source={source}
                        heading="GameFace Deputy"
                        subtitle="Rostered schedule and approved timesheets synced from the GameFace Deputy account (read-only)."
                    />
                </TabsContent>
                <TabsContent value="deputy-insights">
                    <DeputyInsightsView source={source} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
