import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import ErrorBoundary from "../ErrorBoundary";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("kaboom");
  return <div>fine</div>;
}

describe("ErrorBoundary", () => {
  it("shows a readable card with the message instead of blanking, and recovers on resetKey change", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const onReset = vi.fn();

    await act(async () => {
      root.render(
        <ErrorBoundary resetKey="2025" onReset={onReset} resetLabel="Try another season">
          <Boom explode />
        </ErrorBoundary>
      );
    });
    expect(el.textContent).toContain("Something went wrong");
    expect(el.textContent).toContain("kaboom");
    expect(el.textContent).toContain("Try another season");
    expect(el.textContent).toContain("Reload page");

    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => b.textContent === "Try another season")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalled();

    // Re-render with a different resetKey and a healthy child: recovers.
    await act(async () => {
      root.render(
        <ErrorBoundary resetKey="2026">
          <Boom explode={false} />
        </ErrorBoundary>
      );
    });
    expect(el.textContent).toBe("fine");
    act(() => root.unmount());
    vi.restoreAllMocks();
  });
});
