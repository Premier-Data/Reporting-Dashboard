// AFL Golden Player Accuracy — analyst's coded VOLUME vs the master's, grouped
// into Overall / Scoring / Defence / Possession / Disposals / Other, using the
// SAME exact-match engine as football (the shared `buildGroup`).
//
// Unlike football, AFL has no derived aggregates: each stat is its own group
// part. The AFL classifier is a direct, collision-safe keyword matcher
// (first-match-wins) returning the single part key a stat label increments.
// AFL gets EXACT-match only — it passes an empty loosePassPartKeys set so the
// football looser same-player pass rule can never apply here.
//
// Pure module — no React/DOM. Overall spans ALL FIVE groups' parts (per the
// user's explicit confirmation), deliberately different from football's
// core-only Overall.

import {
  buildGroup,
  type AccuracyGroup,
  type AccuracyGroupDef,
  type AccuracyPart,
  type PlayerAccuracyScope,
  type StatClassifier,
} from "./player-accuracy";
import {
  canonicaliseTeams,
  compareInstances,
  type ComparisonRow,
  type Instance,
} from "./xml-compare";

// Re-export the shared accuracy shapes so callers can import them from here
// alongside the AFL helpers if they prefer.
export type { AccuracyGroup, AccuracyGroupDef, AccuracyPart };

// Open string->number map of AFL stat counts.
export type AflCounts = Record<string, number>;

// All 46 AFL stat keys, zeroed. Keys match the part keys in AFL_GROUPS and the
// keys written by bumpAfl.
export function initAflCounts(): AflCounts {
  return {
    // Scoring (9)
    shotInPlay: 0,
    setShot: 0,
    goal: 0,
    behind: 0,
    rushedBehind: 0,
    shallowI50: 0,
    deepI50: 0,
    shallowRebound: 0,
    deepRebound: 0,
    // Defence (8)
    effectiveTackle: 0,
    ineffectiveTackle: 0,
    pressureAct: 0,
    chase: 0,
    spoil: 0,
    smother: 0,
    block: 0,
    knockOn: 0,
    // Possession (7)
    turnover: 0,
    intercept: 0,
    looseBallGet: 0,
    hardBallGet: 0,
    gather: 0,
    contestedGather: 0,
    bounce: 0,
    // Disposals (11)
    effectiveKick: 0,
    ineffectiveKick: 0,
    kickIns: 0,
    effectiveHandball: 0,
    ineffectiveHandball: 0,
    handballReceive: 0,
    contestedMark: 0,
    uncontestedMark: 0,
    interceptMark: 0,
    shallowI50Mark: 0,
    deepI50Mark: 0,
    // Other (11)
    aroundGroundBounce: 0,
    boundaryThrowIn: 0,
    centreBounce: 0,
    freeKickFor: 0,
    freeKickAgainst: 0,
    fiftyMPenalty: 0,
    outOnTheFull: 0,
    hitOut: 0,
    hitOutToAdvantage: 0,
    ruckGather: 0,
    clearance: 0,
  };
}

