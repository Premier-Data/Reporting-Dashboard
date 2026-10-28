"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { calculateKPIs } from "@/lib/analytics";

// Chart components pull in recharts (a heavy dependency). Load them lazily so
// recharts stays out of the dashboard's initial bundle and only downloads when
// the relevant chart/tab is actually shown.
const chartLoading = () => (
  <div className="flex h-64 items-center justify-center text-sm text-slate-400">
    Loading chart…
  </div>
);
const HoursByEmployee = dynamic(() => import("./HoursByEmployee"), {
  ssr: false,
  loading: chartLoading,
});
const CostByArea = dynamic(() => import("./CostByArea"), {
  ssr: false,
  loading: chartLoading,
});
const CostByAreaByWeek = dynamic(() => import("./CostByAreaByWeek"), {
  ssr: false,
  loading: chartLoading,
});
const TTGames = dynamic(() => import("./TTGames"), {
  ssr: false,
  loading: chartLoading,
});
const AwsCosts = dynamic(() => import("./AwsCosts"), {
  ssr: false,
  loading: chartLoading,
});
const CloudflareCosts = dynamic(() => import("./CloudflareCosts"), {
  ssr: false,
  loading: chartLoading,
});
const AveHoursPerGame = dynamic(() => import("./AveHoursPerGame"), {
  ssr: false,
  loading: chartLoading,
});
import AveHoursTopAnalysts from "./AveHoursTopAnalysts";
import AnalystInsightsTable from "./AnalystInsightsTable";
import BonusTracker from "./BonusTracker";
import AnalystHeaderCard from "@/app/analyst-profile/AnalystHeaderCard";

import {
  buildAnalystMetrics,
} from "@/lib/analytics/buildAnalystMetrics";
import {
  seasonsFromTT,
  dateInSeason,
} from "@/lib/analytics/season";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/UI/tabs";
import DashboardLayout from "./DashboardLayout";
import Header from "./Header";

