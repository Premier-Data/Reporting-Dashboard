"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Legacy route: Deputy API now lives in Operations reporting. A client-side
// redirect (static export has no server redirects).
export default function DeputyApiRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/operations-reporting?tab=deputy-api");
  }, [router]);
  return null;
}
