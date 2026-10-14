"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthContext";
import { pageKeyForPath } from "@/lib/api/auth";
import Sidebar from "@/components/layout/Sidebar";
import TopBar from "@/components/layout/Topbar";
import ChatWidget from "@/components/chat/ChatWidget";
import { usePullToRefresh } from "@/components/pwa/usePullToRefresh";
import PullToRefreshIndicator from "@/components/pwa/PullToRefreshIndicator";

// Pages that render without the app chrome / auth guard.
const PUBLIC_PATHS = ["/login"];

export default function AppShell({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const { user, ready, hasAccess, firstAccessiblePath } = useAuth();

    // Mobile sidebar drawer open/close. Desktop keeps the sidebar static.
    const [sidebarOpen, setSidebarOpen] = useState(false);
    // Mobile pull-to-refresh wired to the app-wide <main> scroll container.
    // Hooks must run unconditionally (before the early returns below), so it is
    // declared here and only consumed in the authenticated return. The hook
    // owns the element via a callback ref (pull.ref), so the gesture binds when
    // <main> finally mounts after the pre-auth early-return branches below.
    const pull = usePullToRefresh();
    // Close the drawer whenever the route changes (navigating from the menu).
    useEffect(() => {
        setSidebarOpen(false);
    }, [pathname]);

    const isPublic = PUBLIC_PATHS.includes(pathname);
    const pageKey = pageKeyForPath(pathname);
    // Root "/" mirrors the dashboard.
    const effectiveKey = pathname === "/" ? "dashboard" : pageKey;
    const allowed = isPublic || hasAccess(effectiveKey);
    // Where an unauthorised (but logged-in) user should land.
    const fallback = firstAccessiblePath();

    useEffect(() => {
        if (!ready || isPublic) return;

        // Not logged in → login.
        if (!user) {
            router.replace("/login");
            return;
        }

        // Logged in and allowed here → nothing to do.
        if (hasAccess(effectiveKey)) return;

        // No access to this page. Send to the first page they CAN access.
        // Only redirect if that's a different path, so we never loop when
        // the user has no accessible pages at all.
        if (fallback && fallback !== pathname) {
            router.replace(fallback);
        }
    }, [ready, isPublic, user, effectiveKey, hasAccess, fallback, pathname, router]);

    // Public pages (login) render bare.
    if (isPublic) {
        return <>{children}</>;
    }

    // Restoring session / redirecting an unauthenticated user.
    if (!ready || !user) {
        return (
            <div className="flex h-screen items-center justify-center bg-white text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                Loading...
            </div>
        );
    }

    // Logged in but this account has no accessible pages at all — show a
    // clear message instead of bouncing between redirects.
    if (!allowed && !fallback) {
        return (
            <div className="flex h-screen flex-col items-center justify-center gap-3 bg-white px-6 text-center text-slate-700 dark:bg-slate-950 dark:text-slate-300">
                <p className="text-lg font-semibold">No pages available</p>
                <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">
                    Your account doesn&apos;t have access to any pages yet. Ask
                    a super admin to grant permissions for your role.
                </p>
            </div>
        );
    }

    // Not allowed here but a redirect to an accessible page is in flight.
    if (!allowed) {
        return (
            <div className="flex h-screen items-center justify-center bg-white text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                Loading...
            </div>
        );
    }

    return (
        <div className="flex h-full">
            <Sidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
            />
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
                <TopBar onMenuClick={() => setSidebarOpen(true)} />
                <PullToRefreshIndicator {...pull} />
                <main ref={pull.ref} className="flex-1 overflow-auto">
                    {children}
                </main>
            </div>
            {/* App-wide floating chat (shows on every authenticated page,
                including the accuracy pages). */}
            <ChatWidget />
        </div>
    );
}
