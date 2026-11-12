import type { AnalystMetrics } from "@/types/analyst";
import type { TTGame } from "@/types/ttgame";

import {
    scoreLeagueExperience,
    scoreHomeTeamExperience,
    scoreAwayTeamExperience,
    scoreQuality,
    scoreRecentExperience,
} from "./scoring";

import type { RecommendationContext } from "./types";
import { rowAbsoluteWeek } from "@/lib/analytics/gameWeekIndex";

// ------------------------------------------------
// EVIDENCE
// ------------------------------------------------

export interface EvidenceItem {
    label: string;
    value: number | string;
    assessment: string;
}

export interface RecommendationEvidence {
    leagueGames: number;

    homeTeamGames: number;

    awayTeamGames: number;

    recentGames: number;

    overallRating: number;

    totalGames: number;

    homeTeamName?: string;

    awayTeamName?: string;

    affiliationScore: number;

    affiliatedTeams: string[];
}

// ------------------------------------------------
// RECOMMENDATION
// ------------------------------------------------

export interface Recommendation {
    analyst: AnalystMetrics;

    score: number;

    confidence:
        | "Excellent"
        | "High"
        | "Medium"
        | "Low";

    summary: string;

    evidence: RecommendationEvidence;

    availability: string;

    availabilityDays: string[];

    availabilityMatchesFixture: boolean;
}

// ------------------------------------------------
// TEAM NAME NORMALISATION
// ------------------------------------------------

function normaliseTeamName(
    name: string | null | undefined
): string {
    return (name ?? "")
        .trim()
        .toLowerCase();
}

// ------------------------------------------------
// RECENT TEAM EXPERIENCE (LAST 5 WEEKS)
// ------------------------------------------------
// Counts how many times an analyst coded a given team in the 5 weeks
// leading up to (but not including) the fixture week. Uses the same
// window as the "matches coded in the last 5 weeks" recent-experience
// metric so the two stay consistent. Matches the team on either the
// home OR away side (the analyst may have coded that team in either
// role) and confirms the analyst actually coded that specific side.
const RECENT_WEEKS_WINDOW = 5;

function countRecentTeamGames(
    historicalGames: TTGame[],
    analystName: string,
    teamName: string | null | undefined,
    fixtureWeek: number
): number {
    const team = normaliseTeamName(teamName);

    if (!team || Number.isNaN(fixtureWeek)) {
        return 0;
    }

    const analyst = normaliseTeamName(analystName);

    return historicalGames.filter((game) => {
        // Continuous index so the window works across season boundaries.
        const gameWeek = rowAbsoluteWeek(game);

        const inWindow =
            gameWeek >= fixtureWeek - RECENT_WEEKS_WINDOW &&
            gameWeek < fixtureWeek;

        if (!inWindow) {
            return false;
        }

        const codedHome =
            normaliseTeamName(game.home_team) === team &&
            normaliseTeamName(game.home_allocated) === analyst;

        const codedAway =
            normaliseTeamName(game.away_team) === team &&
            normaliseTeamName(game.away_allocated) === analyst;

        return codedHome || codedAway;
    }).length;
}

// ------------------------------------------------
// BUILD RECOMMENDATIONS
// ------------------------------------------------

