"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

// Safety net: a render error in one dashboard tab shows a readable card instead
// of unmounting the whole app (black page). Changing `resetKey` (e.g. the
// selected season) clears the error so the user can try another selection.
type Props = {
  children: ReactNode;
  resetKey?: string;
  /** Label for the secondary action; omit to hide it. */
  onReset?: () => void;
  resetLabel?: string;
};
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard section crashed:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onReset, resetLabel } = this.props;
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        style={{ marginTop: 20 }}
      >
        <p className="font-semibold">Something went wrong showing this section.</p>
        <p className="mt-1 text-xs text-red-700">{error.message}</p>
        <div className="mt-3 flex gap-2">
          {onReset && (
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null });
                onReset();
              }}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
            >
              {resetLabel ?? "Try again"}
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-100"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
