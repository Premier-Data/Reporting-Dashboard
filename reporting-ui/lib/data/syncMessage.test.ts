import { describe, it, expect } from "vitest";
import { syncMessage } from "./syncMessage";

describe("syncMessage", () => {
    it("reports a completed sync", () => {
        expect(syncMessage(true, new Date(2026, 10, 9, 14, 5))).toMatch(
            /^Synced from Deputy just now \(/
        );
    });

    it("reports when no sync ran", () => {
        const msg = syncMessage(false);
        expect(msg).toContain("No new sync was run");
        expect(msg).toContain("Showing the latest saved data.");
    });
});