// Classify one lowercased stat label into exactly one count key. Matching is
// `s.includes(keyword)`, FIRST-MATCH-WINS: whenever keyword B is a substring of
// keyword A, A is tested first so the more specific phrase wins. Unknown labels
// match nothing (contribute to no group) — mirroring football's behavior.
export function bumpAfl(c: AflCounts, s: string): void {
  // --- Mark variants first (contain shorter phrases) ---
  if (s.includes("intercept mark")) c.interceptMark += 1; // before bare "intercept"
  // i50 marks: real labels are "Marks i50 - Shallow" / "Marks i50 - Deep".
  // Match the full "marks i50" phrase + depth so they never collide with the
  // Scoring "Shallow I50" / "Deep I50" parts (which have no "marks"/"i50 -").
  else if (s.includes("marks i50") && s.includes("shallow"))
    c.shallowI50Mark += 1;
  else if (s.includes("marks i50") && s.includes("deep")) c.deepI50Mark += 1;
  else if (s.includes("uncontested mark")) c.uncontestedMark += 1; // before "contested mark"
  else if (s.includes("contested mark")) c.contestedMark += 1;
  // --- Specific bounces before bare "bounce" ---
  else if (
    s.includes("around ground bounce") ||
    s.includes("around the ground bounce")
  )
    c.aroundGroundBounce += 1;
  else if (s.includes("centre bounce") || s.includes("center bounce"))
    c.centreBounce += 1;
  else if (s.includes("bounce")) c.bounce += 1; // bare bounce -> Possession
  // --- Boundary throw in ---
  else if (s.includes("boundary throw in") || s.includes("boundary throw"))
    c.boundaryThrowIn += 1;
  // --- Gather variants before bare "gather" ---
  else if (s.includes("ruck gather")) c.ruckGather += 1;
  else if (s.includes("contested gather")) c.contestedGather += 1;
  else if (s.includes("gather")) c.gather += 1;
  // --- Hit out to advantage before "hit out" ---
  else if (s.includes("hit out to advantage")) c.hitOutToAdvantage += 1;
  else if (s.includes("hit out")) c.hitOut += 1;
  // --- Tackle: master labels are "Tackles Ineff" / "Tackles Eff". Match
  //     "tackles ineff" BEFORE "tackles eff" ("ineff" contains "eff"). ---
  else if (s.includes("tackles ineff")) c.ineffectiveTackle += 1;
  else if (s.includes("tackles eff")) c.effectiveTackle += 1;
  // --- Kick outcomes before kick ins ---
  else if (s.includes("ineffective kick")) c.ineffectiveKick += 1;
  else if (s.includes("effective kick")) c.effectiveKick += 1;
  else if (
    s.includes("kick ins") ||
    s.includes("kick in") ||
    s.includes("kick-in")
  )
    c.kickIns += 1;
  // --- Handball: ineffective before effective, receive last ---
  else if (s.includes("ineffective handball")) c.ineffectiveHandball += 1;
  else if (s.includes("effective handball")) c.effectiveHandball += 1;
  else if (s.includes("handball receive")) c.handballReceive += 1;
  // --- Scoring: rushed behind before behind; set shot / shot in play ---
  else if (s.includes("rushed behind")) c.rushedBehind += 1;
  else if (s.includes("behind")) c.behind += 1;
  else if (s.includes("set shot")) c.setShot += 1;
  else if (s.includes("shot in play")) c.shotInPlay += 1;
  // --- i50 / rebound (marks already peeled off above) ---
  else if (s.includes("shallow i50")) c.shallowI50 += 1;
  else if (s.includes("deep i50")) c.deepI50 += 1;
  // Rebounds: master labels are "Rebound 50s - Shallow" / "Rebound 50s - Deep".
  // Match the full "rebound 50s" phrase + depth so a bare shallow/deep rule
  // (Scoring I50) can never catch them and vice versa.
  else if (s.includes("rebound 50s") && s.includes("shallow"))
    c.shallowRebound += 1;
  else if (s.includes("rebound 50s") && s.includes("deep"))
    c.deepRebound += 1;
  else if (s.includes("goal")) c.goal += 1;
  // --- Possession ---
  else if (s.includes("turnover")) c.turnover += 1;
  else if (s.includes("intercept")) c.intercept += 1; // after "intercept mark"
  else if (s.includes("loose ball get") || s.includes("loose ball"))
    c.looseBallGet += 1;
  else if (s.includes("hard ball get") || s.includes("hard ball"))
    c.hardBallGet += 1;
  // --- Defence ---
  else if (s.includes("pressure act")) c.pressureAct += 1;
  else if (s.includes("chase")) c.chase += 1;
  else if (s.includes("spoil")) c.spoil += 1;
  else if (s.includes("smother")) c.smother += 1;
  else if (s.includes("block")) c.block += 1;
  else if (s.includes("knock on")) c.knockOn += 1;
  // --- Other ---
  else if (s.includes("free kick for")) c.freeKickFor += 1;
  else if (s.includes("free kick against")) c.freeKickAgainst += 1;
  else if (
    s.includes("50m penalty") ||
    s.includes("50 m penalty") ||
    s.includes("50m")
  )
    c.fiftyMPenalty += 1;
  else if (s.includes("out on the full")) c.outOnTheFull += 1;
  else if (s.includes("clearance")) c.clearance += 1; // Other, NOT Possession/Defence
}

