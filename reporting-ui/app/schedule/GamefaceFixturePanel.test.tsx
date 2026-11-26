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

describe("GamefaceFixturePanel search", () => {
    const fx = [
        fixture("a", { competition: "Alpha League", home_team: "Cats", away_team: "Dogs", round: "R1" }),
        fixture("b", { competition: "Beta Cup", home_team: "Swans", away_team: "Lions", round: "R2" }),
        fixture("c", { competition: "Alpha League", home_team: "Bears", away_team: "Crows", round: "R3" }),
    ];
    function type(c: HTMLElement, value: string) {
        const input = c.querySelector('input[aria-label="Search fixtures"]') as HTMLInputElement;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    }
    const count = (c: HTMLElement) => c.querySelectorAll("li").length;
    it("narrows by competition substring, case-insensitively", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fx} byFixtureId={new Map()} />);
        type(c, "ALPHA");
        expect(count(c)).toBe(2);
        expect(c.textContent).toContain("2 of 3 fixtures");
    });
    it("matches team names and round", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fx} byFixtureId={new Map()} />);
        type(c, "swans");
        expect(count(c)).toBe(1);
        type(c, "r3");
        expect(c.querySelector("li")!.textContent).toContain("Bears");
    });
    it("combines with the competition and status filters", () => {
        const c = mount(
            <GamefaceFixturePanel fixtures={fx} byFixtureId={new Map([["a", allocation(1, "a", "9")]])} />
        );
        const [comp, status] = Array.from(c.querySelectorAll("select")) as HTMLSelectElement[];
        const set = (s: HTMLSelectElement, v: string) =>
            act(() => {
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, v);
                s.dispatchEvent(new Event("change", { bubbles: true }));
            });
        set(comp, "Alpha League");
        type(c, "o");
        expect(count(c)).toBe(2);
        set(status, "available");
        expect(count(c)).toBe(1);
        expect(c.querySelector("li")!.textContent).toContain("Bears");
    });
    it("shows an empty state and clear restores the full list", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fx} byFixtureId={new Map()} />);
        type(c, "zzz");
        expect(count(c)).toBe(0);
        expect(c.textContent).toContain("No fixtures match");
        act(() => {
            (c.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement).click();
        });
        expect(count(c)).toBe(3);
    });
    it("keeps filtered Available rows draggable", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fx} byFixtureId={new Map()} draggable />);
        type(c, "beta");
        expect((c.querySelector("li") as HTMLLIElement).draggable).toBe(true);
    });
});