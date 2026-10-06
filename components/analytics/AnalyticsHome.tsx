// ShapesOS — analytics home (Phase 4b). One date range across traffic (GA4 +
// Search Console via connectors), social engagement, attribution by channel
// and spend. Dense tables next to every chart; sample/mock data is labelled.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3, Globe, Loader2, Search as SearchIcon, Share2, Wallet } from "lucide-react";
import { BarList, LineChart, fillDays } from "./charts";
import { platformLabel } from "@/lib/social/platforms";
import type { AnalyticsOverview } from "@/lib/analytics/overview";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 12 months" },
];

const cardCls = "rounded-lg bg-paper p-4 shadow-hairline";
const thCls = "px-3 py-2 text-left text-xs font-semibold text-muted";
const thNum = "px-3 py-2 text-right text-xs font-semibold text-muted";
const tdCls = "px-3 py-2 text-[0.8125rem] text-ink";
const tdNum = "px-3 py-2 text-right text-[0.8125rem] tabular-nums text-ink";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function int(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");
}
function channelLabel(c: string): string {
  const s = c.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function SampleTag() {
  return <span className="ml-2 inline-flex h-5 items-center rounded-full bg-canvas px-2 text-[0.6875rem] font-semibold text-muted">Sample data</span>;
}

function SectionHead({ icon: Icon, title, right }: { icon: typeof Globe; title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink">
        <Icon className="h-4 w-4" /> {title}
      </h2>
      {right}
    </div>
  );
}

function NotConnected({ what }: { what: string }) {
  return (
    <p className="rounded-md bg-canvas px-3 py-3 text-[0.8125rem] text-muted">
      {what} isn&apos;t connected.{" "}
      <Link href="/dashboard/settings/connectors" className="font-semibold text-ink underline-offset-2 hover:underline">
        Connect it
      </Link>{" "}
      to see it here.
    </p>
  );
}

export function AnalyticsHome() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch on range change; the loading flag is raised by the change event.
  useEffect(() => {
    let live = true;
    fetch(`/api/analytics/overview?days=${days}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((body as { error?: string }).error ?? "Analytics didn't load.");
        return body as AnalyticsOverview;
      })
      .then((body) => {
        if (!live) return;
        setData(body);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Analytics didn't load.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [days]);

  const ga4 = data?.traffic.ga4;
  const gsc = data?.traffic.gsc;
  const social = data && data.social.status === "ok" && "totals" in data.social ? data.social : null;
  const attr = data && data.attribution.status === "ok" ? data.attribution : null;

  const kpis = [
    { label: "Sessions", value: ga4?.status === "ok" ? int(ga4.sessions) : "—", hint: ga4?.status === "ok" ? (ga4.mock ? "GA4 · sample" : "GA4") : "GA4 not connected" },
    { label: "Search clicks", value: gsc?.status === "ok" ? int(gsc.clicks) : "—", hint: gsc?.status === "ok" ? (gsc.mock ? "Top queries · sample" : "Top queries") : "Search Console not connected" },
    { label: "Social impressions", value: social ? int(social.totals.impressions) : "—", hint: social?.mock ? "Includes sample data" : `${social?.postsPublished ?? 0} posts published` },
    { label: "Social engagements", value: social ? int(social.totals.engagements) : "—", hint: "Likes, comments, shares, clicks" },
    { label: "Leads", value: attr ? int(attr.totals.leads) : "—", hint: "With a marketing touch" },
    { label: "Attributed revenue", value: attr ? money(attr.totals.revenueCents) : "—", hint: "Linear model" },
    { label: "Spend", value: attr ? money(attr.totals.spendCents) : "—", hint: "Spend entries" },
    { label: "ROAS", value: attr?.totals.roas != null ? `${attr.totals.roas.toFixed(2)}×` : "—", hint: "Revenue / spend" },
  ];

  const from = data ? new Date(data.window.from) : null;
  const to = data ? new Date(data.window.to) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Date range" className={inputCls} value={days} onChange={(e) => {
            setLoading(true);
            setDays(Number(e.target.value));
          }}>
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
        {loading ? <Loader2 className="h-4 w-4 aos-spin text-muted" aria-label="Loading" /> : null}
        {error ? (
          <span className="flex items-center gap-2 text-[0.8125rem] text-failed-text">
            <span className="aos-shape aos-shape--failed" aria-hidden /> {error}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-lg bg-paper p-3 shadow-hairline">
            <div className="text-[0.75rem] font-semibold text-muted">{k.label}</div>
            <div className="mt-1 text-xl font-heading stretch-heading tabular-nums text-ink">{k.value}</div>
            <div className="mt-0.5 truncate text-[0.75rem] text-subtle">{k.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={cardCls}>
          <SectionHead
            icon={Share2}
            title="Social engagement"
            right={
              <span className="flex items-center text-[0.75rem] text-muted">
                Impressions per day{social?.mock ? <SampleTag /> : null}
              </span>
            }
          />
          {data?.social.status === "error" ? (
            <p className="text-[0.8125rem] text-failed-text">{(data.social as { message: string }).message}</p>
          ) : (
            <>
              <LineChart label="Social impressions per day" points={from && to ? fillDays((social?.daily ?? []).map((d) => ({ x: d.day, y: d.impressions })), from, to) : []} />
              <table className="mt-3 w-full text-left">
                <thead>
                  <tr className="border-b border-line">
                    <th className={thCls}>Platform</th>
                    <th className={thNum}>Impressions</th>
                    <th className={thNum}>Likes</th>
                    <th className={thNum}>Comments</th>
                    <th className={thNum}>Shares</th>
                    <th className={thNum}>Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {(social?.byPlatform ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-[0.8125rem] text-muted">
                        No published posts in this range. <Link href="/dashboard/social" className="font-semibold text-ink hover:underline">Open Social</Link>
                      </td>
                    </tr>
                  ) : (
                    social!.byPlatform.map((p) => (
                      <tr key={p.platform} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className={`${tdCls} font-medium`}>{platformLabel(p.platform)}</td>
                        <td className={tdNum}>{int(p.impressions)}</td>
                        <td className={tdNum}>{int(p.likes)}</td>
                        <td className={tdNum}>{int(p.comments)}</td>
                        <td className={tdNum}>{int(p.shares)}</td>
                        <td className={tdNum}>{int(p.clicks)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className={cardCls}>
          <SectionHead icon={Wallet} title="Revenue and spend by channel" right={<Link href="/dashboard/attribution" className="text-[0.8125rem] font-semibold text-ink hover:underline">Attribution</Link>} />
          {data?.attribution.status === "error" ? (
            <p className="text-[0.8125rem] text-failed-text">{(data.attribution as { message: string }).message}</p>
          ) : (
            <>
              <BarList
                label="Attributed revenue by channel"
                format={(n) => money(n)}
                rows={(attr?.channels ?? []).slice(0, 8).map((c) => ({ key: c.channel, label: channelLabel(c.channel), value: c.revenueCents }))}
              />
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={thCls}>Channel</th>
                      <th className={thNum}>Leads</th>
                      <th className={thNum}>Customers</th>
                      <th className={thNum}>Revenue</th>
                      <th className={thNum}>Spend</th>
                      <th className={thNum}>ROAS</th>
                      <th className={thNum}>CPL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(attr?.channels ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-4 text-center text-[0.8125rem] text-muted">No touches in this range.</td>
                      </tr>
                    ) : (
                      attr!.channels.map((c) => (
                        <tr key={c.channel} className="border-b border-line last:border-0 hover:bg-hover-paper">
                          <td className={`${tdCls} font-medium`}>{channelLabel(c.channel)}</td>
                          <td className={tdNum}>{int(c.leads)}</td>
                          <td className={tdNum}>{c.customers % 1 ? c.customers.toFixed(2) : int(c.customers)}</td>
                          <td className={`${tdNum} font-semibold`}>{money(c.revenueCents)}</td>
                          <td className={tdNum}>{money(c.spendCents)}</td>
                          <td className={tdNum}>{c.roas != null ? `${c.roas.toFixed(2)}×` : "—"}</td>
                          <td className={tdNum}>{c.cplCents != null ? money(c.cplCents) : "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className={cardCls}>
          <SectionHead icon={Globe} title="Top pages" right={ga4?.status === "ok" && ga4.mock ? <SampleTag /> : null} />
          {!ga4 || ga4.status === "not_connected" ? (
            <NotConnected what="Google Analytics 4" />
          ) : ga4.status === "error" ? (
            <p className="text-[0.8125rem] text-failed-text">{ga4.message}</p>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className={thCls}>Page</th>
                  <th className={thNum}>Sessions</th>
                  <th className={thNum}>Conversions</th>
                </tr>
              </thead>
              <tbody>
                {ga4.topPages.map((p) => (
                  <tr key={p.path} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className={`${tdCls} max-w-[280px]`}>
                      <div className="truncate font-medium">{p.title ?? p.path}</div>
                      <div className="truncate font-mono text-[0.75rem] text-muted">{p.path}</div>
                    </td>
                    <td className={tdNum}>{int(p.sessions)}</td>
                    <td className={tdNum}>{int(p.conversions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={cardCls}>
          <SectionHead icon={SearchIcon} title="Top search queries" right={gsc?.status === "ok" && gsc.mock ? <SampleTag /> : null} />
          {!gsc || gsc.status === "not_connected" ? (
            <NotConnected what="Google Search Console" />
          ) : gsc.status === "error" ? (
            <p className="text-[0.8125rem] text-failed-text">{gsc.message}</p>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className={thCls}>Query</th>
                  <th className={thNum}>Clicks</th>
                  <th className={thNum}>Impressions</th>
                  <th className={thNum}>CTR</th>
                  <th className={thNum}>Position</th>
                </tr>
              </thead>
              <tbody>
                {gsc.topQueries.map((r) => (
                  <tr key={r.query} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className={`${tdCls} max-w-[260px] truncate font-medium`}>{r.query}</td>
                    <td className={tdNum}>{int(r.clicks)}</td>
                    <td className={tdNum}>{int(r.impressions)}</td>
                    <td className={tdNum}>{r.ctr != null ? `${(r.ctr * 100).toFixed(1)}%` : "—"}</td>
                    <td className={tdNum}>{r.position != null ? r.position.toFixed(1) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {social && social.byPost.length > 0 ? (
        <section className={cardCls}>
          <SectionHead icon={BarChart3} title="Top social posts" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className={thCls}>Post</th>
                  <th className={thCls}>Campaign</th>
                  <th className={thNum}>Impressions</th>
                  <th className={thNum}>Engagements</th>
                  <th className={thNum}>Clicks</th>
                </tr>
              </thead>
              <tbody>
                {social.byPost.slice(0, 10).map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className={`${tdCls} max-w-[360px]`}>
                      <Link href={`/dashboard/social?post=${encodeURIComponent(p.id)}`} className="block truncate font-medium hover:underline">
                        {p.title}
                      </Link>
                      <div className="text-[0.75rem] text-muted">
                        {p.platforms.map((x) => platformLabel(x)).join(", ")}
                        {p.mock ? " · sample" : ""}
                      </div>
                    </td>
                    <td className={`${tdCls} font-mono text-[0.75rem] text-muted`}>{p.campaign}</td>
                    <td className={tdNum}>{int(p.impressions)}</td>
                    <td className={tdNum}>{int(p.engagements)}</td>
                    <td className={tdNum}>{int(p.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