export function buildRecommendations(
    fixture: TTGame,
    analysts: AnalystMetrics[],
    historicalGames: TTGame[],
    analystAvailability: Map<string, string[]>,
    analystAffiliations: Map<string, string[]>
): Recommendation[] {

    const homeTeam =
        normaliseTeamName(
            fixture.home_team
        );

    const awayTeam =
        normaliseTeamName(
            fixture.away_team
        );

    return analysts

        .map((analyst) => {

            const context: RecommendationContext = {
                fixture,
                analyst,
                analysts,
                historicalGames,
            };

            const availabilityDays =
                analystAvailability.get(
                    analyst.key
                ) ?? [];

            const expectedDay =
                fixture.expected_day ?? "";

            const availabilityMatchesFixture =
                availabilityDays.includes(
                    expectedDay
                );

            const availability =
                availabilityDays.length > 0
                    ? availabilityDays.join(", ")
                    : "No upcoming shifts";

            // ------------------------------------------------
            // TEAM AFFILIATION
            // ------------------------------------------------

            const affiliations =
                analystAffiliations.get(
                    analyst.name
                        .trim()
                        .toLowerCase()
                ) ?? [];

            const normalisedAffiliations =
                affiliations.map(
                    normaliseTeamName
                );

            const affiliatedWithHome =
                normalisedAffiliations.includes(
                    homeTeam
                );

            const affiliatedWithAway =
                normalisedAffiliations.includes(
                    awayTeam
                );

            let affiliationScore = 0;

            if (affiliatedWithHome) {
                affiliationScore += 10;
            }

            if (affiliatedWithAway) {
                affiliationScore += 10;
            }

            const affiliatedTeams =
                affiliations.filter(
                    (team) => {

                        const normalisedTeam =
                            normaliseTeamName(
                                team
                            );

                        return (
                            normalisedTeam ===
                                homeTeam ||
                            normalisedTeam ===
                                awayTeam
                        );

                    }
                );

            // ----------------------------
            // KPI SCORES
            // ----------------------------

            const league =
                scoreLeagueExperience(
                    context
                );

            const home =
                scoreHomeTeamExperience(
                    context
                );

            const away =
                scoreAwayTeamExperience(
                    context
                );

            const recent =
                scoreRecentExperience(
                    context
                );

            const quality =
                scoreQuality(
                    context
                );

            // ----------------------------
            // FINAL SCORE
            // ----------------------------

            const rawScore =
    league +
    home +
    away +
    recent +
    quality +
    affiliationScore;

const score =
    Math.min(rawScore, 100);

            // ----------------------------
            // CONFIDENCE
            // ----------------------------

            let confidence:
                | "Excellent"
                | "High"
                | "Medium"
                | "Low";

            if (score >= 90)
                confidence = "Excellent";
            else if (score >= 75)
                confidence = "High";
            else if (score >= 60)
                confidence = "Medium";
            else
                confidence = "Low";

            // ----------------------------
            // SUMMARY
            // ----------------------------

            let summary =
                "Suitable recommendation based on available experience.";

            if (affiliationScore === 20) {

                summary =
                    "Affiliated with both teams in this fixture.";

            }
            else if (affiliationScore === 10) {

                summary =
                    "Affiliated with one of the teams in this fixture.";

            }
            else if (
                home >= 20 ||
                away >= 20
            ) {

                summary =
                    "Extensive experience with one or both teams.";

            }
            else if (league >= 16) {

                summary =
                    "Highly experienced in this competition.";

            }
            else if (recent >= 9) {

                summary =
                    "Strong recent experience in this league.";

            }
            else if (quality >= 2) {

                summary =
                    "High-performing analyst.";

            }

            // ----------------------------
            // EVIDENCE
            // ----------------------------

            const evidence: RecommendationEvidence = {

                leagueGames:
                    context.analyst.competitions[
                        fixture.Competition ?? ""
                    ] ?? 0,

                // Count how many times this analyst has coded the
                // home/away team in the LAST 5 WEEKS only, not all-time.
                // A team coded 3 times 15 weeks ago isn't relevant to
                // who should code them now, so recency matters more than
                // lifetime totals for this allocation decision.
                homeTeamGames:
                    countRecentTeamGames(
                        historicalGames,
                        analyst.name,
                        fixture.home_team,
                        rowAbsoluteWeek(fixture)
                    ),

                awayTeamGames:
                    countRecentTeamGames(
                        historicalGames,
                        analyst.name,
                        fixture.away_team,
                        rowAbsoluteWeek(fixture)
                    ),

                recentGames:
                    historicalGames.filter(
                        (game) => {

                            const gameWeek =
                                rowAbsoluteWeek(game);
                            const fixtureIdx =
                                rowAbsoluteWeek(fixture);

                            return (
                                game.Competition ===
                                    fixture.Competition &&

                                gameWeek >=
                                    fixtureIdx - 5 &&

                                gameWeek <
                                    fixtureIdx &&

                                (
                                    game.home_allocated ===
                                        analyst.name ||

                                    game.away_allocated ===
                                        analyst.name
                                )
                            );

                        }
                    ).length,

                overallRating:
                    analyst.ratings.overall,

                totalGames:
                    analyst.totalGames,

                homeTeamName:
                    fixture.home_team ?? "",

                awayTeamName:
                    fixture.away_team ?? "",

                affiliationScore,

                affiliatedTeams,

            };

            return {

                analyst,

                computerId: null,

                location: "Office",

                score,

                confidence,

                summary,

                evidence,

                availability,

                availabilityDays,

                availabilityMatchesFixture,

            };

        })

        .sort(
            (a, b) =>
                b.score - a.score
        );
}