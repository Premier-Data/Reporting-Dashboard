import { RecommendationContext } from "./types";
import { rowAbsoluteWeek } from "@/lib/analytics/gameWeekIndex";

// ------------------------------------------------
// LEAGUE EXPERIENCE (20)
// ------------------------------------------------

export function scoreLeagueExperience(
    context: RecommendationContext
): number {

    const league =
        context.fixture.Competition ?? "";

    const games =
        context.analyst.competitions[league] ?? 0;

    if (games >= 10) return 40;
    if (games >= 7) return 30;
    if (games >= 5) return 25;
    if (games >= 3) return 15;
    if (games >= 1) return 10;

    return 0;
}

// ------------------------------------------------
// HOME TEAM EXPERIENCE (30)
// ------------------------------------------------

export function scoreHomeTeamExperience(
    context: RecommendationContext
): number {

    const team =
        context.fixture.home_team ?? "";

    const games =
        context.analyst.teams[team]?.count ?? 0;

    if (games >= 7) return 25;
    if (games >= 5) return 20;
    if (games >= 3) return 16;
    if (games >= 2) return 12;
    if (games >= 1) return 6;

    return 0;
}

// ------------------------------------------------
// AWAY TEAM EXPERIENCE (30)
// ------------------------------------------------

export function scoreAwayTeamExperience(
    context: RecommendationContext
): number {

    const team =
        context.fixture.away_team ?? "";

    const games =
        context.analyst.teams[team]?.count ?? 0;

    if (games >= 7) return 25;
    if (games >= 5) return 20;
    if (games >= 3) return 16;
    if (games >= 2) return 12;
    if (games >= 1) return 6;

    return 0;
}

// ------------------------------------------------
// RECENT EXPERIENCE (15)
// ------------------------------------------------

export function scoreRecentExperience(
    context: RecommendationContext
): number {

    const currentWeek =
        rowAbsoluteWeek(context.fixture);

    const games =
        context.historicalGames.filter((game) => {

            const gameWeek =
                rowAbsoluteWeek(game);

            return (
                game.Competition === context.fixture.Competition &&
                gameWeek >= currentWeek - 5 &&
                gameWeek < currentWeek &&
                (
                    game.home_allocated === context.analyst.name ||
                    game.away_allocated === context.analyst.name
                )
            );

        }).length;

    if (games >= 4) return 10;
    if (games === 3) return 8;
    if (games === 2) return 6;
    if (games === 1) return 4;

    return 0;
}

// ------------------------------------------------
// QUALITY (2.5)
// ------------------------------------------------

export function scoreQuality(
    context: RecommendationContext
): number {

    const rating =
        context.analyst.ratings.overall;

    if (rating >= 90) return 5;
    if (rating >= 85) return 4;
    if (rating >= 80) return 3;
    if (rating >= 75) return 2;
    if (rating >= 70) return 1;

    return 0;
}
