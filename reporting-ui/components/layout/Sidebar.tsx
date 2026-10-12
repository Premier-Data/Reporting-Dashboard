"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import {
  LayoutDashboard,
  Monitor,
  CalendarDays,
  Sparkles,
  Users,
  Shield,
  BarChart3,
  Settings,
  Trophy,
  GitCompare,
  Globe,
  FileCheck2,
  FileSearch,
  History,
  KeyRound,
  UserCog,
  LogOut,
  Flag,
  MessageSquare,
  GraduationCap,
  ExternalLink,
  CloudDownload,
  ListVideo,
  FileText,
  Radio,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthContext";
import { pageKeyForPath, ROLE_LABELS } from "@/lib/api/auth";
import { getUnreadCount, subscribeToAllMessages } from "@/lib/api/messages";

const sections = [
  {
    heading: "",
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
      },
    ],
  },

  {
    heading: "COMMUNICATION",
    items: [
      {
        title: "Messages",
        href: "/messages",
        icon: MessageSquare,
      },
      {
        title: "Learning",
        href: "https://training.premierdata-technology.com",
        icon: GraduationCap,
        // Opens the LMS in a new tab (external — not an internal route).
        external: true,
      },
    ],
  },

  {
    heading: "OPERATIONS",
    items: [
      {
        title: "Live Board",
        href: "/operations",
        icon: Monitor,
      },
      {
        title: "Live Scores",
        href: "/live-scores",
        icon: Radio,
      },
      {
        title: "Computers",
        href: "/computers",
        icon: Monitor,
      },
    ],
  },

 {
  heading: "FIXTURES",
  items: [
    {
      title: "Fixtures",
      href: "/fixtures",
      icon: CalendarDays,
    },
    {
      title: "Comp Fixtures",
      href: "/comp-fixtures",
      icon: CloudDownload,
    },
    {
      title: "Fixture Review",
      href: "/fixture-review",
      icon: ListVideo,
    },
    {
      title: "Competitions",
      href: "/competitions",
      icon: Globe,
    },
    {
      title: "Schedule",
      href: "/schedule",
      icon: CalendarDays,
    },
    {
      title: "AI Recommendations",
      href: "/recommendations",
      icon: Sparkles,
    },
  ],
},

{
  heading: "ANALYST MANAGEMENT",
  items: [
    {
      title: "Analyst Management",
      href: "/analyst-management",
      icon: Users,
    },
    {
      title: "Analyst Profiles",
      href: "/analyst-profile",
      icon: Users,
    },
    {
      title: "Affiliated Teams",
      href: "/affiliated-teams",
      icon: Shield,
    },
  ],
},

  {
    heading: "REPORTING",
    items: [
      {
        title: "Reporting",
        href: "/reporting",
        icon: BarChart3,
      },
      {
        title: "Board Report",
        href: "/board-report",
        icon: FileText,
      },
      {
        title: "Leaderboard",
        href: "/leaderboard",
        icon: Trophy,
      },
      {
        title: "Analyst Comparison",
        href: "/analyst-compare",
        icon: GitCompare,
      },
      {
        title: "Accuracy Comparison",
        href: "/accuracy-compare",
        icon: FileCheck2,
      },
      {
        title: "Fixture Accuracy",
        href: "/accuracy-fixture",
        icon: FileSearch,
      },
      {
        title: "Accuracy History",
        href: "/accuracy-checks",
        icon: History,
      },
    ],
  },

  {
    heading: "ADMIN",
    items: [
      {
        title: "Disputes",
        href: "/disputes",
        icon: Flag,
      },
      {
        title: "User Accounts",
        href: "/users",
        icon: UserCog,
      },
      {
        title: "Permissions",
        href: "/permissions",
        icon: KeyRound,
      },
      {
        title: "Admin Configuration",
        href: "/admin-config",
        icon: SlidersHorizontal,
      },
      {
        title: "Settings",
        href: "/settings",
        icon: Settings,
      },
    ],
  },
];

