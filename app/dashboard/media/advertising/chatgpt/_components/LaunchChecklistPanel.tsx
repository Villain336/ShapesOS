// Marketr — Wave 2 ChatGPT Ads slice 3: launch checklist panel (client).
//
// For an approved campaign: a human confirms tiers, geo (US only at beta),
// and re-enters the daily cap before launch. Launch needs a fresh (<24h)
// approval — the server enforces it.

"use client";

import { useState } from "react";
import { CircleCheck, Loader2, Rocket } from "lucide-react";

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control items-center gap-1.5 rounded-full bg-ink px-[22px] text-base font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const noteCls =
  "flex items-start gap-2 rounded-lg bg-paper px-3 py-2 text-sm shadow-hairline";

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
      <p className={`${noteCls} text-ink`}>
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Campaign launched on StackAdapt — conversational inventory is live.
      </p>
    );
  }

  if (!proposalId) {
    return (
      <p className={`${noteCls} text-muted`}>
        No approved launch proposal found — approve the campaign in the proposal inbox first.
      </p>
    );
  }

  const capDollars = dailyCapCents != null ? (dailyCapCents / 100).toFixed(2) : null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-ink">Launch checklist — confirm before going live</p>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={tiersConfirmed} onChange={(e) => setTiersConfirmed(e.target.checked)} />
        Tier targeting confirmed: {targetTiers.length ? targetTiers.join(", ") : "—"}
      </label>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={geoConfirmed} onChange={(e) => setGeoConfirmed(e.target.checked)} />
        Geo confirmed: United States only (ChatGPT ads beta inventory)
      </label>
      <div className="flex items-center gap-2">
        <label className="text-sm text-ink">
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
        <p className="rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">{error}</p>
      )}
      <div>
        <button type="button" className={btnPrimary} disabled={busy} onClick={launch}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
          Launch campaign
        </button>
      </div>
      <p className="text-xs text-subtle">
        Launch spends real money through your StackAdapt account. It needs the approval from the last 24
        hours — older approvals must be re-approved.
      </p>
    </div>
  );
}
