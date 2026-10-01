// Marketr — Phase 18 slice 5: link a Spotify ad account (manual ID).

"use client";

import { useState } from "react";
import { Link2, Loader2 } from "lucide-react";

export default function LinkAdvertiserForm() {
  const [name, setName] = useState("");
  const [adAccountId, setAdAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ads/guided/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platformKey: "spotify", name: name.trim() || undefined, externalAccountId: adAccountId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not link the account");
        return;
      }
      setOk(true);
      setName("");
      setAdAccountId("");
    } catch {
      setError("Could not link the account");
    } finally {
      setBusy(false);
    }
  }

  if (ok) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
        Ad account linked — it now appears in the forms below.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Account label (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Spotify"
            className="rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Ad account ID (from Spotify Ads Manager)
          <input
            value={adAccountId}
            onChange={(e) => setAdAccountId(e.target.value)}
            placeholder="From Manage ad accounts in Ad Studio"
            autoComplete="off"
            className="rounded-md border border-stone-300 px-2.5 py-1.5 font-mono text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !adAccountId.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
          {busy ? "Linking…" : "Link account"}
        </button>
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </div>
  );
}
