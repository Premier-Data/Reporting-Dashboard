"use client";
import { Suspense, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthContext";
import GamefaceGate from "@/components/deputy/GamefaceGate";
import {
    GAMEFACE_PAGE_KEY,
    resolveScheduleDeputy,
    type ScheduleDeputy,
} from "@/lib/deputy/scheduleChoice";
import ScheduleView from "./ScheduleView";

function SchedulePageInner() {
    const params = useSearchParams();
    const { hasAccess } = useAuth();
    const canSeeGameface = hasAccess(GAMEFACE_PAGE_KEY);
    // The choice lives in state so the view switches immediately. On the static
    // export a query-only router.replace did not reliably re-render the page.
    // The URL is kept in sync with history.pushState, and popstate (back/forward)
    // feeds the state back.
    const [param, setParam] = useState<string | null>(params.get("deputy"));
    const deputy = resolveScheduleDeputy(param, canSeeGameface);

    useEffect(() => {
        const onPop = () => setParam(new URLSearchParams(window.location.search).get("deputy"));
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    function choose(next: ScheduleDeputy) {
        setParam(next === "gameface" ? "gameface" : null);
        window.history.pushState(null, "", next === "gameface" ? "/schedule?deputy=gameface" : "/schedule");
    }

    // Only users with GameFace access get a choice.
    const picker = canSeeGameface ? (
        <select
            aria-label="Deputy"
            value={deputy}
            onChange={(e) => choose(e.target.value as ScheduleDeputy)}
            className="mr-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700"
        >
            <option value="premier">Premier Data</option>
            <option value="gameface">GameFace</option>
        </select>
    ) : null;

    if (deputy === "gameface") {
        return (
            <GamefaceGate title="GameFace Schedule" headerExtra={picker}>
                {({ source, lock }) => (
                    <ScheduleView
                        key="gameface"
                        source={source}
                        title="GameFace Schedule"
                        subtitle="GameFace Deputy roster and approved shifts (read-only)"
                        headerExtra={
                            <>
                                {picker}
                                <button
                                    type="button"
                                    onClick={lock}
                                    className="mr-1 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                                    title="Forget the password for this tab"
                                >
                                    <Lock size={12} />
                                    Lock
                                </button>
                            </>
                        }
                    />
                )}
            </GamefaceGate>
        );
    }

    return <ScheduleView key="premier" headerExtra={picker} />;
}

export default function SchedulePage() {
    return (
        <Suspense fallback={null}>
            <SchedulePageInner />
        </Suspense>
    );
}
