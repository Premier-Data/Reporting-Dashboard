"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import DashboardClient from "@/components/DashboardClient";
import DeputyLoadError from "@/components/DeputyLoadError";
import { DeputyShiftsError, getDeputyShifts } from "@/lib/api/deputyShifts";

/**
 * The reporting dashboard fetches its data CLIENT-SIDE (in this effect)
 * rather than in a server component.
 *
 * Why: the site is built with `output: "export"` (static export). A
 * server component would fetch the Deputy shifts / TT_Games at BUILD time
 * and bake the result into static HTML — so the dashboard would freeze
 * to whatever week the data was at when the site was last deployed
 * (this is exactly why costs stopped updating past week 21). Fetching
 * on the client means the dashboard always reflects live Supabase data,
 * no redeploy required.
 *
 * Supabase caps an unpaginated select at 1000 rows, so TT_Games is paged
 * through with .range() to guarantee every week loads. Deputy shifts come only
 * from the Deputy API through lib/api/deputyShifts.ts.
 */
async function loadAll(table: string): Promise<any[]> {
  const pageSize = 1000;
  let rows: any[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    rows = rows.concat(data);
    from += pageSize;

    if (data.length < pageSize) break;
  }

  return rows;
}

export default function Home() {
  const [deputyData, setDeputyData] = useState<any[]>([]);
  const [ttData, setTtData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deputyError, setDeputyError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDeputyError(null);

    async function load() {
      try {
        const [deputyRows, ttRows] = await Promise.all([
          getDeputyShifts({ force: reloadKey > 0 }),
          loadAll("TT_Games"),
        ]);

        if (cancelled) return;

        console.log("DEPUTY ROW COUNT:", deputyRows.length);
        console.log("TT ROW COUNT:", ttRows.length);

        setDeputyData(deputyRows);
        setTtData(ttRows);
      } catch (err) {
        console.error("Failed loading dashboard data:", err);
        if (!cancelled) {
          if (err instanceof DeputyShiftsError) setDeputyError(err.message);
          else setError("Unable to load dashboard data.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", padding: 32, background: "#F4F7FB" }}>
        Loading dashboard...
      </div>
    );
  }

  if (deputyError) {
    return (
      <div style={{ minHeight: "100vh", padding: 32, background: "#F4F7FB" }}>
        <DeputyLoadError message={deputyError} onRetry={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: "100vh", padding: 32, background: "#F4F7FB" }}>
        {error}
      </div>
    );
  }

  return (
    <DashboardClient
      deputyData={deputyData}
      ttData={ttData}
    />
  );
}
