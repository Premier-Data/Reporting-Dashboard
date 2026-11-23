"use client";

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    type ReactNode,
} from "react";
import {
    login as apiLogin,
    getRolePermissions,
    buildPermissionMap,
    PAGES,
    type UserAccount,
    type Role,
} from "@/lib/api/auth";

import { clearStoredPassword } from "@/lib/activity/storedPassword";

const STORAGE_KEY = "pd_auth_user";

interface AuthContextValue {
    user: UserAccount | null;
    role: Role | null;
    /** permissions[role][pageKey] = boolean */
    permissions: Record<string, Record<string, boolean>>;
    ready: boolean;
    login: (username: string, password: string) => Promise<boolean>;
    logout: () => void;
    hasAccess: (pageKey: string | null) => boolean;
    /** First route path the current user can access, or null if none. */
    firstAccessiblePath: () => string | null;
    /** Where to send the user after login (analysts -> their profile). */
    landingPath: () => string | null;
    reloadPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<UserAccount | null>(null);
    const [permissions, setPermissions] = useState<
        Record<string, Record<string, boolean>>
    >({});
    // `ready` flips true once we've restored any saved session + loaded
    // permissions, so the guard doesn't flash/redirect prematurely.
    const [ready, setReady] = useState(false);

    const reloadPermissions = useCallback(async () => {
        try {
            const rows = await getRolePermissions();
            setPermissions(buildPermissionMap(rows));
        } catch (err) {
            console.error("Failed loading permissions:", err);
        }
    }, []);

    // Restore session + load permissions on mount.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const raw =
                    typeof window !== "undefined"
                        ? window.localStorage.getItem(STORAGE_KEY)
                        : null;
                if (raw) {
                    const parsed = JSON.parse(raw) as UserAccount;
                    if (!cancelled) setUser(parsed);
                }
            } catch {
                // ignore malformed storage
            }
            await reloadPermissions();
            if (!cancelled) setReady(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadPermissions]);

    const doLogin = useCallback(
        async (username: string, password: string) => {
            const account = await apiLogin(username, password);
            if (!account) return false;
            setUser(account);
            try {
                window.localStorage.setItem(
                    STORAGE_KEY,
                    JSON.stringify(account)
                );
            } catch {
                // ignore storage failures
            }
            // Refresh permissions on login in case they changed.
            await reloadPermissions();
            return true;
        },
        [reloadPermissions]
    );

    const logout = useCallback(() => {
        setUser(null);
        clearStoredPassword();
        try {
            window.localStorage.removeItem(STORAGE_KEY);
        } catch {
            // ignore
        }
    }, []);

    const hasAccess = useCallback(
        (pageKey: string | null) => {
            if (!pageKey) return false;
            if (!user) return false;
            // Super admin always has access to everything.
            if (user.role === "super_admin") return true;
            return permissions[user.role]?.[pageKey] === true;
        },
        [user, permissions]
    );

    const firstAccessiblePath = useCallback((): string | null => {
        if (!user) return null;
        for (const page of PAGES) {
            if (!page.href) continue;
            if (
                user.role === "super_admin" ||
                permissions[user.role]?.[page.key] === true
            ) {
                return page.href;
            }
        }
        return null;
    }, [user, permissions]);

    // After login: an allocated analyst lands on their own profile; everyone
    // else on their first accessible page. Profile access is treated as
    // allowed unless explicitly revoked, so this still works before the
    // permission map has finished loading right after login.
    const landingPath = useCallback((): string | null => {
        if (!user) return null;
        const profileDenied =
            user.role !== "super_admin" &&
            permissions[user.role]?.["analyst-profile"] === false;
        const allocatedName = user.analyst_name?.trim();

        if (user.role === "analyst") {
            // Allocated analyst → their own profile.
            if (allocatedName && !profileDenied) {
                return `/analyst-profile?analyst=${encodeURIComponent(
                    allocatedName
                )}`;
            }
            // Not allocated → Accuracy History.
            return "/accuracy-checks";
        }

        return firstAccessiblePath();
    }, [user, permissions, firstAccessiblePath]);

    return (
        <AuthContext.Provider
            value={{
                user,
                role: user?.role ?? null,
                permissions,
                ready,
                login: doLogin,
                logout,
                hasAccess,
                firstAccessiblePath,
                landingPath,
                reloadPermissions,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return ctx;
}
