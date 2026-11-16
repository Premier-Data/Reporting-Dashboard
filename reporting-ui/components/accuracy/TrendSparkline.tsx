"use client";

import type { TrendPoint } from "@/lib/comparison/trainingPlan";

/** Small inline SVG sparkline of error rate per check (oldest to current). */
export default function TrendSparkline({
  points,
  width = 120,
  height = 28,
}: {
  points: TrendPoint[];
  width?: number;
  height?: number;
}) {
  const pad = 3;
  const n = points.length;
  const max = Math.max(0.3, ...points.map((p) => p.rate ?? 0));
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (r: number) => height - pad - (r / max) * (height - 2 * pad);

  // Split into runs of counted points so uncounted checks show as gaps.
  const runs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    if (p.counted && p.rate != null) {
      cur.push({ x: x(i), y: y(p.rate) });
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  });
  if (cur.length) runs.push(cur);

  return (
    <svg
      role="img"
      aria-label="Error rate trend"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {runs.map((run, i) =>
        run.length > 1 ? (
          <polyline
            key={i}
            points={run.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#64748b"
            strokeWidth={1.5}
          />
        ) : null
      )}
      {points.map((p, i) =>
        p.counted && p.rate != null ? (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.rate)}
            r={p.isCurrent ? 3 : 2}
            fill={p.isCurrent ? "#dc2626" : "#64748b"}
          />
        ) : null
      )}
    </svg>
  );
}
