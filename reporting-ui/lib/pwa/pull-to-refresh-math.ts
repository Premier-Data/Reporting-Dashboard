// Pure math for the mobile pull-to-refresh gesture. No DOM, no imports — the
// only piece worth unit-testing in isolation from the touch/DOM plumbing.

/** Resistance applied to the raw drag distance so the pull feels "heavy". */
export const RESISTANCE = 0.5;

export interface PullResult {
    /** Resisted offset in px, clamped to [0, maxOffset]. */
    offset: number;
    /** True once the resisted offset reaches the threshold. */
    crossed: boolean;
    /** offset / threshold, clamped to [0, 1] (indicator fill / arrow fade). */
    progress: number;
}

/**
 * Resisted vertical offset for a raw downward drag distance.
 *
 * - A non-positive drag (upward / none) yields a fully reset result.
 * - Otherwise offset = min(rawDeltaY * RESISTANCE, maxOffset).
 * - crossed is true when offset >= threshold.
 * - progress is offset / threshold clamped to [0, 1].
 */
export function computePull(
    rawDeltaY: number,
    threshold: number,
    maxOffset: number
): PullResult {
    if (rawDeltaY <= 0) {
        return { offset: 0, crossed: false, progress: 0 };
    }

    const offset = Math.min(rawDeltaY * RESISTANCE, maxOffset);
    const crossed = offset >= threshold;
    const progress = Math.min(offset / threshold, 1);

    return { offset, crossed, progress };
}