export default function Sidebar({
  open = false,
  onClose,
}: {
  /** Mobile drawer open state. Desktop ignores this (always visible). */
  open?: boolean;
  onClose?: () => void;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, hasAccess, logout } = useAuth();

  // Unread message count for the Messages nav badge. Refreshed on mount, when
  // the route changes (so opening/reading a thread updates it), and live via
  // Realtime on any new message.
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!user) return;
    const uid = user.id;
    let cancelled = false;
    const refresh = () =>
      getUnreadCount(uid)
        .then((n) => {
          if (!cancelled) setUnread(n);
        })
        .catch(() => {});
    refresh();
    const unsub = subscribeToAllMessages(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [user, pathname]);

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  // Only show items the current role can access; drop empty sections.
  // External links (e.g. the LMS) aren't page-gated — show them to any logged
  // in user.
  const visibleSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        "external" in item && item.external
          ? !!user
          : hasAccess(pageKeyForPath(item.href))
      ),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <>
      {/* Mobile backdrop — only when the drawer is open. Tapping it closes. */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`
          z-50 flex w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50
          dark:border-slate-800 dark:bg-[#0B1220]
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform
          ${open ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
        `}
      >

      {/* Mobile close button (top-right of the drawer). */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close menu"
        className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white md:hidden"
      >
        <X size={20} />
      </button>

      <div className="border-b border-slate-200 px-6 py-6 dark:border-slate-800">

        <Image
          src="/Premier Data_Logo.png"
          alt="Premier Data logo"
          width={543}
          height={242}
          priority
          className="mx-auto h-auto w-full max-w-[240px] object-contain"
        />

        <p className="mt-3 text-center text-sm font-medium tracking-wide text-slate-500 dark:text-slate-400">
          Operations Platform
        </p>

      </div>

      <nav className="flex-1 overflow-y-auto px-4 py-6">

        {visibleSections.map((section) => (

          <div
            key={section.heading}
            className="mb-8"
          >

            {section.heading && (
              <div className="mb-3 px-3 text-xs font-semibold tracking-widest text-slate-400 dark:text-slate-500">
                {section.heading}
              </div>
            )}

            <div className="space-y-1">

              {section.items.map((item) => {

                const Icon = item.icon;
                const isExternal = "external" in item && item.external;
                const active = !isExternal && pathname.startsWith(item.href);

                const baseClass = `
                  flex items-center gap-3 rounded-lg px-3 py-3 transition
                  ${active
                    ? "bg-sky-600 text-white"
                    : "text-slate-600 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                  }
                `;

                // External links (e.g. the LMS) open in a new tab.
                if (isExternal) {
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={baseClass}
                    >
                      <Icon size={18} />
                      <span className="flex-1 text-sm font-medium">
                        {item.title}
                      </span>
                      <ExternalLink size={14} className="text-slate-400 dark:text-slate-500" />
                    </a>
                  );
                }

                return (

                  <Link
                    key={item.href}
                    href={item.href}
                    className={baseClass}
                  >

                    <Icon size={18} />

                    <span className="flex-1 text-sm font-medium">
                      {item.title}
                    </span>

                    {item.href === "/messages" && unread > 0 && (
                      <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}

                  </Link>

                );

              })}

            </div>

          </div>

        ))}

      </nav>

      <div className="border-t border-slate-200 p-4 dark:border-slate-800">

        {user && (
          <div className="mb-3">
            <div className="truncate text-sm font-medium text-slate-900 dark:text-white">
              {user.analyst_name || user.username}
            </div>
            <div className="text-xs text-slate-400 dark:text-slate-500">
              {ROLE_LABELS[user.role]}
            </div>
          </div>
        )}

        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-200 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <LogOut size={16} /> Sign out
        </button>

      </div>

      </aside>
    </>
  );
}