"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/UI/tabs";
import { THEME } from "@/lib/theme";
import DeputyApiView from "@/components/deputy/DeputyApiView";
import DeputyInsightsView from "@/components/deputy/DeputyInsightsView";
import GamesWeeklyView from "@/components/operations/GamesWeeklyView";

// Tab values double as the ?tab= query value (and match the old routes:
// /deputy-api -> ?tab=deputy-api). Each tab is gated by its own page key, so a
// role with only Deputy Insights sees only that tab.
const TABS = [
  { value: "deputy-api", label: "Deputy API", pageKey: "deputy-api" },
  { value: "deputy-insights", label: "Deputy Insights", pageKey: "deputy-insights" },
  // Games is super admin only (no role_permissions key).
  { value: "games", label: "Games", pageKey: null, superAdminOnly: true },
] as const;

function OperationsReportingTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { hasAccess, user } = useAuth();

  const visible = TABS.filter((t) =>
    "superAdminOnly" in t ? user?.role === "super_admin" : hasAccess(t.pageKey)
  );
  if (visible.length === 0) return null;

  // Requested tab if the role may see it, otherwise the first allowed tab.
  const requested = searchParams.get("tab");
  const active =
    visible.find((t) => t.value === requested)?.value ?? visible[0].value;

  return (
    <div style={{ background: THEME.bg }}>
      <h1 className="px-6 pt-6 text-2xl font-bold text-white">
        Operations reporting
      </h1>
      <Tabs
        value={active}
        onValueChange={(v) =>
          router.replace(`${pathname}?tab=${v}`, { scroll: false })
        }
      >
        <TabsList className="mx-6 mt-4 flex gap-2 border-b border-slate-700">
          {visible.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="deputy-api">
          <DeputyApiView />
        </TabsContent>
        <TabsContent value="deputy-insights">
          <DeputyInsightsView />
        </TabsContent>
        <TabsContent value="games">
          <GamesWeeklyView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function OperationsReportingPage() {
  return (
    <Suspense fallback={null}>
      <OperationsReportingTabs />
    </Suspense>
  );
}
