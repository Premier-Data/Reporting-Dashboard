"use client";
import { useRef, useState, type ReactNode } from "react";
import {
    ALREADY_ALLOCATED_MESSAGE,
    type GamefaceAllocation,
    type GamefaceAllocator,
} from "@/lib/api/gamefaceDeputy";
/** dataTransfer type carrying a comp fixture id from the fixture panel. */
export const GAMEFACE_FIXTURE_DND_TYPE = "application/x-gameface-fixture";
type Props = {
    /** Undefined in Premier Data mode: renders a plain div with no drop handling. */
    allocator?: GamefaceAllocator;
    rosterId: string;
    employeeName: string;
    byFixtureId: Map<string, GamefaceAllocation>;
    /** Reload fixtures and allocations (after success or any failure). */
    onChanged: () => void | Promise<void>;
    /** Message to show; empty string clears. */
    onMessage: (message: string) => void;
    className?: string;
    children: ReactNode;
};
/** A published GameFace shift that accepts a dragged fixture. Same allocate call as the modal button. */
export default function GamefaceShiftDropZone({
    allocator,
    rosterId,
    employeeName,
    byFixtureId,
    onChanged,
    onMessage,
    className,
    children,
}: Props) {
    const [over, setOver] = useState(false);
    const busy = useRef(false);
    if (allocator === undefined) return <div className={className}>{children}</div>;
    const accepts = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(GAMEFACE_FIXTURE_DND_TYPE);
    async function drop(e: React.DragEvent) {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(GAMEFACE_FIXTURE_DND_TYPE);
        if (!id || busy.current || allocator === undefined) return;
        if (byFixtureId.has(id)) {
            onMessage(ALREADY_ALLOCATED_MESSAGE);
            return;
        }
        busy.current = true;
        try {
            await allocator.allocate({ compFixtureId: id, rosterId, employeeName });
            onMessage("");
        } catch (err) {
            onMessage(err instanceof Error ? err.message : "Could not allocate the fixture");
        } finally {
            busy.current = false;
            await onChanged();
        }
    }
    return (
        <div
            data-gameface-drop-zone
            data-drop-over={over ? "true" : undefined}
            className={`${className ?? ""} ${over ? "rounded outline outline-2 outline-blue-500 bg-blue-50" : ""}`}
            onDragOver={(e) => {
                if (!accepts(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!over) setOver(true);
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
            }}
            onDrop={drop}
        >
            {children}
        </div>
    );
}
