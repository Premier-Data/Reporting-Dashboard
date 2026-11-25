"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/UI/tabs";
import { THEME } from "@/lib/theme";
import DeputyApiView from "@/components/deputy/DeputyApiView";
import DeputyInsightsView from "@/components/deputy/DeputyInsightsView";
import GamefaceGate from "@/components/deputy/GamefaceGate";

type TabValue = "deputy-api" | "deputy-insights";

export default function GamefaceDeputyPage() {
    const [tab, setTab] = useState<TabValue>("deputy-api");

    return (
        <GamefaceGate title="GameFace Deputy">
            {({ source, lock }) => (
                <div style={{ background: THEME.bg }}>
                    <div className="flex items-center justify-between px-6 pt-6">
                        <h1 className="text-2xl font-bold text-white">GameFace Deputy</h1>
                        <div className="flex items-center gap-2">

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
            )}
        </GamefaceGate>
    );
}
