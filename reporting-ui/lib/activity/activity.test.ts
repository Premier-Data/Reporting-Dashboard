import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import {
    BREAK_MS,
    ONLINE_WINDOW_MS,
    formatDuration,
    mergedLength,
    presenceStatus,
    sectionFromPath,
    summariseDays,
} from "./activity";

describe("presenceStatus", () => {
    const now = Date.parse("2025-01-01T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();

    it("is offline without presence or when last seen is too old", () => {
        expect(presenceStatus(null, null, now)).toBe("offline");
        expect(presenceStatus(ago(ONLINE_WINDOW_MS + 1), ago(1000), now)).toBe("offline");
    });
    it("is active when seen recently and active within the break window", () => {
        expect(presenceStatus(ago(10_000), ago(BREAK_MS - 1), now)).toBe("active");
    });
    it("is idle when seen recently but not active within the break window", () => {
        expect(presenceStatus(ago(10_000), ago(BREAK_MS), now)).toBe("idle");
        expect(presenceStatus(ago(10_000), null, now)).toBe("idle");
    });
    it("is online at exactly the online window", () => {
        expect(presenceStatus(ago(ONLINE_WINDOW_MS), null, now)).toBe("idle");
    });
});

describe("mergedLength", () => {
    it("merges overlapping and adjacent intervals and ignores gaps", () => {
        expect(
            mergedLength([
                { start: 0, end: 10 },
                { start: 5, end: 15 },
                { start: 20, end: 30 },
            ])
        ).toBe(25);
    });
    it("returns 0 for no intervals", () => {
        expect(mergedLength([])).toBe(0);
    });
});

describe("summariseDays", () => {
    it("cuts a stretch that crosses local midnight into two days", () => {
        const a = new Date(2025, 0, 1, 23, 30);
        const b = new Date(2025, 0, 2, 0, 30);
        const days = summariseDays(
            [{ id: "1", started_at: a.toISOString(), ended_at: b.toISOString(), section: "x" }],
            new Date(2025, 0, 1),
            new Date(2025, 0, 2)
        );
        expect(days).toHaveLength(2);
        expect(days[0].day).toBe(new Date(2025, 0, 2).getTime()); // newest first
        expect(days[0].workedMs).toBe(30 * 60_000);
        expect(days[1].workedMs).toBe(30 * 60_000);
    });
    it("includes days with no activity", () => {
        const days = summariseDays([], new Date(2025, 0, 1), new Date(2025, 0, 3));
        expect(days).toHaveLength(3);
        expect(days.every((d) => d.workedMs === 0 && d.first === null)).toBe(true);
    });
});

describe("formatDuration", () => {
    it("formats minutes and hours", () => {
        expect(formatDuration(5 * 60_000)).toBe("5m");
        expect(formatDuration(75 * 60_000)).toBe("1h 15m");
    });
});

describe("sectionFromPath", () => {
    it("uses the page key", () => {
        expect(sectionFromPath("/accuracy-compare")).toBe("accuracy-compare");
    });
    it("maps aliased routes to their parent key", () => {
        expect(sectionFromPath("/push-log")).toBe("live-scores");
    });
    it("is dashboard for the root", () => {
        expect(sectionFromPath("/")).toBe("dashboard");
    });
    it("falls back to the first path segment for unknown routes", () => {
        expect(sectionFromPath("/something-new/abc")).toBe("something-new");
    });
});
