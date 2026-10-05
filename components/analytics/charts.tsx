// ShapesOS — minimal chart primitives for the analytics home (Phase 4b).
// Inline SVG, no chart library. Agentic OS: charts are ink on paper (the
// four status colors are reserved for agent states), single series, thin
// 2px lines, recessive gridlines, hover tooltip on every mark, and every
// chart has a table next to it on the page.
"use client";

import { useState } from "react";

export interface Point {
  /** YYYY-MM-DD */
  x: string;
  y: number;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Fill missing days with 0 so the line doesn't skip gaps. */
export function fillDays(points: Point[], from: Date, to: Date): Point[] {
  const byDay = new Map(points.map((p) => [p.x, p.y]));
  const out: Point[] = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  for (let t = start; t <= end && out.length < 800; t += 86_400_000) {
    const k = new Date(t).toISOString().slice(0, 10);
    out.push({ x: k, y: byDay.get(k) ?? 0 });
  }
  return out;
}

export function LineChart({ points, label, height = 160 }: { points: Point[]; label: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const padL = 40;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const max = niceMax(Math.max(0, ...points.map((p) => p.y)));
  const n = points.length;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.y).toFixed(1)}`).join(" ");
  const ticks = [0, max / 2, max];
  const hp = hover != null ? points[hover] : null;

  if (n === 0) return <p className="py-8 text-center text-[13px] text-muted">No data in this range.</p>;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${label}, ${points[0]!.x} to ${points[n - 1]!.x}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--aos-line)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--aos-text-muted)">
              {fmt(t)}
            </text>
          </g>
        ))}
        <text x={padL} y={H - 6} fontSize={11} fill="var(--aos-text-muted)">
          {points[0]!.x.slice(5)}
        </text>
        <text x={W - padR} y={H - 6} fontSize={11} fill="var(--aos-text-muted)" textAnchor="end">
          {points[n - 1]!.x.slice(5)}
        </text>
        <path d={path} fill="none" stroke="var(--aos-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hp && hover != null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--aos-line-strong)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(hp.y)} r={4} fill="var(--aos-ink)" stroke="var(--aos-paper)" strokeWidth={2} />
          </g>
        ) : null}
      </svg>
      {hp && hover != null ? (
        <div
          className="pointer-events-none absolute top-0 rounded-md bg-ink px-2 py-1 text-[12px] font-semibold text-paper shadow-raised"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)" }}
        >
          {hp.x} · {hp.y.toLocaleString("en-US")}
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal bars, one series, value labels at the bar end. */
export function BarList({
  rows,
  format = (n: number) => n.toLocaleString("en-US"),
  label,
}: {
  rows: Array<{ key: string; label: string; value: number }>;
  format?: (n: number) => string;
  label: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="py-8 text-center text-[13px] text-muted">No data in this range.</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-3" title={`${r.label}: ${format(r.value)}`}>
          <span className="truncate text-[13px] text-ink">{r.label}</span>
          <span className="h-2.5 rounded-full bg-control">
            <span
              className="block h-2.5 rounded-full bg-ink"
              style={{ width: `${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%` }}
            />
          </span>
          <span className="text-right text-[13px] font-semibold tabular-nums text-ink">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
