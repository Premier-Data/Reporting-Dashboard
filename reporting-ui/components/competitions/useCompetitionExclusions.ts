"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EXCLUSIONS_NOT_SET_UP,
  ExclusionsTableMissingError,
  addExclusions,
  listExclusions,
  removeExclusions,
  type NewExclusion,
} from "@/lib/api/competitionExclusions";
import {
  exclusionKeySets,
  fallbackExclusionRows,
  type ExclusionRow,
} from "@/lib/analytics/exclusions";

export type ExclusionStatus = "loading" | "ready" | "fallback";

export type ExclusionState = {
  rows: ExclusionRow[];
  status: ExclusionStatus;
  fallbackReason: "missing" | "error" | null;
  errorMessage: string | null;
  /** Message to show the user when the built-in list is in use, else null. */
  notice: string | null;
  canPersist: boolean;
};

export type ExclusionsController = {
  rows: ExclusionRow[];
  status: ExclusionStatus;
  notice: string | null;
  canPersist: boolean;
  competitionKeys: ReadonlySet<string>;
  teamKeys: ReadonlySet<string>;
  /** Name stamped into created_by. */
  actor?: string;
  refresh: () => Promise<void>;
  /** Rejects on failure or when exclusions cannot be persisted. */
  add: (items: NewExclusion[]) => Promise<void>;
  /** Restore (delete) by row id. Rejects on failure. */
  restore: (ids: number[]) => Promise<void>;
};

/** Pure: turns a load result into hook state (missing table / error -> built-in list). */
export function resolveExclusionState(
  result: { rows: ExclusionRow[] } | { error: unknown }
): ExclusionState {
  if ("rows" in result) {
    return {
      rows: result.rows,
      status: "ready",
      fallbackReason: null,
      errorMessage: null,
      notice: null,
      canPersist: true,
    };
  }
  if (result.error instanceof ExclusionsTableMissingError) {
    return {
      rows: fallbackExclusionRows(),
      status: "fallback",
      fallbackReason: "missing",
      errorMessage: null,
      notice: EXCLUSIONS_NOT_SET_UP,
      canPersist: false,
    };
  }
  const msg = result.error instanceof Error ? result.error.message : String(result.error);
  return {
    rows: fallbackExclusionRows(),
    status: "fallback",
    fallbackReason: "error",
    errorMessage: msg,
    notice: `Could not load exclusions (${msg}); using the built-in list`,
    canPersist: false,
  };
}

const LOADING_STATE: ExclusionState = {
  rows: fallbackExclusionRows(),
  status: "loading",
  fallbackReason: null,
  errorMessage: null,
  notice: null,
  canPersist: false,
};

export function useCompetitionExclusions(actor?: string): ExclusionsController {
  const [state, setState] = useState<ExclusionState>(LOADING_STATE);
  const alive = useRef(true);

  const load = useCallback(async () => {
    let next: ExclusionState;
    try {
      next = resolveExclusionState({ rows: await listExclusions() });
    } catch (error) {
      next = resolveExclusionState({ error });
    }
    if (alive.current) setState(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const { competitionKeys, teamKeys } = useMemo(() => exclusionKeySets(state.rows), [state.rows]);

  const add = useCallback(
    async (items: NewExclusion[]) => {
      if (!state.canPersist) throw new Error(state.notice ?? EXCLUSIONS_NOT_SET_UP);
      await addExclusions(items);
      await load();
    },
    [state.canPersist, state.notice, load]
  );

  const restore = useCallback(
    async (ids: number[]) => {
      if (!state.canPersist) throw new Error(state.notice ?? EXCLUSIONS_NOT_SET_UP);
      await removeExclusions({ ids });
      await load();
    },
    [state.canPersist, state.notice, load]
  );

  return {
    rows: state.rows,
    status: state.status,
    notice: state.notice,
    canPersist: state.canPersist,
    competitionKeys,
    teamKeys,
    actor,
    refresh: load,
    add,
    restore,
  };
}
