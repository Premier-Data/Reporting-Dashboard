import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const FORBIDDEN = [/AllocationModal/, /assignFixture/, /createDownloadJob/, /autodownload/i, /ttGames|TT_Games/];

describe("GameFace fixture allocation isolation", () => {
    it.each(["GamefaceFixturePanel.tsx", "GamefaceAllocateModal.tsx", "../../lib/deputy/gamefaceFixtures.ts"])(
        "%s has no Premier allocation or download imports",
        (file) => {
            const src = read(file);
            for (const bad of FORBIDDEN) expect(src).not.toMatch(bad);
        }
    );

    it("ScheduleView only uses the allocator behind a defined check", () => {
        const src = read("ScheduleView.tsx");
        const lines = src.split("\n");
        const uses = lines.filter(
            (l) => /\ballocator\b/.test(l) && !/^\s*(\/\/|\*|\/\*|import)/.test(l)
        );
        expect(uses.length).toBeGreaterThan(0);
        expect(src).toContain("allocator !== undefined");
        expect(src).toContain("allocator === undefined");
        expect(src).not.toMatch(/gamefaceShiftFixtures\([^)]*\)\s*&&\s*allocator/);
    });

    it("page.tsx passes allocator only in the GameFace branch", () => {
        const src = read("page.tsx");
        const [, premierBranch] = src.split('if (deputy === "gameface")')[1].split("\n    }\n");
        expect(src.match(/allocator=/g)).toHaveLength(1);
        expect(premierBranch).toContain('<ScheduleView key="premier"');
        expect(premierBranch).not.toContain("allocator");
    });
});
