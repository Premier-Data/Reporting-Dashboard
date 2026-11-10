/** Feedback text shown after a manual "Sync from Deputy" click. */
export function syncMessage(synced: boolean, now: Date = new Date()): string {
    if (synced) {
        const time = now.toLocaleTimeString("en-AU", {
            hour: "2-digit",
            minute: "2-digit",
        });
        return `Synced from Deputy just now (${time})`;
    }
    return "No new sync was run (one ran in the last minute, or Deputy could not be reached). Showing the latest saved data.";
}
