import type { CompFixtureRow } from "@/lib/api/compFixtures";
import type { GamefaceAllocation } from "@/lib/api/gamefaceDeputy";

export function fixture(id: string, over: Partial<CompFixtureRow> = {}): CompFixtureRow {
    return {
        id,
        competition_uid: 1,
        competition: "AFL Comp",
        season: 2025,
        sport: "Australian Rules Football",
        round: "R1",
        fixture_date: "2025-05-01",
        fixture_time: "19:00",
        home_team: `Home ${id}`,
        away_team: `Away ${id}`,
        home_team_uid: null,
        away_team_uid: null,
        is_final: false,
        score: "",
        video_url: "",
        video_name: "",
        ...over,
    } as CompFixtureRow;
}

export function allocation(id: number, fixtureId: string, rosterId: string, name = "Sam"): GamefaceAllocation {
    return {
        id,
        comp_fixture_id: fixtureId,
        roster_deputy_id: rosterId,
        employee_name: name,
        shift_date: "2025-05-01",
        allocated_by: "admin",
        allocated_at: "2025-05-01T00:00:00Z",
    };
}
