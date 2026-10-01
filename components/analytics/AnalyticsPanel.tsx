// Marketr — Phase 12 "embeds": analytics dashboard panel (Umami-backed).
// Client component. Fetches /api/analytics/umami and renders stat cards +
// a pageview sparkline. Without a configured Umami sidecar it renders an
// honest empty state with the docker-compose profile instructions — never
// fabricated numbers.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  MousePointerClick,
  TerminalSquare,
  Users,
  Eye,
} from "lucide-react";
import { OpenInSheetsButton } from "@/components/office/OpenInSheetsButton";

interface Stats {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

interface Bucket {
  t: number;
  x: string;
  y: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; stats: Stats; series: Bucket[] };

const PERIODS = [7, 30, 90];

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Flatten stats + daily series into sheet rows (blank row separates sections). */
function sheetRows(stats: Stats, series: Bucket[]): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [
    ["Pageviews", stats.pageviews],
    ["Visitors", stats.visitors],
    ["Visits", stats.visits],
    ["Bounces", stats.bounces],
    ["Time on site (s)", Math.round(stats.totaltime)],
    [],
    ["Date", "Pageviews"],
  ];
  for (const b of series) rows.push([b.x, b.y]);
  return rows;
}

function Sparkline({ series }: { series: Bucket[] }) {
  const max = Math.max(1, ...series.map((b) => b.y));
  const W = 560;
  const H = 120;
  const step = series.length > 1 ? W / (series.length - 1) : W;
  const pts = series
    .map((b, i) => `${(i * step).toFixed(1)},${(H - (b.y / max) * (H - 16) - 8).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" role="img" aria-label="Pageviews over time">
      <polyline
        points={pts}
        fill="none"
        stroke="#000000"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {series.map((b, i) => (
        <circle
          key={i}
          cx={i * step}
          cy={H - (b.y / max) * (H - 16) - 8}
          r="2.5"
          fill="#000000"
        />
      ))}
    </svg>
  );
}

export function AnalyticsPanel() {
  const [days, setDays] = useState(30);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async (d: number) => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/analytics/umami?days=${d}`);
      const json = (await res.json()) as {
        stats?: Stats;
        series?: Bucket[];
        error?: string;
      };
      if (res.status === 503) {
        setState({ kind: "unconfigured", message: json.error ?? "Umami is not configured." });
        return;
      }
      if (!res.ok || !json.stats) {
        setState({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({ kind: "ready", stats: json.stats, series: json.series ?? [] });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Request failed." });
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-white p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDays(p)}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
                days === p
                  ? "bg-ink text-white"
                  : "text-muted hover:bg-hover"
              }`}
            >
              {p}d
            </button>
          ))}
        </div>
        {state.kind === "ready" && (
          <OpenInSheetsButton
            title={`Analytics — last ${days} days`}
            headers={["Metric", "Value"]}
            rows={sheetRows(state.stats, state.series)}
            sourceRef="analytics:overview"
            sheetName="Overview"
          />
        )}
      </div>

      {state.kind === "loading" && (
        <div className="rounded-xl border border-line bg-white p-8 text-center text-sm text-muted">
          Loading analytics…
        </div>
      )}

      {state.kind === "unconfigured" && (
          <div className="rounded-xl border border-line bg-canvas p-6">
            <div className="flex items-center gap-2 text-ink">
              <BarChart3 className="h-5 w-5 text-ink" />
              <h2 className="text-sm font-semibold">Umami is not connected</h2>
            </div>
            <p className="mt-2 text-[13px] text-muted">
              {state.message}{" "}
              Analytics for public pages (share links, campaign pages) come from a
              self-hosted Umami sidecar — MIT, cookieless, ~100MB idle.
            </p>
            <div className="mt-3 rounded-lg border border-line bg-white p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <TerminalSquare className="h-4 w-4" /> Quick start
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-ink p-3 font-mono text-[11px] leading-relaxed text-white">
{`docker compose -f docker-compose.yml \\
  -f docker/profiles/umami.yml \\
  --profile umami up -d`}
              </pre>
              <p className="mt-2 text-xs text-muted">
                Then set <code className="font-mono">UMAMI_URL</code>,{" "}
                <code className="font-mono">UMAMI_API_KEY</code>,{" "}
                <code className="font-mono">UMAMI_WEBSITE_ID</code> and{" "}
                <code className="font-mono">UMAMI_SCRIPT_URL</code> on the host
                (Settings → Providers shows the status).
              </p>
            </div>
          </div>
        )}

      {state.kind === "error" && (
        <div className="rounded-xl border border-failed bg-failed-tint p-4 text-[13px] text-failed-text" role="alert">
          Couldn&apos;t load analytics: {state.message}
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              { icon: Eye, label: "Pageviews", value: fmt(state.stats.pageviews) },
              { icon: Users, label: "Visitors", value: fmt(state.stats.visitors) },
              { icon: MousePointerClick, label: "Visits", value: fmt(state.stats.visits) },
              { icon: Activity, label: "Bounces", value: fmt(state.stats.bounces) },
              { icon: BarChart3, label: "Time on site", value: fmtDuration(state.stats.totaltime) },
            ].map((c) => (
              <div key={c.label} className="rounded-xl border border-line bg-white p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  <c.icon className="h-3.5 w-3.5" />
                  {c.label}
                </div>
                <div className="mt-1 text-2xl font-bold tracking-tight text-ink">
                  {c.value}
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-sm font-semibold text-ink">Pageviews</h2>
            <p className="text-xs text-muted">Last {days} days · via Umami</p>
            <div className="mt-2">
              {state.series.length > 0 ? (
                <Sparkline series={state.series} />
              ) : (
                <p className="py-8 text-center text-[13px] text-muted">
                  No pageviews recorded in this period yet.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
