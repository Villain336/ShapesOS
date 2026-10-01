// Marketr — Phase 18 slice 6: unified cross-platform ad reporting.
//
// One analytics home: AdReport rows from every platform (Amazon Ads,
// StackAdapt, guided walmart/spotify imports) roll up into spend,
// impressions, clicks, CTR, conversions, revenue, and ROAS — per campaign
// and per platform, with date-range and platform filters. Lineage on every
// row: report → campaign → approval → platform receipt.

import { redirect } from "next/navigation";
import { BarChart3 } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ADS_PLATFORMS } from "@/lib/adplatforms/types";
import {
  defaultRange,
  fetchAdReportRows,
  parseRangeDate,
  rollupByCampaign,
  rollupByPlatform,
  rollupRows,
  type ReportRange,
} from "@/lib/adplatforms/unified-reporting";
import AdsTabs from "../_components/AdsTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Ad reports — Marketr",
  description: "Unified cross-platform ad reporting: spend, ROAS, and lineage.",
};

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function pct(frac: number | null): string {
  if (frac === null) return "—";
  return `${(frac * 100).toFixed(2)}%`;
}

function roasText(roas: number | null): string {
  if (roas === null) return "—";
  return `${roas.toFixed(2)}×`;
}

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";
const chipSlate = `${chip} bg-stone-100 text-stone-600 border-stone-200`;
const chipBrand = `${chip} bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20`;

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-0.5 text-xl font-bold tracking-tight text-stone-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-stone-500">{sub}</div>}
    </div>
  );
}

export default async function AdReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const params = await searchParams;
  const rawFrom = typeof params.from === "string" ? params.from : undefined;
  const rawTo = typeof params.to === "string" ? params.to : undefined;
  const rawPlatform = typeof params.platform === "string" ? params.platform : undefined;
  const def = defaultRange();
  const range: ReportRange = {
    from: parseRangeDate(rawFrom) ?? def.from,
    to: parseRangeDate(rawTo) ?? def.to,
  };
  const platformKeys = rawPlatform && rawPlatform !== "all" ? [rawPlatform] : undefined;

  const rows = await fetchAdReportRows(workspace.id, { from: range.from, to: range.to, platformKeys });
  const totals = rollupRows(rows);
  const byPlatform = rollupByPlatform(rows);
  const byCampaign = rollupByCampaign(rows);

  const fromStr = range.from.toISOString().slice(0, 10);
  const toStr = range.to.toISOString().slice(0, 10);
  const platformOptions = Object.values(ADS_PLATFORMS).map((p) => ({ key: p.key, label: p.displayName }));

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Reports</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — normalized spend, impressions, clicks, and ROAS across every platform. Every figure traces to the campaign, the approval, and the platform receipt.
        </p>
      </div>

      <AdsTabs active="reports" />

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          name="from"
          defaultValue={fromStr}
          className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[12px] text-stone-800"
        />
        <span className="text-[12px] text-stone-400">→</span>
        <input
          type="date"
          name="to"
          defaultValue={toStr}
          className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[12px] text-stone-800"
        />
        <select
          name="platform"
          defaultValue={rawPlatform ?? "all"}
          className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[12px] text-stone-800"
        >
          <option value="all">All platforms</option>
          {platformOptions.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="inline-flex items-center gap-1 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white px-6 py-12 text-center">
          <BarChart3 className="h-8 w-8 text-stone-300" />
          <p className="text-[14px] font-medium text-stone-700">No ad data in this window</p>
          <p className="max-w-sm text-[13px] text-stone-500">
            Connect a platform and pull reporting (Amazon Ads, StackAdapt), or import spend via the guided Walmart Connect / Spotify flows. Rows appear here once ingested.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Ad spend" value={money(totals.spendCents)} sub={`${num(totals.rowCount)} daily rows`} />
            <Kpi label="Attributed revenue" value={money(totals.revenueCents)} sub={`${num(totals.conversions)} conversions`} />
            <Kpi label="Blended ROAS" value={roasText(totals.roas)} sub={totals.roas === null ? "no spend in window" : "revenue ÷ spend"} />
            <Kpi label="Clicks" value={num(totals.clicks)} sub={`${num(totals.impressions)} impressions · CTR ${pct(totals.ctr)}`} />
          </div>

          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div className="border-b border-stone-200 bg-stone-50 px-3 py-2 text-[12px] font-medium text-stone-700">
              By platform
            </div>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Platform</th>
                  <th className="px-3 py-2 font-medium text-right">Spend</th>
                  <th className="px-3 py-2 font-medium text-right">Impr.</th>
                  <th className="px-3 py-2 font-medium text-right">Clicks</th>
                  <th className="px-3 py-2 font-medium text-right">CTR</th>
                  <th className="px-3 py-2 font-medium text-right">Conv.</th>
                  <th className="px-3 py-2 font-medium text-right">Revenue</th>
                  <th className="px-3 py-2 font-medium text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {byPlatform.map((p) => (
                  <tr key={p.platformKey} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                    <td className="px-3 py-2.5">
                      <span className={chipBrand}>{p.platformLabel}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium text-stone-900">{money(p.totals.spendCents)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{num(p.totals.impressions)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{num(p.totals.clicks)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{pct(p.totals.ctr)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{num(p.totals.conversions)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{money(p.totals.revenueCents)}</td>
                    <td className="px-3 py-2.5 text-right font-medium text-stone-900">{roasText(p.totals.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div className="border-b border-stone-200 bg-stone-50 px-3 py-2 text-[12px] font-medium text-stone-700">
              By campaign
            </div>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Platform</th>
                  <th className="px-3 py-2 font-medium text-right">Spend</th>
                  <th className="px-3 py-2 font-medium text-right">Clicks</th>
                  <th className="px-3 py-2 font-medium text-right">Conv.</th>
                  <th className="px-3 py-2 font-medium text-right">Revenue</th>
                  <th className="px-3 py-2 font-medium text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {byCampaign.map((c) => (
                  <tr key={c.campaignId} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                    <td className="px-3 py-2.5 font-medium text-stone-900">{c.campaignName}</td>
                    <td className="px-3 py-2.5">
                      <span className={chipSlate}>{c.platformLabel}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium text-stone-900">{money(c.totals.spendCents)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{num(c.totals.clicks)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{num(c.totals.conversions)}</td>
                    <td className="px-3 py-2.5 text-right text-stone-600">{money(c.totals.revenueCents)}</td>
                    <td className="px-3 py-2.5 text-right font-medium text-stone-900">{roasText(c.totals.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