// -------------------------
// NORMALISATION
// -------------------------
const normalize = (v: any) =>
  String(v ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const formatNumber = (v: any) =>
  Number(v || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatCurrency = (v: any) =>
  `$${Number(v || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// -------------------------
// MAIN COMPONENT
// -------------------------
export default function DashboardClient({
  deputyData,
  ttData,
}: {
  deputyData: any[];
  ttData: any[];
}) {
  // -------------------------
  // STATE
  // -------------------------
  const [employee, setEmployee] = useState("all");
  const [area, setArea] = useState("all");
  // ONE week filter drives the whole dashboard (KPIs, charts, tables) for both
  // deputy shifts and TT games. "all" = every week in the selected season.
  const [week, setWeek] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [ttAnalyst, setTtAnalyst] = useState("all");

  // -------------------------
  // SEASON TOGGLE
  // -------------------------
  // The 2027 season runs 1 Oct 2026 – 30 Sep 2027. TT_Games carry an explicit
  // `season` column (stamped per sheet in sync-deputy.js); deputy_shifts don't,
  // so they're scoped by the season's Oct→Sep date window instead.
  const seasonInfo = useMemo(() => seasonsFromTT(ttData ?? []), [ttData]);
  const [season, setSeason] = useState<string>("all");

  // Default to the most recent season once data loads (keeps "all" only if no
  // season data exists). Runs when the available seasons change.
  useEffect(() => {
    if (season === "all" && seasonInfo.years.length > 0) {
      setSeason(String(seasonInfo.years[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonInfo.years.length]);

  // Base datasets scoped to the chosen season. Everything below filters these
  // instead of the raw props, so the season toggle drives the whole dashboard.
  const seasonTT = useMemo(() => {
    const safe = ttData ?? [];
    if (season === "all") return safe;
    if (season === "unknown") {
      return safe.filter(
        (r) => r.season == null || !Number.isFinite(Number(r.season))
      );
    }
    const yr = Number(season);
    return safe.filter((r) => Number(r.season) === yr);
  }, [ttData, season]);

  const seasonDeputy = useMemo(() => {
    const safe = deputyData ?? [];
    if (season === "all" || season === "unknown") return safe;
    const yr = Number(season);
    return safe.filter((r) => {
      if (!r.shift_date) return false;
      const d = new Date(r.shift_date);
      return !Number.isNaN(d.getTime()) && dateInSeason(d, yr);
    });
  }, [deputyData, season]);

  // -------------------------
  // WEEK FILTER (single, season-scoped)
  // -------------------------
  // Week numbers restart each season, so the week list is built from the
  // season-scoped data. Union of weeks present in BOTH deputy + TT so the one
  // dropdown covers every table. Sorted numerically.
  const weekOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of seasonDeputy) {
      const w = String(r.week ?? "").trim();
      if (w) set.add(w);
    }
    for (const r of seasonTT) {
      const w = String(r.week ?? r.Week ?? "").trim();
      if (w) set.add(w);
    }
    return [...set].sort((a, b) => Number(a) - Number(b));
  }, [seasonDeputy, seasonTT]);

  // Week numbers mean different dates per season, so reset the week filter to
  // "all" whenever the season changes (a stale "W5" from another season would
  // otherwise show nothing or the wrong week).
  useEffect(() => {
    setWeek("all");
  }, [season]);

  // Season- AND week-scoped base datasets. Everything below (KPIs, charts,
  // tables, performance) reads these, so the one week dropdown drives the lot.
  const weekDeputy = useMemo(() => {
    if (week === "all") return seasonDeputy;
    return seasonDeputy.filter((r) => String(r.week ?? "").trim() === week);
  }, [seasonDeputy, week]);

  const weekTT = useMemo(() => {
    if (week === "all") return seasonTT;
    return seasonTT.filter(
      (r) => String(r.week ?? r.Week ?? "").trim() === week
    );
  }, [seasonTT, week]);

  // The actual calendar date range covered by the current selection, from the
  // shift dates + game dates in scope. Shown beside the Week dropdown so the
  // user sees which dates "Week N" (or the whole season) actually spans.
  const dateRangeLabel = useMemo(() => {
    const isos: string[] = [];
    for (const r of weekDeputy) {
      const s = r.shift_date ? String(r.shift_date).slice(0, 10) : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) isos.push(s);
    }
    for (const r of weekTT) {
      const s = r.Date ? String(r.Date).slice(0, 10) : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) isos.push(s);
    }
    if (isos.length === 0) return "";
    isos.sort();
    const fmt = (iso: string) =>
      new Date(`${iso}T00:00:00`).toLocaleDateString("en-AU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    const min = fmt(isos[0]);
    const max = fmt(isos[isos.length - 1]);
    return min === max ? min : `${min} – ${max}`;
  }, [weekDeputy, weekTT]);

  // -------------------------
  // FILTER DEPUTY DATA
  // -------------------------
  const filtered = useMemo(() => {
    const safe = weekDeputy ?? [];

    return safe.filter((r) => {
      const shiftDate = r.shift_date ? new Date(r.shift_date) : null;
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;

      return (
        (employee === "all" || normalize(r.employee_name) === normalize(employee)) &&
        (area === "all" || normalize(r.area_name) === normalize(area)) &&
        (!start || (shiftDate && shiftDate >= start)) &&
        (!end || (shiftDate && shiftDate <= end))
      );
    });
  }, [weekDeputy, employee, area, startDate, endDate]);

  // -------------------------
  // FILTER TT DATA
  // -------------------------
  const filteredTT = useMemo(() => {
    const selected = normalize(ttAnalyst);

    return (weekTT ?? []).filter((r) => {
      const home = normalize(r.home_allocated);
      const away = normalize(r.away_allocated);

      return (
        ttAnalyst === "all" || home === selected || away === selected
      );
    });
  }, [weekTT, ttAnalyst]);

  // -------------------------
  // KPI
  // -------------------------
  const kpis = useMemo(() => calculateKPIs(filtered), [filtered]);

  // -------------------------
  // ANALYST METRICS
  // -------------------------
  const analystMetrics = useMemo(() => {
    return buildAnalystMetrics(filtered, filteredTT);
  }, [filtered, filteredTT]);

  // -------------------------
  // SELECTED ANALYST
  // -------------------------
  const selectedAnalyst = useMemo(() => {
    if (employee === "all") return null;

    return (
      analystMetrics.find(
        (a) => a.name?.toLowerCase() === employee?.toLowerCase()
      ) || null
    );
  }, [analystMetrics, employee]);

  // -------------------------
  // DEBUG
  // -------------------------
  useEffect(() => {
    console.log("🔥 DASHBOARD UPDATED");

    console.log("📊 RAW deputyData:", deputyData?.length);
    console.log("📊 RAW ttData:", ttData?.length);

    console.log("📊 FILTERED:", filtered?.length);
    console.log("📊 FILTERED TT:", filteredTT?.length);

    console.log("📊 METRICS:", analystMetrics?.length);
    console.log("📊 FIRST ANALYST:", analystMetrics?.[0]);
  }, [
    deputyData,
    ttData,
    filtered,
    filteredTT,
    analystMetrics
  ]);
  if (!analystMetrics?.length) {
    console.log("❌ No analyst metrics generated");
    return null;
  }
  console.log("👤 SELECTED EMPLOYEE:", employee);
  console.log("👤 SELECTED ANALYST:", selectedAnalyst?.name);
  // -------------------------
  // RENDER
  // -------------------------
  return (
    <DashboardLayout>
      <main style={{ minHeight: "100vh", padding: 32, background: "#F4F7FB" }}>
        <Header />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <h1
              style={{
                fontSize: 28,
                fontWeight: 700,
                margin: 0,
              }}
            >
              📊 Reporting Dashboard
            </h1>

            {/* SEASON TOGGLE — scopes the whole dashboard. Games use TT_Games'
                explicit season; shifts use the season's Oct→Sep date window. */}
            {(seasonInfo.years.length > 0 || seasonInfo.hasUnknown) && (
              <div
                style={{
                  display: "inline-flex",
                  borderRadius: 10,
                  background: "#E2E8F0",
                  padding: 3,
                  gap: 2,
                }}
              >
                {seasonInfo.years.map((y) => (
                  <SeasonButton
                    key={y}
                    label={`${y}`}
                    active={season === String(y)}
                    onClick={() => setSeason(String(y))}
                  />
                ))}
                {seasonInfo.hasUnknown && (
                  <SeasonButton
                    label="Unknown"
                    active={season === "unknown"}
                    onClick={() => setSeason("unknown")}
                  />
                )}
                <SeasonButton
                  label="All"
                  active={season === "all"}
                  onClick={() => setSeason("all")}
                />
              </div>
            )}

            {/* ONE week filter — drives KPI cards, charts and every table. */}
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                fontWeight: 600,
                color: "#475569",
              }}
            >
              Week
              <select
                value={week}
                onChange={(e) => setWeek(e.target.value)}
                style={{
                  borderRadius: 8,
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  padding: "7px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#0F172A",
                  cursor: "pointer",
                }}
              >
                <option value="all">All weeks</option>
                {weekOptions.map((w) => (
                  <option key={w} value={w}>
                    Week {w}
                  </option>
                ))}
              </select>
            </label>

            {/* Actual date range covered by the current season/week selection. */}
            {dateRangeLabel && (
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#64748B",
                  whiteSpace: "nowrap",
                }}
              >
                {dateRangeLabel}
              </span>
            )}
          </div>

          <div
            style={{
              display: "flex",
              gap: 10,
            }}
          >
            <Link
              href="/analyst-profile"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 18px",
                borderRadius: 10,
                background: "#0F172A",
                color: "#FFFFFF",
                fontSize: 14,
                fontWeight: 600,
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              View Analyst Profiles →
            </Link>

            <Link
              href="/computers"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 18px",
                borderRadius: 10,
                background: "#0F172A",
                color: "#FFFFFF",
                fontSize: 14,
                fontWeight: 600,
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              Computers →
            </Link>
          </div>
        </div>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="aws">AWS</TabsTrigger>
            <TabsTrigger value="cloudflare">Cloudflare</TabsTrigger>
            <TabsTrigger value="tt">TT Games</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="bonus">Bonus</TabsTrigger>
          </TabsList>
          {/* OVERVIEW */}
          <TabsContent value="overview">
            {/* KPI CARDS */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 15,
              }}
            >
              <Card title="Total Hours" value={formatNumber(kpis.totalHours)} />
              <Card title="Total Cost" value={formatCurrency(kpis.totalCost)} />
              <Card title="Employees" value={kpis.employeeCount} />
              <Card title="Shifts" value={kpis.shiftCount} />
            </div>

            {/* MAIN CHARTS */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 20,
                marginTop: 20,
              }}
            >
              <HoursByEmployee data={filtered} />
              <CostByArea data={weekDeputy} />
            </div>


            {/* WEEKLY COST TABLE */}
            <div style={{ marginTop: 20 }}>
              <CostByAreaByWeek data={filtered} />
            </div>
          </TabsContent>

          {/* AWS COSTS */}
          <TabsContent value="aws">
            <div style={{ marginTop: 20 }}>
              <AwsCosts />
            </div>
          </TabsContent>

          {/* CLOUDFLARE COSTS */}
          <TabsContent value="cloudflare">
            <div style={{ marginTop: 20 }}>
              <CloudflareCosts />
            </div>
          </TabsContent>

          {/* TT GAMES */}
          <TabsContent value="tt">
            <div style={{ marginTop: 20 }}>
              <TTGames data={filteredTT} />
            </div>
          </TabsContent>

          {/* PERFORMANCE */}
          <TabsContent value="performance">
            <AveHoursTopAnalysts deputyData={weekDeputy} ttData={weekTT} />

            <AnalystInsightsTable analysts={analystMetrics} />

            <AveHoursPerGame
              deputyData={weekDeputy}
              ttData={weekTT}
            />
          </TabsContent>

        </Tabs>

        {selectedAnalyst && (
          <div style={{ marginTop: 20 }}>
            <AnalystHeaderCard data={selectedAnalyst} />
          </div>
        )}
      </main>
    </DashboardLayout>
  );
}

// -------------------------
// SEASON TOGGLE BUTTON
// -------------------------
function SeasonButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none",
        cursor: "pointer",
        borderRadius: 8,
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: 600,
        background: active ? "#0F172A" : "transparent",
        color: active ? "#FFFFFF" : "#475569",
        transition: "background 0.15s, color 0.15s",
      }}
    >
      {label}
    </button>
  );
}

// -------------------------
// CARD
// -------------------------
function Card({ title, value }: any) {
  return (
    <div style={{ padding: 20, borderRadius: 16, background: "#fff" }}>
      <div style={{ fontSize: 12 }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
    </div>
  );
}