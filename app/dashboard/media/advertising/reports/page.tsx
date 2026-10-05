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
  title: "Ad reports — ShapesOS",
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
  "inline-flex h-badge items-center whitespace-nowrap rounded-full border border-line bg-paper px-2.5 text-sm font-semibold text-muted";

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2.5 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover";

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-paper px-4 py-3 shadow-hairline">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-bold tracking-tight text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Reports</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — normalized spend, impressions, clicks, and ROAS across every platform. Every figure traces to the campaign, the approval, and the platform receipt.
        </p>
      </div>

      <AdsTabs active="reports" />

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input type="date" name="from" defaultValue={fromStr} className={inputCls} />
        <span className="text-xs text-subtle">→</span>
        <input type="date" name="to" defaultValue={toStr} className={inputCls} />
        <select name="platform" defaultValue={rawPlatform ?? "all"} className={inputCls}>
          <option value="all">All platforms</option>
          {platformOptions.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <button type="submit" className={btnPrimarySm}>
          <BarChart3 className="h-3.5 w-3.5" />
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
          <BarChart3 className="h-8 w-8 text-subtle" />
          <p className="text-md font-semibold text-ink">No ad data in this window</p>
          <p className="max-w-sm text-sm text-muted">
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

          <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
            <div className="border-b border-line px-3 py-2 text-xs font-semibold text-muted">
              By platform
            </div>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas">
                  <th className="px-3 py-2 text-xs font-semibold text-muted">Platform</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Spend</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Impr.</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Clicks</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">CTR</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Conv.</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Revenue</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {byPlatform.map((p) => (
                  <tr key={p.platformKey} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2.5">
                      <span className={chip}>{p.platformLabel}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">{money(p.totals.spendCents)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{num(p.totals.impressions)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{num(p.totals.clicks)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{pct(p.totals.ctr)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{num(p.totals.conversions)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{money(p.totals.revenueCents)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">{roasText(p.totals.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
            <div className="border-b border-line px-3 py-2 text-xs font-semibold text-muted">
              By campaign
            </div>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas">
                  <th className="px-3 py-2 text-xs font-semibold text-muted">Campaign</th>
                  <th className="px-3 py-2 text-xs font-semibold text-muted">Platform</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Spend</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Clicks</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Conv.</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Revenue</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {byCampaign.map((c) => (
                  <tr key={c.campaignId} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2.5 font-semibold text-ink">{c.campaignName}</td>
                    <td className="px-3 py-2.5">
                      <span className={chip}>{c.platformLabel}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">{money(c.totals.spendCents)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{num(c.totals.clicks)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{num(c.totals.conversions)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{money(c.totals.revenueCents)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">{roasText(c.totals.roas)}</td>
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
