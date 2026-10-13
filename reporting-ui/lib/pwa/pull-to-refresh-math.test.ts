// Unit tests for the pull-to-refresh offset/threshold math. Mirrors the
// colocated-test convention used elsewhere (e.g. lib/comparison/*.test.ts).
import { describe, it, expect } from "vitest";
import { computePull, RESISTANCE } from "./pull-to-refresh-math";

const THRESHOLD = 70;
const MAX_OFFSET = 110;

describe("computePull", () => {
    it("returns a fully reset result for an upward drag", () => {
        expect(computePull(-120, THRESHOLD, MAX_OFFSET)).toEqual({
            offset: 0,
            crossed: false,
            progress: 0,
        });
    });

    it("returns a fully reset result for zero drag", () => {
        expect(computePull(0, THRESHOLD, MAX_OFFSET)).toEqual({
            offset: 0,
            crossed: false,
            progress: 0,
        });
    });

    it("applies resistance below the threshold without crossing", () => {
        // 100px raw * 0.5 = 50px resisted, which is below the 70px threshold.
        const result = computePull(100, THRESHOLD, MAX_OFFSET);
        expect(result.offset).toBe(50);
        expect(result.crossed).toBe(false);
        expect(result.progress).toBeCloseTo(50 / 70, 5);
    });

    it("keeps RESISTANCE pinned at 0.5", () => {
        expect(RESISTANCE).toBe(0.5);
    });

    it("crosses exactly at the threshold", () => {
        // 140px raw * 0.5 = 70px resisted == threshold.
        const result = computePull(140, THRESHOLD, MAX_OFFSET);
        expect(result.offset).toBe(70);
        expect(result.crossed).toBe(true);
        expect(result.progress).toBe(1);
    });

    it("crosses past the threshold", () => {
        const result = computePull(200, THRESHOLD, MAX_OFFSET);
        expect(result.offset).toBe(100);
        expect(result.crossed).toBe(true);
        expect(result.progress).toBe(1);
    });

    it("clamps the offset to maxOffset for very large drags", () => {
        // 1000px raw * 0.5 = 500px, clamped down to 110px.
        const result = computePull(1000, THRESHOLD, MAX_OFFSET);
        expect(result.offset).toBe(MAX_OFFSET);
        expect(result.crossed).toBe(true);
        expect(result.progress).toBe(1);
    });
});