// AFL has no derived aggregates — each stat is its own part — so deriveAfl is
// the identity. Kept for symmetry with deriveFootball.
export function deriveAfl(c: AflCounts): AflCounts {
  return { ...c };
}

// The AFL classifier: run bumpAfl on a single stat label and return the set of
// keys with a positive count (exactly one, or empty if no keyword matched).
export const aflClassify: StatClassifier = (statLower: string) => {
  const c = initAflCounts();
  bumpAfl(c, statLower);
  const keys = new Set<string>();
  for (const k of Object.keys(c)) if ((c[k] ?? 0) > 0) keys.add(k);
  return keys;
};

// The five AFL groups. Order matters for display. Each part's `key` matches a
// bumpAfl count key; `label` is the human stat name.
export const AFL_GROUPS = {
  scoring: {
    label: "Scoring",
    parts: [
      { key: "shotInPlay", label: "Shot in Play" },
      { key: "setShot", label: "Set Shot" },
      { key: "goal", label: "Goal" },
      { key: "behind", label: "Behind" },
      { key: "rushedBehind", label: "Rushed Behind" },
      { key: "shallowI50", label: "Shallow I50" },
      { key: "deepI50", label: "Deep I50" },
      { key: "shallowRebound", label: "Shallow Rebound" },
      { key: "deepRebound", label: "Deep Rebound" },
    ],
  },
  defence: {
    label: "Defence",
    parts: [
      { key: "effectiveTackle", label: "Effective Tackle" },
      { key: "ineffectiveTackle", label: "Ineffective Tackle" },
      { key: "pressureAct", label: "Pressure Act" },
      { key: "chase", label: "Chase" },
      { key: "spoil", label: "Spoil" },
      { key: "smother", label: "Smother" },
      { key: "block", label: "Block" },
      { key: "knockOn", label: "Knock On" },
    ],
  },
  possession: {
    label: "Possession",
    parts: [
      { key: "turnover", label: "Turnover" },
      { key: "intercept", label: "Intercept" },
      { key: "looseBallGet", label: "Loose Ball Get" },
      { key: "hardBallGet", label: "Hard Ball Get" },
      { key: "gather", label: "Gather" },
      { key: "contestedGather", label: "Contested Gather" },
      { key: "bounce", label: "Bounce" },
    ],
  },
  disposals: {
    label: "Disposals",
    parts: [
      { key: "effectiveKick", label: "Effective Kick" },
      { key: "ineffectiveKick", label: "Ineffective Kick" },
      { key: "kickIns", label: "Kick Ins" },
      { key: "effectiveHandball", label: "Effective Handball" },
      { key: "ineffectiveHandball", label: "Ineffective Handball" },
      { key: "handballReceive", label: "Handball Receive" },
      { key: "contestedMark", label: "Contested Mark" },
      { key: "uncontestedMark", label: "Uncontested Mark" },
      { key: "interceptMark", label: "Intercept Mark" },
      { key: "shallowI50Mark", label: "Shallow i50 Mark" },
      { key: "deepI50Mark", label: "Deep i50 Mark" },
    ],
  },
  other: {
    label: "Other",
    parts: [
      { key: "aroundGroundBounce", label: "Around Ground Bounce" },
      { key: "boundaryThrowIn", label: "Boundary Throw In" },
      { key: "centreBounce", label: "Centre Bounce" },
      { key: "freeKickFor", label: "Free Kick For" },
      { key: "freeKickAgainst", label: "Free Kick Against" },
      { key: "fiftyMPenalty", label: "50m Penalty" },
      { key: "outOnTheFull", label: "Out on the Full" },
      { key: "hitOut", label: "Hit Out" },
      { key: "hitOutToAdvantage", label: "Hit Out to Advantage" },
      { key: "ruckGather", label: "Ruck Gather" },
      { key: "clearance", label: "Clearance" },
    ],
  },
} as const;

