import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import GamefaceAllocateModal from "./GamefaceAllocateModal";
import { AlreadyAllocatedError } from "@/lib/api/gamefaceDeputy";
import { allocation, fixture } from "./gamefaceTestData";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shift = { rosterId: "42", employeeName: "Sam", date: "2025-05-01" };
const fixtures = [
    fixture("a", { fixture_date: "2025-05-01" }),
    fixture("taken", { fixture_date: "2025-05-01" }),
];
const byFixtureId = new Map([["taken", allocation(1, "taken", "7", "Other")]]);

function mount(allocate: (...a: any[]) => Promise<unknown>, onChanged = vi.fn(), onClose = vi.fn()) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const allocator: any = { allocate };
    act(() => {
        createRoot(container).render(
            <GamefaceAllocateModal
                shift={shift}
                fixtures={fixtures}
                byFixtureId={byFixtureId}
                allocator={allocator}
                onClose={onClose}
                onChanged={onChanged}
            />
        );
    });
    return { container, onChanged, onClose };
}

const allocateButton = (c: HTMLElement) =>
    Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Allocate") as HTMLButtonElement;

describe("GamefaceAllocateModal", () => {
    it("lists only unallocated fixtures", () => {
        const { container } = mount(vi.fn());
        expect(container.textContent).toContain("Home a v Away a");
        expect(container.textContent).not.toContain("Home taken");
    });

    it("allocates once with the shift roster id and closes", async () => {
        const allocate = vi.fn().mockResolvedValue({});
        const { container, onChanged, onClose } = mount(allocate);
        await act(async () => {
            allocateButton(container).click();
        });
        expect(allocate).toHaveBeenCalledTimes(1);
        expect(allocate).toHaveBeenCalledWith({ compFixtureId: "a", rosterId: "42", employeeName: "Sam" });
        expect(onChanged).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("shows the already-allocated message, refreshes, and stays open", async () => {
        const allocate = vi.fn().mockRejectedValue(new AlreadyAllocatedError());
        const { container, onChanged, onClose } = mount(allocate);
        await act(async () => {
            allocateButton(container).click();
        });
        expect(container.querySelector("[role=alert]")!.textContent).toContain("already allocated");
        expect(onChanged).toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });
});
