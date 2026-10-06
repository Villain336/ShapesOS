// Marketr — Phase 18 slice 5: register a campaign launched in Spotify Ads Manager.

"use client";

import { useState } from "react";
import { CircleCheck, Megaphone, Loader2 } from "lucide-react";

export interface GuidedAccountOption {
  id: string;
  name: string | null;
  externalAccountId: string;
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";

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
      <p className="rounded-lg bg-paper px-3 py-2 text-sm text-muted shadow-hairline">
        Link an ad account above first — campaigns need an account to live under.
      </p>
    );
  }

  if (ok) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2 text-sm text-ink shadow-hairline">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Campaign registered — it appears on the Campaigns tab and imported spend can attach to it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-3 shadow-hairline">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Ad account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.externalAccountId} ({a.externalAccountId})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Campaign name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 Audio Test" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Spotify campaign ID
          <input
            value={externalCampaignId}
            onChange={(e) => setExternalCampaignId(e.target.value)}
            placeholder="From Spotify Ads Manager"
            autoComplete="off"
            className={`${inputCls} font-mono`}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Status (as in Ads Manager)
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              <option value="live">Live</option>
              <option value="paused">Paused</option>
              <option value="ended">Ended</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Budget (USD, optional)
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="250.00"
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
          className={btnPrimarySm}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Megaphone className="h-3.5 w-3.5" />}
          {busy ? "Registering…" : "Register campaign"}
        </button>
        {error && <span className="text-xs text-failed-text">{error}</span>}
      </div>
    </div>
  );
}
