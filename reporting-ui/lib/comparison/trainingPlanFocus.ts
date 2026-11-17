// Pure helpers for "watch this training-plan instance in the video player":
// the highlight descriptor shown in the player, matching it back to a
// timeline row, and the origin state that decides where closing returns to.

import type { ComparisonRow } from "./xml-compare";
import { ERROR_TYPE_LABEL, type PlanInstance } from "./trainingPlan";
import type { ErrorType } from "./trainingPlanDrills";

export interface PlanFocus {
  key: string;
  type: ErrorType;
  /** Human label for the status badge, e.g. "Wrong player". */
  typeLabel: string;
  /** Tailwind classes for the coloured badge (dark-surface friendly). */
  badgeClass: string;
  stat: string;
  codedStat: string | null;
  expected: { team: string; player: string } | null;
  coded: { team: string; player: string } | null;
  /** mm:ss label of the instance's code time. */
  timeLabel: string;
  startSeconds: number;
  timeSeconds: number;
}

const BADGE_CLASS: Record<ErrorType, string> = {
  missed: "bg-rose-500 text-white",
  extra: "bg-amber-400 text-slate-900",
  wrong_player: "bg-violet-500 text-white",
  wrong_stat: "bg-orange-500 text-white",
  wrong_team: "bg-fuchsia-500 text-white",
};

export function buildPlanFocus(i: PlanInstance): PlanFocus {
  return {
    key: i.key,
    type: i.type,
    typeLabel: ERROR_TYPE_LABEL[i.type],
    badgeClass: BADGE_CLASS[i.type],
    stat: i.stat,
    codedStat: i.codedStat,
    expected: i.expected,
    coded: i.coded,
    timeLabel: i.timeLabel,
    startSeconds: i.startSeconds,
    timeSeconds: i.timeSeconds,
  };
}

/**
 * True when a comparison row is the row this plan instance was built from.
 * The plan derives start/mid from `master ?? analyst`, so match on the same.
 */
export function rowMatchesFocus(row: ComparisonRow, focus: PlanFocus | null): boolean {
  if (!focus) return false;
  const first = row.master ?? row.analyst;
  if (!first) return false;
  return first.start === focus.startSeconds && first.mid === focus.timeSeconds;
}

/** Where the open video player was launched from. */
export type PlayerOrigin = "timeline" | "training-plan";

export interface PlayerState {
  open: boolean;
  origin: PlayerOrigin;
  focus: PlanFocus | null;
}

export const PLAYER_CLOSED: PlayerState = { open: false, origin: "timeline", focus: null };

/** Open from the normal comparison timeline (today's behaviour). */
export function openFromTimeline(): PlayerState {
  return { open: true, origin: "timeline", focus: null };
}

/** Open from a training-plan instance: remember the origin and the focus. */
export function openFromPlan(instance: PlanInstance): PlayerState {
  return { open: true, origin: "training-plan", focus: buildPlanFocus(instance) };
}

/**
 * Close the player. `returnToPlan` tells the caller to leave the plan mounted
 * and give focus back to the play button; the plan itself is never closed.
 */
export function closePlayer(state: PlayerState): { next: PlayerState; returnToPlan: boolean } {
  return { next: PLAYER_CLOSED, returnToPlan: state.open && state.origin === "training-plan" };
}
