// Marketr — Phase 10 M6: data-costs client UI.
// House style diffed against app/dashboard/studio/StudioApp.tsx:
// dense tables (rows hover:bg-violet-50/40), violet primaries, Lucide icons,
// sub-tabs with icon + label (active = border-violet-600 text-violet-700),
// info notes border-stone-200 bg-stone-50.
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  CheckCircle2,
  Coins,
  Database,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import type { DataCostSummary } from "@/lib/intelligence/providers/meter";
import type { VendorConfigRow, RoutingRules } from "@/lib/intelligence/providers/credentials";
import type { SerpVendorId } from "@/lib/intelligence/providers/types";

// ── Small atoms (StudioApp parity) ───────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const thCls = "px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500";
const tdCls = "px-2.5 py-1.5 text-[13px] text-stone-800";
const rowCls = "border-t border-stone-100 hover:bg-violet-50/40";
const noteCls = "rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600";

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function periodOptions(current: string): string[] {
  const out: string[] = [];
  const [y, m] = current.split("-").map(Number);
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  period: string;
  summary: DataCostSummary;
  configs: VendorConfigRow[];
  health: Array<{ vendor: SerpVendorId; configured: boolean; costPerSerpCallUsd: number }>;
  cacheStats: { rows: number; totalHits: number; oldestFetchedAt: Date | null; freshestFetchedAt: Date | null };
  cacheTtlDays: number;
  cacheMaxTtlDays: number;
  envVars: Record<SerpVendorId, string[]>;
  isAdmin: boolean;
}

