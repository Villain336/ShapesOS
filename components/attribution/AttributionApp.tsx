// Marketr — Revenue attribution dashboard (C2).
// Light mode, CRM density: model tabs, KPI cards, channel/campaign/content
// tables, manual spend entry. Read-only analytics on the Lead model.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChartLineUp,
  CurrencyDollar,
  Plus,
  Trash,
  X,
  CalendarBlank,
  Link as LinkIcon,
  Megaphone,
} from "@phosphor-icons/react";
import { formatMoney } from "../crm/types";
import { EmptyState } from "../crm/ui";
import { BundlesSection } from "./BundlesSection";

type Model = "first_touch" | "last_touch" | "linear";

const MODELS: { id: Model; label: string; hint: string }[] = [
  { id: "first_touch", label: "First touch", hint: "100% of revenue to the first touch" },
  { id: "last_touch", label: "Last touch", hint: "100% of revenue to the last touch" },
  { id: "linear", label: "Linear", hint: "Revenue split evenly across all touches" },
];

const RANGES = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "12m", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

interface ModelNums { customers: number; cacCents: number | null; revenueCents: number; roas: number | null }
interface ChannelRow {
  channel: string; leads: number; spendCents: number; cplCents: number | null;
  perModel: Record<Model, ModelNums>;
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

const cardCls = "rounded-[10px] border border-stone-200 bg-white p-4";
const thCls = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500";
const tdCls = "px-3 py-2.5 text-[13px] text-stone-700 tabular-nums";
const tdNum = "px-3 py-2.5 text-[13px] text-stone-700 tabular-nums text-right";
const thNum = "px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-stone-500";

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
      const [s, ch, cp, ct, sp] = await Promise.all([
        fetch(`/api/attribution/summary?model=${model}&${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/channels?${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/campaigns?${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/content?model=${model}&${qs}`).then((r) => r.json()),
        fetch(`/api/attribution/spend`).then((r) => r.json()),
      ]);
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
    if (!confirm("Delete this spend entry?")) return;
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
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-stone-200 bg-white px-5 pb-0 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium text-stone-500">Marketr · Analytics</div>
            <h1 className="text-[20px] font-semibold tracking-tight text-stone-900">Revenue Attribution</h1>
          </div>
          <div className="flex items-center gap-2 pb-3">
            <select
              className="crm-select !py-[6px] !text-[12.5px]"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              aria-label="Date range"
            >
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <select
              className="crm-select !py-[6px] !text-[12.5px] max-w-[180px]"
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
              className={`rounded-t-[8px] border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors ${
                model === m.id
                  ? "border-violet-600 text-violet-700"
                  : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {loading && !summary ? (
          <p className="py-12 text-center text-sm text-stone-500">Loading attribution…</p>
        ) : (
          <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              {kpis.map((k) => (
                <div key={k.label} className={cardCls}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{k.label}</div>
                  <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight text-stone-900">{k.value}</div>
                  <div className="mt-0.5 text-[11.5px] text-stone-400">{k.hint}</div>
                </div>
              ))}
            </div>

            {summary && summary.unattributedRevenueCents > 0 && (
              <div className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
                <span className="font-semibold">{formatMoney(summary.unattributedRevenueCents)}</span> of won revenue
                has no marketing touches — those leads were created without UTM data. Add UTMs to capture forms to close the gap.
              </div>
            )}

            {/* Measurement bundles (P2) */}
            <BundlesSection />

            {/* Channel performance */}
            <section className={cardCls}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
                  <ChartLineUp size={16} className="text-violet-600" /> Channel performance
                </h2>
                <span className="text-[11.5px] text-stone-400">Revenue columns follow the {MODELS.find((m) => m.id === model)!.label.toLowerCase()} model</span>
              </div>
              {channels.length === 0 ? (
                <EmptyState icon={ChartLineUp} title="No touches yet" hint="Capture leads with UTMs (or import a CSV with utm_* columns) and move them to Won to see channel ROAS." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="crm-table w-full">
                    <thead><tr className="border-b border-stone-200">
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
                          <tr key={c.channel} className="border-b border-stone-100 last:border-0">
                            <td className="px-3 py-2.5 text-[13px] font-medium text-stone-900">{channelLabel(c.channel)}</td>
                            <td className={tdNum}>{formatMoney(c.spendCents)}</td>
                            <td className={tdNum}>{c.leads}</td>
                            <td className={tdNum}>{c.cplCents == null ? "—" : formatMoney(c.cplCents)}</td>
                            <td className={tdNum}>{fmtNum(m.customers, m.customers % 1 ? 2 : 0)}</td>
                            <td className={tdNum}>{m.cacCents == null ? "—" : formatMoney(m.cacCents)}</td>
                            <td className={`${tdNum} font-semibold text-stone-900`}>{formatMoney(m.revenueCents)}</td>
                            <td className={tdNum}>{fmtRoas(m.roas)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Campaigns */}
            <section className={cardCls}>
              <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-stone-900">
                <Megaphone size={16} className="text-violet-600" /> Campaigns
              </h2>
              {campaigns.length === 0 ? (
                <EmptyState icon={Megaphone} title="No campaigns yet" hint="utm_campaign values (or capture-form names) appear here once leads carry them." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="crm-table w-full">
                    <thead><tr className="border-b border-stone-200">
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
                          <tr key={`${c.channel}::${c.campaign}`} className="border-b border-stone-100 last:border-0">
                            <td className="px-3 py-2.5 text-[13px] font-medium text-stone-900">{c.campaign ?? "—"}</td>
                            <td className="px-3 py-2.5 text-[13px] text-stone-500">{channelLabel(c.channel)}</td>
                            <td className={tdNum}>{formatMoney(c.spendCents)}</td>
                            <td className={tdNum}>{c.leads}</td>
                            <td className={tdNum}>{fmtNum(m.customers, m.customers % 1 ? 2 : 0)}</td>
                            <td className={`${tdNum} font-semibold text-stone-900`}>{formatMoney(m.revenueCents)}</td>
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
              <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-stone-900">
                <LinkIcon size={16} className="text-violet-600" /> Revenue-influenced content
              </h2>
              {content.length === 0 ? (
                <EmptyState icon={LinkIcon} title="No content touches yet" hint="Pass a contentId (a Marketr page) with a touch to see which pages influence revenue." />
              ) : (
                <div className="flex flex-col divide-y divide-stone-100">
                  {content.slice(0, 20).map((c) => (
                    <div key={c.contentId} className="flex items-center justify-between gap-4 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-stone-900">
                          {c.keywordPhrase ?? c.publishedUrl ?? c.contentId}
                        </div>
                        <div className="truncate text-[11.5px] text-stone-400">
                          {c.publishedUrl ?? c.contentId} · {c.touches} touches · {c.leads} leads
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[14px] font-semibold tabular-nums text-stone-900">{formatMoney(c.revenueCents)}</div>
                        <div className="text-[11.5px] tabular-nums text-stone-400">{fmtNum(c.customers, c.customers % 1 ? 2 : 0)} customers</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Spend manager */}
            <section className={cardCls}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
                  <CurrencyDollar size={16} className="text-violet-600" /> Spend entries
                </h2>
                <button className="crm-btn-primary !py-[6px] !text-[12.5px]" onClick={() => setShowSpendForm((v) => !v)}>
                  {showSpendForm ? <X size={14} /> : <Plus size={14} />} {showSpendForm ? "Cancel" : "Add spend"}
                </button>
              </div>
              <p className="mb-3 text-[12px] text-stone-500">
                Ad platform APIs aren&apos;t connected yet, so spend is entered manually. Organic and physical channels work with $0 spend — CPL/CAC/ROAS simply report as “—”.
              </p>
              {showSpendForm && (
                <div className="mb-4 grid grid-cols-2 gap-3 rounded-[8px] border border-stone-200 bg-stone-50 p-4 md:grid-cols-3">
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                    Channel
                    <input className="crm-input" value={spendDraft.channel} onChange={(e) => setSpendDraft({ ...spendDraft, channel: e.target.value })} placeholder="paid_search" />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                    Campaign <span className="font-normal text-stone-400">(optional)</span>
                    <input className="crm-input" value={spendDraft.campaign} onChange={(e) => setSpendDraft({ ...spendDraft, campaign: e.target.value })} placeholder="Q3 brand push" />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                    Amount (USD)
                    <input className="crm-input" inputMode="decimal" value={spendDraft.amount} onChange={(e) => setSpendDraft({ ...spendDraft, amount: e.target.value })} placeholder="1250.00" />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                    Period start
                    <input className="crm-input" type="date" value={spendDraft.periodStart} onChange={(e) => setSpendDraft({ ...spendDraft, periodStart: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                    Period end
                    <input className="crm-input" type="date" value={spendDraft.periodEnd} onChange={(e) => setSpendDraft({ ...spendDraft, periodEnd: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                    Notes <span className="font-normal text-stone-400">(optional)</span>
                    <input className="crm-input" value={spendDraft.notes} onChange={(e) => setSpendDraft({ ...spendDraft, notes: e.target.value })} placeholder="Google Ads invoice #…" />
                  </label>
                  <div className="col-span-2 flex items-center gap-3 md:col-span-3">
                    <button className="crm-btn-primary" onClick={saveSpend} disabled={spendSaving}>
                      {spendSaving ? "Saving…" : "Save spend entry"}
                    </button>
                    {spendError && <span className="text-[12.5px] text-red-600">{spendError}</span>}
                  </div>
                </div>
              )}
              {spend.length === 0 ? (
                <EmptyState icon={CalendarBlank} title="No spend entries" hint="Add spend per channel and period to unlock CPL, CAC, and ROAS." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="crm-table w-full">
                    <thead><tr className="border-b border-stone-200">
                      <th className={thCls}>Channel</th>
                      <th className={thCls}>Campaign</th>
                      <th className={thNum}>Amount</th>
                      <th className={thCls}>Period</th>
                      <th className={thCls}>Notes</th>
                      <th className={thCls}><span className="sr-only">Actions</span></th>
                    </tr></thead>
                    <tbody>
                      {spend.map((s) => (
                        <tr key={s.id} className="border-b border-stone-100 last:border-0">
                          <td className="px-3 py-2.5 text-[13px] font-medium text-stone-900">{channelLabel(s.channel)}</td>
                          <td className="px-3 py-2.5 text-[13px] text-stone-500">{s.campaign ?? "—"}</td>
                          <td className={`${tdNum} font-semibold text-stone-900`}>{formatMoney(s.amountCents)}</td>
                          <td className="px-3 py-2.5 text-[12.5px] text-stone-500">
                            {new Date(s.periodStart).toLocaleDateString()} → {new Date(s.periodEnd).toLocaleDateString()}
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2.5 text-[12.5px] text-stone-500">{s.notes ?? "—"}</td>
                          <td className="px-3 py-2.5 text-right">
                            <button
                              className="crm-btn-ghost !px-2 !py-1 text-stone-400 hover:text-red-600"
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
