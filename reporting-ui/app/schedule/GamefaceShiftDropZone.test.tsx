import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import GamefaceShiftDropZone, { GAMEFACE_FIXTURE_DND_TYPE } from "./GamefaceShiftDropZone";
import GamefaceFixturePanel from "./GamefaceFixturePanel";
import { AlreadyAllocatedError, ALREADY_ALLOCATED_MESSAGE } from "@/lib/api/gamefaceDeputy";
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
function dragEvent(type: string, id?: string) {
    const e = new Event(type, { bubbles: true, cancelable: true }) as any;
    const data: Record<string, string> = id ? { [GAMEFACE_FIXTURE_DND_TYPE]: id } : {};
    e.dataTransfer = {
        types: Object.keys(data),
        getData: (t: string) => data[t] ?? "",
        setData: (t: string, v: string) => {
            data[t] = v;
            e.dataTransfer.types = Object.keys(data);
        },
        dropEffect: "none",
        effectAllowed: "all",
    };
    return e;
}
async function fire(el: Element, e: Event) {
    await act(async () => {
        el.dispatchEvent(e);
    });
}
function zone(allocate: any, byFixtureId = new Map<string, any>(), allocator: any = { allocate }, none = false) {
    const onChanged = vi.fn();
    const onMessage = vi.fn();
    const c = mount(
        <GamefaceShiftDropZone
            allocator={none ? undefined : allocator}
            rosterId="42"
            employeeName="Sam"
            byFixtureId={byFixtureId}
            onChanged={onChanged}
            onMessage={onMessage}
        >
            <span>shift</span>
        </GamefaceShiftDropZone>
    );
    return { c, onChanged, onMessage, el: c.firstElementChild as HTMLElement };
}
describe("GamefaceShiftDropZone", () => {
    it("allocates once on drop of a fixture and refreshes", async () => {
        const allocate = vi.fn().mockResolvedValue({});
        const { el, onChanged, onMessage } = zone(allocate);
        const over = dragEvent("dragover", "fx1");
        await fire(el, over);
        expect(over.defaultPrevented).toBe(true);
        expect(el.dataset.dropOver).toBe("true");
        await fire(el, dragEvent("drop", "fx1"));
        expect(allocate).toHaveBeenCalledTimes(1);
        expect(allocate).toHaveBeenCalledWith({ compFixtureId: "fx1", rosterId: "42", employeeName: "Sam" });
        expect(onChanged).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenLastCalledWith("");
        expect(el.dataset.dropOver).toBeUndefined();
    });
    it("does not accept or allocate for unrelated drags", async () => {
        const allocate = vi.fn();
        const { el } = zone(allocate);
        const over = dragEvent("dragover");
        await fire(el, over);
        expect(over.defaultPrevented).toBe(false);
        await fire(el, dragEvent("drop"));
        expect(allocate).not.toHaveBeenCalled();
    });
    it("is inert without an allocator (Premier Data)", async () => {
        const { el } = zone(vi.fn(), new Map(), undefined, true);
        const over = dragEvent("dragover", "fx1");
        await fire(el, over);
        expect(over.defaultPrevented).toBe(false);
        expect(el.dataset.dropOver).toBeUndefined();
    });
    it("refuses an already allocated fixture with the existing message", async () => {
        const allocate = vi.fn();
        const { el, onMessage } = zone(allocate, new Map([["fx1", allocation(1, "fx1", "7")]]));
        await fire(el, dragEvent("drop", "fx1"));
        expect(allocate).not.toHaveBeenCalled();
        expect(onMessage).toHaveBeenCalledWith(ALREADY_ALLOCATED_MESSAGE);
    });
    it("shows the message and refreshes on a 409", async () => {
        const allocate = vi.fn().mockRejectedValue(new AlreadyAllocatedError());
        const { el, onChanged, onMessage } = zone(allocate);
        await fire(el, dragEvent("drop", "fx1"));
        expect(onMessage).toHaveBeenCalledWith(ALREADY_ALLOCATED_MESSAGE);
        expect(onChanged).toHaveBeenCalledTimes(1);
    });
    it("shows the error and refreshes on a network failure", async () => {
        const allocate = vi.fn().mockRejectedValue(new Error("network down"));
        const { el, onChanged, onMessage } = zone(allocate);
        await fire(el, dragEvent("drop", "fx1"));
        expect(onMessage).toHaveBeenCalledWith("network down");
        expect(onChanged).toHaveBeenCalledTimes(1);
    });
});
describe("GamefaceFixturePanel dragging", () => {
    const fixtures = [fixture("a"), fixture("b")];
    const byFixtureId = new Map([["b", allocation(1, "b", "7")]]);
    it("makes only Available fixtures draggable, carrying the fixture id", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fixtures} byFixtureId={byFixtureId} draggable />);
        const [a, b] = Array.from(c.querySelectorAll("li"));
        expect(a.draggable).toBe(true);
        expect(b.draggable).toBe(false);
        const e = dragEvent("dragstart");
        act(() => {
            a.dispatchEvent(e);
        });
        expect(e.dataTransfer.getData(GAMEFACE_FIXTURE_DND_TYPE)).toBe("a");
    });
    it("is not draggable without the draggable prop", () => {
        const c = mount(<GamefaceFixturePanel fixtures={fixtures} byFixtureId={new Map()} />);
        expect(Array.from(c.querySelectorAll("li")).some((li) => li.draggable)).toBe(false);
    });
});