const TABS = [
  { id: "spend", label: "Spend", icon: Coins },
  { id: "cache", label: "Volume cache", icon: Database },
  { id: "routing", label: "Vendor routing", icon: ArrowLeftRight },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ── Spend tab ────────────────────────────────────────────────────────────────

function SpendTab({ summary, period }: { summary: DataCostSummary; period: string }) {
  const router = useRouter();
  const capUsd = summary.capCents != null ? summary.capCents / 100 : null;
  const spendUsd = summary.totalCostUsd;
  const pct = capUsd != null && capUsd > 0 ? Math.min(100, (spendUsd / capUsd) * 100) : null;
  const hitRate = summary.volumeCacheHitRate;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <select
          className={inputCls}
          value={period}
          onChange={(e) => router.push(`/dashboard/intelligence/data-costs?period=${e.target.value}`)}
          aria-label="Billing period"
        >
          {periodOptions(period).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Spend · {summary.period}</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">{fmtUsd(spendUsd)}</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Budget cap</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">
            {capUsd != null ? `$${capUsd.toFixed(2)}` : "—"}
          </div>
          {pct != null && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
              <div
                className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-violet-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">API calls</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">{summary.totalCalls.toLocaleString()}</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Cache hit rate</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">
            {hitRate != null ? `${(hitRate * 100).toFixed(1)}%` : "—"}
          </div>
          <div className="mt-0.5 text-[11px] text-stone-500">volume lookups served free</div>
        </div>
      </div>

      {capUsd != null && pct != null && pct >= 80 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {pct >= 100
              ? "Budget cap reached — new data calls are blocked by the circuit breaker until the cap is raised."
              : `At ${pct.toFixed(0)}% of the monthly data budget. New calls trip the circuit breaker at 100%.`}
          </span>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-stone-50/60">
              <th className={thCls}>Vendor</th>
              <th className={thCls}>Meter</th>
              <th className={`${thCls} text-right`}>Calls</th>
              <th className={`${thCls} text-right`}>Quantity</th>
              <th className={`${thCls} text-right`}>Cost (USD)</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.length === 0 && (
              <tr className={rowCls}>
                <td className={`${tdCls} text-stone-500`} colSpan={5}>
                  No metered calls in {summary.period} yet.
                </td>
              </tr>
            )}
            {summary.rows.map((r) => (
              <tr key={`${r.vendor}::${r.meter}`} className={rowCls}>
                <td className={tdCls}>
                  <Chip tone={r.vendor === "volume_cache" ? "green" : "violet"}>{r.vendor}</Chip>
                </td>
                <td className={tdCls}><span className="font-mono text-[12px]">{r.meter}</span></td>
                <td className={`${tdCls} text-right tabular-nums`}>{r.calls.toLocaleString()}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{r.quantity.toLocaleString()}</td>
                <td className={`${tdCls} text-right tabular-nums font-medium`}>{fmtUsd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={noteCls}>
        Every external data call is metered append-only (api_meter) and audit-logged. Zero-cost rows
        (volume_cache) are lookups served from the shared cache — no vendor was paid.
      </div>
    </div>
  );
}

// ── Cache tab ────────────────────────────────────────────────────────────────

function CacheTab({ props }: { props: Props }) {
  const hitRate = props.summary.volumeCacheHitRate;
  const s = props.cacheStats;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Cached keywords</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">{s.rows.toLocaleString()}</div>
          <div className="mt-0.5 text-[11px] text-stone-500">shared dedup cache</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Aggregate hits</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">{s.totalHits.toLocaleString()}</div>
          <div className="mt-0.5 text-[11px] text-stone-500">never per-tenant</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Hit rate (period)</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">
            {hitRate != null ? `${(hitRate * 100).toFixed(1)}%` : "—"}
          </div>
          <div className="mt-0.5 text-[11px] text-stone-500">target ~90% at scale</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">TTL policy</div>
          <div className="mt-1 text-xl font-bold tracking-tight text-stone-900">{props.cacheTtlDays}d</div>
          <div className="mt-0.5 text-[11px] text-stone-500">max {props.cacheMaxTtlDays}d from fetch</div>
        </div>
      </div>

      <div className={noteCls}>
        Defensive posture (§M6): 30–90 day TTLs, cache-invalidation-on-use (a hit refreshes expiry, but never past{" "}
        {props.cacheMaxTtlDays} days from the original fetch — this is not a shadow database), and per-workspace
        attribution so the cache can be narrowed later if counsel ever weighs in. Volume is always a band
        (e.g. “1K–10K”), never a false-precision point.
      </div>

      <div className={noteCls}>
        <span className="font-medium text-stone-700">Keyword Planner (free volume path) — not connected.</span>{" "}
        Planner is free via the Google Ads API but requires a manager account and a ~5-business-day manual
        Basic-access review; Explorer access blocks KeywordPlanIdeaService. Until it&apos;s set up, volume misses
        fall through to vendor clickstream bulk (~$132/1M).
      </div>
    </div>
  );
}

// ── Routing tab ──────────────────────────────────────────────────────────────

function RoutingTab({ props }: { props: Props }) {
  const [vendor, setVendor] = useState<SerpVendorId>("serper");
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const defaultVendor = useMemo(() => {
    for (const c of props.configs) {
      const r = (c.routingRules ?? {}) as RoutingRules;
      if (r.default) return r.default;
    }
    return "serper" as SerpVendorId;
  }, [props.configs]);

  const aiVendor = useMemo(() => {
    for (const c of props.configs) {
      const r = (c.routingRules ?? {}) as RoutingRules;
      if (r.aiOverview) return r.aiOverview;
    }
    return "talordata" as SerpVendorId;
  }, [props.configs]);

  async function switchVendor() {
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/intelligence/data-costs/vendor-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-stone-50/60">
              <th className={thCls}>Vendor</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Configured</th>
              <th className={`${thCls} text-right`}>Cost / 1K calls</th>
              <th className={thCls}>Role</th>
            </tr>
          </thead>
          <tbody>
            {props.health.map((h) => {
              const cfg = props.configs.find((c) => c.vendor === h.vendor);
              return (
                <tr key={h.vendor} className={rowCls}>
                  <td className={tdCls}>
                    <span className="font-mono text-[12px] font-medium">{h.vendor}</span>
                  </td>
                  <td className={tdCls}>
                    <Chip tone={cfg?.status === "active" ? "green" : "slate"}>{cfg?.status ?? "active"}</Chip>
                  </td>
                  <td className={tdCls}>
                    {h.configured ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" /> yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-stone-400">
                        <XCircle className="h-3.5 w-3.5" /> no key
                      </span>
                    )}
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>${(h.costPerSerpCallUsd * 1000).toFixed(2)}</td>
                  <td className={tdCls}>
                    <div className="flex gap-1">
                      {defaultVendor === h.vendor && <Chip tone="violet">default</Chip>}
                      {aiVendor === h.vendor && <Chip tone="blue">AI overview</Chip>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={noteCls}>
        Routing: TalorData when AI-overview detection matters, Serper at volume for price, DataForSEO as the
        breadth fallback. Missing credentials: {Object.entries(props.envVars)
          .map(([v, vars]) => `${v} (${vars.join("/")})`)
          .join(" · ")} — set env vars for demo mode or bind a <span className="font-mono text-[12px]">serp_vendor</span> data source.
      </div>

      {props.isAdmin ? (
        <div className="flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <span className="text-[13px] font-medium text-stone-700">Default vendor</span>
          <select className={inputCls} value={vendor} onChange={(e) => setVendor(e.target.value as SerpVendorId)}>
            <option value="serper">serper</option>
            <option value="dataforseo">dataforseo</option>
            <option value="talordata">talordata</option>
          </select>
          <button className={btnPrimary} onClick={switchVendor} disabled={switching}>
            {switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
            Switch default vendor
          </button>
          {error && <span className="text-[12px] text-red-700">{error}</span>}
        </div>
      ) : (
        <div className={noteCls}>
          <span className="font-medium text-stone-700">Admin role required</span> to switch the default vendor —
          no self-serve vendor switching without approval.
        </div>
      )}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

export function DataCostsClient(props: Props) {
  const [tab, setTab] = useState<TabId>("spend");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-stone-200">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
                active ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === "spend" && <SpendTab summary={props.summary} period={props.period} />}
      {tab === "cache" && <CacheTab props={props} />}
      {tab === "routing" && <RoutingTab props={props} />}
    </div>
  );
}
