// Marketr — Wave 2 ChatGPT Ads slice 2: campaign proposal form (client).

"use client";

import { useState } from "react";
import { Loader2, Plus, Send, Trash2, ExternalLink } from "lucide-react";

export interface StackAdaptAccountOption {
  id: string;
  name: string | null;
  externalAccountId: string;
}

interface CreativeDraft {
  headline: string;
  body: string;
  ctaLabel: string;
  locale: string;
  source: "human" | "ai_generated";
  aiProviderUsed: string;
  aiModelUsed: string;
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
const labelCls = "block text-[12px] font-medium text-stone-600";

function emptyCreative(): CreativeDraft {
  return { headline: "", body: "", ctaLabel: "", locale: "en-US", source: "human", aiProviderUsed: "", aiModelUsed: "" };
}

export default function ProposeCampaignForm({ accounts }: { accounts: StackAdaptAccountOption[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [tierFree, setTierFree] = useState(true);
  const [tierGo, setTierGo] = useState(false);
  const [tags, setTags] = useState("");
  const [dailyBudget, setDailyBudget] = useState("");
  const [totalBudget, setTotalBudget] = useState("");
  const [bidStrategy, setBidStrategy] = useState("cpc");
  const [creatives, setCreatives] = useState<CreativeDraft[]>([emptyCreative()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ proposalId: string; adsManagerLink: string } | null>(null);

  function updateCreative(i: number, patch: Partial<CreativeDraft>) {
    setCreatives((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
      const res = await fetch("/api/ads/chatgpt/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          name,
          objective: objective || undefined,
          targetTiers: [...(tierFree ? ["free"] : []), ...(tierGo ? ["go"] : [])],
          topicIntentTags: tags,
          budgetDailyCents: toCents(dailyBudget),
          budgetTotalCents: toCents(totalBudget),
          bidStrategy,
          creatives: creatives.map((c) => ({
            headline: c.headline,
            body: c.body,
            ctaLabel: c.ctaLabel || undefined,
            locale: c.locale,
            source: c.source,
            aiProviderUsed: c.aiProviderUsed || undefined,
            aiModelUsed: c.aiModelUsed || undefined,
          })),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; proposalId?: string; adsManagerLink?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not propose the campaign");
        return;
      }
      setDone({ proposalId: data.proposalId ?? "", adsManagerLink: data.adsManagerLink ?? "" });
    } catch {
      setError("Could not propose the campaign");
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-500">
        Connect a StackAdapt ad account first — ChatGPT campaigns buy through the StackAdapt rail.
      </p>
    );
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-[13px] text-emerald-800">
        <p className="font-medium">Campaign proposed — nothing spends until you approve it.</p>
        <p className="mt-1">
          Review it in the{" "}
          <a href="/dashboard/media/advertising/proposals" className="underline">
            proposal inbox
          </a>
          . You can also open it in{" "}
          <a href={done.adsManagerLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
            Ads Manager <ExternalLink className="h-3 w-3" />
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className={labelCls}>Campaign name</label>
          <input className={`${inputCls} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Fall launch" />
        </div>
        <div>
          <label className={labelCls}>StackAdapt account</label>
          <select className={`${inputCls} mt-1 w-full`} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name ?? a.externalAccountId}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className={labelCls}>Objective</label>
          <input className={`${inputCls} mt-1 w-full`} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Drive demo bookings from high-intent ChatGPT users" />
        </div>
        <div>
          <label className={labelCls}>Target tiers</label>
          <div className="mt-1 flex gap-3 text-[13px] text-stone-700">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={tierFree} onChange={(e) => setTierFree(e.target.checked)} /> Free
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={tierGo} onChange={(e) => setTierGo(e.target.checked)} /> Go
            </label>
          </div>
        </div>
        <div>
          <label className={labelCls}>Bid strategy</label>
          <select className={`${inputCls} mt-1 w-full`} value={bidStrategy} onChange={(e) => setBidStrategy(e.target.value)}>
            <option value="cpc">CPC</option>
            <option value="cpm">CPM</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Topic intent tags (comma-separated)</label>
          <input className={`${inputCls} mt-1 w-full`} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="crm software, sales automation" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Daily budget ($)</label>
            <input className={`${inputCls} mt-1 w-full`} value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} placeholder="50" inputMode="decimal" />
          </div>
          <div>
            <label className={labelCls}>Total budget ($)</label>
            <input className={`${inputCls} mt-1 w-full`} value={totalBudget} onChange={(e) => setTotalBudget(e.target.value)} placeholder="1500" inputMode="decimal" />
          </div>
        </div>
      </div>

      <div className="mt-1">
        <div className="flex items-center justify-between">
          <span className={labelCls}>Creative variants</span>
          <button type="button" className={btnGhost} onClick={() => setCreatives((cs) => [...cs, emptyCreative()])}>
            <Plus className="h-3.5 w-3.5" /> Add variant
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {creatives.map((c, i) => (
            <div key={i} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <input className={inputCls} value={c.headline} onChange={(e) => updateCreative(i, { headline: e.target.value })} placeholder="Headline" />
                <input className={inputCls} value={c.ctaLabel} onChange={(e) => updateCreative(i, { ctaLabel: e.target.value })} placeholder="CTA label (optional)" />
                <textarea className={`${inputCls} md:col-span-2`} rows={2} value={c.body} onChange={(e) => updateCreative(i, { body: e.target.value })} placeholder="Body copy" />
                <select className={inputCls} value={c.source} onChange={(e) => updateCreative(i, { source: e.target.value as CreativeDraft["source"] })}>
                  <option value="human">Human-written</option>
                  <option value="ai_generated">AI-generated</option>
                </select>
                <input className={inputCls} value={c.locale} onChange={(e) => updateCreative(i, { locale: e.target.value })} placeholder="Locale (en-US)" />
                {c.source === "ai_generated" && (
                  <>
                    <input className={inputCls} value={c.aiProviderUsed} onChange={(e) => updateCreative(i, { aiProviderUsed: e.target.value })} placeholder="AI provider (required)" />
                    <input className={inputCls} value={c.aiModelUsed} onChange={(e) => updateCreative(i, { aiModelUsed: e.target.value })} placeholder="AI model" />
                  </>
                )}
              </div>
              <div className="mt-2 flex justify-end">
                <button type="button" className={btnGhost} disabled={creatives.length === 1} onClick={() => setCreatives((cs) => cs.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <button type="button" className={btnPrimary} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Propose campaign
        </button>
        <p className="text-[12px] text-stone-500">Proposing never spends — a human approves every dollar in the proposal inbox.</p>
      </div>
    </div>
  );
}
