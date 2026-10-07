"use client";

// ShapesOS — Phase 19B (WS=engine): a range over seeded runs, per day.
// Never a single number: a light band (lowest → highest seed), a darker
// band (middle half) and the median line. Ink only — the status colours are
// for agents (DESIGN.md); scenario B is told apart by a dashed line, not a hue.

import type { Range } from "@/lib/sim/results";

export interface RangeSeries {
  label: string;
  ranges: Range[];
  dashed?: boolean;
}

const W = 560;
const H = 180;
const PAD = { l: 48, r: 12, t: 10, b: 26 };

export function RangeChart({ title, series, format, description }: { title: string; series: RangeSeries[]; format: (n: number) => string; description: string }) {
  const days = Math.max(1, ...series.map((s) => s.ranges.length));
  const max = Math.max(1e-9, ...series.flatMap((s) => s.ranges.map((r) => r.max)));
  const x = (d: number) => PAD.l + (days === 1 ? (W - PAD.l - PAD.r) / 2 : (d / (days - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const band = (rs: Range[], lo: (r: Range) => number, hi: (r: Range) => number) =>
    rs.length ? `M${rs.map((r, i) => `${x(i)},${y(hi(r))}`).join("L")}L${[...rs].map((r, i) => [i, r] as const).reverse().map(([i, r]) => `${x(i)},${y(lo(r))}`).join("L")}Z` : "";
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-semibold text-ink">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. ${description}`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--aos-line-strong)" strokeWidth={1} />
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--aos-line)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(max * f) + 4} textAnchor="end" className="fill-muted" fontSize={11}>
              {format(max * f)}
            </text>
          </g>
        ))}
        {Array.from({ length: days }, (_, d) => (
          <text key={d} x={x(d)} y={H - 8} textAnchor="middle" className="fill-muted" fontSize={11}>
            {d + 1}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.label}>
            <path d={band(s.ranges, (r) => r.min, (r) => r.max)} fill="var(--aos-ink)" fillOpacity={0.08} />
            <path d={band(s.ranges, (r) => r.p25, (r) => r.p75)} fill="var(--aos-ink)" fillOpacity={0.14} />
            <polyline points={s.ranges.map((r, i) => `${x(i)},${y(r.median)}`).join(" ")} fill="none" stroke="var(--aos-ink)" strokeWidth={2} strokeDasharray={s.dashed ? "6 4" : undefined} />
          </g>
        ))}
      </svg>
      {series.length > 1 ? (
        <div className="flex flex-wrap gap-4 text-xs text-muted">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden>
                <line x1="0" x2="22" y1="3" y2="3" stroke="var(--aos-ink)" strokeWidth={2} strokeDasharray={s.dashed ? "6 4" : undefined} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </figure>
  );
}
