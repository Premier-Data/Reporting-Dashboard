import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// The Next router is mocked so that router.replace/push never change
// useSearchParams (the failure seen on the static export): the page must
// switch views from its own state and not depend on the router re-rendering.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(window.location.search.split("#")[0]),
}));
vi.mock("@/components/auth/AuthContext", () => ({
    useAuth: () => ({ hasAccess: () => true }),
}));
vi.mock("@/components/deputy/GamefaceGate", () => ({
    default: ({ children, headerExtra }: any) => (
        <div data-testid="view">
            gameface-gate
            {headerExtra}
            {children({ source: "gameface", lock: () => {} })}
        </div>
    ),
}));
vi.mock("./ScheduleView", () => ({
    default: ({ headerExtra, title }: any) => (
        <div data-testid="view">
            {title ?? "premier-view"}
            {headerExtra}
        </div>
    ),
}));

import SchedulePage from "./page";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function pick(container: HTMLElement, value: string) {
    const select = container.querySelector("select") as HTMLSelectElement;
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
        setter.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

describe("Schedule page deputy dropdown", () => {
    let container: HTMLElement;
    beforeEach(() => {
        window.history.replaceState(null, "", "/schedule");
        document.body.innerHTML = "";
        container = document.createElement("div");
        document.body.appendChild(container);
        act(() => {
            createRoot(container).render(<SchedulePage />);
        });
    });

    it("switches Premier Data -> GameFace -> Premier Data each time, updating the URL", () => {
        expect(container.textContent).toContain("premier-view");

        pick(container, "gameface");
        expect(container.textContent).toContain("GameFace Schedule");
        expect(window.location.search).toBe("?deputy=gameface");
        expect((container.querySelector("select") as HTMLSelectElement).value).toBe("gameface");

        pick(container, "premier");
        expect(container.textContent).toContain("premier-view");
        expect(container.textContent).not.toContain("GameFace Schedule");
        expect(window.location.search).toBe("");
        expect((container.querySelector("select") as HTMLSelectElement).value).toBe("premier");
    });

    it("follows browser back/forward", () => {
        pick(container, "gameface");
        expect(container.textContent).toContain("GameFace Schedule");
        act(() => {
            window.history.replaceState(null, "", "/schedule");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        expect(container.textContent).toContain("premier-view");
    });
});
