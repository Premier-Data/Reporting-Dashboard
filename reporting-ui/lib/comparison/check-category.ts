// Pure auto-suggest for a saved check's category. Evaluated in a FIXED
// priority order so the save UI can pre-select a sensible default that matches
// how the check will actually be stored (overlap-scoped totals + the five
// Golden Player Accuracy groups). No React, no data-layer, no side effects —
// kept trivially unit-testable in a node vitest env.

import type { CheckCategory } from "@/lib/api/accuracyChecks";
import type { PlayerAccuracy } from "@/lib/comparison/player-accuracy";

// Golden Accuracy threshold: the master coded fewer than 60% of the analyst's
// events, i.e. a spot-check sample rather than a full re-grade.
const GOLDEN_RATIO = 0.6;

// The five Golden Player Accuracy GROUPS that define "full game vs specific
// stats" — the core four plus Other (NOT the derived `overall`).
const CATEGORY_GROUPS: readonly (keyof PlayerAccuracy)[] = [
    "passing",
    "offensive",
    "defensive",
    "goalkeeper",
    "other",
];

/**
 * Suggest a category from a check's overlap-scoped totals and player accuracy.
 *
 * Priority order:
 *   1. Golden Accuracy FIRST — when analystTotal > 0 and
 *      masterTotal / analystTotal < 0.60. If analystTotal is 0 the ratio rule
 *      is skipped (no divide-by-zero, never golden on this rule).
 *   2. Otherwise count how many of the five groups have master events > 0:
 *        3+ groups  → full_game
 *        1-2 groups → specific_stats
 *        0 groups   → full_game (sensible default for a check with no
 *                     player-accuracy data)
 */
export function suggestCheckCategory(args: {
    masterTotal: number;
    analystTotal: number;
    playerAccuracy: PlayerAccuracy;
}): CheckCategory {
    const { masterTotal, analystTotal, playerAccuracy } = args;

    // 1. Golden by ratio (guard divide-by-zero).
    if (analystTotal > 0 && masterTotal / analystTotal < GOLDEN_RATIO) {
        return "golden_accuracy";
    }

    // 2. Count groups with master events.
    const groupsWithEvents = CATEGORY_GROUPS.reduce(
        (n, g) => n + (playerAccuracy[g].master > 0 ? 1 : 0),
        0
    );

    if (groupsWithEvents >= 3) return "full_game";
    if (groupsWithEvents >= 1) return "specific_stats";
    return "full_game";
}
