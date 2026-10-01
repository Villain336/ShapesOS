// Marketr — Wave 2 ChatGPT Ads slice 3: launch checklist panel (client).
//
// For an approved campaign: a human confirms tiers, geo (US only at beta),
// and re-enters the daily cap before launch. Launch needs a fresh (<24h)
// approval — the server enforces it.

"use client";

import { useState } from "react";
import { Loader2, Rocket } from "lucide-react";

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";

export default function LaunchChecklistPanel({
  campaignId,
  proposalId,
  targetTiers,
  dailyCapCents,
}: {
  campaignId: string;
  proposalId: string | null;
  targetTiers: string[];
  dailyCapCents: number | null;
}) {
  const [tiersConfirmed, setTiersConfirmed] = useState(false);
  const [geoConfirmed, setGeoConfirmed] = useState(false);
  const [capEntry, setCapEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ads/chatgpt/campaigns/${campaignId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          tiersConfirmed,
          geoConfirmed,
          dailyCapCents: Math.round(Number(capEntry) * 100),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not launch the campaign");
        return;
      }
      setLaunched(true);
    } catch {
      setError("Could not launch the campaign");
    } finally {
      setBusy(false);
    }
  }

  if (launched) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
        Campaign launched on StackAdapt — conversational inventory is live.
      </p>
    );
  }

  if (!proposalId) {
    return (
      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-500">
        No approved launch proposal found — approve the campaign in the proposal inbox first.
      </p>
    );
  }

  const capDollars = dailyCapCents != null ? (dailyCapCents / 100).toFixed(2) : null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-medium text-stone-800">Launch checklist — confirm before going live</p>
      <label className="flex items-center gap-2 text-[13px] text-stone-700">
        <input type="checkbox" checked={tiersConfirmed} onChange={(e) => setTiersConfirmed(e.target.checked)} />
        Tier targeting confirmed: {targetTiers.length ? targetTiers.join(", ") : "—"}
      </label>
      <label className="flex items-center gap-2 text-[13px] text-stone-700">
        <input type="checkbox" checked={geoConfirmed} onChange={(e) => setGeoConfirmed(e.target.checked)} />
        Geo confirmed: United States only (ChatGPT ads beta inventory)
      </label>
      <div className="flex items-center gap-2">
        <label className="text-[13px] text-stone-700">
          Re-enter the daily cap ${capDollars ?? "—"} to confirm:
        </label>
        <input
          className={`${inputCls} w-28`}
          value={capEntry}
          onChange={(e) => setCapEntry(e.target.value)}
          placeholder={capDollars ?? ""}
          inputMode="decimal"
        />
      </div>
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}
      <div>
        <button type="button" className={btnPrimary} disabled={busy} onClick={launch}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
          Launch campaign
        </button>
      </div>
      <p className="text-[12px] text-stone-500">
        Launch spends real money through your StackAdapt account. It needs the approval from the last 24
        hours — older approvals must be re-approved.
      </p>
    </div>
  );
}
