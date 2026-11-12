import { buildRatings } from "./ratings/buildRatings";
import { buildOverall } from "./ratings/buildOverall";
import { isExcludedAnalystName } from "./excludedAnalysts";
import { seasonWeekKey } from "./gameWeekIndex";

import type { AnalystMetrics } from "@/types/analyst";
import type { DeputyShift } from "@/types/deputy";
import type { TTGame } from "@/types/ttgame";

// -------------------------
// NORMALISER
// -------------------------
const normKey = (value: unknown): string =>
  String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// -------------------------
// MAIN
// -------------------------
export function buildAnalystMetrics(
  shifts: DeputyShift[] = [],
  games: TTGame[] = []
): AnalystMetrics[] {
  const map = new Map<string, AnalystMetrics>();
  const workedWeeks = new Map<string, Set<string>>();
  const gameWeeks = new Map<string, Set<string>>();

  // -------------------------
  // CREATE / GET ANALYST
  // -------------------------
  const getOrCreate = (name: string): AnalystMetrics => {
    const key = normKey(name);

    if (!workedWeeks.has(key)) {
      workedWeeks.set(key, new Set<string>());
    }

    if (!gameWeeks.has(key)) {
      gameWeeks.set(key, new Set<string>());
    }

    if (!map.has(key)) {
      map.set(key, {
        key,
        name: name.trim() || "Unknown",

        team: "AUS",

        totalHours: 0,
        totalCost: 0,
        totalGames: 0,

        avgHoursPerWeek: 0,
        avgGamesPerWeek: 0,

        avgHoursPerGame: 0,
        avgCostPerGame: 0,
        costPerHour: 0,

        areas: {},
        competitions: {},
        teams: {},

        ratings: {
          speed: 0,
          efficiency: 0,
          workRate: 0,
          experience: 0,
          consistency: 0,
          versatility: 0,
          knowledge: 0,
          overall: 0,
        },

        grade: "",

        rank: 0,
        percentile: 0,
        totalAnalysts: 0,

        strengths: [],
        weaknesses: [],

        availabilityDays: [],
      });
    }

    return map.get(key)!;
  };

  // =====================================================
  // SHIFTS
  // =====================================================
  for (const shift of shifts) {
    if (!shift?.employee_name) continue;
    if (isExcludedAnalystName(shift.employee_name)) continue;

    const analyst = getOrCreate(shift.employee_name);
    const area = shift.area_name ?? "Unknown";
    const areaKey = normKey(area);

    const hours = Number(shift.total_hours || 0);
    const cost = Number(shift.total_cost || 0);

    // Season-qualified key: bare week numbers repeat across seasons.
    const derivedKey = seasonWeekKey({
      shift_date: (shift as { shift_date?: unknown }).shift_date,
      season: (shift as { season?: unknown }).season,
      week: shift.week,
    });
    const week =
      derivedKey ??
      shift.week ??
      shift.week_name ??
      shift.week_start ??
      shift.pay_week;

    if (week) {
      workedWeeks.get(analyst.key)?.add(String(week));
    }

    // Store hours by area
    analyst.areas[area] =
      (analyst.areas[area] || 0) + hours;

    // Only include analyst-related work in total hours and cost
    if (
      areaKey.includes("home analyst") ||
      areaKey.includes("office analyst")
    ) {
      analyst.totalHours += hours;
      analyst.totalCost += cost;
    }
  }

  // =====================================================
  // TT GAMES
  // =====================================================

  let homeCount = 0;
  let awayCount = 0;

  for (const game of games) {

    const competition =
      game?.Competition ?? "Unknown";

    const gameWeekKey = seasonWeekKey(game);

    // ===================================================
    // HOME ANALYST
    // ===================================================

    if (game.home_allocated && !isExcludedAnalystName(game.home_allocated)) {

      homeCount++;

      const analyst = getOrCreate(game.home_allocated);

      if (gameWeekKey) {
        gameWeeks.get(analyst.key)?.add(gameWeekKey);
      }

      // One side of a game = 0.5 game
      analyst.totalGames += 0.5;

      // League breakdown
      analyst.competitions[competition] =
        (analyst.competitions[competition] || 0) + 0.5;

      if (game.home_team) {

        const team = game.home_team;

        if (!analyst.teams[team]) {
          analyst.teams[team] = {
            count: 0,
            league: competition,
          };
        }

        analyst.teams[team].count += 1;
      }
    }

    // ===================================================
    // AWAY ANALYST
    // ===================================================

    if (game.away_allocated && !isExcludedAnalystName(game.away_allocated)) {

      awayCount++;

      const analyst = getOrCreate(game.away_allocated);

      if (gameWeekKey) {
        gameWeeks.get(analyst.key)?.add(gameWeekKey);
      }

      // One side of a game = 0.5 game
      analyst.totalGames += 0.5;

      // League breakdown
      analyst.competitions[competition] =
        (analyst.competitions[competition] || 0) + 0.5;

      if (game.away_team) {

        const team = game.away_team;

        if (!analyst.teams[team]) {
          analyst.teams[team] = {
            count: 0,
            league: competition,
          };
        }

        analyst.teams[team].count += 1;
      }
    }
  }
  // =====================================================
  // FINAL CALCULATIONS
  // =====================================================
  map.forEach((analyst) => {

    const weeksWorked =
      workedWeeks.get(analyst.key)?.size ?? 0;

    analyst.avgHoursPerWeek =
      weeksWorked > 0
        ? analyst.totalHours / weeksWorked
        : 0;

    const gameWeeksWorked =
      gameWeeks.get(analyst.key)?.size ?? 0;

    analyst.avgGamesPerWeek =
      gameWeeksWorked > 0
        ? analyst.totalGames / gameWeeksWorked
        : 0;

    analyst.avgHoursPerWeek = Number(
      analyst.avgHoursPerWeek.toFixed(2)
    );

    analyst.avgGamesPerWeek = Number(
      analyst.avgGamesPerWeek.toFixed(2)
    );

    analyst.costPerHour =
      analyst.totalHours > 0
        ? analyst.totalCost / analyst.totalHours
        : 0;

    analyst.avgHoursPerGame =
      analyst.totalGames > 0
        ? analyst.totalHours / analyst.totalGames
        : 0;

    analyst.avgCostPerGame =
      analyst.totalGames > 0
        ? analyst.totalCost / analyst.totalGames
        : 0;

    if (
      analyst.totalHours === 0 &&
      analyst.totalCost === 0
    ) {
      analyst.team = "PHL";
    } else {
      analyst.team = "AUS";
    }

    // Round values
    analyst.totalHours = Number(
      analyst.totalHours.toFixed(2)
    );

    analyst.totalCost = Number(
      analyst.totalCost.toFixed(2)
    );

    analyst.totalGames = Number(
      analyst.totalGames.toFixed(1)
    );

    analyst.avgHoursPerWeek = Number(
      analyst.avgHoursPerWeek.toFixed(2)
    );


    // NOW calculate ratings
    const ratings = buildRatings(analyst);
    const overall = buildOverall(
      ratings,
      analyst.team
    );

    analyst.ratings = {
      ...ratings,
      overall: overall.overall,
    };

    analyst.grade = overall.grade;
  });

  // -------------------------
  // DEBUG
  // -------------------------
  console.log("📊 ANALYST COUNT:", map.size);
  console.log(
    "📊 SAMPLE:",
    Array.from(map.values()).slice(0, 3)
  );

  // -------------------------
  // RETURN
  // -------------------------
  const analysts = Array.from(map.values())
    // Only include analysts that have actually coded games
    .filter((a) => a.totalGames > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Total analysts after filtering
  analysts.forEach((a) => {
    a.totalAnalysts = analysts.length;
  });

  return analysts;
}