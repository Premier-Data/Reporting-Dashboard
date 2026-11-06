"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Legacy route: Deputy Insights now lives in Operations reporting. A
// client-side redirect (static export has no server redirects).
export default function DeputyInsightsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/operations-reporting?tab=deputy-insights");
  }, [router]);
  return null;
}
