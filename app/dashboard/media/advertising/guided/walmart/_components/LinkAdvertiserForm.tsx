// Marketr — Phase 18 slice 4: link a Walmart advertiser account (manual ID).

"use client";

import { useState } from "react";
import { CircleCheck, Link2, Loader2 } from "lucide-react";

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";

export default function LinkAdvertiserForm() {
  const [name, setName] = useState("");
  const [advertiserId, setAdvertiserId] = useState("");
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
        body: JSON.stringify({ platformKey: "walmart", name: name.trim() || undefined, externalAccountId: advertiserId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not link the account");
        return;
      }
      setOk(true);
      setName("");
      setAdvertiserId("");
    } catch {
      setError("Could not link the account");
    } finally {
      setBusy(false);
    }
  }

  if (ok) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2 text-sm text-ink shadow-hairline">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Advertiser account linked — it now appears in the forms below.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-3 shadow-hairline">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Account label (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Walmart"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Advertiser ID (from Walmart Ad Center)
          <input
            value={advertiserId}
            onChange={(e) => setAdvertiserId(e.target.value)}
            placeholder="e.g. 600001"
            autoComplete="off"
            className={`${inputCls} font-mono`}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !advertiserId.trim()}
          className={btnPrimarySm}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
          {busy ? "Linking…" : "Link account"}
        </button>
        {error && <span className="text-xs text-failed-text">{error}</span>}
      </div>
    </div>
  );
}
