/**
 * Remembers the admin's password for the Activity Log in sessionStorage
 * (per tab, gone when the tab/browser closes). Never use localStorage or cookies.
 */
export const ACTIVITY_PW_KEY = "pd_activity_admin_pw";

/** Message thrown by lib/api/activity.ts when the credentials are rejected. */
export const BAD_CREDENTIALS_MESSAGE = "Incorrect password or not an admin";

type StoreLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): StoreLike | null {
    try {
        return typeof window !== "undefined" ? window.sessionStorage : null;
    } catch {
        return null;
    }
}

export function setStoredPassword(
    username: string,
    password: string,
    store: StoreLike | null = defaultStore()
): void {
    try {
        store?.setItem(ACTIVITY_PW_KEY, JSON.stringify({ username, password }));
    } catch {
        // ignore storage failures
    }
}

export function clearStoredPassword(store: StoreLike | null = defaultStore()): void {
    try {
        store?.removeItem(ACTIVITY_PW_KEY);
    } catch {
        // ignore
    }
}

/** Returns the saved password only if it belongs to `username`; otherwise clears it. */
export function getStoredPassword(
    username: string,
    store: StoreLike | null = defaultStore()
): string | null {
    if (!store) return null;
    try {
        const raw = store.getItem(ACTIVITY_PW_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { username?: unknown; password?: unknown };
        if (
            parsed.username === username &&
            typeof parsed.password === "string" &&
            parsed.password
        ) {
            return parsed.password;
        }
    } catch {
        // malformed: fall through and clear
    }
    clearStoredPassword(store);
    return null;
}

export function isBadCredentials(err: unknown): boolean {
    return err instanceof Error && err.message === BAD_CREDENTIALS_MESSAGE;
}
