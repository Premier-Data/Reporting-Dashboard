import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import GamefaceFixturePanel from "./GamefaceFixturePanel";
import { allocation, fixture } from "./gamefaceTestData";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function mount(el: React.ReactElement) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
        createRoot(container).render(el);
    });
    return container;
}

describe("GamefaceFixturePanel", () => {
    const fixtures = [
        fixture("a", { competition: "Comp A", fixture_date: "2025-05-02" }),
        fixture("b", { competition: "Comp B", fixture_date: "2025-05-01" }),
    ];

    it("renders only the supplied fixtures, sorted by date, with Available and Allocated badges", () => {
        const byFixtureId = new Map([["a", allocation(1, "a", "10", "Sam")]]);
        const c = mount(<GamefaceFixturePanel fixtures={fixtures} byFixtureId={byFixtureId} />);
        expect(c.textContent).toContain("Fixtures this week (AFL)");
        const items = Array.from(c.querySelectorAll("li"));
        expect(items).toHaveLength(2);
        expect(items[0].textContent).toContain("Home b v Away b");
        expect(items[0].textContent).toContain("Available");
        expect(items[1].textContent).toContain("Allocated: Sam");
    });

    it("filters by competition", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fixtures} byFixtureId={new Map()} />);
        const select = c.querySelector("select") as HTMLSelectElement;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "Comp A");
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        const items = Array.from(c.querySelectorAll("li"));
        expect(items).toHaveLength(1);
        expect(items[0].textContent).toContain("Home a");
    });

    it("shows the empty state", () => {
        const c = mount(<GamefaceFixturePanel fixtures={[]} byFixtureId={new Map()} />);
        expect(c.textContent).toContain("No AFL fixtures synced for this week");
    });
});
