// Editable rule table that turns an error pattern into a suggested practice
// for the training plan. First rule whose provided fields all match wins; if
// none match, DEFAULT_DRILLS[type] is used. Keep the most specific rules first.

export type ErrorType =
  | "missed"
  | "extra"
  | "wrong_player"
  | "wrong_stat"
  | "wrong_team";

export type DrillRule = {
  stat?: RegExp;
  category?: RegExp;
  type?: ErrorType;
  text: string;
};

export const DRILL_RULES: DrillRule[] = [
  {
    type: "missed",
    stat: /tackle|hit ?out|ground ball|loose ball|contested|smother|block/i,
    text: "Run a second pass at 0.5x speed over busy passages; practise the shortcut for this stat until tagging takes under a second.",
  },
  {
    type: "wrong_player",
    text: "Re-watch the flagged clips with the roster open; confirm jersey number and kit colours before tagging; practise on 10 clips from the listed timestamps.",
  },
  {
    type: "extra",
    text: "Re-read the definition of the stat and the duplicate rule; check each listed clip against it before tagging.",
  },
  {
    type: "wrong_stat",
    text: "Compare the coded stat with the master for each clip; review the definition boundary between the two stats.",
  },
  {
    type: "wrong_team",
    text: "Check attacking direction and kit colours at the start of each period; re-tag the listed clips.",
  },
];

export const DEFAULT_DRILLS: Record<ErrorType, string> = {
  missed:
    "Review the flagged clips and re-watch busy passages at reduced speed so no events are skipped.",
  extra:
    "Check each flagged clip against the stat definition before tagging; remove events that do not qualify.",
  wrong_player:
    "Confirm the jersey number against the roster before tagging; re-watch the flagged clips.",
  wrong_stat:
    "Review the definitions of the stats that were confused and re-tag the flagged clips.",
  wrong_team:
    "Confirm team colours and attacking direction before tagging; re-tag the flagged clips.",
};

export function drillFor(
  stat: string | null,
  category: string | null,
  type: ErrorType
): string {
  for (const rule of DRILL_RULES) {
    if (rule.type !== undefined && rule.type !== type) continue;
    if (rule.stat !== undefined && !(stat != null && rule.stat.test(stat)))
      continue;
    if (
      rule.category !== undefined &&
      !(category != null && rule.category.test(category))
    )
      continue;
    return rule.text;
  }
  return DEFAULT_DRILLS[type];
}
