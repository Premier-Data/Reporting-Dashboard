import { describe, it, expect } from "vitest";
import type { Dispute } from "@/lib/api/disputes";
import {
    groupByMasterInstance,
    buildMasterSummaries,
    buildCheckInfoMap,
    type CheckInfo,
} from "./groupByMasterInstance";

let nextId = 1;
function d(p: Partial<Dispute>): Dispute {
    return {
        id: nextId++,
        created_at: "2025-01-01T00:00:00Z",
        check_id: 1,
        instance_id: "x",
        side: "master",
        stat: "Goal",
        player: "#7",
        team: "Home",
        code_time: 100,
        raised_by: null,
        reason: null,
        category: null,
        status: "open",
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
        deleted_at: null,
        deleted_by: null,
        ...p,
    };
}
const info = (mk: string, analyst: string, tolerance: number | null = 3): CheckInfo => ({
    masterKey: mk,
    analyst,
    tolerance,
});
const checks = (o: Record<number, CheckInfo>) =>
    new Map<number, CheckInfo>(Object.entries(o).map(([k, v]) => [Number(k), v]));

const std = checks({
    1: info("m1", "Ann"),
    2: info("m1", "Bob"),
    3: info("m1", "Cat"),
    4: info("m2", "Ann"),
});

describe("groupByMasterInstance", () => {
    it("groups the same master event across analysts", () => {
        const g = groupByMasterInstance(
            [d({ check_id: 1 }), d({ check_id: 2 }), d({ check_id: 3, code_time: 100.3 })],
            std
        );
        expect(g).toHaveLength(1);
        expect(g[0].analystCount).toBe(3);
        expect(g[0].kind).toBe("master");
    });

    it("does not merge distinct master events 2s apart", () => {
        const g = groupByMasterInstance(
            [d({ check_id: 1, code_time: 100 }), d({ check_id: 2, code_time: 102 })],
            std
        );
        expect(g).toHaveLength(2);
    });

    it("does not chain-merge master events (0, 0.4, 0.8)", () => {
        const g = groupByMasterInstance(
            [
                d({ check_id: 1, code_time: 100 }),
                d({ check_id: 2, code_time: 100.4 }),
                d({ check_id: 3, code_time: 100.8 }),
            ],
            std
        );
        expect(g.map((x) => x.disputes.length).sort()).toEqual([1, 2]);
    });

    it("does not chain-merge analyst events beyond the anchor tolerance", () => {
        const c = checks({ 1: info("m1", "A"), 2: info("m1", "B"), 3: info("m1", "C") });
        const g = groupByMasterInstance(
            [
                d({ check_id: 1, side: "analyst", code_time: 100 }),
                d({ check_id: 2, side: "analyst", code_time: 102.5 }),
                d({ check_id: 3, side: "analyst", code_time: 105 }),
            ],
            c
        );
        expect(g).toHaveLength(2);
    });

    it("attaches an analyst-side dispute within tolerance to a master group (mixed)", () => {
        const g = groupByMasterInstance(
            [d({ check_id: 1, side: "master" }), d({ check_id: 2, side: "analyst", code_time: 102 })],
            std
        );
        expect(g).toHaveLength(1);
        expect(g[0].kind).toBe("mixed");
        expect(g[0].time).toBe(100);
    });

    it("uses the smaller tolerance (3 vs 5)", () => {
        const c = checks({ 1: info("m1", "A", 3), 2: info("m1", "B", 5) });
        const g = groupByMasterInstance(
            [d({ check_id: 1, side: "master" }), d({ check_id: 2, side: "analyst", code_time: 104 })],
            c
        );
        expect(g).toHaveLength(2);
    });

    it("merges AFc / AFC masters via the normalised key and #07 / 7", () => {
        const c = buildCheckInfoMap([
            { id: 1, file_name_master: "AFc", analyst_name: "A" },
            { id: 2, file_name_master: " AFC ", analyst_name: "B" },
        ]);
        const g = groupByMasterInstance(
            [d({ check_id: 1, player: "#07" }), d({ check_id: 2, player: "7" })],
            c
        );
        expect(g).toHaveLength(1);
    });

    it("never mixes different masters", () => {
        const g = groupByMasterInstance([d({ check_id: 1 }), d({ check_id: 4 })], std);
        expect(g).toHaveLength(2);
    });

    it("different player or stat means a different group", () => {
        const g = groupByMasterInstance(
            [d({ check_id: 1 }), d({ check_id: 2, player: "#8" }), d({ check_id: 3, stat: "Behind" })],
            std
        );
        expect(g).toHaveLength(3);
    });

    it("same check and side twice splits; opposite sides stay together", () => {
        const split = groupByMasterInstance(
            [d({ check_id: 1, code_time: 100 }), d({ check_id: 1, code_time: 100.2 })],
            std
        );
        expect(split).toHaveLength(2);
        const together = groupByMasterInstance(
            [d({ check_id: 1, side: "master" }), d({ check_id: 1, side: "analyst", code_time: 101 })],
            std
        );
        expect(together).toHaveLength(1);
    });

    it("same analyst on two checks counts once; blank analysts count separately", () => {
        const c = checks({ 1: info("m1", "Ann"), 2: info("m1", " ann "), 3: info("m1", ""), 4: info("m1", "") });
        const g = groupByMasterInstance(
            [d({ check_id: 1 }), d({ check_id: 2 })],
            c
        );
        expect(g[0].analystCount).toBe(1);
        expect(g[0].checkCount).toBe(2);
        const b = groupByMasterInstance([d({ check_id: 3 }), d({ check_id: 4 })], c);
        expect(b[0].analystCount).toBe(2);
    });

    it("keeps unkeyable disputes as single groups", () => {
        const g = groupByMasterInstance(
            [
                d({ check_id: 99 }),
                d({ check_id: 1, code_time: null }),
                d({ check_id: 1, stat: " " }),
                d({ check_id: 1, player: null, code_time: 5 }),
            ],
            std
        );
        expect(g).toHaveLength(4);
        expect(g.filter((x) => !x.keyable)).toHaveLength(3);
        expect(g.filter((x) => !x.keyable).every((x) => x.key.startsWith("single:"))).toBe(true);
    });

    it("includes resolved disputes with correct counts", () => {
        const g = groupByMasterInstance(
            [d({ check_id: 1 }), d({ check_id: 2, status: "confirmed" })],
            std
        );
        expect(g[0].openCount).toBe(1);
        expect(g[0].resolvedCount).toBe(1);
    });

    it("target prefers open master-side, and time equals target time", () => {
        const g = groupByMasterInstance(
            [
                d({ id: 500, check_id: 1, side: "analyst", code_time: 99 }),
                d({ id: 501, check_id: 2, side: "master", code_time: 100, status: "denied" }),
                d({ id: 502, check_id: 3, side: "master", code_time: 100.2 }),
            ],
            std
        );
        expect(g[0].target.id).toBe(502);
        expect(g[0].time).toBe(100.2);
    });

    it("analyst_only group uses min time", () => {
        const g = groupByMasterInstance(
            [
                d({ check_id: 1, side: "analyst", code_time: 101 }),
                d({ check_id: 2, side: "analyst", code_time: 100 }),
            ],
            std
        );
        expect(g[0].kind).toBe("analyst_only");
        expect(g[0].time).toBe(100);
    });

    it("orders by analysts desc then time", () => {
        const g = groupByMasterInstance(
            [
                d({ check_id: 1, code_time: 10 }),
                d({ check_id: 1, code_time: 50 }),
                d({ check_id: 2, code_time: 50 }),
            ],
            std
        );
        expect(g[0].time).toBe(50);
        expect(g[0].analystCount).toBe(2);
        expect(g[1].time).toBe(10);
    });

    it("flags conflicting categories", () => {
        const g = groupByMasterInstance(
            [
                d({ check_id: 1, category: "stat_difference" }),
                d({ check_id: 2, category: "timing_comparison" }),
                d({ check_id: 3, category: null }),
            ],
            std
        );
        expect(g[0].conflicting).toBe(true);
        const same = groupByMasterInstance(
            [d({ check_id: 1, category: "stat_difference" }), d({ check_id: 2, category: null })],
            std
        );
        expect(same[0].conflicting).toBe(false);
    });

    it("handles empty input", () => {
        expect(groupByMasterInstance([], std)).toEqual([]);
    });
});

