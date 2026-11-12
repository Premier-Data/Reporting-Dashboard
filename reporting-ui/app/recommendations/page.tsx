"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { HubConnectionState } from "@microsoft/signalr";
import { getHubConnection } from "@/lib/signalr";
import Image from "next/image";

import { supabase } from "@/lib/supabase";
import {
  analystShifts,
  getDeputyRostersWithWeek,
  getDeputyShifts,
  type DeputyRosterWithSeason,
} from "@/lib/api/deputyShifts";
import { deputySeasonOf } from "@/lib/deputy/reportWeeks";
import { absoluteWeekIndex, mapFixtureWeekTT } from "@/lib/analytics/season";
import { rowAbsoluteWeek, seasonWeekOfRow } from "@/lib/analytics/gameWeekIndex";
import { filterRosterForFixture } from "@/lib/recommendations/rosterSeason";
import DeputyLoadError from "@/components/DeputyLoadError";
import { leagueLogos } from "@/app/analyst-profile/leagueLogos";

import { buildAnalystMetrics } from "@/lib/analytics/buildAnalystMetrics";
import { isExcludedAnalystName } from "@/lib/analytics/excludedAnalysts";
import {
  buildRecommendations,
  type Recommendation,
} from "@/lib/recommendations/recommendationEngine";

import {
  getAutoDownloadFixtures,
  type AutoDownloadFixture,
} from "@/lib/api/autodownload";

import {
  getAutoDownloadAnalysts,
  type AutoDownloadAnalyst,
} from "@/lib/api/analysts";

import RecommendationTable from "@/components/recommendations/RecommendationTable";
import ScoreBreakdown from "@/components/recommendations/ScoreBreakdown";
import {
  createDownloadJob,
  getDownloadJobs,
  type DownloadJob,
} from "@/lib/api/downloadJobs";
import { assignFixture } from "@/lib/api/assignFixture";
import type { TTGame } from "@/types/ttgame";
import type { DeputyShift } from "@/types/deputy";
import type { AnalystMetrics } from "@/types/analyst";
import { buildAnalystAvailability } from "@/lib/recommendations/buildAnalystAvailability";
import { Info } from "lucide-react";

/**
 * Finds the API fixture matching a TT_Games row.
 *
 * Prefers matching on game_key/gameKey — a stable identifier derived
 * from date+teams. Falls back to a home/away team name match only when
 * either side is missing a game_key (older synced rows). Fuzzy
 * home/away-only matching was the previous approach everywhere on this
 * page, but it silently collapses onto whichever fixture happens to
 * match first when the API has more than one row for the same teams
 * (e.g. duplicate rows from a past sync bug, or two fixtures between
 * the same two teams in different rounds/seasons) — which is why a
 * fixture allocated on the Fixtures/Schedule pages could show as
 * "allocated" there while Recommendations kept showing it as
 * unassigned, or vice versa.
 */
function findAutoFixture(
  autoFixtures: AutoDownloadFixture[],
  fixture: { game_key?: string | null; home_team?: string | null; away_team?: string | null }
): AutoDownloadFixture | undefined {

  const key = fixture.game_key?.trim();

  if (key) {
    const byKey = autoFixtures.find(
      (af: any) => af.gameKey && af.gameKey === key
    );

    if (byKey) return byKey;
  }

  const fHome = (fixture.home_team ?? "").trim().toLowerCase();
  const fAway = (fixture.away_team ?? "").trim().toLowerCase();

  return autoFixtures.find((af: any) => {
    const afHome = (af.homeTeam ?? "").trim().toLowerCase();
    const afAway = (af.awayTeam ?? "").trim().toLowerCase();
    return afHome === fHome && afAway === fAway;
  });
}

