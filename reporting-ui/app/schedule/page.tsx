"use client";
import { Suspense } from "react";
import { Lock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthContext";
import GamefaceGate from "@/components/deputy/GamefaceGate";
import {
    GAMEFACE_PAGE_KEY,
    resolveScheduleDeputy,
    type ScheduleDeputy,
} from "@/lib/deputy/scheduleChoice";
import ScheduleView from "./ScheduleView";

function SchedulePageInner() {
    const router = useRouter();
    const params = useSearchParams();
    const { hasAccess } = useAuth();
    const canSeeGameface = hasAccess(GAMEFACE_PAGE_KEY);
    const deputy = resolveScheduleDeputy(params.get("deputy"), canSeeGameface);

    function choose(next: ScheduleDeputy) {
        router.replace(next === "gameface" ? "/schedule?deputy=gameface" : "/schedule");
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
