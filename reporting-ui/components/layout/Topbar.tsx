import { Menu } from "lucide-react";

export default function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  return (
    <header className="flex h-16 items-center gap-3 border-b border-slate-800 bg-[#101826] px-4 md:px-8">

      {/* Hamburger — mobile only; opens the sidebar drawer. */}
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        className="rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-white md:hidden"
      >
        <Menu size={22} />
      </button>

      <h2 className="truncate text-lg font-semibold text-white md:text-xl">
        Premier Data Platform
      </h2>

    </header>
  );
}