export default function RecommendationPage() {
  const [historicalGames, setHistoricalGames] = useState<TTGame[]>([]);
  const [fixtures, setFixtures] = useState<TTGame[]>([]);
  const [autoFixtures, setAutoFixtures] = useState<AutoDownloadFixture[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  const [autoAnalysts, setAutoAnalysts] = useState<AutoDownloadAnalyst[]>([]);
  const [analystAffiliations, setAnalystAffiliations] =
    useState<Map<string, string[]>>(new Map());
  const [manualAssignOpen, setManualAssignOpen] =
    useState(false);

  const [teamHistoryOpen, setTeamHistoryOpen] =
    useState<string | null>(null);

  const [dayAssignConfirm, setDayAssignConfirm] =
    useState<{ recommendation: Recommendation; day: string; date: string } | null>(null);

  const [manualSearch, setManualSearch] =
    useState("");

  const [selectedFixture, setSelectedFixture] = useState<TTGame | null>(null);

  const [selectedWeek, setSelectedWeek] = useState(1);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);

  const [fixtureSearch, setFixtureSearch] = useState("");

  const [loading, setLoading] = useState(true);

  const [analysts, setAnalysts] = useState<AnalystMetrics[]>([]);
  const [roster, setRoster] = useState<DeputyRosterWithSeason[]>([]);
  const [deputyError, setDeputyError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sortField, setSortField] = useState<
    | "Week"
    | "Round"
    | "Competition"
    | "home_team"
    | "away_team"
    | "expected_day"
  >("Week");

  const [sortDirection, setSortDirection] =
    useState<"asc" | "desc">("asc");


  // --------------------------------------------------
  // LOAD HISTORICAL DATA (ONCE)
  // --------------------------------------------------

  useEffect(() => {
    async function loadHistory() {
      setLoading(true);

      // Deputy shifts and rosters come only from the Deputy API (shared layer).
      setDeputyError(null);
      let shifts: DeputyShift[];
      let rosterData: DeputyRosterWithSeason[];
      try {
        [shifts, rosterData] = await Promise.all([
          getDeputyShifts({ force: reloadKey > 0 }).then(analystShifts),
          getDeputyRostersWithWeek({ force: reloadKey > 0 }),
        ]);
      } catch (e) {
        setDeputyError(e instanceof Error ? e.message : String(e));
        setLoading(false);
        return;
      }
      const { data: affiliationData, error: affiliationError } =
        await supabase
          .from("analyst_team_affiliations")
          .select(`
      analyst_name,
      team_id,
      teams (
        team_name
      )
    `);

      if (affiliationError) {
        console.error(
          "Failed loading analyst affiliations:",
          affiliationError
        );
      } else {
        const affiliationMap = new Map<string, string[]>();

        affiliationData?.forEach((row: any) => {
          const analystName =
            row.analyst_name?.trim().toLowerCase();

          const teamName =
            row.teams?.team_name?.trim();

          if (!analystName || !teamName) return;

          const existing =
            affiliationMap.get(analystName) ?? [];

          existing.push(teamName);

          affiliationMap.set(
            analystName,
            existing
          );
        });

        setAnalystAffiliations(affiliationMap);

        console.log(
          "ANTHONY CLARKE AFFILIATIONS:",
          affiliationMap.get("anthony clarke")
        );

        console.log(
          "ALL AFFILIATIONS:",
          Object.fromEntries(affiliationMap)
        );
      }

      setRoster(rosterData);

      const autoFixtureData =
        await getAutoDownloadFixtures();

      console.log("Auto Fixture Data:", autoFixtureData);

      if (Array.isArray(autoFixtureData)) {
        setAutoFixtures(autoFixtureData);
      } else {
        console.error("Expected array but received:", autoFixtureData);
        setAutoFixtures([]);
      }

      const autoAnalystData =
        await getAutoDownloadAnalysts();

      if (Array.isArray(autoAnalystData)) {
        setAutoAnalysts(autoAnalystData);
      } else {
        console.error(
          "Expected analyst array but received:",
          autoAnalystData
        );

        setAutoAnalysts([]);
      }

      const allGames: TTGame[] = [];

      let from = 0;
      const pageSize = 1000;

      while (true) {
        const { data, error } = await supabase
          .from("TT_Games")
          .select("*")
          .order("Date")
          .order("Competition")
          .range(from, from + pageSize - 1);

        if (error) throw error;

        if (!data?.length) break;

        allGames.push(...mapFixtureWeekTT(data as TTGame[]));

        if (data.length < pageSize) break;

        from += pageSize;
      }

      setHistoricalGames(allGames);

      // Default to the latest fixture's (season, week), not max(Week)
      // across all seasons.
      const latestIdx = Math.max(
        ...allGames.map(g => rowAbsoluteWeek(g)).filter(Number.isFinite)
      );
      const latestGame = allGames.find(
        g => rowAbsoluteWeek(g) === latestIdx
      );
      const latestSw = latestGame ? seasonWeekOfRow(latestGame) : null;
      const latestWeek = latestSw?.week ?? 1;

      setSelectedSeason(latestSw?.season ?? null);
      setSelectedWeek(latestWeek);

      const latestWeekFixtures = allGames.filter(
        g => rowAbsoluteWeek(g) === latestIdx
      );

      setFixtures(latestWeekFixtures);

      if (latestWeekFixtures.length > 0) {
        setSelectedFixture(latestWeekFixtures[0]);
      }

      const analystData =
        buildAnalystMetrics(
          shifts,
          allGames
        );

      setAnalysts(analystData);

      setLoading(false);
    }

    loadHistory();
  }, [reloadKey]);

  useEffect(() => {
    if (historicalGames.length === 0) return;

    if (selectedSeason == null) return;

    const targetIdx = absoluteWeekIndex(selectedSeason, selectedWeek);
    const weekFixtures = historicalGames.filter(
      g => rowAbsoluteWeek(g) === targetIdx
    );

    setFixtures(weekFixtures);

    if (weekFixtures.length > 0) {
      setSelectedFixture(weekFixtures[0]);
    } else {
      setSelectedFixture(null);
    }

  }, [selectedWeek, selectedSeason, historicalGames]);

  useEffect(() => {
    console.log("RecommendationPage MOUNTED");

    return () => {
      console.log("RecommendationPage UNMOUNTED");
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDownloadJobs() {
      try {
        const jobs = await getDownloadJobs();

        if (!cancelled) {
          setDownloadJobs(jobs);
        }
      } catch (error) {
        console.error("Failed loading download jobs:", error);
      }
    }

    loadDownloadJobs();

    const interval = setInterval(
      loadDownloadJobs,
      2000
    );

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // --------------------------------------------------
  // SYNC ALLOCATED FIXTURES (polling + SignalR)
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function refreshAutoFixtures() {
      try {
        const data = await getAutoDownloadFixtures();

        if (!cancelled && Array.isArray(data)) {
          setAutoFixtures(data);
        }
      } catch (err) {
        console.error("Failed refreshing auto fixtures:", err);
      }
    }

    const interval = setInterval(refreshAutoFixtures, 5000);

    const connection = getHubConnection();

    const handleRefresh = async () => {
      console.log("Recommendations: RefreshOperations received");
      await refreshAutoFixtures();
    };

    connection.off("RefreshOperations", handleRefresh);
    connection.on("RefreshOperations", handleRefresh);

    const startSignalR = async () => {
      try {
        if (connection.state === HubConnectionState.Disconnected) {
          await connection.start();
          console.log("Recommendations SignalR connected:", connection.state);
        }
      } catch (err) {
        console.error("Recommendations SignalR connection failed:", err);
      }
    };

    startSignalR();

    return () => {
      cancelled = true;
      clearInterval(interval);
      connection.off("RefreshOperations", handleRefresh);
    };
  }, []);

  // --------------------------------------------------
  // SORT
  // --------------------------------------------------

  const sortedFixtures = useMemo(() => {
    const sorted = [...fixtures];

    sorted.sort((a, b) => {
      const direction =
        sortDirection === "asc" ? 1 : -1;

      switch (sortField) {
        case "Week":
          return (
            (rowAbsoluteWeek(a) - rowAbsoluteWeek(b)) *
            direction
          );

        case "Round":
          return (
            (a.Round ?? "").localeCompare(
              b.Round ?? ""
            ) * direction
          );

        case "Competition":
          return (
            (a.Competition ?? "").localeCompare(
              b.Competition ?? ""
            ) * direction
          );

        case "home_team":
          return (
            (a.home_team ?? "").localeCompare(
              b.home_team ?? ""
            ) * direction
          );

        case "away_team":
          return (
            (a.away_team ?? "").localeCompare(
              b.away_team ?? ""
            ) * direction
          );

        case "expected_day":
          return (
            (a.expected_day ?? "").localeCompare(
              b.expected_day ?? ""
            ) * direction
          );

        default:
          return 0;
      }
    });

    return sorted;
  }, [fixtures, sortField, sortDirection]);

  // Search filter for the Fixtures card — matches home/away team,
  // competition, round or game_key. Applied after sorting so the list
  // stays in the user's chosen order while narrowed to matches.
  const visibleFixtures = useMemo(() => {
    const term = fixtureSearch.trim().toLowerCase();

    if (!term) return sortedFixtures;

    return sortedFixtures.filter(f => {
      const haystack = [
        f.home_team,
        f.away_team,
        f.Competition,
        f.Round,
        f.game_key,
      ]
        .map(v => (v ?? "").toString().toLowerCase())
        .join(" ");

      return haystack.includes(term);
    });
  }, [sortedFixtures, fixtureSearch]);

  const fixturesWithDownloads = useMemo(() => {

    if (!Array.isArray(autoFixtures)) {
      return sortedFixtures;
    }

    return sortedFixtures.map(fixture => {

      const autoFixture = findAutoFixture(autoFixtures, fixture);

      const downloadJob = downloadJobs.find(
        job => job.gameKey === fixture.game_key
      );

      return {

        ...fixture,

        downloadStatus:
          downloadJob?.status ??
          autoFixture?.status ??
          null,

        assignedAnalyst:
          autoFixture?.analyst ?? null,

        assignedComputer:
          autoFixture?.computer ?? null,

        downloadPercent:
          downloadJob?.downloadPercent ??
          autoFixture?.downloadPercent ??
          null,

        downloadSpeedMbps:
          downloadJob?.downloadSpeedMbps ??
          autoFixture?.downloadSpeedMbps ??
          null,

        fileSizeBytes:
          downloadJob?.fileSizeBytes ??
          autoFixture?.fileSizeBytes ??
          null,

        downloadedBytes:
          downloadJob?.downloadedBytes ?? 0,

        downloadCompletedAt:
          autoFixture?.downloadCompletedAt ?? null,

      };

    });

  }, [sortedFixtures, autoFixtures, downloadJobs]);

  const autoFixturesByGameKey = useMemo(() => {

    if (!Array.isArray(autoFixtures) || autoFixtures.length === 0) {
      return new Map<string, any>();
    }

    // Keyed by gameKey — a stable identifier, unlike a bare home+away
    // composite which collapses distinct fixtures between the same two
    // teams (different rounds/seasons) onto a single map entry.
    const map = new Map<string, any>();
    autoFixtures.forEach((af: any) => {
      if (af.gameKey) {
        map.set(af.gameKey, af);
      }
    });
    return map;

  }, [autoFixtures]);

  // --------------------------------------------------
  // BUILD RECOMMENDATIONS
  // --------------------------------------------------
  // Roster week numbers repeat across seasons, so scope the roster to the
  // selected fixture's season before matching by week.
  const seasonRoster = useMemo(() => {
    let fixtureSeason: number | undefined;
    if (selectedFixture) {
      const s = Number(selectedFixture.season);
      fixtureSeason =
        selectedFixture.season != null && Number.isFinite(s)
          ? s
          : deputySeasonOf(selectedFixture.Date.substring(0, 10));
    } else if (roster.length > 0) {
      fixtureSeason = Math.max(...roster.map((r) => r.season));
    }
    return fixtureSeason == null ? [] : filterRosterForFixture(roster, fixtureSeason);
  }, [roster, selectedFixture]);

  const analystAvailability = useMemo(() => {
    const availabilityByAnalyst =
      buildAnalystAvailability(seasonRoster);

    const currentWeek = selectedFixture
      ? Number(selectedFixture.Week)
      : selectedWeek;

    const availabilityForWeek =
      new Map<string, string[]>();

    availabilityByAnalyst.forEach((weekMap, analyst) => {
      availabilityForWeek.set(
        analyst,
        weekMap.get(currentWeek) ?? []
      );
    });

    return availabilityForWeek;

  }, [seasonRoster, selectedFixture, selectedWeek]);

  // --------------------------------------------------
  // ANALYST SCHEDULE DATES FOR TOOLTIP
  // --------------------------------------------------
  const analystScheduleDates = useMemo(() => {
    const currentWeek = selectedFixture
      ? Number(selectedFixture.Week)
      : selectedWeek;

    const scheduleMap = new Map<string, { day: string; date: string }[]>();

    for (const shift of seasonRoster) {
      if (
        !shift.employee_name ||
        !shift.shift_date ||
        shift.week == null ||
        shift.week !== currentWeek
      ) {
        continue;
      }

      const analyst = shift.employee_name.trim().toLowerCase();
      const shiftDate = new Date(shift.shift_date);
      const day = shiftDate.toLocaleDateString("en-AU", { weekday: "short" });
      const dateStr = format(shiftDate, "dd MMM");

      if (!scheduleMap.has(analyst)) {
        scheduleMap.set(analyst, []);
      }

      const existing = scheduleMap.get(analyst)!;
      // Avoid duplicates
      if (!existing.some(e => e.date === dateStr)) {
        existing.push({ day, date: dateStr });
      }
    }

    // Sort each analyst's dates chronologically
    scheduleMap.forEach((dates) => {
      dates.sort((a, b) => a.date.localeCompare(b.date));
    });

    return scheduleMap;
  }, [seasonRoster, selectedFixture, selectedWeek]);

  const selectedRecommendation = useMemo(() => {

    if (
      !selectedFixture ||
      analysts.length === 0
    ) {
      return [];
    }

    return buildRecommendations(
      selectedFixture,
      analysts,
      historicalGames,
      analystAvailability,
      analystAffiliations
    );

  }, [
    selectedFixture,
    analysts,
    historicalGames,
    analystAvailability,
    analystAffiliations,
  ]);

  // --------------------------------------------------
  // ALREADY-ALLOCATED IN THIS COMPETITION + ROUND
  // --------------------------------------------------
  // Once an analyst has been given a game in a competition round, they
  // shouldn't keep appearing as a recommendation for every other fixture
  // in the same round — otherwise whoever is allocating just sees the
  // same top names on every fixture. We derive who's already been
  // allocated within the selected fixture's Competition+Round (from the
  // AutoDownload API assignments) and (a) hide them from the
  // recommendation list and (b) surface them in a summary section so the
  // allocator can see the coverage so far.
  const allocatedInRound = useMemo(() => {
    if (!selectedFixture) return [];

    const comp = (selectedFixture.Competition ?? "").trim().toLowerCase();
    const round = (selectedFixture.Round ?? "").trim().toLowerCase();
    const selectedKey = selectedFixture.game_key;

    // All TT_Games in the same competition + round.
    const roundGames = historicalGames.filter(
      g =>
        (g.Competition ?? "").trim().toLowerCase() === comp &&
        (g.Round ?? "").trim().toLowerCase() === round
    );

    const results: {
      analystName: string;
      analystKey: string;
      home_team: string;
      away_team: string;
      isSelected: boolean;
    }[] = [];

    // De-dupe by analyst — an analyst assigned to more than one game in
    // the round only needs to show once (we keep their first fixture).
    const seen = new Set<string>();

    for (const game of roundGames) {
      const auto = findAutoFixture(autoFixtures, game);
      const analystName = (auto as any)?.analyst as string | null | undefined;

      if (!analystName || !analystName.trim()) continue;
      if (isExcludedAnalystName(analystName)) continue;

      const analystKey = analystName.trim().toLowerCase();
      if (seen.has(analystKey)) continue;
      seen.add(analystKey);

      results.push({
        analystName,
        analystKey,
        home_team: game.home_team,
        away_team: game.away_team,
        isSelected: game.game_key === selectedKey,
      });
    }

    return results.sort((a, b) =>
      a.analystName.localeCompare(b.analystName)
    );
  }, [selectedFixture, historicalGames, autoFixtures]);

  // Normalised set of analysts already allocated to OTHER fixtures in
  // this round (excludes whoever is on the currently selected fixture so
  // the current allocation still displays correctly).
  const allocatedElsewhereInRound = useMemo(() => {
    const set = new Set<string>();
    for (const entry of allocatedInRound) {
      if (!entry.isSelected) {
        set.add(entry.analystKey);
      }
    }
    return set;
  }, [allocatedInRound]);

  // --------------------------------------------------
  // DAY-BASED EXCLUSION
  // --------------------------------------------------
  // If an analyst already has a fixture assigned for the same working
  // day as the selected fixture (based on the analyst's availability,
  // NOT the fixture's match date), they shouldn't appear in the
  // recommendations. This stops the same person always topping the list
  // when they're already booked on that day.
  //
  // The "day" is the expected_day on the TT_Games row — it represents
  // which day of the week the work is scheduled for (e.g. "Tuesday").
  // We look at ALL fixtures in the same week that already have an
  // analyst assigned and share the same expected_day as the selected
  // fixture.
  const busyOnSameDay = useMemo(() => {
    const set = new Set<string>();

    if (!selectedFixture || !selectedFixture.expected_day) return set;

    const targetDay = (selectedFixture.expected_day ?? "")
      .trim()
      .toLowerCase();

    if (!targetDay) return set;

    const targetWeek = rowAbsoluteWeek(selectedFixture);

    // Find all TT_Games in the same week with the same expected_day
    // that already have an analyst assigned (via the API).
    for (const game of historicalGames) {
      if (game.game_key === selectedFixture.game_key) continue;
      if (rowAbsoluteWeek(game) !== targetWeek) continue;

      const gameDay = (game.expected_day ?? "").trim().toLowerCase();
      if (gameDay !== targetDay) continue;

      const auto = findAutoFixture(autoFixtures, game);
      const analystName = (auto as any)?.analyst as string | null | undefined;

      if (!analystName || !analystName.trim()) continue;
      if (isExcludedAnalystName(analystName)) continue;

      set.add(analystName.trim().toLowerCase());
    }

    return set;
  }, [selectedFixture, historicalGames, autoFixtures]);

  // Recommendations with analysts already allocated elsewhere in the
  // round OR already booked on the same day removed.
  const visibleRecommendations = useMemo(() => {
    return selectedRecommendation.filter(
      r => {
        const key = r.analyst.name.trim().toLowerCase();
        if (allocatedElsewhereInRound.has(key)) return false;
        if (busyOnSameDay.has(key)) return false;
        return true;
      }
    );
  }, [selectedRecommendation, allocatedElsewhereInRound, busyOnSameDay]);

  async function handleAssign(
    recommendation: Recommendation
  ) {

    if (!selectedFixture) return;

    try {

      const recName = recommendation.analyst.name.trim().toLowerCase();

      // Try exact match first, then normalised (collapse whitespace,
      // strip zero-width chars), then "starts with" / "contains" as a
      // last-resort fuzzy match.  The recommendation names come from
      // Supabase (TT_Games / Deputy) while the AutoDownload API has its
      // own analyst table — tiny spelling differences (hyphens, middle
      // initials, trailing spaces) can break exact matching.
      let autoAnalyst = autoAnalysts.find(
        a => a.name.trim().toLowerCase() === recName
      );

      if (!autoAnalyst) {
        const norm = (s: string) =>
          s.replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const recNorm = norm(recommendation.analyst.name);

        autoAnalyst = autoAnalysts.find(
          a => norm(a.name) === recNorm
        );
      }

      if (!autoAnalyst) {
        // Partial: check if either name starts with the other (handles
        // "Jimmy Dwyer" vs "Jimmy Dwyer (NEW)" etc.)
        autoAnalyst = autoAnalysts.find(
          a => {
            const apiName = a.name.trim().toLowerCase();
            return apiName.startsWith(recName) || recName.startsWith(apiName);
          }
        );
      }

      if (!autoAnalyst) {
        alert(
          `Analyst "${recommendation.analyst.name}" not found in AutoDownload.\n\n` +
          `Make sure this analyst has been added to the AutoDownload system ` +
          `(Computers > Analysts) with the same name as they appear in the roster.`
        );
        return;
      }

      const location: "Home" | "Office" =
        autoAnalyst.officeComputer ? "Office" : "Home";

      const computer =
        location === "Office"
          ? autoAnalyst.officeComputer
          : autoAnalyst.homeComputer;

      if (!computer) {
        alert(`${autoAnalyst.name} does not have a computer assigned.`);
        return;
      }

      // Find the API fixture ID for this game
      const autoFixture = findAutoFixture(autoFixtures, selectedFixture);

      // 1. Assign the fixture (creates FixtureAssignment, syncs with all pages)
      if (autoFixture && (autoFixture as any).id) {
        await assignFixture(
          (autoFixture as any).id,
          autoAnalyst.id,
          location
        );
      }

      // 2. Create download job (triggers the autodownload on the desktop agent)
      await createDownloadJob({
        gameKey: selectedFixture.game_key,
        videoUrl: selectedFixture.videoURL ?? "",
        analystId: autoAnalyst.id,
        computerId: computer.id,
        assignmentLocation: location,
        year: selectedFixture.Date.substring(0, 4),
        leagueName: selectedFixture.Competition,
        fileSizeBytes:
          autoFixture?.fileSizeBytes ?? null,
      });

      alert(`Assigned to ${autoAnalyst.name} and download queued.`);

    } catch (err) {

      console.error(err);
      alert(err instanceof Error ? err.message : "Assignment failed.");

    }
  }


  function calculateScheduledDate(dayName: string): string {
    const dayIndex: Record<string, number> = {
      Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
      Thursday: 4, Friday: 5, Saturday: 6,
    };

    const targetDay = dayIndex[dayName] ?? 0;
    const fixtureDate = selectedFixture?.Date
      ? new Date(selectedFixture.Date)
      : new Date();

    const currentDay = fixtureDate.getDay();
    let diff = targetDay - currentDay;
    if (diff < 0) diff += 7;
    const scheduledDate = new Date(fixtureDate);
    scheduledDate.setDate(fixtureDate.getDate() + diff);
    return scheduledDate.toISOString().split("T")[0];
  }

  // Opens the confirmation modal
  function handleAssignDay(
    recommendation: Recommendation,
    dayName: string
  ) {
    if (!selectedFixture) return;

    setDayAssignConfirm({
      recommendation,
      day: dayName,
      date: calculateScheduledDate(dayName),
    });
  }

  // Performs the actual assignment after confirmation
  async function confirmAssignDay() {
    if (!dayAssignConfirm || !selectedFixture) return;

    const { recommendation, day: dayName, date: scheduledDateStr } = dayAssignConfirm;

    try {
      const recName = recommendation.analyst.name.trim().toLowerCase();

      let autoAnalyst = autoAnalysts.find(
        a => a.name.trim().toLowerCase() === recName
      );

      if (!autoAnalyst) {
        const norm = (s: string) =>
          s.replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const recNorm = norm(recommendation.analyst.name);

        autoAnalyst = autoAnalysts.find(
          a => norm(a.name) === recNorm
        );
      }

      if (!autoAnalyst) {
        autoAnalyst = autoAnalysts.find(
          a => {
            const apiName = a.name.trim().toLowerCase();
            return apiName.startsWith(recName) || recName.startsWith(apiName);
          }
        );
      }

      if (!autoAnalyst) {
        alert(
          `Analyst "${recommendation.analyst.name}" not found in AutoDownload.\n\n` +
          `Make sure this analyst has been added to the AutoDownload system ` +
          `(Computers > Analysts) with the same name as they appear in the roster.`
        );
        setDayAssignConfirm(null);
        return;
      }

      const location: "Home" | "Office" =
        autoAnalyst.officeComputer ? "Office" : "Home";

      const computer =
        location === "Office"
          ? autoAnalyst.officeComputer
          : autoAnalyst.homeComputer;

      if (!computer) {
        alert(`${autoAnalyst.name} does not have a computer assigned.`);
        setDayAssignConfirm(null);
        return;
      }

      const autoFixture = findAutoFixture(autoFixtures, selectedFixture);

      // 1. Assign with scheduled date (shows on Schedule page)
      if (autoFixture && (autoFixture as any).id) {
        await assignFixture(
          (autoFixture as any).id,
          autoAnalyst.id,
          location,
          scheduledDateStr
        );
      }

      // 2. Create download job (triggers autodownload)
      await createDownloadJob({
        gameKey: selectedFixture.game_key,
        videoUrl: selectedFixture.videoURL ?? "",
        analystId: autoAnalyst.id,
        computerId: computer.id,
        assignmentLocation: location,
        year: selectedFixture.Date.substring(0, 4),
        leagueName: selectedFixture.Competition,
        fileSizeBytes: autoFixture?.fileSizeBytes ?? null,
      });

      setDayAssignConfirm(null);
      alert(`Assigned to ${autoAnalyst.name} for ${dayName}`);

    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Assignment failed.");
      setDayAssignConfirm(null);
    }
  }


  async function handleManualAssign(
    analyst: AutoDownloadAnalyst,
    location?: "Home" | "Office"
  ) {

    if (!selectedFixture) return;

    const assignLocation: "Home" | "Office" =
      location ?? (analyst.officeComputer ? "Office" : "Home");

    let computer;

    if (assignLocation === "Home") {
      computer = analyst.homeComputer;
    } else {
      computer = analyst.officeComputer;
    }

    if (!computer) {
      alert(`${analyst.name} does not have a ${assignLocation} computer assigned.`);
      return;
    }

    try {

      // Find the API fixture for this game
      const autoFixture = findAutoFixture(autoFixtures, selectedFixture);

      // 1. Assign the fixture (syncs with all pages)
      if (autoFixture && (autoFixture as any).id) {
        await assignFixture(
          (autoFixture as any).id,
          analyst.id,
          assignLocation
        );
      }

      // 2. Create download job (triggers autodownload)
      await createDownloadJob({
        gameKey: selectedFixture.game_key,
        videoUrl: selectedFixture.videoURL ?? "",
        year: selectedFixture.Date.substring(0, 4),
        leagueName: selectedFixture.Competition,
        analystId: analyst.id,
        computerId: computer.id,
        assignmentLocation: assignLocation,
        fileSizeBytes:
          autoFixture?.fileSizeBytes ?? null,
      });

      setManualAssignOpen(false);

      alert(`Assigned to ${analyst.name} and download queued.`);

    } catch (err) {

      console.error(err);
      alert(err instanceof Error ? err.message : "Assignment failed.");

    }

  }
  // --------------------------------------------------
  // KEEP SELECTION VALID
  // --------------------------------------------------

  // Season-qualified weeks in chronological order (week numbers repeat
  // across seasons).
  const availableWeeks = useMemo(() => {
    const seen = new Map<number, { season: number; week: number }>();
    for (const g of historicalGames) {
      const sw = seasonWeekOfRow(g);
      if (sw) seen.set(absoluteWeekIndex(sw.season, sw.week), sw);
    }
    return [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, sw]) => sw);
  }, [historicalGames]);

  function handleSort(
    field:
      | "Week"
      | "Round"
      | "Competition"
      | "home_team"
      | "away_team"
      | "expected_day"
  ) {
    if (sortField === field) {
      setSortDirection(
        sortDirection === "asc"
          ? "desc"
          : "asc"
      );
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }

  const affiliatedAnalystsForFixture = useMemo(() => {
    if (!selectedFixture) {
      return [];
    }

    const normaliseTeamName = (
      name: string | null | undefined
    ) =>
      (name ?? "")
        .trim()
        .toLowerCase();

    const homeTeam =
      normaliseTeamName(
        selectedFixture.home_team
      );

    const awayTeam =
      normaliseTeamName(
        selectedFixture.away_team
      );

    const results: {
      analystName: string;
      affiliatedTeams: string[];
      affiliationScore: number;
    }[] = [];

    analystAffiliations.forEach(
      (teams, analystKey) => {

        const matchingTeams =
          teams.filter((team) => {

            const normalisedTeam =
              normaliseTeamName(team);

            return (
              normalisedTeam === homeTeam ||
              normalisedTeam === awayTeam
            );
          });

        if (matchingTeams.length === 0) {
          return;
        }

        const analyst =
          analysts.find(
            (a) =>
              a.name
                .trim()
                .toLowerCase() === analystKey
          );

        results.push({
          analystName:
            analyst?.name ?? analystKey.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),

          affiliatedTeams:
            matchingTeams,

          affiliationScore:
            matchingTeams.length * 10,
        });

      }
    );

    return results.sort(
      (a, b) =>
        b.affiliationScore -
        a.affiliationScore
    );

  }, [
    selectedFixture,
    analystAffiliations,
    analysts,
  ]);

  return (
    <div className="h-screen bg-[#0b1220] text-slate-200 flex flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-[2200px] px-6 pt-6 pb-4 flex flex-col flex-1 overflow-hidden">
        <h1 className="mb-4 text-3xl font-bold shrink-0">
          Fixture Allocation Engine
        </h1>

        <div className="grid grid-cols-[45%_55%] gap-4 flex-1 overflow-hidden">
          <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-4 flex flex-col overflow-hidden">

            <h2 className="mb-3 text-lg font-bold shrink-0">
              Fixtures
            </h2>

            <select
              value={`${selectedSeason}-${selectedWeek}`}
              onChange={(e) => {
                const [s, w] = e.target.value.split("-").map(Number);
                setSelectedSeason(s);
                setSelectedWeek(w);
              }}
              className="mb-3 w-full rounded border border-slate-700 bg-slate-900 p-2 shrink-0"
            >
              {availableWeeks.map(({ season: s, week: w }) => (
                <option key={`${s}-${w}`} value={`${s}-${w}`}>
                  {new Set(availableWeeks.map(x => x.season)).size > 1
                    ? `${s} Week ${w}`
                    : `Week ${w}`}
                </option>
              ))}
            </select>

            <div className="relative mb-3 shrink-0">
              <input
                type="text"
                value={fixtureSearch}
                onChange={(e) => setFixtureSearch(e.target.value)}
                placeholder="Search team, competition or round..."
                className="w-full rounded border border-slate-700 bg-slate-900 py-2 pl-3 pr-8 text-sm placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              />
              {fixtureSearch && (
                <button
                  onClick={() => setFixtureSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                  title="Clear search"
                >
                  ×
                </button>
              )}
            </div>

            {deputyError ? (
              <DeputyLoadError
                message={deputyError}
                onRetry={() => setReloadKey((k) => k + 1)}
              />
            ) : loading ? (
              <div>Loading...</div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-700 flex flex-col flex-1">

                {/* HEADER */}

                <div className="grid grid-cols-[6%_5%_22%_22%_20%_14%_11%] bg-slate-900 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">

                  <button
                    onClick={() =>
                      handleSort("Week")
                    }
                    className="text-left hover:text-white"
                  >
                    Wk{" "}
                    {sortField === "Week" &&
                      (sortDirection === "asc"
                        ? "▲"
                        : "▼")}
                  </button>

                  <button
                    onClick={() =>
                      handleSort("Round")
                    }
                    className="text-left hover:text-white"
                  >
                    Rd{" "}
                    {sortField === "Round" &&
                      (sortDirection === "asc"
                        ? "▲"
                        : "▼")}
                  </button>

                  <button
                    onClick={() =>
                      handleSort("home_team")
                    }
                    className="text-left hover:text-white"
                  >
                    Home{" "}
                    {sortField ===
                      "home_team" &&
                      (sortDirection === "asc"
                        ? "▲"
                        : "▼")}
                  </button>

                  <button
                    onClick={() =>
                      handleSort("away_team")
                    }
                    className="text-left hover:text-white"
                  >
                    Away{" "}
                    {sortField ===
                      "away_team" &&
                      (sortDirection === "asc"
                        ? "▲"
                        : "▼")}
                  </button>

                  <button
                    onClick={() =>
                      handleSort(
                        "Competition"
                      )
                    }
                    className="text-left hover:text-white"
                  >
                    Comp{" "}
                    {sortField ===
                      "Competition" &&
                      (sortDirection === "asc"
                        ? "▲"
                        : "▼")}
                  </button>

                  <button
                    onClick={() =>
                      handleSort("expected_day")
                    }
                    className="text-left hover:text-white"
                  >
                    Date{" "}
                    {sortField === "expected_day" &&
                      (sortDirection === "asc"
                        ? "▲"
                        : "▼")}
                  </button>

                  <div className="text-left">
                    Status
                  </div>
                </div>

                {/* ROWS */}

                <div className="flex-1 overflow-y-auto">
                  {visibleFixtures.length === 0 && (
                    <div className="px-3 py-6 text-center text-xs text-slate-500">
                      {fixtureSearch
                        ? "No fixtures match your search."
                        : "No fixtures for this week."}
                    </div>
                  )}
                  {visibleFixtures.map((fixture, index) => {
                    const autoFixture =
                      (fixture.game_key
                        ? autoFixturesByGameKey.get(fixture.game_key)
                        : undefined) ??
                      findAutoFixture(autoFixtures, fixture);

                    return (
                      <button
                        key={index}
                        onClick={() => setSelectedFixture(fixture)}
                        className={`grid w-full grid-cols-[6%_5%_22%_22%_20%_14%_11%] items-center border-t border-slate-700 px-2 py-1.5 text-left text-xs transition ${selectedFixture?.game_key === fixture.game_key
                            ? "bg-sky-500/15"
                            : autoFixture && autoFixture.analyst
                              ? "bg-emerald-500/50 hover:bg-emerald-500/75"
                              : "hover:bg-slate-800"
                          }`}
                      >
                        <div className="font-semibold text-sky-400">
                          {fixture.Week}
                        </div>

                        <div className="text-slate-400">
                          {fixture.Round}
                        </div>

                        <div className="truncate">
                          {fixture.home_team}
                        </div>

                        <div className="truncate">
                          {fixture.away_team}
                        </div>

                        <div
                          className="truncate text-slate-400"
                          title={fixture.Competition}
                        >
                          {fixture.Competition}
                        </div>

                        <div className="text-slate-300 truncate">
                          {fixture.Date
                            ? new Date(fixture.Date).toLocaleDateString("en-AU", { day: "2-digit", month: "short" })
                            : "-"}
                        </div>

                        <div>
                          {autoFixture && autoFixture.status && autoFixture.status !== "Pending" && (
                            <span className="text-[10px] text-sky-400">
                              {autoFixture.status}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div> {/* closes the left panel */}

          <div className="rounded-xl border border-slate-700 bg-[#0f1b2d] p-4 overflow-y-auto">

            <h2 className="mb-3 text-lg font-bold">
              Recommendations
            </h2>

            {selectedFixture ? (
              <>
                <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">

                  <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">
                    Selected Fixture
                  </div>

                  <div className="flex items-center justify-between">

                    <div className="flex-1 min-w-0">

                      <div className="text-lg font-bold truncate">
                        <button
                          onClick={() => setTeamHistoryOpen(selectedFixture.home_team)}
                          className="text-white hover:text-sky-400 transition"
                        >
                          {selectedFixture.home_team}
                        </button>
                        <span className="text-slate-500 mx-2">vs</span>
                        <button
                          onClick={() => setTeamHistoryOpen(selectedFixture.away_team)}
                          className="text-white hover:text-sky-400 transition"
                        >
                          {selectedFixture.away_team}
                        </button>
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-l text-slate-400">
                        {(() => {
                          const comp = selectedFixture.Competition ?? "";
                          const year = selectedFixture.Date?.substring(0, 4) ?? "2026";
                          const logoPath = leagueLogos[`${comp} ${year}`] ?? leagueLogos[comp] ?? null;
                          if (logoPath) {
                            return (
                              <Image
                                src={logoPath}
                                alt={comp}
                                width={40}
                                height={40}
                                className="rounded-sm"
                              />
                            );
                          }
                          return null;
                        })()}
                        {selectedFixture.Competition}
                      </div>

                    </div>

                    <div className="ml-4 text-right shrink-0">

                      <div className="text-xs text-slate-400">
                        Week {selectedFixture.Week} • Round {selectedFixture.Round}
                      </div>

                      <div className="mt-1 rounded bg-sky-500/15 px-2 py-1 text-center">
                        <div className="text-[9px] uppercase tracking-wider text-sky-300">
                          Expected Day
                        </div>
                        <select
                          value={selectedFixture.expected_day ?? ""}
                          onChange={async (e) => {
                            const newDay = e.target.value || null;
                            const gameKey = selectedFixture.game_key;

                            // Optimistic update — update both fixtures
                            // (week-filtered) and historicalGames (all games)
                            // so the day-based exclusion logic re-evaluates.
                            setFixtures(prev =>
                              prev.map(g =>
                                g.game_key === gameKey
                                  ? { ...g, expected_day: newDay }
                                  : g
                              )
                            );
                            setHistoricalGames(prev =>
                              prev.map(g =>
                                g.game_key === gameKey
                                  ? { ...g, expected_day: newDay }
                                  : g
                              )
                            );

                            // Persist to Supabase
                            const { error } = await supabase
                              .from("TT_Games")
                              .update({ expected_day: newDay })
                              .eq("game_key", gameKey);

                            if (error) {
                              console.error("Failed updating expected_day:", error);
                              alert("Failed to update expected day.");
                            }
                          }}
                          className="mt-0.5 w-full rounded border border-sky-500/30 bg-slate-900 px-1.5 py-0.5 text-sm font-semibold text-sky-200 focus:border-sky-400 focus:outline-none cursor-pointer"
                        >
                          <option value="">Not set</option>
                          <option value="Monday">Monday</option>
                          <option value="Tuesday">Tuesday</option>
                          <option value="Wednesday">Wednesday</option>
                          <option value="Thursday">Thursday</option>
                          <option value="Friday">Friday</option>
                          <option value="Saturday">Saturday</option>
                          <option value="Sunday">Sunday</option>
                        </select>
                      </div>

                    </div>

                  </div>

                  {/* ALLOCATED ANALYST */}
                  {(() => {
                    const selectedAutoFixture = findAutoFixture(autoFixtures, selectedFixture);

                    if (selectedAutoFixture && (selectedAutoFixture as any).analyst) {
                      return (
                        <div className="mt-3 flex items-center gap-3 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2">
                          <div className="text-xs uppercase tracking-wide text-sky-400 shrink-0">
                            Allocated
                          </div>
                          <div className="font-semibold text-white text-sm">
                            {(selectedAutoFixture as any).analyst}
                          </div>
                          <div className="text-xs text-slate-400">
                            {[(selectedAutoFixture as any).assignmentLocation, (selectedAutoFixture as any).computer, (selectedAutoFixture as any).status !== "Pending" ? (selectedAutoFixture as any).status : null].filter(Boolean).join(" • ")}
                          </div>
                        </div>
                      );
                    }

                    return null;
                  })()}

                  {/* AFFILIATED ANALYSTS */}
                  {affiliatedAnalystsForFixture.length > 0 && (
                    <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">

                      <div className="mb-2 flex items-center gap-2">
                        <div className="text-xs uppercase tracking-wide text-emerald-400">
                          Affiliated
                        </div>
                      </div>

                      <div className="space-y-1">

                        {affiliatedAnalystsForFixture.map(
                          (analyst) => (

                            <div
                              key={analyst.analystName}
                              className="flex items-center justify-between text-sm"
                            >

                              <div className="font-medium text-white">
                                {analyst.analystName}
                              </div>

                              <div className="flex items-center gap-1">

                                {analyst.affiliatedTeams.map(
                                  (team) => (
                                    <span
                                      key={team}
                                      className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300"
                                    >
                                      {team}
                                    </span>
                                  )
                                )}

                                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs font-bold text-emerald-300">
                                  +{analyst.affiliationScore}
                                </span>

                              </div>

                            </div>

                          )
                        )}

                      </div>

                    </div>
                  )}

                </div>

                <RecommendationTable
                  fixture={selectedFixture}
                  recommendations={visibleRecommendations}
                  downloadJob={
                    downloadJobs.find(
                      job => job.gameKey === selectedFixture.game_key
                    ) ?? null
                  }
                  autoAnalysts={autoAnalysts}
                  onAssign={handleAssign}
                  onAssignDay={handleAssignDay}
                  onAssignOther={() => setManualAssignOpen(true)}
                />

                {/* ALLOCATED IN THIS COMPETITION + ROUND */}
                <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4">

                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-white">
                      Allocated this round
                    </h3>
                    <span className="text-[11px] text-slate-400">
                      {selectedFixture.Competition} • Round {selectedFixture.Round}
                    </span>
                  </div>

                  {allocatedInRound.length === 0 ? (
                    <div className="text-xs text-slate-500">
                      No analysts allocated in this round yet.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {allocatedInRound.map((entry) => (
                        <div
                          key={entry.analystKey}
                          className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                            entry.isSelected
                              ? "border-sky-500/40 bg-sky-500/10"
                              : "border-slate-700 bg-slate-800/50"
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-medium text-white truncate">
                              {entry.analystName}
                            </span>
                            {entry.isSelected && (
                              <span className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
                                This fixture
                              </span>
                            )}
                          </div>
                          <div className="ml-3 shrink-0 truncate text-xs text-slate-400">
                            {entry.home_team} v {entry.away_team}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                </div>

              </>
            ) : (
              <div className="rounded-lg border border-slate-700 bg-slate-900 p-8 text-center text-slate-500">
                No fixture selected.
              </div>
            )}

          </div>
        </div>

      </div>

      {manualAssignOpen && (

        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
          onClick={() => setManualAssignOpen(false)}
        >

          <div
            className="w-full max-w-xl rounded-xl bg-slate-900 p-6"
            onClick={(e) => e.stopPropagation()}
          >

            <h2 className="mb-4 text-xl font-bold">
              Assign Another Analyst
            </h2>

            <input
              value={manualSearch}
              onChange={(e) =>
                setManualSearch(e.target.value)
              }
              placeholder="Search analyst..."
              className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2"
            />

            <div className="max-h-[400px] overflow-y-auto rounded-lg border border-slate-700">

              {autoAnalysts

                .filter(a =>
                  (
                    a.homeComputer ||
                    a.officeComputer
                  ) &&
                  a.name
                    .toLowerCase()
                    .includes(
                      manualSearch.toLowerCase()
                    )
                )

                .sort((a, b) =>
                  a.name.localeCompare(b.name)
                )

                .map(a => (

                  <div
                    key={a.id}
                    className="border-b border-slate-700 p-4"
                  >

                    <div className="mb-2 flex items-center gap-2 font-semibold">
                      {a.name}
                      <div className="group relative">
                        <Info size={15} className="cursor-pointer text-slate-400 hover:text-sky-400" />
                        <div className="pointer-events-none absolute left-6 top-0 z-50 hidden min-w-[200px] rounded-lg border border-slate-600 bg-slate-800 p-3 shadow-lg group-hover:block">
                          <div className="mb-1.5 text-xs font-semibold text-slate-300">
                            Week {selectedFixture ? selectedFixture.Week : selectedWeek} Availability
                          </div>
                          {(() => {
                            const key = a.name.trim().toLowerCase();
                            const dates = analystScheduleDates.get(key);
                            if (!dates || dates.length === 0) {
                              return (
                                <div className="text-xs text-slate-500">
                                  No shifts rostered
                                </div>
                              );
                            }
                            return (
                              <div className="space-y-1">
                                {dates.map((d) => (
                                  <div key={d.date} className="flex items-center justify-between text-xs">
                                    <span className="text-slate-400">{d.day}</span>
                                    <span className="text-white">{d.date}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">

                      {a.homeComputer && (

                        <button
                          onClick={() =>
                            handleManualAssign(
                              a,
                              "Home"
                            )
                          }
                          className="flex w-full items-center justify-between rounded bg-emerald-600 px-3 py-2 hover:bg-emerald-500"
                        >

                          <span>
                            Home
                          </span>

                          <span>
                            {a.homeComputer.computerName}
                          </span>

                        </button>

                      )}

                      {a.officeComputer && (

                        <button
                          onClick={() =>
                            handleManualAssign(
                              a,
                              "Office"
                            )
                          }
                          className="flex w-full items-center justify-between rounded bg-sky-600 px-3 py-2 hover:bg-sky-500"
                        >

                          <span>
                            Office
                          </span>

                          <span>
                            {a.officeComputer.computerName}
                          </span>

                        </button>

                      )}

                    </div>

                  </div>

                ))}

            </div>

            <button
              onClick={() =>
                setManualAssignOpen(false)
              }
              className="mt-4 w-full rounded-lg border border-slate-700 py-2 hover:bg-slate-800"
            >
              Cancel
            </button>

          </div>

        </div>

      )}

      {/* DAY ASSIGN CONFIRMATION MODAL */}
      {dayAssignConfirm && selectedFixture && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
          onClick={() => setDayAssignConfirm(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-slate-900 border border-slate-700 p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-white mb-1">
              Confirm Allocation
            </h2>

            <p className="text-sm text-slate-400 mb-5">
              Assign this fixture to the analyst for the selected day?
            </p>

            <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Analyst</div>
                <div className="font-semibold text-white">
                  {dayAssignConfirm.recommendation.analyst.name}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Fixture</div>
                <div className="font-semibold text-white">
                  {selectedFixture.home_team} vs {selectedFixture.away_team}
                </div>
                <div className="text-xs text-slate-400">
                  {selectedFixture.Competition} • Round {selectedFixture.Round}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Scheduled Day</div>
                <div className="font-semibold text-sky-400">
                  {dayAssignConfirm.day}
                  {" — "}
                  {new Date(`${dayAssignConfirm.date}T00:00:00`).toLocaleDateString("en-AU", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </div>
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setDayAssignConfirm(null)}
                className="flex-1 rounded-lg border border-slate-700 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={confirmAssignDay}
                className="flex-1 rounded-lg bg-sky-600 py-2.5 text-sm font-semibold text-white hover:bg-sky-500"
              >
                Confirm Allocation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TEAM HISTORY MODAL */}
      {teamHistoryOpen && selectedFixture && (() => {
        const teamName = teamHistoryOpen;

        // Find last 10 games for this team from historicalGames
        const teamGames = historicalGames
          .filter(g =>
            g.home_team?.trim().toLowerCase() === teamName.trim().toLowerCase() ||
            g.away_team?.trim().toLowerCase() === teamName.trim().toLowerCase()
          )
          .sort((a, b) => rowAbsoluteWeek(b) - rowAbsoluteWeek(a))
          .slice(0, 10);

        // Get unique analysts who coded this team
        const analystNames = new Set<string>();
        teamGames.forEach(g => {
          if (g.home_team?.trim().toLowerCase() === teamName.trim().toLowerCase()) {
            if (g.home_allocated && !isExcludedAnalystName(g.home_allocated)) {
              analystNames.add(g.home_allocated);
            }
          }
          if (g.away_team?.trim().toLowerCase() === teamName.trim().toLowerCase()) {
            if (g.away_allocated && !isExcludedAnalystName(g.away_allocated)) {
              analystNames.add(g.away_allocated);
            }
          }
        });

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={() => setTeamHistoryOpen(null)}
          >
            <div
              className="w-full max-w-3xl max-h-[80vh] overflow-hidden rounded-xl bg-slate-900 shadow-2xl flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
                <div>
                  <h2 className="text-lg font-bold text-white">
                    {teamName} — Last 10 Games
                  </h2>
                  <p className="text-xs text-slate-400">
                    Click an analyst to assign them to the current fixture
                  </p>
                </div>
                <button
                  onClick={() => setTeamHistoryOpen(null)}
                  className="text-slate-400 hover:text-white text-lg px-2"
                >
                  ×
                </button>
              </div>

              {/* Games Table */}
              <div className="flex-1 overflow-y-auto px-5 py-3">
                <table className="w-full text-xs text-left">
                  <thead className="text-slate-400 uppercase text-[10px]">
                    <tr>
                      <th className="pb-2">Wk</th>
                      <th className="pb-2">Competition</th>
                      <th className="pb-2">Rnd</th>
                      <th className="pb-2">Home</th>
                      <th className="pb-2">Away</th>
                      <th className="pb-2">Coded By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamGames.map((game, i) => {
                      const isHome = game.home_team?.trim().toLowerCase() === teamName.trim().toLowerCase();
                      const coder = isHome ? game.home_allocated : game.away_allocated;

                      return (
                        <tr key={`${game.game_key}-${i}`} className="border-t border-slate-700">
                          <td className="py-2 text-sky-400 font-semibold">{game.Week}</td>
                          <td className="py-2 text-slate-400 truncate">{game.Competition}</td>
                          <td className="py-2 text-slate-400">{game.Round}</td>
                          <td className="py-2 truncate">{game.home_team}</td>
                          <td className="py-2 truncate">{game.away_team}</td>
                          <td className="py-2 text-emerald-400 font-medium">{coder ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Unique analysts with Assign buttons */}
              {analystNames.size > 0 && (
                <div className="border-t border-slate-700 px-5 py-3">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">
                    Previous analysts for {teamName}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[...analystNames].sort().map(name => {
                      const matchedAnalyst = autoAnalysts.find(
                        a => a.name.trim().toLowerCase() === name.trim().toLowerCase()
                      );

                      return (
                        <button
                          key={name}
                          disabled={!matchedAnalyst}
                          onClick={async () => {
                            if (!matchedAnalyst) return;

                            const location: "Home" | "Office" =
                              matchedAnalyst.officeComputer ? "Office" : "Home";
                            const computer = location === "Office"
                              ? matchedAnalyst.officeComputer
                              : matchedAnalyst.homeComputer;

                            if (!computer) {
                              alert(`${name} does not have a computer assigned.`);
                              return;
                            }

                            try {
                              const autoFixture = findAutoFixture(autoFixtures, selectedFixture);

                              if (autoFixture && (autoFixture as any).id) {
                                await assignFixture(
                                  (autoFixture as any).id,
                                  matchedAnalyst.id,
                                  location
                                );
                              }

                              await createDownloadJob({
                                gameKey: selectedFixture.game_key,
                                videoUrl: selectedFixture.videoURL ?? "",
                                analystId: matchedAnalyst.id,
                                computerId: computer.id,
                                assignmentLocation: location,
                                year: selectedFixture.Date.substring(0, 4),
                                leagueName: selectedFixture.Competition,
                                fileSizeBytes: autoFixture?.fileSizeBytes ?? null,
                              });

                              alert(`Assigned to ${name} and download queued.`);
                              setTeamHistoryOpen(null);
                            } catch (err) {
                              console.error(err);
                              alert(err instanceof Error ? err.message : "Assignment failed.");
                            }
                          }}
                          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                            matchedAnalyst
                              ? "bg-sky-600 text-white hover:bg-sky-500"
                              : "bg-slate-800 text-slate-500 cursor-not-allowed"
                          }`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="border-t border-slate-700 px-5 py-3">
                <button
                  onClick={() => setTeamHistoryOpen(null)}
                  className="w-full rounded-lg border border-slate-700 py-2 text-sm hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>)
}
