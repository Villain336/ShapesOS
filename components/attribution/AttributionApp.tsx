// Marketr — Revenue attribution dashboard (C2).
// Light mode, CRM density: model tabs, KPI cards, channel/campaign/content
// tables, manual spend entry. Read-only analytics on the Lead model.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChartLine,
  DollarSign,
  Plus,
  Trash,
  X,
  Calendar,
  Link as LinkIcon,
  Megaphone,
  Flag,
  FlagOff,
  Equal,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { formatMoney } from "../crm/types";
import { EmptyState } from "../crm/ui";
import { BundlesSection } from "./BundlesSection";
import { confirmAction } from "@/lib/ui/feedback";

type Model = "first_touch" | "last_touch" | "linear";

const MODELS: { id: Model; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "first_touch", label: "First touch", hint: "100% of revenue to the first touch", icon: Flag },
  { id: "last_touch", label: "Last touch", hint: "100% of revenue to the last touch", icon: FlagOff },
  { id: "linear", label: "Linear", hint: "Revenue split evenly across all touches", icon: Equal },
];

const RANGES = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "12m", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

interface ModelNums { customers: number; cacCents: number | null; revenueCents: number; roas: number | null }
interface Engagement { impressions: number; likes: number; comments: number; shares: number; clicks: number; engagements: number }
interface ChannelRow {
  channel: string; leads: number; spendCents: number; cplCents: number | null;
  perModel: Record<Model, ModelNums>;
  /** Phase 4b: social_organic carries post engagement. */
  engagement?: Engagement;
}
interface SocialPostRow extends Engagement {
  id: string; title: string; platforms: string[]; campaign: string; publishedAt: string | null; mock: boolean;
  leads: number; revenueCents: number; clickToLead: number | null;
}
interface SocialData {
  engagement: Engagement; channelLeads: number; channelRevenueCents: number;
  posts: SocialPostRow[]; mock: boolean; postsPublished: number;
}
interface CampaignRow extends ChannelRow { campaign: string | null }
interface ContentRow {
  contentId: string; publishedUrl: string | null; keywordPhrase: string | null;
  touches: number; leads: number; customers: number; revenueCents: number;
}
interface SummaryData {
  model: Model; leads: number; customers: number; attributedRevenueCents: number;
  unattributedRevenueCents: number; spendCents: number;
  cplCents: number | null; cacCents: number | null; roas: number | null;
}
interface SpendRow {
  id: string; channel: string; campaign: string | null; amountCents: number;
  periodStart: string; periodEnd: string; notes: string | null;
}
interface Pipeline { id: string; name: string }

function channelLabel(c: string): string {
  return c.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}
function fmtRoas(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return "—";
  return `${r.toFixed(2)}×`;
}

