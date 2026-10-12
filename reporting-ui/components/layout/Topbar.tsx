"use client";

import { Menu, Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme/ThemeContext";

export default function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <header className="flex h-16 items-center gap-3 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-[#101826] md:px-8">

      {/* Hamburger — mobile only; opens the sidebar drawer. */}
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white md:hidden"
      >
        <Menu size={22} />
      </button>

      <h2 className="truncate text-lg font-semibold text-slate-900 dark:text-white md:text-xl">
        Premier Data Platform
      </h2>

      {/* Day / night theme toggle. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={isDark ? "Switch to day mode" : "Switch to night mode"}
        title={isDark ? "Switch to day mode" : "Switch to night mode"}
        className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

    </header>
  );
}
