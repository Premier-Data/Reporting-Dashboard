"use client";

// Visible error state for the Deputy API data layer (lib/api/deputyShifts.ts).
// Pages show this instead of blank or partial data and never fall back to
// another data source.
export default function DeputyLoadError({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      <p className="font-semibold">Deputy data could not be loaded.</p>
      {message && <p className="mt-1 text-xs text-red-700">{message}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
        >
          Retry
        </button>
      )}
    </div>
  );
}
