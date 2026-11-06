"use client";

import * as React from "react";

type TabsContextType = {
  value: string;
  setValue: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextType | null>(null);

export function Tabs({
  defaultValue,
  value: controlledValue,
  onValueChange,
  children,
}: {
  defaultValue?: string;
  /** Controlled mode (e.g. tab kept in the URL). Omit for uncontrolled. */
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
}) {
  const [innerValue, setInnerValue] = React.useState(defaultValue ?? "");
  const value = controlledValue ?? innerValue;
  const setValue = (next: string) => {
    if (controlledValue === undefined) setInnerValue(next);
    onValueChange?.(next);
  };

  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className ?? "flex gap-2 border-b mb-4"}>
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  activeClassName,
  inactiveClassName,
}: {
  value: string;
  children: React.ReactNode;
  activeClassName?: string;
  inactiveClassName?: string;
}) {
  const ctx = React.useContext(TabsContext);

  if (!ctx) throw new Error("TabsTrigger must be used inside Tabs");

  const active = ctx.value === value;

  return (
    <button
      onClick={() => ctx.setValue(value)}
      className={
        active
          ? activeClassName ??
            "px-4 py-2 text-sm border-b-2 transition border-blue-600 text-blue-600"
          : inactiveClassName ??
            "px-4 py-2 text-sm border-b-2 transition border-transparent text-gray-500"
      }
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(TabsContext);

  if (!ctx) throw new Error("TabsContent must be used inside Tabs");

  if (ctx.value !== value) return null;

  return <div>{children}</div>;
}