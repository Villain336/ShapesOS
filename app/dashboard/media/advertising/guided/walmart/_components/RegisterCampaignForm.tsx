// Marketr — Phase 18 slice 4: register a campaign launched in Walmart Ad Center.

"use client";

import { useState } from "react";
import { Megaphone, Loader2 } from "lucide-react";

export interface GuidedAccountOption {
  id: string;
  name: string | null;
  externalAccountId: string;
}

export default function RegisterCampaignForm({ accounts }: { accounts: GuidedAccountOption[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [name, setName] = useState("");
  const [externalCampaignId, setExternalCampaignId] = useState("");
  const [status, setStatus] = useState("live");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const budgetCents = budget.trim() === "" ? null : Math.round(Number(budget) * 100);
      const res = await fetch("/api/ads/guided/campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, name, externalCampaignId, status, budgetCents }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not register the campaign");
        return;
      }
      setOk(true);
      setName("");
      setExternalCampaignId("");
      setBudget("");
    } catch {
      setError("Could not register the campaign");
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-500">
        Link an advertiser account above first — campaigns need an account to live under.
      </p>
    );
  }

  if (ok) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
        Campaign registered — it appears on the Campaigns tab and imported spend can attach to it.
      </p>
    );
  }

  const inputCls =
    "rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Advertiser account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.externalAccountId} ({a.externalAccountId})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Campaign name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 Sponsored Products" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Walmart campaign ID
          <input
            value={externalCampaignId}
            onChange={(e) => setExternalCampaignId(e.target.value)}
            placeholder="From Walmart Ad Center"
            autoComplete="off"
            className={`${inputCls} font-mono`}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-stone-600">
            Status (as in Ad Center)
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              <option value="live">Live</option>
              <option value="paused">Paused</option>
              <option value="ended">Ended</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-stone-600">
            Budget (USD, optional)
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="500.00"
              inputMode="decimal"
              className={inputCls}
            />
          </label>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !accountId || !name.trim() || !externalCampaignId.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Megaphone className="h-3.5 w-3.5" />}
          {busy ? "Registering…" : "Register campaign"}
        </button>
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </div>
  );
}