export type AflPlayerAccuracy = {
  overall: AccuracyGroup;
  scoring: AccuracyGroup;
  defence: AccuracyGroup;
  possession: AccuracyGroup;
  disposals: AccuracyGroup;
  other: AccuracyGroup;
};

// Build-group options for AFL: the AFL classifier + an EMPTY loosePassPartKeys
// set so the football looser same-player pass rule can NEVER apply to AFL.
const AFL_OPTS = {
  classify: aflClassify,
  loosePassPartKeys: new Set<string>(),
} as const;

/**
 * Compute the AFL Golden Player Accuracy groups (EXACT-match / event-level)
 * from scoped comparison rows. Reuses the shared buildGroup with the AFL
 * classifier. Overall spans ALL FIVE groups' parts (master = sum of the five
 * groups' masters), per the user's explicit confirmation.
 *
 * Pass the already-scoped ComparisonRow[] (the caller applies any time-range /
 * team filtering before comparing).
 */
export function computeAflPlayerAccuracy(
  rows: ComparisonRow[]
): AflPlayerAccuracy {
  const scoring = buildGroup(AFL_GROUPS.scoring, rows, AFL_OPTS);
  const defence = buildGroup(AFL_GROUPS.defence, rows, AFL_OPTS);
  const possession = buildGroup(AFL_GROUPS.possession, rows, AFL_OPTS);
  const disposals = buildGroup(AFL_GROUPS.disposals, rows, AFL_OPTS);
  const other = buildGroup(AFL_GROUPS.other, rows, AFL_OPTS);

  const overall = buildGroup(
    {
      label: "Overall",
      parts: [
        ...AFL_GROUPS.scoring.parts,
        ...AFL_GROUPS.defence.parts,
        ...AFL_GROUPS.possession.parts,
        ...AFL_GROUPS.disposals.parts,
        ...AFL_GROUPS.other.parts,
      ],
    },
    rows,
    AFL_OPTS
  );

  return { overall, scoring, defence, possession, disposals, other };
}

// Precomputed AFL Player Accuracy for all three scopes — the AFL analogue of
// StoredPlayerAccuracy. Small enough to STORE on the check (JSON column
// `player_accuracy`) so the fixture table renders without re-parsing the raw
// XML. `afl` is the literal `true` discriminant that lets a per-row reader
// detect the STORED shape regardless of the row's `sport` column.
export type StoredAflPlayerAccuracy = {
  afl: true;
  both: AflPlayerAccuracy;
  home: AflPlayerAccuracy;
  away: AflPlayerAccuracy;
};

/**
 * Compute AFL Player Accuracy for all three scopes (both/home/away) from raw
 * master + analyst instances. Mirrors computePlayerAccuracyByScope in
 * player-accuracy.ts: canonicalises teams (so home/away filtering works), then
 * compares + groups per scope. This is what gets stored on an AFL check at
 * save/update/propagate/backfill/merge time and read back by the fixture table.
 */
export function computeAflPlayerAccuracyByScope(
  masterInstances: Instance[],
  analystInstances: Instance[],
  tolerance: number,
  masterFileName?: string | null
): StoredAflPlayerAccuracy {
  const canon = canonicaliseTeams(
    masterInstances,
    analystInstances,
    tolerance,
    masterFileName
  );

  const forScope = (scope: PlayerAccuracyScope): AflPlayerAccuracy => {
    const inScope = (i: Instance) =>
      scope === "both" || i.team.trim().toLowerCase() === scope;
    const cmp = compareInstances(
      canon.master.filter(inScope),
      canon.analyst.filter(inScope),
      tolerance,
      masterFileName
    );
    return computeAflPlayerAccuracy(cmp.rows);
  };

  return {
    afl: true,
    both: forScope("both"),
    home: forScope("home"),
    away: forScope("away"),
  };
}
