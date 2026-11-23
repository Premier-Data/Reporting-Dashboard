import { describe, expect, it } from "vitest";
import {
    ACTIVITY_PW_KEY,
    BAD_CREDENTIALS_MESSAGE,
    clearStoredPassword,
    getStoredPassword,
    isBadCredentials,
    setStoredPassword,
} from "./storedPassword";

function memStore() {
    const m = new Map<string, string>();
    return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
        has: (k: string) => m.has(k),
    };
}

describe("storedPassword", () => {
    it("round-trips for the same user", () => {
        const s = memStore();
        setStoredPassword("admin", "pw", s);
        expect(getStoredPassword("admin", s)).toBe("pw");
    });

    it("clears and returns null when the user differs", () => {
        const s = memStore();
        setStoredPassword("admin", "pw", s);
        expect(getStoredPassword("other", s)).toBeNull();
        expect(s.has(ACTIVITY_PW_KEY)).toBe(false);
    });

    it("clear removes it", () => {
        const s = memStore();
        setStoredPassword("admin", "pw", s);
        clearStoredPassword(s);
        expect(getStoredPassword("admin", s)).toBeNull();
    });

    it("clears malformed data", () => {
        const s = memStore();
        s.setItem(ACTIVITY_PW_KEY, "{oops");
        expect(getStoredPassword("admin", s)).toBeNull();
        expect(s.has(ACTIVITY_PW_KEY)).toBe(false);
    });

    it("returns null with no storage", () => {
        expect(getStoredPassword("admin", null)).toBeNull();
    });

    it("detects bad-credentials errors", () => {
        expect(isBadCredentials(new Error(BAD_CREDENTIALS_MESSAGE))).toBe(true);
        expect(isBadCredentials(new Error("x"))).toBe(false);
    });
});
