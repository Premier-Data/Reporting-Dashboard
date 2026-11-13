"use client";

import type { ReactNode } from "react";

import type { TableSort } from "@/lib/tableSort";

/**
 * Sortable column header: a real <th scope="col"> with a keyboard-accessible
 * button, aria-sort, and a visible indicator on every header (arrow on the
 * active column, a muted up/down mark on the others).
 */
export default function SortableTh<K extends string>({
  sort,
  sortKey,
  className = "",
  children,
}: {
  sort: TableSort<K>;
  sortKey: K;
  /** Padding, width and alignment classes for the <th>. */
  className?: string;
  children: ReactNode;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={className}
    >
      <button
        type="button"
        onClick={() => sort.toggle(sortKey)}
        className="inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {children}
        <span aria-hidden="true" className={active ? "text-sky-400" : "text-slate-600"}>
          {active ? (sort.dir === "asc" ? "\u25B2" : "\u25BC") : "\u2195"}
        </span>
      </button>
    </th>
  );
}
