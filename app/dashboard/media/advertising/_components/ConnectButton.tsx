// Marketr — Phase 18 slice 1: per-platform connect button.
//
// OAuth platforms navigate to the consent URL from /api/ads/oauth/start.
// Key-based and guided platforms show their honest state instead of a dead
// button.

"use client";

import { useState } from "react";
import { KeyRound, ListChecks, Loader2, PlugZap } from "lucide-react";

export default function ConnectButton({
  platformKey,
  displayName,
}: {
  platformKey: string;
  displayName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (platformKey === "stackadapt") {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-stone-500" title="Paste your StackAdapt GraphQL API key in Settings → Integrations (slice 3)">
        <KeyRound className="h-3.5 w-3.5" />
        API key in slice 3
      </span>
    );
  }
  if (platformKey === "spotify") {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-stone-500" title="Spotify has no campaign API — the guided setup flow lands in slice 5">
        <ListChecks className="h-3.5 w-3.5" />
        Guided in slice 5
      </span>
    );
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ads/oauth/start?platform=${encodeURIComponent(platformKey)}`);
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not start OAuth");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not start OAuth");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
        {busy ? "Opening…" : `Connect ${displayName}`}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  );
}