describe("buildMasterSummaries", () => {
    const rows = [
        { id: 1, file_name_master: "M1", analyst_name: "Ann" },
        { id: 2, file_name_master: "m1", analyst_name: "Bob" },
        { id: 4, file_name_master: "M2", analyst_name: "Ann" },
    ];
    const cm = buildCheckInfoMap(rows);

    it("orders by open multi groups and excludes analyst-only from multi", () => {
        const groups = groupByMasterInstance(
            [
                d({ check_id: 1 }),
                d({ check_id: 2 }),
                d({ check_id: 4, code_time: 5 }),
                d({ check_id: 4, code_time: 6, side: "analyst" }),
                d({ check_id: 4, code_time: 6.5, side: "analyst", stat: "Goal" }),
            ],
            cm
        );
        const s = buildMasterSummaries(groups, rows);
        expect(s[0].masterKey).toBe("m1");
        expect(s[0].openMultiGroups).toBe(1);
        expect(s[0].analysts).toBe(2);
        expect(s[1].openMultiGroups).toBe(0);
    });

    it("appends the unassigned pseudo master last", () => {
        const groups = groupByMasterInstance([d({ check_id: 99 }), d({ check_id: 1 })], cm);
        const s = buildMasterSummaries(groups, rows);
        expect(s[s.length - 1].masterKey).toBe("");
    });
});