function rangeToDates(range: string): { from?: string; to?: string } {
  if (range === "all") return {};
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

const cardCls = "rounded-[10px] border border-line bg-white p-4";
const thCls = "px-3 py-2 text-left text-xs font-semibold text-muted";
const tdCls = "px-3 py-2.5 text-[0.8125rem] text-muted tabular-nums";
const tdNum = "px-3 py-2.5 text-[0.8125rem] text-muted tabular-nums text-right";
const thNum = "px-3 py-2 text-right text-xs font-semibold text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnDeny =
  "inline-flex items-center justify-center rounded-full bg-white p-2 text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

export function AttributionApp() {
  const [model, setModel] = useState<Model>("linear");
  const [range, setRange] = useState("90d");
  const [pipelineId, setPipelineId] = useState("");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [content, setContent] = useState<ContentRow[]>([]);
  const [spend, setSpend] = useState<SpendRow[]>([]);
  const [social, setSocial] = useState<SocialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSpendForm, setShowSpendForm] = useState(false);
  const [spendDraft, setSpendDraft] = useState({
    channel: "paid_search", campaign: "", amount: "", periodStart: "", periodEnd: "", notes: "",
  });
  const [spendSaving, setSpendSaving] = useState(false);
  const [spendError, setSpendError] = useState("");

  useEffect(() => {
    fetch("/api/crm/pipelines").then((r) => r.json()).then((d) => setPipelines(d.pipelines ?? [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = rangeToDates(range);
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (pipelineId) q.set("pipelineId", pipelineId);
      const qs = q.toString();
      const [s, ch, cp, ct, sp, so] = await Promise.all([
        fetch(`/api/attribution/summary?model=${model}&${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/channels?${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/campaigns?${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/content?model=${model}&${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/spend`).then((r) => r.json()),
        fetch(`/api/attribution/social?model=${model}&${qs}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setSocial(so as SocialData | null);
      setSummary(s);
      setChannels(ch.channels ?? []);
      setCampaigns(cp.campaigns ?? []);
      setContent(ct.items ?? []);
      setSpend(sp.spend ?? []);
    } catch {
      /* keep previous data */
    } finally {
      setLoading(false);
    }
  }, [model, range, pipelineId]);

  useEffect(() => { load(); }, [load]);

  const saveSpend = async () => {
    setSpendError("");
    const amountCents = Math.round(Number(spendDraft.amount) * 100);
    if (!spendDraft.channel.trim()) { setSpendError("Channel is required."); return; }
    if (!Number.isFinite(amountCents) || amountCents < 0) { setSpendError("Enter a valid amount."); return; }
    if (!spendDraft.periodStart || !spendDraft.periodEnd) { setSpendError("Period start and end are required."); return; }
    setSpendSaving(true);
    try {
      const r = await fetch("/api/attribution/spend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: spendDraft.channel.trim(),
          campaign: spendDraft.campaign.trim() || undefined,
          amountCents,
          periodStart: new Date(spendDraft.periodStart).toISOString(),
          periodEnd: new Date(spendDraft.periodEnd).toISOString(),
          notes: spendDraft.notes.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setSpendError(d.error ?? "Could not save spend."); return; }
      setSpend((s) => [d.spend, ...s]);
      setSpendDraft({ channel: "paid_search", campaign: "", amount: "", periodStart: "", periodEnd: "", notes: "" });
      setShowSpendForm(false);
      load(); // refresh ROAS/CPL/CAC math
    } finally {
      setSpendSaving(false);
    }
  };

  const deleteSpend = async (id: string) => {
    if (!await confirmAction("Delete this spend entry?")) return;
    const r = await fetch(`/api/attribution/spend/${id}`, { method: "DELETE" });
    if (r.ok) {
      setSpend((s) => s.filter((x) => x.id !== id));
      load();
    }
  };

  const kpis: { label: string; value: string; hint: string }[] = summary ? [
    { label: "Attributed revenue", value: formatMoney(summary.attributedRevenueCents), hint: `${MODELS.find((m) => m.id === model)!.label} model` },
    { label: "Ad spend", value: formatMoney(summary.spendCents), hint: "Manual spend entries" },
    { label: "ROAS", value: fmtRoas(summary.roas), hint: "Revenue / spend" },
    { label: "Customers", value: fmtNum(summary.customers, summary.customers % 1 ? 2 : 0), hint: "Won leads with revenue" },
    { label: "CAC", value: summary.cacCents == null ? "—" : formatMoney(summary.cacCents), hint: "Spend / customers" },
    { label: "CPL", value: summary.cplCents == null ? "—" : formatMoney(summary.cplCents), hint: "Spend / leads" },
  ] : [];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      {/* Header */}
      <div className="border-b border-line bg-white px-5 pb-0 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="aos-heading">Revenue attribution</h1>
          </div>
          <div className="flex items-center gap-2 pb-3">
            <select
              className={inputCls}
              value={range}
              onChange={(e) => setRange(e.target.value)}
              aria-label="Date range"
            >
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <select
              className={`${inputCls} max-w-[180px]`}
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              aria-label="Pipeline"
            >
              <option value="">All pipelines</option>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        {/* Model tabs */}
        <div className="mt-3 flex gap-1">
          {MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              title={m.hint}
              className={`flex items-center gap-1.5 rounded-t-[8px] border-b-2 px-3.5 py-2 text-[0.8125rem] font-medium transition-colors ${
                model === m.id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <m.icon size={15} />
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {loading && !summary ? (
          <p className="py-12 text-center text-sm text-muted">Loading attribution…</p>
        ) : (
          <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              {kpis.map((k) => (
                <div key={k.label} className={cardCls}>
                  <div className="text-[0.6875rem] font-semibold text-muted">{k.label}</div>
                  <div className="mt-1 text-[1.375rem] font-semibold tabular-nums tracking-tight text-ink">{k.value}</div>
                  <div className="mt-0.5 text-[0.71875rem] text-subtle">{k.hint}</div>
                </div>
              ))}
            </div>

            {summary && summary.unattributedRevenueCents > 0 && (
              <div className="flex items-start gap-2.5 rounded-lg bg-needs px-4 py-3 text-ink">
                <span
                  className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:14px]"
                  style={{ color: "inherit" }}
                  aria-hidden
                />
                <p className="text-[0.8125rem]">
                  <span className="font-semibold">{formatMoney(summary.unattributedRevenueCents)}</span> of won revenue
                  has no marketing touches — those leads were created without UTM data. Add UTMs to capture forms to close the gap.
                </p>
              </div>
            )}

            {/* Measurement bundles (P2) */}
            <BundlesSection />

            {/* Channel performance */}
            <section className={cardCls}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[0.875rem] font-semibold text-ink">
                  <ChartLine size={16} className="text-ink" /> Channel performance
                </h2>
                <span className="text-[0.71875rem] text-subtle">Revenue columns follow the {MODELS.find((m) => m.id === model)!.label.toLowerCase()} model</span>
              </div>
              {channels.length === 0 ? (
                <EmptyState icon={ChartLine} title="No touches yet" hint="Capture leads with UTMs (or import a CSV with utm_* columns) and move them to Won to see channel ROAS." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[0.8125rem]">
                    <thead><tr className="border-b border-line">
                      <th className={thCls}>Channel</th>
                      <th className={thNum}>Spend</th>
                      <th className={thNum}>Leads</th>
                      <th className={thNum}>CPL</th>
                      <th className={thNum}>Customers</th>
                      <th className={thNum}>CAC</th>
                      <th className={thNum}>Revenue</th>
                      <th className={thNum}>ROAS</th>
                    </tr></thead>
                    <tbody>
                      {channels.map((c) => {
                        const m = c.perModel[model];
                        return (
                          <tr key={c.channel} className="border-b border-line last:border-0">
                            <td className="px-3 py-2.5 text-[0.8125rem] font-medium text-ink">
                              {channelLabel(c.channel)}
                              {c.engagement ? (
                                <div className="text-[0.71875rem] font-normal text-subtle">
                                  {c.engagement.impressions.toLocaleString("en-US")} impressions · {c.engagement.clicks.toLocaleString("en-US")} clicks
                                </div>
                              ) : null}
                            </td>
                            <td className={tdNum}>{formatMoney(c.spendCents)}</td>
                            <td className={tdNum}>{c.leads}</td>
                            <td className={tdNum}>{c.cplCents == null ? "—" : formatMoney(c.cplCents)}</td>
                            <td className={tdNum}>{fmtNum(m.customers, m.customers % 1 ? 2 : 0)}</td>
                            <td className={tdNum}>{m.cacCents == null ? "—" : formatMoney(m.cacCents)}</td>
                            <td className={`${tdNum} font-semibold text-ink`}>{formatMoney(m.revenueCents)}</td>
                            <td className={tdNum}>{fmtRoas(m.roas)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Social posts (Phase 4b): engagement joined to UTM-tagged leads */}
            <section className={cardCls}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-[0.875rem] font-semibold text-ink">
                  <Share2 size={16} className="text-ink" /> Social posts
                </h2>
                <span className="text-[0.71875rem] text-subtle">
                  {social?.mock ? "Includes sample engagement (no Postiz credentials) · " : ""}Leads come from the posts&apos; UTM-tagged links
                </span>
              </div>
              {!social || social.posts.length === 0 ? (
                <EmptyState icon={Share2} title="No social engagement yet" hint="Publish a post from Social. Engagement syncs back hourly, and leads from its links land here." />
              ) : (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[
                      { label: "Impressions", value: social.engagement.impressions.toLocaleString("en-US") },
                      { label: "Engagements", value: social.engagement.engagements.toLocaleString("en-US") },
                      { label: "Link clicks", value: social.engagement.clicks.toLocaleString("en-US") },
                      { label: "Social leads", value: String(social.channelLeads) },
                      { label: "Social revenue", value: formatMoney(social.channelRevenueCents) },
                    ].map((k) => (
                      <div key={k.label} className="rounded-md bg-canvas px-3 py-2">
                        <div className="text-[0.6875rem] font-semibold text-muted">{k.label}</div>
                        <div className="text-[1.125rem] font-semibold tabular-nums text-ink">{k.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[0.8125rem]">
                      <thead><tr className="border-b border-line">
                        <th className={thCls}>Post</th>
                        <th className={thCls}>Campaign</th>
                        <th className={thNum}>Impressions</th>
                        <th className={thNum}>Engagements</th>
                        <th className={thNum}>Clicks</th>
                        <th className={thNum}>Leads</th>
                        <th className={thNum}>Click → lead</th>
                        <th className={thNum}>Revenue</th>
                      </tr></thead>
                      <tbody>
                        {social.posts.slice(0, 25).map((p) => (
                          <tr key={p.id} className="border-b border-line last:border-0">
                            <td className="max-w-[320px] px-3 py-2.5 text-[0.8125rem] text-ink">
                              <a href={`/dashboard/social?post=${encodeURIComponent(p.id)}`} className="block truncate font-medium hover:underline">{p.title}</a>
                              <div className="text-[0.71875rem] text-subtle">{p.platforms.join(", ")}{p.mock ? " · sample" : ""}</div>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[0.75rem] text-muted">{p.campaign}</td>
                            <td className={tdNum}>{p.impressions.toLocaleString("en-US")}</td>
                            <td className={tdNum}>{p.engagements.toLocaleString("en-US")}</td>
                            <td className={tdNum}>{p.clicks.toLocaleString("en-US")}</td>
                            <td className={tdNum}>{p.leads}</td>
                            <td className={tdNum}>{p.clickToLead == null ? "—" : `${(p.clickToLead * 100).toFixed(1)}%`}</td>
                            <td className={`${tdNum} font-semibold text-ink`}>{formatMoney(p.revenueCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            {/* Campaigns */}
            <section className={cardCls}>
              <h2 className="mb-3 flex items-center gap-2 text-[0.875rem] font-semibold text-ink">
                <Megaphone size={16} className="text-ink" /> Campaigns
              </h2>
              {campaigns.length === 0 ? (
                <EmptyState icon={Megaphone} title="No campaigns yet" hint="utm_campaign values (or capture-form names) appear here once leads carry them." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[0.8125rem]">
                    <thead><tr className="border-b border-line">
                      <th className={thCls}>Campaign</th>
                      <th className={thCls}>Channel</th>
                      <th className={thNum}>Spend</th>
                      <th className={thNum}>Leads</th>
                      <th className={thNum}>Customers</th>
                      <th className={thNum}>Revenue</th>
                      <th className={thNum}>ROAS</th>
                    </tr></thead>
                    <tbody>
                      {campaigns.slice(0, 25).map((c) => {
                        const m = c.perModel[model];
                        return (
                          <tr key={`${c.channel}::${c.campaign}`} className="border-b border-line last:border-0">
                            <td className="px-3 py-2.5 text-[0.8125rem] font-medium text-ink">{c.campaign ?? "—"}</td>
                            <td className="px-3 py-2.5 text-[0.8125rem] text-muted">{channelLabel(c.channel)}</td>
                            <td className={tdNum}>{formatMoney(c.spendCents)}</td>
                            <td className={tdNum}>{c.leads}</td>
                            <td className={tdNum}>{fmtNum(m.customers, m.customers % 1 ? 2 : 0)}</td>
                            <td className={`${tdNum} font-semibold text-ink`}>{formatMoney(m.revenueCents)}</td>
                            <td className={tdNum}>{fmtRoas(m.roas)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Revenue-influenced content */}
            <section className={cardCls}>
              <h2 className="mb-3 flex items-center gap-2 text-[0.875rem] font-semibold text-ink">
                <LinkIcon size={16} className="text-ink" /> Revenue-influenced content
              </h2>
              {content.length === 0 ? (
                <EmptyState icon={LinkIcon} title="No content touches yet" hint="Pass a contentId (a ShapesOS page) with a touch to see which pages influence revenue." />
              ) : (
                <div className="flex flex-col divide-y divide-line">
                  {content.slice(0, 20).map((c) => (
                    <div key={c.contentId} className="flex items-center justify-between gap-4 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-[0.8125rem] font-medium text-ink">
                          {c.keywordPhrase ?? c.publishedUrl ?? c.contentId}
                        </div>
                        <div className="truncate text-[0.71875rem] text-subtle">
                          {c.publishedUrl ?? c.contentId} · {c.touches} touches · {c.leads} leads
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[0.875rem] font-semibold tabular-nums text-ink">{formatMoney(c.revenueCents)}</div>
                        <div className="text-[0.71875rem] tabular-nums text-subtle">{fmtNum(c.customers, c.customers % 1 ? 2 : 0)} customers</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Spend manager */}
            <section className={cardCls}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[0.875rem] font-semibold text-ink">
                  <DollarSign size={16} className="text-ink" /> Spend entries
                </h2>
                <button className={btnPrimary} onClick={() => setShowSpendForm((v) => !v)}>
                  {showSpendForm ? <X size={14} /> : <Plus size={14} />} {showSpendForm ? "Cancel" : "Add spend"}
                </button>
              </div>
              <p className="mb-3 text-[0.75rem] text-muted">
                Ad platform APIs aren&apos;t connected yet, so spend is entered manually. Organic and physical channels work with $0 spend — CPL/CAC/ROAS simply report as “—”.
              </p>
              {showSpendForm && (
                <div className="mb-4 grid grid-cols-2 gap-3 rounded-[8px] border border-line bg-canvas p-4 md:grid-cols-3">
                  <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-muted">
                    Channel
                    <input className={inputCls} value={spendDraft.channel} onChange={(e) => setSpendDraft({ ...spendDraft, channel: e.target.value })} placeholder="paid_search" />
                  </label>
                  <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-muted">
                    Campaign <span className="font-normal text-subtle">(optional)</span>
                    <input className={inputCls} value={spendDraft.campaign} onChange={(e) => setSpendDraft({ ...spendDraft, campaign: e.target.value })} placeholder="Q3 brand push" />
                  </label>
                  <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-muted">
                    Amount (USD)
                    <input className={inputCls} inputMode="decimal" value={spendDraft.amount} onChange={(e) => setSpendDraft({ ...spendDraft, amount: e.target.value })} placeholder="1250.00" />
                  </label>
                  <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-muted">
                    Period start
                    <input className={inputCls} type="date" value={spendDraft.periodStart} onChange={(e) => setSpendDraft({ ...spendDraft, periodStart: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-muted">
                    Period end
                    <input className={inputCls} type="date" value={spendDraft.periodEnd} onChange={(e) => setSpendDraft({ ...spendDraft, periodEnd: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-muted">
                    Notes <span className="font-normal text-subtle">(optional)</span>
                    <input className={inputCls} value={spendDraft.notes} onChange={(e) => setSpendDraft({ ...spendDraft, notes: e.target.value })} placeholder="Google Ads invoice #…" />
                  </label>
                  <div className="col-span-2 flex items-center gap-3 md:col-span-3">
                    <button className={btnPrimary} onClick={saveSpend} disabled={spendSaving}>
                      {spendSaving ? "Saving…" : "Save spend entry"}
                    </button>
                    {spendError && <span className="text-[0.78125rem] text-failed-text">{spendError}</span>}
                  </div>
                </div>
              )}
              {spend.length === 0 ? (
                <EmptyState icon={Calendar} title="No spend entries" hint="Add spend per channel and period to unlock CPL, CAC, and ROAS." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[0.8125rem]">
                    <thead><tr className="border-b border-line">
                      <th className={thCls}>Channel</th>
                      <th className={thCls}>Campaign</th>
                      <th className={thNum}>Amount</th>
                      <th className={thCls}>Period</th>
                      <th className={thCls}>Notes</th>
                      <th className={thCls}><span className="sr-only">Actions</span></th>
                    </tr></thead>
                    <tbody>
                      {spend.map((s) => (
                        <tr key={s.id} className="border-b border-line last:border-0">
                          <td className="px-3 py-2.5 text-[0.8125rem] font-medium text-ink">{channelLabel(s.channel)}</td>
                          <td className="px-3 py-2.5 text-[0.8125rem] text-muted">{s.campaign ?? "—"}</td>
                          <td className={`${tdNum} font-semibold text-ink`}>{formatMoney(s.amountCents)}</td>
                          <td className="px-3 py-2.5 text-[0.78125rem] text-muted">
                            {new Date(s.periodStart).toLocaleDateString()} → {new Date(s.periodEnd).toLocaleDateString()}
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2.5 text-[0.78125rem] text-muted">{s.notes ?? "—"}</td>
                          <td className="px-3 py-2.5 text-right">
                            <button
                              className={btnDeny}
                              onClick={() => deleteSpend(s.id)}
                              aria-label="Delete spend entry"
                            >
                              <Trash size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
